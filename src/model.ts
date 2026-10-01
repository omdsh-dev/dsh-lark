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

/** One provider/model pair, both halves known, with an optional thinking level. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
  /** Absent leaves the model's own default in force. */
  readonly reasoningEffort?: string | undefined
}

/** One advertised model, as the host llm registry lists it. */
export interface CatalogEntry {
  readonly provider: string
  readonly id: string
  readonly name: string
  /** The thinking levels the route accepts: empty when it offers none, absent when unknown. */
  readonly efforts?: readonly string[] | undefined
}

/** Separates the thinking level from the route in a persisted entry. */
const EFFORT_SEPARATOR = '#'

/**
 * Render a route (or a partial deployment selection) for the chat.
 * @param options - provider/model, either possibly absent.
 * @returns `provider/model`, the present half alone, or the host-default label.
 */
export function formatRoute(options: HostAgentOptions): string {
  const parts = [options.provider, options.model].filter(
    (part): part is string => part !== undefined && part !== '',
  )
  if (parts.length === 0) return '宿主默认'
  const effort = options.reasoningEffort === undefined || options.reasoningEffort === ''
    ? ''
    : ` · effort ${options.reasoningEffort}`
  return `${parts.join('/')}${effort}`
}

/**
 * Serialize a route for the persisted entry. The first `/` splits it back
 * apart, so the provider half must not contain one — and host provider route
 * keys do not, while model ids (`org/model` styles) may. A thinking level
 * rides after a `#`, so an entry written before levels existed still reads
 * as the same route.
 */
export function serializeRoute(route: ModelRoute): string {
  const effort = route.reasoningEffort === undefined ? '' : `${EFFORT_SEPARATOR}${route.reasoningEffort}`
  return `${route.provider}/${route.model}${effort}`
}

/**
 * Parse one persisted entry back into a route.
 * @param entry - a non-marker entry value.
 * @returns the route, treating everything after the first `/` as the model id
 *   and a trailing `#level` as its thinking level.
 */
export function parseRoute(entry: string): ModelRoute | undefined {
  const hash = entry.lastIndexOf(EFFORT_SEPARATOR)
  const base = hash > 0 ? entry.slice(0, hash) : entry
  const effort = hash > 0 ? entry.slice(hash + 1) : ''
  const separator = base.indexOf('/')
  if (separator <= 0 || separator === base.length - 1) return undefined
  return {
    provider: base.slice(0, separator),
    model: base.slice(separator + 1),
    ...effort === '' ? {} : { reasoningEffort: effort },
  }
}

/**
 * The levels one route offers, read from the catalog.
 * @param catalog - advertised routes.
 * @param route - the route to look up.
 * @returns the offered levels; empty when the route is unlisted or offers none.
 */
export function effortsFor(catalog: readonly CatalogEntry[], route: HostAgentOptions): readonly string[] {
  return catalog.find(entry => entry.provider === route.provider && entry.id === route.model)?.efforts ?? []
}

/**
 * Carry the deployment's thinking level onto a route that names none, when
 * the route offers it. Without this, a switch would silently drop thinking:
 * the route replaces the whole default selection, level included.
 * @param route - the route being switched to.
 * @param catalog - advertised routes.
 * @param inherited - the deployment default's level, if any.
 * @returns the route, with the inherited level where it applies.
 */
export function withInheritedEffort(
  route: ModelRoute,
  catalog: readonly CatalogEntry[],
  inherited: string | undefined,
): ModelRoute {
  if (route.reasoningEffort !== undefined || inherited === undefined) return route
  return effortsFor(catalog, route).includes(inherited) ? { ...route, reasoningEffort: inherited } : route
}

/**
 * Refuse a level for a route the catalog lists with no levels at all. An
 * unlisted route stays advisory, but a listed one that offers nothing will
 * fail the next request with UNSUPPORTED_REASONING_EFFORT, so say it here and
 * point at a route carrying the same model id that does offer levels.
 * @returns the refusal, or undefined when the level may be recorded.
 */
function refuseLevelless(catalog: readonly CatalogEntry[], route: HostAgentOptions): string | undefined {
  const listed = catalog.find(entry => entry.provider === route.provider && entry.id === route.model)
  if (listed?.efforts === undefined || listed.efforts.length > 0) return undefined
  const elsewhere = catalog.filter(entry => entry.id === route.model && (entry.efforts ?? []).length > 0)
  const hint = elsewhere.length === 0
    ? ''
    : `\n可调档位的路由：${elsewhere.map(entry => `\`/${MODEL_COMMAND} use ${entry.provider}/${entry.id} <effort>\``).join('、')}`
  return `⚠️ \`${route.provider}/${route.model}\` 这条路由不支持调 effort。${hint}`
}

