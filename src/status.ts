/**
 * The `/status` report: what this conversation is pointed at and what its
 * agent is doing, assembled by the bridge from channel state alone — no agent
 * is created to answer it, because "what would my next message do" must be
 * answerable before a first message exists.
 * @module dsh-lark-channel/status
 */

import { statusCard } from './cards.ts'
import type { Copy } from './cards.ts'
import type { LarkDocCapabilitySnapshot } from './capability.ts'
import { marked } from './clicks.ts'
import type { HostContextPressure, HostSession, HostSessionProjections, HostTokenUsage } from './host.ts'
import type { PresetOption } from './permission.ts'
import type { ConversationSubject } from './session.ts'

/** What one session's meters report, in the shape the status card takes. */
export interface SessionMeters {
  readonly context?: { readonly used: number; readonly window?: number | undefined } | undefined
  readonly usage?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  } | undefined
}

/** Read one number out of an untyped projection value. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Read one live session's token meters.
 *
 * Everything here is optional by the host's own contract: a deployment may
 * compose no token meter, and a session that has not made a request yet has no
 * sample. Absent stays absent — a status row claiming zero tokens where the
 * meter simply is not there would be a lie an operator acts on.
 * @param projections - the session projection registry, when composed.
 * @param session - the live session; an unbound conversation has none.
 * @returns the meters worth showing, each present only when known.
 */
export function readMeters(
  projections: HostSessionProjections | undefined,
  session: HostSession | undefined,
): SessionMeters {
  if (projections === undefined || session === undefined) return {}
  let values: Record<string, unknown>
  try {
    values = projections.snapshot(session).values
  } catch {
    // A meter that cannot be read is a meter this report does without.
    return {}
  }
  const pressure = values.contextPressure as HostContextPressure | undefined
  const totals = values.tokenUsage as HostTokenUsage | undefined
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  const usage = totals === undefined
    ? undefined
    : {
        input: count(totals.uncachedInputTokens),
        output: count(totals.outputTokens),
        cacheRead: count(totals.cacheReadTokens),
        cacheWrite: count(totals.cacheWriteTokens),
      }
  return {
    ...used === undefined
      ? {}
      : { context: { used: count(used), window: pressure?.contextWindow } },
    ...usage === undefined || (usage.input === 0 && usage.output === 0) ? {} : { usage },
  }
}

/** Show this conversation's routing and activity. Channel-owned: needs no agent. */
export const STATUS_COMMAND = 'status'

/** Marks this plugin's status refresh apart from other card actions. */
export const STATUS_ACTION = 'dsh-lark-channel/status'

/** Card payload carried by a status refresh. */
export interface StatusActionValue extends ConversationSubject {
  readonly kind: typeof STATUS_ACTION
}

/**
 * Narrow an arbitrary card-action value to this module's refresh payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function statusActionValue(value: unknown): StatusActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== STATUS_ACTION) return undefined
  if (typeof record.key !== 'string' || typeof record.chatId !== 'string') return undefined
  if (typeof record.chatType !== 'string') return undefined
  if (record.owner !== undefined && typeof record.owner !== 'string') return undefined
  return {
    kind: STATUS_ACTION,
    key: record.key,
    chatId: record.chatId,
    chatType: record.chatType,
    ...record.owner === undefined ? {} : { owner: record.owner },
  }
}

/** Everything the report states, resolved by the bridge. */
export interface StatusFields {
  /** The directory the conversation's agent runs in. */
  readonly workspace: string
  /** Whether that is the deployment default. */
  readonly workspaceIsDefault: boolean
  /** Display form of the model route. */
  readonly route: string
  /** Whether that is the deployment default. */
  readonly routeIsDefault: boolean
  /** The durable session id the conversation resolves to. */
  readonly sessionId: string
  /** Whether an agent is currently bound for the conversation. */
  readonly bound: boolean
  /** Whether a turn is running right now. */
  readonly running: boolean
  /** Open approval cards waiting in this chat. */
  readonly pendingApprovals: number
  /** The running plugin's version; empty hides the row rather than lying. */
  readonly version: string
  /** Cloud-document features available to the next agent created in this bridge. */
  readonly documentCapabilities: LarkDocCapabilitySnapshot
  /**
   * The permission preset in force, as the deployment defines it — the knobs
   * travel with the name so the row describes what the session can actually
   * do rather than what its preset happens to be called.
   */
  readonly preset?: PresetOption | undefined
  /**
   * What the next request would carry against what the model can hold. Absent
   * until a session has made one request, and absent entirely where the
   * deployment composed no token meter.
   */
  readonly context?: { readonly used: number; readonly window?: number | undefined } | undefined
  /** Whole-session token totals, when the meter is composed. */
  readonly usage?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  } | undefined
}

/** Render one capability table without hiding exact missing scope names. */
export function documentCapabilityCopy(snapshot: LarkDocCapabilitySnapshot): Copy {
  const labels = {
    read: { zh: '读', en: 'read' },
    write: { zh: '写', en: 'write' },
    comment: { zh: '评论', en: 'comment' },
  } as const
  const rows = (['read', 'write', 'comment'] as const).map((capability) => {
    const state = snapshot[capability]
    const mark = state.enabled ? '✓' : '✗'
    const missing = state.enabled || state.missingScopes.length === 0
      ? { zh: '', en: '' }
      : {
          zh: `（缺 ${state.missingScopes.join('、')}）`,
          en: ` (missing ${state.missingScopes.join(', ')})`,
        }
    return {
      zh: `${labels[capability].zh} ${mark}${missing.zh}`,
      en: `${labels[capability].en} ${mark}${missing.en}`,
    }
  })
  const unverified = Object.values(snapshot).some(state => !state.scopeMapVerified)
  return {
    zh: `${rows.map(row => row.zh).join('　')}${unverified ? '；scope 名单待实测' : ''}`,
    en: `${rows.map(row => row.en).join('  ')}${unverified ? '; scope map awaiting live verification' : ''}`,
  }
}

/**
 * Render the report as a card.
 *
 * The refresh button carries the conversation rather than reading it from the
 * click, because the facets a key is built from — a thread, a sender — are not
 * in a card action at all. It is the same reason every control card here
 * carries its own subject.
 * @param fields - resolved status facts.
 * @param subject - the conversation the report is about, and where it lives.
 * @returns a card object for `send({ card })`.
 */
export function renderStatusCard(fields: StatusFields, subject: ConversationSubject): object {
  return statusCard({
    workspace: fields.workspace,
    workspaceIsDefault: fields.workspaceIsDefault,
    route: fields.route,
    routeIsDefault: fields.routeIsDefault,
    sessionId: fields.sessionId,
    activity: fields.running ? 'running' : fields.bound ? 'idle' : 'unbound',
    pendingApprovals: fields.pendingApprovals,
    version: fields.version,
    documentCapabilities: documentCapabilityCopy(fields.documentCapabilities),
    ...fields.preset === undefined ? {} : { preset: fields.preset },
    ...fields.context === undefined ? {} : { context: fields.context },
    ...fields.usage === undefined ? {} : { usage: fields.usage },
    // Marked, because a status card stays in the chat and refreshing twice is
    // the most ordinary thing to do with it.
    refresh: marked({
      kind: STATUS_ACTION,
      key: subject.key,
      chatId: subject.chatId,
      chatType: subject.chatType,
      ...subject.owner === undefined ? {} : { owner: subject.owner },
    } satisfies StatusActionValue),
  })
}
