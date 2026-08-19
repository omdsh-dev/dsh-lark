/**
 * Per-conversation model routing. `/model use` points one conversation at a
 * provider/model route; unlike a workspace switch this keeps the SAME session —
 * a route is an `agentOptions` fact the host accepts on resume, not part of the
 * session's identity — so the conversation continues with its context intact
 * and only the model changes from the next message on.
 *
 * The catalog shown by `/model` comes from the host `llm` registry's own
 * listing. It is advisory by that service's contract: adapters may accept
 * models they do not list, so an unlisted route is set with a note, never
 * rejected.
 *
 * The mapping persists through the host settings service, in the same section
 * as credentials and workspace switches.
 * @module dsh-lark-channel/model
 */

import { modelCard } from './cards.ts'
import { marked } from './clicks.ts'
import type { HostAgentOptions } from './host.ts'
import type { ConversationSubject } from './session.ts'

/** Show or switch this conversation's model route. Channel-owned: needs no agent. */
export const MODEL_COMMAND = 'model'

/** Marks this plugin's model buttons apart from other card actions. */
export const MODEL_ACTION = 'dsh-lark-channel/model'

/** How many routes the picker offers before it defers to the typed form. */
const PICKER_ROWS = 10

/** Card payload carried by one model pick. */
export interface ModelActionValue extends ConversationSubject {
  readonly kind: typeof MODEL_ACTION
  /** The route to switch to; absent means "back to the deployment default". */
  readonly route?: string | undefined
}

/**
 * Narrow an arbitrary card-action value to this module's pick payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function modelActionValue(value: unknown): ModelActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== MODEL_ACTION) return undefined
  if (typeof record.key !== 'string' || typeof record.chatId !== 'string') return undefined
  if (typeof record.chatType !== 'string') return undefined
  if (record.owner !== undefined && typeof record.owner !== 'string') return undefined
  if (record.route !== undefined && typeof record.route !== 'string') return undefined
  return {
    kind: MODEL_ACTION,
    key: record.key,
    chatId: record.chatId,
    chatType: record.chatType,
    ...record.owner === undefined ? {} : { owner: record.owner },
    ...record.route === undefined ? {} : { route: record.route },
  }
}

/** Entry value marking "explicitly the default": deep-merge persistence cannot delete a key. */
const DEFAULT_MARKER = ''

/** One provider/model pair, both halves known. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** One advertised model, as the host llm registry lists it. */
export interface CatalogEntry {
  readonly provider: string
  readonly id: string
  readonly name: string
}

/**
 * Render a route (or a partial deployment selection) for the chat.
 * @param options - provider/model, either possibly absent.
 * @returns `provider/model`, the present half alone, or the host-default label.
 */
export function formatRoute(options: HostAgentOptions): string {
  const parts = [options.provider, options.model].filter(
    (part): part is string => part !== undefined && part !== '',
  )
  return parts.length === 0 ? '宿主默认' : parts.join('/')
}

/**
 * Serialize a route for the persisted entry. The first `/` splits it back
 * apart, so the provider half must not contain one — and host provider route
 * keys do not, while model ids (`org/model` styles) may.
 */
function serializeRoute(route: ModelRoute): string {
  return `${route.provider}/${route.model}`
}

/**
 * Parse one persisted entry back into a route.
 * @param entry - a non-marker entry value.
 * @returns the route, treating everything after the first `/` as the model id.
 */
export function parseRoute(entry: string): ModelRoute | undefined {
  const separator = entry.indexOf('/')
  if (separator <= 0 || separator === entry.length - 1) return undefined
  return { provider: entry.slice(0, separator), model: entry.slice(separator + 1) }
}

/** What one `/model use` or `/model reset` attempt concluded. */
export interface RouteChange {
  /** False when the conversation was already on that route. */
  readonly changed: boolean
  /** Whether the mapping survives a restart. */
  readonly durable: boolean
}

/** Construction options for {@link ChatModels}. */
export interface ChatModelsOptions {
  /** Persisted conversation-key → serialized route; {@link DEFAULT_MARKER} means default. */
  readonly entries?: Record<string, string> | undefined
  /** Deep-merge one patch into the plugin's settings section; false = not composed. */
  readonly persist?: ((patch: { chatModels: Record<string, string> }) => Promise<boolean>) | undefined
  /** Operator console line. */
  readonly report?: ((line: string) => void) | undefined
}