/** Render offered levels for the chat. */
function renderEfforts(efforts: readonly string[]): string {
  return efforts.length === 0 ? '（该模型未声明档位）' : efforts.map(id => `\`${id}\``).join(' ')
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
  // A pick carries the level the conversation already runs at when the picked
  // route offers it, so pressing a row changes the model and nothing else.
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
      value: pick(serializeRoute({
        provider: entry.provider,
        model: entry.id,
        ...current?.reasoningEffort !== undefined && (entry.efforts ?? []).includes(current.reasoningEffort)
          ? { reasoningEffort: current.reasoningEffort }
          : {},
      })),
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
  /** The deployment default's selection, when one resolves. */
  readonly deploymentSelection?: (() => HostAgentOptions | undefined) | undefined
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

  if (verb === 'effort') {
    const level = rest.join(' ').trim()
    const catalog = await ports.catalog()
    const base = currentRoute ?? ports.deploymentSelection?.()
    if (base?.provider === undefined || base.model === undefined) {
      return { markdown: `⚠️ 读不到当前模型，请用 \`/${MODEL_COMMAND} use <provider/model> <effort>\`。` }
    }
    const offered = effortsFor(catalog, base)
    const levelless = level === '' ? undefined : refuseLevelless(catalog, base)
    if (levelless !== undefined) return { markdown: levelless }
    if (level === '') {
      return {
        markdown: `🧠 当前 effort：\`${base.reasoningEffort ?? '未设置（模型默认）'}\`\n可选：${renderEfforts(offered)}\n用法：\`/${MODEL_COMMAND} effort <档位>\``,
      }
    }
    if (offered.length > 0 && !offered.includes(level)) {
      return { markdown: `⚠️ \`${base.model}\` 不支持 effort \`${level}\`。可选：${renderEfforts(offered)}` }
    }
    const route: ModelRoute = { provider: base.provider, model: base.model, reasoningEffort: level }
    return applyRoute(store, key, route, offered.length > 0, ports)
  }

  if (verb === 'use') {
    const words = [...rest]
    // Routes carry no spaces, so a second word can only be a level.
    const requested = words.length >= 2 ? words.pop() : undefined
    const target = words.join(' ').trim()
    if (target === '') return { markdown: `用法：\`/${MODEL_COMMAND} use <provider/model 或模型名> [effort]\`` }
    const catalog = await ports.catalog()
    const resolved = resolveRouteInput(target, catalog)
    if ('reason' in resolved) return { markdown: `⚠️ ${resolved.reason}` }
    const offered = effortsFor(catalog, resolved.route)
    const levelless = requested === undefined ? undefined : refuseLevelless(catalog, resolved.route)
    if (levelless !== undefined) return { markdown: levelless }
    if (requested !== undefined && offered.length > 0 && !offered.includes(requested)) {
      return { markdown: `⚠️ \`${resolved.route.model}\` 不支持 effort \`${requested}\`。可选：${renderEfforts(offered)}` }
    }
    const route = requested === undefined
      ? withInheritedEffort(resolved.route, catalog, ports.deploymentSelection?.()?.reasoningEffort)
      : { ...resolved.route, reasoningEffort: requested }
    return applyRoute(store, key, route, resolved.listed, ports)
  }

  return {
    markdown: `用法：\`/${MODEL_COMMAND}\`、\`/${MODEL_COMMAND} use <provider/model> [effort]\`、\`/${MODEL_COMMAND} effort [档位]\`、\`/${MODEL_COMMAND} reset\``,
  }
}

/** Record one route and word the reply; shared by `use` and `effort`. */
async function applyRoute(
  store: ChatModels,
  key: string,
  route: ModelRoute,
  listed: boolean,
  ports: ModelCommandPorts,
): Promise<ModelReply> {
  const result = await store.set(key, route)
  if (!result.changed) return { markdown: `🤖 本会话已在使用 \`${formatRoute(route)}\`。` }
  await ports.release()
  const advisory = listed ? '' : '\n（目录未列出该路由；宿主目录是建议性的，仍按你给的设置。）'
  const durability = result.durable ? '' : '\n（本部署未组合 settings，这次切换在重启后会丢失。）'
  return {
    markdown: `🤖 已切换到 \`${formatRoute(route)}\`\n下一条消息起生效，上下文保留。${advisory}${durability}`,
  }
}
