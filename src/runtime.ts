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
import { failureDetail } from './format.ts'
import { createFileDiag } from './diag.ts'
import { createSettingsBinding, entryIdOf, userSectionOf } from './settings-store.ts'
import type { CotEvent, CotHandle } from './cot.ts'
import type { PanelCommand } from './slash-panel.ts'
import { beginOnboarding } from './onboarding.ts'
import type { LarkCredentials, OnboardedApp, RegisterAppPort } from './onboarding.ts'
import { describeAuthorization, resolveAuthorization } from './authorization.ts'
import type { Authorization } from './authorization.ts'
import type { HostLoader, HostSettings } from './host.ts'

/**
 * The credentials seam's change notification, as the host publishes it.
 *
 * Spelled here rather than merged into the context's event map: the event
 * belongs to a package this one does not depend on, and a `declare module` merge
 * of that map changes how every OTHER event name resolves in this package's
 * test program.
 */
const CREDENTIALS_UPDATED = 'credentials/reference-updated'

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
 * Name where a resolved app secret came from, in the operator's terms.
 *
 * The harness resolves a reference from its own store BEFORE an inherited
 * environment variable, so a deployment that both onboarded and still exports
 * the name connects with the stored secret. That fact is invisible from the
 * chat, which is why the connection line carries it.
 * @param source - the provider's own source label.
 * @returns the phrase to print beside the reference.
 */
function secretOrigin(source: string | undefined): string {
  if (source === 'file') return '来自凭据存储'
  if (source === 'env') return '来自环境变量'
  if (source === 'config') return '来自内联配置'
  return source === undefined || source === '' ? '来源未知' : `来自 ${source}`
}

/**
 * The transport options one deployment runs under.
 *
 * Separated from the client it configures so the decisions here — who the
 * transport itself will accept, and whether it may merge a chat's messages —
 * can be read and tested without a network client.
 * @param config - resolved plugin configuration with credentials.
 * @param authorization - who this deployment answers.
 * @returns the options for `createLarkChannel`.
 */
export function channelOptions(config: ChannelConfig, authorization: Authorization): LarkChannelOptions {
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
  // The transport batches by CHAT: messages arriving within its window are
  // merged into one, `{...last, content: joined}` — the LAST sender's name on
  // everyone's words. This channel prefixes each group message with who said
  // it, so a merge does not just blur a burst, it misattributes it: A's
  // sentence reaches the model labelled B. Under a finer session scope it is
  // worse still, handing one conversation another's words. Nothing is lost by
  // closing the window: the agent's own inbox already drains several queued
  // messages into a single turn.
  options.safety = { batch: { text: { delayMs: 0 }, media: { delayMs: 0 } } }
  if (config.domain !== undefined) options.domain = config.domain
  return options
}

/**
 * Create the production Lark transport from resolved configuration.
 * @param config - resolved plugin configuration with credentials.
 * @param authorization - who this deployment answers.
 * @returns the real `@larksuite/channel` client behind the bridge's port surface.
 */