/**
 * The per-conversation model state: which route each conversation asked for,
 * against the deployment default meaning "no entry". Pure state plus injected
 * persistence, mirroring the workspace store.
 */
export class ChatModels {
  private readonly entries: Map<string, string>
  private readonly persist: (patch: { chatModels: Record<string, string> }) => Promise<boolean>
  private readonly report: (line: string) => void
  /** The non-durable warning is orientation; once is enough. */
  private warnedNotDurable = false

  constructor(options: ChatModelsOptions = {}) {
    this.entries = new Map(Object.entries(options.entries ?? {}))
    this.persist = options.persist ?? (async () => false)
    this.report = options.report ?? (() => {})
  }

  /** The route one conversation asked for, or undefined for the deployment default. */
  routeFor(key: string): ModelRoute | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined || entry === DEFAULT_MARKER) return undefined
    return parseRoute(entry)
  }

  /** Whether one conversation runs on the deployment default. */
  isDefault(key: string): boolean {
    return this.routeFor(key) === undefined
  }

  /** Point one conversation at a route. */
  async set(key: string, route: ModelRoute): Promise<RouteChange> {
    return this.record(key, serializeRoute(route))
  }

  /** Return one conversation to the deployment default. */
  async reset(key: string): Promise<RouteChange> {
    return this.record(key, DEFAULT_MARKER)
  }

  private async record(key: string, value: string): Promise<RouteChange> {
    const changed = (this.entries.get(key) ?? DEFAULT_MARKER) !== value
    this.entries.set(key, value)
    let durable = true
    if (changed) {
      durable = await this.persist({ chatModels: { [key]: value } }).catch((error: unknown) => {
        this.report(`lark-channel: persisting the model switch failed: ${String(error)}`)
        return false
      })
      if (!durable && !this.warnedNotDurable) {
        this.warnedNotDurable = true
        this.report('lark-channel: model switches are in-memory only (no settings service); they reset on restart')
      }
    }
    return { changed, durable }
  }
}

/**
 * Build the picker for one conversation.
 *
 * The catalog is advertised rather than exhaustive, so the picker offers the
 * first {@link PICKER_ROWS} routes and says how many it left out — the typed
 * form reaches any of them, including routes the registry never listed.
 * @param subject - the conversation the card governs and the chat it lives in.
 * @param catalog - advertised routes.
 * @param current - the route this conversation asked for, if any.
 * @param deploymentRoute - the default's display form.
 * @returns a card object for `send({ card })`.
 */
export function modelPickerCard(
  subject: ConversationSubject,
  catalog: readonly CatalogEntry[],
  current: ModelRoute | undefined,
  deploymentRoute: string,
): object {
  const shown = catalog.slice(0, PICKER_ROWS)
  // Marked per rendering: a picker card stays in the chat, and switching back
  // to a model already picked once is an ordinary thing to want.
  const pick = (route?: string): ModelActionValue => marked({
    kind: MODEL_ACTION,
    key: subject.key,
    chatId: subject.chatId,
    chatType: subject.chatType,
    ...subject.owner === undefined ? {} : { owner: subject.owner },
    ...route === undefined ? {} : { route },
  })
  return modelCard({
    current: current === undefined ? deploymentRoute : formatRoute(current),
    isDefault: current === undefined,
    entries: shown.map(entry => ({
      label: `${entry.provider}/${entry.id}`,
      detail: entry.name === entry.id ? undefined : entry.name,
      current: current !== undefined && entry.provider === current.provider && entry.id === current.model,
      value: pick(serializeRoute({ provider: entry.provider, model: entry.id })),
    })),
    hidden: catalog.length - shown.length,
    // Nothing to reset to when the conversation is already on the default.
    ...current === undefined ? {} : { reset: pick() },
  })
}

/** What {@link runModelCommand} needs from the bridge. */
export interface ModelCommandPorts {
  /** The host llm registry's advertised routes; empty when none is composed. */
  readonly catalog: () => Promise<readonly CatalogEntry[]>
  /** The deployment default's display form. */
  readonly deploymentRoute: () => string
  /** Awaited after a change, before the reply; releases the conversation's agent. */
  readonly release: () => Promise<void>
}

