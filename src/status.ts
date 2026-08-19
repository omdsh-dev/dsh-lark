/**
 * The `/status` report: what this conversation is pointed at and what its
 * agent is doing, assembled by the bridge from channel state alone — no agent
 * is created to answer it, because "what would my next message do" must be
 * answerable before a first message exists.
 * @module dsh-lark-channel/status
 */

import { statusCard } from './cards.ts'
import { marked } from './clicks.ts'
import {
  foldedTokenCount,
  isCompactionEndEvent,
  isCompactionStartEvent,
  isCompactionSummaryEvent,
} from './host.ts'
import type {
  CompactionEndData,
  HostContextPressure,
  HostSession,
  HostSessionEvent,
  HostSessionProjections,
  HostTokenUsage,
} from './host.ts'
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

/** What one session's compaction history adds up to, in the shape the card takes. */
export interface CompactionTally {
  /**
   * How many compactions landed on the conversation AND folded an amount worth
   * stating. A bracket that failed its close changed nothing; one that only
   * pruned, or reported a count `foldedTokenCount` will not vouch for, folded
   * nothing this row can put a number on. Neither is counted here, so this is
   * the number of entries behind `foldedTokens` rather than every compaction
   * the log remembers.
   */
  readonly count: number
  /** How many tokens of history those compactions replaced, in total. */
  readonly foldedTokens: number
}

/**
 * What one bracket ended up folding, now that its close is in.
 *
 * A `summary` having landed is NOT the verdict. When `end` carries an error the
 * host deliberately leaves the conversation surface untouched and only the log
 * remembers the attempt, so a tally that counted summaries on their own would
 * report a memory loss that never happened — the kind of reading an operator
 * acts on by re-explaining something the agent never forgot. Hence the pairing:
 * a clean close AND a folded amount, or this bracket changed nothing worth
 * stating.
 * @param data - the closing bracket's payload.
 * @param folded - the amount this bracket's summary reported, if it wrote one.
 * @returns the amount to add to the tally, or undefined to leave it be.
 */
function landedFold(data: CompactionEndData, folded: number | undefined): number | undefined {
  return data.error === undefined ? folded : undefined
}

/**
 * Fold the session log into "how often, and how much".
 *
 * One forward pass with a single pending slot, because the host's own lock
 * allows at most one open bracket per session: a `start` arriving while another
 * is open means the previous one died unclosed, and overwriting the slot is
 * what stops an orphan from lending its folded amount to the bracket after it.
 * @param events - the whole session log, oldest first.
 * @returns the totals, which may be zero.
 */
function tallyCompactions(events: readonly HostSessionEvent[]): CompactionTally {
  let openId: string | undefined
  let pendingFolded: number | undefined
  let count = 0
  let foldedTokens = 0
  for (const event of events) {
    if (isCompactionStartEvent(event)) {
      openId = event.data.compactionId
      pendingFolded = undefined
      continue
    }
    if (isCompactionSummaryEvent(event)) {
      if (openId === event.data.compactionId) pendingFolded = foldedTokenCount(event.data)
      continue
    }
    if (!isCompactionEndEvent(event) || openId !== event.data.compactionId) continue
    // The manual kind counts here, and `turn` is read nowhere in this loop.
    // That asymmetry with the thinking-process line is deliberate, not an
    // oversight to be tidied away: that line skips a manual `/compact` because
    // the command reply already said so in the chat, while this row is the
    // session's own running total — "how many times has this conversation been
    // compacted, and how much did it forget" — an answer that does not depend
    // on who asked for it.
    const landed = landedFold(event.data, pendingFolded)
    if (landed !== undefined) {
      count += 1
      foldedTokens += landed
    }
    openId = undefined
    pendingFolded = undefined
  }
  return { count, foldedTokens }
}

/**
 * Read how much of one live session's history has been folded away.
 *
 * Absent stays absent, for the same reason the meters above go missing rather
 * than reading zero: a host too old to expose its session log cannot say, and a
 * row saying `0` where nothing is known is a lie an operator acts on. A session
 * nothing has compacted yet is the same case — there is no compaction to report,
 * so the row does not appear at all.
 * @param session - the live session; an unbound conversation has none.
 * @returns the tally, or undefined when there is none to state.
 */
export function readCompactions(session: HostSession | undefined): CompactionTally | undefined {
  const events = session?.events
  if (events === undefined) return undefined
  const tally = tallyCompactions(events)
  return tally.count === 0 ? undefined : tally
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
  /** Whether this conversation has an explicit /session switch (resumed on next message). */
  readonly switched?: boolean | undefined
  /** Whether a turn is running right now. */
  readonly running: boolean
  /** Open approval cards waiting in this chat. */
  readonly pendingApprovals: number
  /** The running plugin's version; empty hides the row rather than lying. */
  readonly version: string
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
  /**
   * How often this session's history has been folded into a summary, and by how
   * much. Absent where the host is too old to expose its session log, and absent
   * — rather than zero — until something has actually been compacted.
   */
  readonly compaction?: CompactionTally | undefined
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
    activity: fields.running ? 'running' : fields.bound ? 'idle' : fields.switched === true ? 'switched' : 'unbound',
    pendingApprovals: fields.pendingApprovals,
    version: fields.version,
    ...fields.preset === undefined ? {} : { preset: fields.preset },
    ...fields.context === undefined ? {} : { context: fields.context },
    ...fields.usage === undefined ? {} : { usage: fields.usage },
    ...fields.compaction === undefined ? {} : { compaction: fields.compaction },
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
