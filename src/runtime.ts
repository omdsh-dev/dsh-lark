/**
 * Runtime boundary and Cordis activation for the plugin.
 * @module dsh-lark-channel/runtime
 */

import { createLarkChannel, registerApp } from '@larksuite/channel'
import type { LarkChannelOptions, PolicyConfig } from '@larksuite/channel'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { installBridge, type ChannelPort } from './bridge.ts'
import { migrateAppSecret, resolveAppSecret, storeAppSecret } from './credentials.ts'
import type { HostCredentials } from './credentials.ts'
import { instanceIdentity } from './instance.ts'
import type { CotEvent, CotHandle } from './cot.ts'
import type { PanelCommand } from './slash-panel.ts'
import { beginOnboarding } from './onboarding.ts'
import type { LarkCredentials, OnboardedApp, RegisterAppPort } from './onboarding.ts'
import { describeAuthorization, resolveAuthorization } from './authorization.ts'
import type { Authorization } from './authorization.ts'
import type { HostLoader, HostSettings } from './host.ts'

/** Resolved configuration whose credentials are present; the transport can be built. */
export type ChannelConfig = ResolvedConfig & LarkCredentials

/** The app-config endpoint for the bot's slash-command panel; the SDK has no method for it. */
const SLASH_COMMAND_API = '/open-apis/application/v7/app_slash_commands'

/**
 * The thinking-process endpoint: `POST` opens one, `PUT` appends events, and a
 * terminal `RUN_FINISHED` closes it without a further call.
 */
const COT_API = '/open-apis/im/v1/message_cot'

/**
 * Narrow a resolved configuration to one carrying live credentials.
 * @param config - resolved plugin configuration.
 * @returns whether both credential fields are non-empty strings.
 */
function hasCredentials(config: ResolvedConfig): config is ChannelConfig {
  return typeof config.appId === 'string' && config.appId !== ''
    && typeof config.appSecret === 'string' && config.appSecret !== ''
}

/**
 * Create the production Lark transport from resolved configuration.
 * @param config - resolved plugin configuration with credentials.
 * @returns the real `@larksuite/channel` client behind the bridge's port surface.
 */
export function createLarkChannelPort(config: ChannelConfig, authorization: Authorization): ChannelPort {
  // Transport-level defense in depth. The plugin's own inbound check is the
  // authority (it runs where the agent is driven), but leaving the transport at
  // its `dmMode: 'open'` default would let unauthorized traffic reach this
  // process at all — and an allowlist the transport enforces never depends on
  // this plugin's handler being reached.
  const policy: PolicyConfig = { requireMention: config.requireMention }
  // Only narrow when a deployment asked to. Who may open a conversation with
  // the bot at all is the app's visibility scope, set in the developer console;
  // restricting again here by default would duplicate that decision.
  if (authorization.directSenders.size > 0) {
    policy.dmMode = 'allowlist'
    policy.dmAllowlist = [...authorization.directSenders]
  }
  if (config.groupAllowlist.length > 0) policy.groupAllowlist = config.groupAllowlist
  const options: LarkChannelOptions = {
    appId: config.appId,
    appSecret: config.appSecret,
    policy,
    source: 'dsh-lark-channel',
    respectProxyEnv: true,
  }
  if (config.domain !== undefined) options.domain = config.domain
  const channel = createLarkChannel(options)
  // The slash-command panel has no SDK method; it is a plain app-config API,
  // reached through the transport's own authenticated client.
  const raw = channel.rawClient as {
    request(payload: { method: string; url: string; data?: unknown }): Promise<unknown>
  }
  return Object.assign(channel, {
    async listSlashCommands(): Promise<PanelCommand[]> {
      // The collection route requires a paging query; without one it 404s.
      const response = await raw.request({
        method: 'GET',
        url: `${SLASH_COMMAND_API}?page_size=50`,
      }) as { data?: { items?: { command?: string; command_id?: string }[] } }
      return (response.data?.items ?? [])
        .filter((item): item is { command: string; command_id: string } =>
          typeof item.command === 'string' && typeof item.command_id === 'string')
        .map(item => ({ command: item.command, commandId: item.command_id }))
    },
    async deleteSlashCommand(commandId: string): Promise<void> {
      await raw.request({ method: 'DELETE', url: `${SLASH_COMMAND_API}/${commandId}` })
    },
    async createCot(chatId: string, options: { replyTo?: string; hidden: boolean }): Promise<CotHandle> {
      const response = await raw.request({
        method: 'POST',
        url: `${COT_API}?receive_id_type=chat_id`,
        data: {
          receive_id: chatId,
          ...options.replyTo === undefined ? {} : { origin_message_id: options.replyTo },
          cot_hidden: options.hidden,
          // A thinking process is not news: it must not raise an unread badge
          // or pull the conversation to the top of the list on every turn.
          enable_badge: false,
          update_feed_rank: false,
        },
      }) as { data?: { cot_id?: string; message_id?: string } }
      const cotId = response.data?.cot_id
      const messageId = response.data?.message_id
      if (cotId === undefined || messageId === undefined) {
        throw new Error('lark-channel: the platform returned no cot_id/message_id')
      }
      return { cotId, messageId }
    },
    async writeCotEvents(handle: CotHandle, events: readonly CotEvent[]): Promise<void> {
      await raw.request({
        method: 'PUT',
        url: COT_API,
        data: { events, message_id: handle.messageId, cot_id: handle.cotId },
      })
    },
    async createSlashCommand(command: string, description: string): Promise<void> {
      await raw.request({
        method: 'POST',
        url: SLASH_COMMAND_API,
        data: { command, description: { default_value: description } },
      })
    },
  })
}