export function createLarkChannelPort(config: ChannelConfig, authorization: Authorization): ChannelPort {
  const channel = createLarkChannel(channelOptions(config, authorization))
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
  /**
   * Reports made before the bridge exists.
   *
   * Whether managed state can be stored is decided during bootstrap, and the
   * bridge's diagnostic file is opened when the bridge installs — so the one
   * line that says WHY session state will not survive a restart would otherwise
   * reach the terminal alone. The bridge writes these to its file at install.
   */
  const startupNotices: string[] = []
  /**
   * Why this channel is up, and what will survive a restart.
   *
   * Reported on the console line that announces the connection, because "it
   * works now" answers neither of the two questions an operator asks next:
   * where the app secret came from, and whether `/cd`, `/model` and the session
   * pointers are durable. Set during bootstrap, which resolves both.
   */
  let credentialOrigin = '未配置'
  let stateDurable = false

  const start = (resolved: ChannelConfig): void => {
    if (!active || started) return
    started = true
    const authorization = resolveAuthorization(resolved)
    internals.notify(describeAuthorization(authorization))
    // Where the credentials came from and what will survive a restart: the two
    // questions "it works now" cannot answer, and the difference between a
    // deployment that was repaired and one whose stored state is being read.
    internals.notify(
      `lark-channel: 已连接 ${resolved.appId}（密钥来自${credentialOrigin}）；`
      + `托管状态（/cd、/model、会话指针）：${stateDurable ? '已持久化' : '仅本次进程'}`,
    )
    const port = internals.createPort(resolved, authorization)
    try {
      installBridge(
        ctx,
        resolved,
        port,
        internals.notify,
        authorization,
        persistState,
        internals.reconnectDeadlineMs === undefined ? undefined : { deadlineMs: internals.reconnectDeadlineMs },
        startupNotices,
      )
    } catch (error: unknown) {
      // A bridge that throws while installing leaves a CONNECTED transport with
      // no handlers: every message is swallowed and the chat simply goes quiet,
      // which is indistinguishable from the bot being offline. Said out loud
      // with the stack that names the line, and the port is closed rather than
      // left as a zombie — and not rethrown, so a caller that was onboarding
      // does not report this as a registration failure.
      started = false
      const detail = failureDetail(error)
      const stack = error instanceof Error ? error.stack : undefined
      internals.notify(`lark-channel: installing the bridge failed: ${detail}`)
      // The stack goes to the same places as the line above, and not only to the
      // logger: this failure happens once, in a process whose console is usually
      // gone by the time anyone asks which line threw, and a deployment may
      // compose no logger printer at all.
      if (stack !== undefined) internals.notify(`lark-channel: install failure stack:\n${stack}`)
      ctx.logger.error('installing the bridge failed: %s', stack ?? detail)
      if (resolved.diagnosticsFile !== undefined) {
        createFileDiag(
          {
            file: resolved.diagnosticsFile,
            ...resolved.cwd === undefined ? {} : { cwd: resolved.cwd },
            level: resolved.diagnosticsLevel,
          },
          reason => internals.notify(reason),
        )('error', `installing the bridge failed: ${detail}\n${stack ?? ''}`)
      }
      void port.disconnect().catch(() => {})
    }
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
    // The settings seam moved between host generations: the modern one writes a
    // row's volatile config by the row's own id, the older one registered a
    // namespace and handed back a scope. The binding picks whichever this
    // deployment composed and says so once when it can use neither, instead of
    // leaving managed state silently in memory.
    const rowId = entryIdOf(ctx) ?? identity.settingsNamespace
    const binding = createSettingsBinding({
      settings,
      entryId: rowId,
      namespace: identity.settingsNamespace,
      schema: Config,
      base: config,
      report: (line) => {
        internals.notify(line)
        startupNotices.push(line)
      },
    })
    if (binding.resolved !== undefined) resolved = resolveConfig(binding.resolved as Config)
    persistState = binding.persist
    // Onboarding hands the secret to the credentials seam and records only the
    // reference, so the settings document never learns it.
    //
    // The patch is built field by field rather than spread from the scanned app:
    // the host validates every key it is handed against this row's own fields
    // and refuses the whole patch over one it does not declare, which is how a
    // registration that reported the scanner's identity lost the credentials it
    // had just created. Only what the row owns goes here.
    persist = async (app) => {
      const stored = await internals.storeSecret(credentials, app.appSecret, internals.notify, identity.secretRef)
      return persistState({
        appId: app.appId,
        // Where the secret goes decides what the document records: the reference
        // when a provider took it, the secret itself when none is composed, and
        // blanked rather than omitted because a deep-merge patch cannot remove a
        // key — an empty secret is an absent one everywhere here.
        ...stored.inSettings ? { appSecret: app.appSecret } : { appSecret: '' },
        ...stored.ref === undefined ? {} : { appSecretRef: stored.ref },
      })
    }

    // A secret already sitting in the settings document moves behind a
    // reference on this boot, so a bot onboarded before the seam was used is
    // repaired by restarting rather than by scanning again. Only a secret the
    // DOCUMENT holds is moved: one a deployment injected through its own
    // composition belongs to that deployment, and copying it into the
    // credential store would take over a value its owner still supplies. A host
    // that publishes no per-row document section (the older seam) leaves the
    // judgement where it was.
    const migratedRef = documentSecretOf(settings, rowId) === false
      ? undefined
      : await migrateAppSecret(credentials, resolved, persistState, internals.notify, identity.secretRef)
    if (migratedRef !== undefined) resolved = { ...resolved, appSecret: '', appSecretRef: migratedRef }

    // Nothing defaults `appSecretRef` out of the Loader, so a deployment that
    // exported this row's reference is configured only because the identity's
    // own reference is named here — exporting `LARK_APP_SECRET` is enough while
    // the credential store holds nothing under that name, because the store
    // outranks the environment. An inline `appSecret` still wins inside
    // `resolveAppSecret`, so a composition that injects the value keeps owning it.
    const inlineSecret = typeof resolved.appSecret === 'string' && resolved.appSecret !== ''
    // The reference this row's secret is actually resolved through: a deployment
    // that named its own `appSecretRef` owns that one, and the identity's own
    // reference is only the default. Both the resolution and the watch below
    // name this same value, because watching the default instead reported
    // nothing when a deployment's own reference rotated.
    const secretRef = resolved.appSecretRef ?? identity.secretRef
    const secret = await resolveAppSecret(
      credentials,
      { ...resolved, appSecretRef: secretRef },
      internals.notify,
    )
    if (secret !== undefined) resolved = { ...resolved, appSecret: secret.value }
    watchAppSecret(ctx, credentials, secretRef, resolved.appSecret, internals.notify)
    // The two facts an operator asks for right after something was fixed, and
    // neither is visible from the chat: where the secret came from, and whether
    // managed state is durable. Filled here, reported with the connection.
    credentialOrigin = inlineSecret
      ? '内联配置'
      : secret === undefined ? '未配置（会扫码注册）' : `凭据 ${secretRef}（${secretOrigin(secret.source)}）`
    stateDurable = binding.durable

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

/**
 * Whether the user settings document carries this row's app secret.
 * @param settings - the composed settings service, when one is.
 * @param ns - the row id the document would key this row's section by.
 * @returns true or false when the host publishes the document's own section,
 * undefined when it publishes none and the caller must keep its old judgement.
 */
function documentSecretOf(settings: unknown, ns: string): boolean | undefined {
  const section = userSectionOf(settings, ns)
  if (section === null || typeof section !== 'object') return undefined
  const secret = (section as { readonly appSecret?: unknown }).appSecret
  return typeof secret === 'string' && secret !== ''
}

/**
 * Report a change to this row's app secret that the running transport cannot take.
 *
 * The transport is built with the secret as a constructor option, so a rotated
 * value cannot reach the client this process already holds: re-reading it and
 * saying what changed is the honest answer, and a restart is what applies it.
 * Staying silent would leave an operator believing the rotation landed.
 * @param ctx - the plugin's scoped context, which owns the subscription.
 * @param credentials - the seam, when one is composed.
 * @param ref - the reference this row's secret lives under.
 * @param inUse - the secret the transport was built with, when it had one.
 * @param report - operator console line.
 */
function watchAppSecret(
  ctx: Context,
  credentials: HostCredentials | undefined,
  ref: string,
  inUse: string | undefined,
  report: (line: string) => void,
): void {
  if (credentials === undefined) return
  // The one host event this package listens to that its own dependencies do not
  // declare, so it is named structurally: the seam is reached by name, and the
  // listener is owned by the calling fiber like every other `ctx.on`.
  const events = ctx as unknown as {
    on(name: string, listener: (ref: unknown) => void): () => void
  }
  events.on(CREDENTIALS_UPDATED, (changed) => {
    if (changed !== ref) return
    void credentials.resolve(ref).then((resolved) => {
      const next = resolved?.value
      if (next === undefined || next === '') {
        report(`lark-channel: credential "${ref}" is gone; the running transport keeps the secret it connected with until restart`)
        return
      }
      if (next !== inUse) report(`lark-channel: credential "${ref}" changed; restart the bot to connect with the new secret`)
    }).catch((error: unknown) => {
      report(`lark-channel: re-reading credential "${ref}" failed: ${String(error)}`)
    })
  })
}