/**
 * Resolve the operator's route input against the catalog: a full
 * `provider/model` form is taken as written, and a bare model id is accepted
 * when exactly one advertised route carries it — the same shorthand contract
 * `/cd` uses for directory basenames.
 * @param input - the operator's target exactly as typed.
 * @param catalog - advertised routes.
 * @returns the route with its catalog standing, or the refusal.
 */
export function resolveRouteInput(
  input: string,
  catalog: readonly CatalogEntry[],
): { route: ModelRoute; listed: boolean } | { reason: string } {
  if (input.includes('/')) {
    const route = parseRoute(input)
    if (route === undefined) return { reason: `\`${input}\` 不是合法的 \`provider/model\` 形式。` }
    const listed = catalog.some(entry => entry.provider === route.provider && entry.id === route.model)
    return { route, listed }
  }
  const matches = catalog.filter(entry => entry.id === input)
  if (matches.length === 1 && matches[0] !== undefined) {
    return { route: { provider: matches[0].provider, model: matches[0].id }, listed: true }
  }
  if (matches.length > 1) {
    const rows = matches.map(entry => `- \`${entry.provider}/${entry.id}\``).join('\n')
    return { reason: `模型 \`${input}\` 属于多个 provider：\n${rows}\n请用完整的 \`provider/model\`。` }
  }
  return {
    reason: catalog.length === 0
      ? '本部署没有可枚举的模型目录，请用完整的 `provider/model` 形式。'
      : `目录里没有 \`${input}\`。发 \`/${MODEL_COMMAND}\` 查看可用路由，或用完整的 \`provider/model\`。`,
  }
}

/** What one `/model` line produced: a card to send, or a line of markdown. */
export type ModelReply = { readonly card: object } | { readonly markdown: string }

/**
 * Run one `/model` command line and produce the chat reply.
 *
 * The bare form answers with the picker card; every other form answers in
 * text, because `/model use x` is what someone types when they already know
 * the route and want it applied without reading a card.
 * @param line - the complete line, slash included.
 * @param subject - the conversation the command is about, and where it lives.
 * @param store - the model route state.
 * @param ports - catalog, default display, and the release hook.
 * @returns the card or the markdown for the chat.
 */
export async function runModelCommand(
  line: string,
  subject: ConversationSubject,
  store: ChatModels,
  ports: ModelCommandPorts,
): Promise<ModelReply> {
  const key = subject.key
  const argument = line.trimStart().slice(1 + MODEL_COMMAND.length).trim()
  const [verb, ...rest] = argument.split(/\s+/).filter(part => part !== '')
  const currentRoute = store.routeFor(key)

  if (verb === undefined) {
    const catalog = await ports.catalog()
    return { card: modelPickerCard(subject, catalog, currentRoute, ports.deploymentRoute()) }
  }

  if (verb === 'reset') {
    const result = await store.reset(key)
    if (!result.changed) return { markdown: `🤖 本会话已在使用默认模型 \`${ports.deploymentRoute()}\`。` }
    await ports.release()
    const durability = result.durable ? '' : '\n（本部署未组合 settings，这次切换在重启后会丢失。）'
    return { markdown: `🤖 已切回默认模型 \`${ports.deploymentRoute()}\`\n下一条消息起生效，上下文保留。${durability}` }
  }

  if (verb === 'use') {
    const target = rest.join(' ').trim()
    if (target === '') return { markdown: `用法：\`/${MODEL_COMMAND} use <provider/model 或模型名>\`` }
    const resolved = resolveRouteInput(target, await ports.catalog())
    if ('reason' in resolved) return { markdown: `⚠️ ${resolved.reason}` }
    const result = await store.set(key, resolved.route)
    if (!result.changed) return { markdown: `🤖 本会话已在使用 \`${formatRoute(resolved.route)}\`。` }
    await ports.release()
    const advisory = resolved.listed ? '' : '\n（目录未列出该路由；宿主目录是建议性的，仍按你给的设置。）'
    const durability = result.durable ? '' : '\n（本部署未组合 settings，这次切换在重启后会丢失。）'
    return {
      markdown: `🤖 已切换到 \`${formatRoute(resolved.route)}\`\n下一条消息起生效，上下文保留。${advisory}${durability}`,
    }
  }

  return {
    markdown: `用法：\`/${MODEL_COMMAND}\`、\`/${MODEL_COMMAND} use <provider/model>\`、\`/${MODEL_COMMAND} reset\``,
  }
}