/** Substitutable production boundaries; tests replace them with fakes. */
export const internals: {
  createPort: (config: ChannelConfig, authorization: Authorization) => ChannelPort
  registerApp: RegisterAppPort
  /** Operator console line; the default profile composes no logger printer. */
  notify: (line: string) => void
  /** Shortest gap between two issued QR codes; absent keeps the onboarding default. */
  reissueFloorMs?: number
  /** Reconnect-watchdog deadline override; absent keeps the bridge default. */
  reconnectDeadlineMs?: number
  /** How an onboarded secret is stored; substituted in tests. */
  storeSecret: typeof storeAppSecret
} = {
  createPort: createLarkChannelPort,
  registerApp,
  storeSecret: storeAppSecret,
  // Stamped because the incident this console exists for was dated off a file
  // mtime: the log itself could not answer WHEN its last line was written.
  notify: (line) => void process.stderr.write(`[${new Date().toLocaleString('sv-SE')}] ${line}\n`),
}

/**
 * Apply the plugin to its Cordis context. With credentials configured (entry
 * config or a stored settings section) the transport connects directly;
 * without them the official QR registration flow runs first and persists the
 * scanned credentials through the host `settings` service when one is composed.
 * @param ctx - Scoped plugin context; requires the `agents` service.
 * @param config - Configuration resolved by Cordis from the exported schema.
 */
export function apply(ctx: Context, config: Config): void {
  let active = true
  let started = false
  ctx.effect(() => () => { active = false }, 'lark:lifetime')

  /**
   * Install the bridge once credentials are known, stating this channel's reach
   * on the console: who it serves is a security fact its operator must see, and
   * a groups-only channel (no owner configured yet) is a valid deployment.
   */
  // Durable plugin state (onboarded credentials, workspace switches) goes
  // through the settings section when one is composed; false tells the writer
  // the value lives in memory only.
  let persistState = async (_patch: object): Promise<boolean> => false

  const start = (resolved: ChannelConfig): void => {
    if (!active || started) return
    started = true
    const authorization = resolveAuthorization(resolved)
    internals.notify(describeAuthorization(authorization))
    installBridge(
      ctx,
      resolved,
      internals.createPort(resolved, authorization),
      internals.notify,
      authorization,
      persistState,
      internals.reconnectDeadlineMs === undefined ? undefined : { deadlineMs: internals.reconnectDeadlineMs },
    )
  }

  const bootstrap = async (): Promise<void> => {
    // Loader siblings mount concurrently; whether the optional settings
    // service exists is only decided once the application settles.
    await (ctx.get('loader') as HostLoader | undefined)?.await()
    if (!active) return

    let resolved = resolveConfig(config)
    // A named row keys its settings, its credential, and its session ids apart
    // from every other row; an unnamed one keeps the original identifiers.
    const identity = instanceIdentity(resolved.instance)
    let persist = async (_app: OnboardedApp): Promise<boolean> => false
    const credentials = ctx.get('credentials') as HostCredentials | undefined
    const settings = ctx.get('settings') as HostSettings | undefined
    if (settings !== undefined) {
      try {
        const scope = settings.register(identity.settingsNamespace, Config, { base: config })
        resolved = resolveConfig(scope.get() as Config)
        persistState = async (patch) => {
          await scope.update(patch)
          return true
        }
        // Onboarding hands the secret to the credentials seam and records only
        // the reference, so the settings document never learns it.
        persist = async (app) => {
          const stored = await internals.storeSecret(credentials, app.appSecret, internals.notify, identity.secretRef)
          return persistState({
            ...app,
            ...stored.ref === undefined ? {} : { appSecretRef: stored.ref },
            // Blanked rather than omitted: the patch deep-merges, so a key is
            // overwritten and never removed, and an empty secret is an absent
            // one everywhere here.
            ...stored.inSettings ? {} : { appSecret: '' },
          })
        }
      } catch (error) {
        ctx.logger.error(
          'settings registration failed; continuing with entry config only: %s',
          error instanceof Error ? error.message : error,
        )
      }
    }

    // A secret already sitting in the settings document moves behind a
    // reference on this boot, so a bot onboarded before the seam was used is
    // repaired by restarting rather than by scanning again.
    const migratedRef = await migrateAppSecret(credentials, resolved, persistState, internals.notify, identity.secretRef)
    if (migratedRef !== undefined) resolved = { ...resolved, appSecret: '', appSecretRef: migratedRef }

    const secret = await resolveAppSecret(credentials, resolved, internals.notify)
    if (secret !== undefined) resolved = { ...resolved, appSecret: secret }

    if (hasCredentials(resolved)) {
      start(resolved)
      return
    }
    const base = resolved
    beginOnboarding({
      ctx,
      register: internals.registerApp,
      notify: internals.notify,
      persist,
      onCredentials: app => { start({ ...base, ...app }) },
      appId: resolved.appId,
      ...identity.name === undefined ? {} : { instance: identity.name },
      ...internals.reissueFloorMs === undefined ? {} : { reissueFloorMs: internals.reissueFloorMs },
    })
  }

  void bootstrap().catch((error: unknown) => {
    ctx.logger.error('lark-channel bootstrap failed: %s', error instanceof Error ? error.message : error)
  })
}
