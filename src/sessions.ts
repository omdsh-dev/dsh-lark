/**
 * Continuing a session this conversation did not start.
 *
 * A conversation's session id is DERIVED — chat, then the directory it is in —
 * and that is what makes a restarted process find the same conversation again.
 * The one thing derivation cannot express is "carry on with that other
 * session": the one `/new` minted, or the one opened on a laptop in the web UI
 * and now wanted on a phone.
 *
 * So a pointer records which session the conversation is on, and the whole
 * design here follows from what a chat can safely be shown and safely be given:
 *
 * - **Nothing is typed.** A session id is a machine identifier; asking someone
 *   to transcribe `lark-oc_…--e3` on a phone is not an interface. Every switch
 *   is a press on a row this channel produced, which is also what makes the
 *   list the only place authorization has to happen.
 * - **The list is the boundary.** A conversation may continue its own past
 *   sessions and sessions no conversation owns; never another chat's, whose
 *   title alone is a summary of what was said there.
 * - **The workspace decides what is on offer.** A session carries the directory
 *   it runs in, so continuing one from elsewhere would move the sandbox without
 *   anyone saying so. To reach those, `/cd` there first.
 * - **A pick is undone by picking.** This conversation's own derived session is
 *   always a row, so going back is the same gesture as going away — no second
 *   verb, nothing to remember.
 * - **A card lives as long as the derivation behind it.** Its rows are
 *   authorized by one reading of the corpus, so the first pick retires the card
 *   rather than redrawing it with new buttons: a card that stayed pressable
 *   would offer rows from a list the conversation may have outgrown. Going
 *   somewhere else means asking for the list again.
 * - **Nothing here opens a log it does not have to.** The host already folds
 *   and checkpoints what a row shows, so the picker reads those rows and falls
 *   back to the logs only where a deployment composes no such cache. That is
 *   what lets the whole corpus be described — and therefore paged — instead of
 *   a bounded window of it.
 * @module dsh-lark-channel/sessions
 */

import type {
  HostEventRecord,
  HostProjectionBlock,
  HostSession,
  HostSessionProjectionCache,
  HostSessionProjections,
  HostSessionQuery,
  HostSessionRecord,
} from './host.ts'
import { paginate, type Page } from './pager.ts'
import type { ConversationSubject } from './session.ts'

/** List the sessions this conversation may continue. Channel-owned: needs no agent. */
export const SESSIONS_COMMAND = 'sessions'

/** Marks this plugin's session rows apart from other card actions. */
export const SESSIONS_ACTION = 'dsh-lark-channel/sessions'

/** How many session rows one page of the picker draws. */
export const SESSIONS_PAGE_ROWS = 8

/**
 * The projection keys a row's cheap facts come from.
 *
 * All three are fixed-size state — a title, a dozen counters, two fields — so
 * reading them for every candidate costs nothing beside opening one log. The
 * one key whose state grows with the conversation is {@link RICH_KEY}, and that
 * one is read only for the rows a card actually draws.
 */
const CHEAP_KEYS = ['title', 'sessionStats', 'sessionListMetadata'] as const

/** The projection key whose state grows with the conversation: its turn outline. */
const RICH_KEY = 'turnOutline'

/**
 * How many rows the picker offers before it asks for a keyword instead.
 *
 * The log rung's bound. Where a projection cache can label a row without
 * opening its log, the list is paged instead and this does not apply.
 */
export const PICKER_ROWS = 5

/**
 * How many candidates beyond the visible rows are described anyway.
 *
 * The log rung's spare. Describing costs a log read per session, so the window
 * is bounded — but a window exactly as wide as the card runs the card short
 * whenever a candidate turns out to be a session nothing ever happened in, and
 * those are dropped only after they have been read. A spare of zero leaves a
 * card of eight empty candidates with nothing to draw at all, which is why this
 * cannot be zero.
 *
 * Kept no larger than it must be, because a read is not proportional to what
 * the row shows: every accessor on the query engine materializes the session's
 * WHOLE log, and a workspace here held a 47 MB / 41k-event session. A window of
 * twelve measured over a second on already-decompressed files, worse once the
 * host's own decode is counted, and the platform drops a card callback it
 * considers unanswered — which reaches the presser as "the callback service
 * timed out" rather than as a slow bot.
 */
export const PICKER_SPARE = 4

/**
 * How many candidates a keyword is matched against by title.
 *
 * The log rung's bound. A title is a log read per session, so a keyword search
 * over a corpus of hundreds cannot read them all. Ordered newest-first, so what
 * it does read is the half of the corpus a person is plausibly looking for.
 */
export const SEARCH_MAX = 60

/** One session a conversation may continue, as the picker shows it. */
export interface SessionChoice {
  readonly id: string
  /** The host's folded title, absent when the log carries none. */
  readonly title?: string | undefined
  /** When the session was created, for the row's relative time. */
  readonly createdAt?: number | undefined
  /** Whether an agent is driving it right now — on another surface, usually. */
  readonly live: boolean
  /** Whether this is the conversation's own derived session. */
  readonly own: boolean
  /** Whether the conversation is on it now. */
  readonly current: boolean
  /**
   * The last thing a person said in it — what a reader actually recognizes a
   * conversation by, and the one label that stays true as it goes on.
   */
  readonly lastSaid?: string | undefined
  /** Turns taken, so a long thread reads as one. */
  readonly turns?: number | undefined
  /** When it last moved, which is what "recent" should mean in the list. */
  readonly lastActive?: number | undefined
}

/** What one session's own projections say about it, beyond its header. */
export interface SessionFacts {
  /** Turns taken, which is the honest measure of how much is in there. */
  readonly turns: number
  /** When it last moved, which is what "recent" means in a list. */
  readonly lastActive?: number | undefined
  /** The last thing a PERSON said in it. */
  readonly lastSaid?: string | undefined
  /** The host's folded title, absent when the log carries none. */
  readonly title?: string | undefined
  /** Whether nothing was ever said in it, as the host's own list judges it. */
  readonly blank?: boolean | undefined
}

/**
 * Where a row's facts come from, in the order the ladder tries them.
 *
 * The host folds every registered projection over every session log anyway and
 * checkpoints the result durably, so the cheap rung costs no log read at all —
 * which is what lets a card label the WHOLE corpus instead of a bounded window
 * of it. The log rung is what a deployment composing no such cache has always
 * had, and it stays because this plugin ships to deployments that compose less
 * than the one it was written on.
 */
export interface FactSources {
  /** The persisted projection rows, when the deployment composes them. */
  readonly cache?: HostSessionProjectionCache | undefined
  /** The live registry, which serves the same keys from a running session. */
  readonly projections?: HostSessionProjections | undefined
  /** The attached Session for one id, when this process already has one. */
  readonly liveSession?: ((id: string) => HostSession | undefined) | undefined
}

/** One projection value as a record, or undefined when it is anything else. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Whether one listed header can witness a stored projection record.
 *
 * A record is bound to the format generation and the lineage that folded it, so
 * a header that cannot name both cannot address one. Named separately from the
 * read itself because the rung is decided for the whole corpus at once: one
 * unaddressable record makes the list unpageable rather than half-pageable.
 * @param header - the listed header.
 * @returns true when a cache row could be bound to this lifecycle.
 */
export function cacheAddressable(header: HostSessionRecord['header']): boolean {
  return typeof header?.id === 'string' && header.id !== ''
    && typeof header.createdAt === 'number'
    && typeof header.version === 'number'
    && typeof header.isSeeded === 'boolean'
}

/**
 * The projection rows that describe one listed session, without opening its log.
 * @param sources - the cache faces to try.
 * @param header - the listed header, which is the cache's identity witness.
 * @param keys - the projection keys to read.
 * @returns the block served, or undefined when no face can bind this lifecycle.
 */
export function projectedFacts(
  sources: FactSources,
  header: HostSessionRecord['header'],
  keys: readonly string[],
): HostProjectionBlock | undefined {
  if (typeof header?.id !== 'string' || header.id === '') return undefined
  // A running session's cells are the registry's own cut and trail the log by
  // nothing; the stored rows trail it by the last checkpoint. Both are the same
  // keys, so the newer face is simply asked first.
  const live = sources.liveSession?.(header.id)
  if (live !== undefined) {
    // Guarded like every other read of a composed service here: a registry that
    // throws must cost this row its projection facts, not the whole listing.
    try {
      const running = sources.projections?.cachedSnapshot?.(live, keys)
      if (running !== undefined) return running
    } catch {
      // The stored row below is the same cut, one checkpoint older.
    }
  }
  if (!cacheAddressable(header)) return undefined
  return sources.cache?.cachedSnapshot({
    id: header.id,
    createdAt: header.createdAt as number,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    version: header.version,
    isSeeded: header.isSeeded,
  }, keys)
}

/**
 * The facts a cheap block carries: how much happened, when it last moved, what
 * it is called, and whether anything was ever said in it.
 * @param values - the served projection values, absent when nothing was served.
 * @returns the facts the block answered; turns default to zero for the rest.
 */
function cheapFacts(values: Record<string, unknown> | undefined): SessionFacts {
  const stats = asRecord(values?.sessionStats)
  const metadata = asRecord(values?.sessionListMetadata)
  const title = values?.title
  const turns = typeof stats?.turns === 'number' ? stats.turns : 0
  const lastPromptAt = typeof metadata?.lastPromptAt === 'number' ? metadata.lastPromptAt : undefined
  return {
    turns,
    ...lastPromptAt === undefined ? {} : { lastActive: lastPromptAt },
    ...typeof title === 'string' && title !== '' ? { title } : {},
    ...typeof metadata?.blank === 'boolean' ? { blank: metadata.blank } : {},
  }
}

/**
 * The last thing a person said, as the turn outline recorded it.
 *
 * The outline keeps the FIRST human prompt of each turn and deliberately
 * ignores later ones in the same turn, so a steer mid-turn does not relabel the
 * conversation. That is the label a row wants: what the conversation has been
 * about, not what was last typed into it.
 * @param values - the served projection values, absent when nothing was served.
 * @returns the label, clipped the way every other row label is.
 */
function outlineSaid(values: Record<string, unknown> | undefined): string | undefined {
  const turns = asRecord(values?.turnOutline)?.turns
  if (!Array.isArray(turns)) return undefined
  const prompt = asRecord(turns.at(-1))?.prompt
  if (typeof prompt !== 'string') return undefined
  const said = prompt.replace(/\s+/g, ' ').trim()
  if (said === '') return undefined
  return said.length <= SAID_MAX_CHARS ? said : `${said.slice(0, SAID_MAX_CHARS)}…`
}

/** The event a turn opens with, counted as the size of a session. */
const TURN_START = 'turn/start'

/** The event carrying what someone said — a person or a plugin. */
const USER_MESSAGE = 'user/message'

/** The source kind a person's own message carries. */
const HUMAN = 'user'

/** How far back to look for the last human message among injected ones. */
const HUMAN_LOOKBACK = 16

/** How much of a message a row shows before it stops being a label. */
const SAID_MAX_CHARS = 40

/**
 * Shortest human line this will label a row with.
 *
 * "？" is an honest answer to "what was said last" and a useless answer to
 * "which conversation is this". A row labelled by a keystroke names nothing,
 * so the walk keeps going back for a line with something in it and settles for
 * the short one only when the conversation holds nothing else.
 */
const SAID_MIN_CHARS = 4

/**
 * Read what makes one session recognizable by opening its log.
 *
 * The log rung of the ladder, for a deployment composing no projection cache.
 * Everything it computes is already folded and stored by the host wherever
 * `sessionProjectionCache` is composed, which is why the picker prefers that
 * face: the same answer for no read at all.
 *
 * The last human line, not the first and not the title. A title here is folded
 * from the session's FIRST prompt, so a chat that opened with "hello" is
 * called Hello forever; and the opening line of a long conversation says as
 * little. What a person recognizes a conversation by is what it has been about
 * lately.
 *
 * Telling a person's message from an injected one needs the event's `source`,
 * which only the raw read carries: the same `user/message` stream holds system
 * prompt snapshots, skill catalogs and job notices, and any of them can be the
 * newest entry. So the seqs come from the cheap listing and exactly one
 * bounded window is read around the newest one.
 * @param query - the host session-query engine.
 * @param id - the session to describe.
 * @returns the facts, as far as the engine offers them.
 */
export async function sessionFacts(
  query: HostSessionQuery,
  id: string,
  signal?: AbortSignal,
): Promise<SessionFacts> {
  if (query.listEvents === undefined) return { turns: 0 }
  const events = await query.listEvents(id).catch((): readonly HostEventRecord[] => [])
  signal?.throwIfAborted()
  const turns = events.filter(event => event.type === TURN_START).length
  // Folded rather than spread: a long session's log runs to tens of thousands
  // of events, and `Math.max(...events)` passes every one of them as an
  // argument — which throws before it ever compares anything.
  const lastActive = events.length === 0
    ? undefined
    : events.reduce((latest, event) => (event.time > latest ? event.time : latest), 0)
  const facts: SessionFacts = { turns, ...lastActive === undefined ? {} : { lastActive } }
  const newest = events.filter(event => event.type === USER_MESSAGE).at(-1)
  if (newest === undefined || query.readEvent === undefined) return facts
  const window = await query
    .readEvent({ sessionId: id, seq: newest.seq, before: HUMAN_LOOKBACK })
    .catch(() => ({ events: [] as const }))
  const spoken = [...window.events ?? []]
    .reverse()
    .filter(event => event.type === USER_MESSAGE && event.data?.source?.kind === HUMAN)
    .map(event => (event.data?.content ?? [])
      .filter(block => block.type === 'text' && block.text !== undefined)
      .map(block => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(text => text !== '')
  const said = spoken.find(text => text.length >= SAID_MIN_CHARS) ?? spoken[0]
  if (said === undefined) return facts
  return {
    ...facts,
    lastSaid: said.length <= SAID_MAX_CHARS ? said : `${said.slice(0, SAID_MAX_CHARS)}…`,
  }
}

/** Entry value marking "no pick"; a deep-merged patch cannot delete a key. */
const NO_PICK = ''

/** Card payload carried by one session row, or by a page control. */
export interface SessionActionValue extends ConversationSubject {
  readonly kind: typeof SESSIONS_ACTION
  /**
   * The rendering every control on this card carries.
   *
   * Shared by the rows and the page controls rather than minted per button: a
   * card is retired by the first pick, so a second press anywhere on it has to
   * be recognizable as that same card.
   */
  readonly a: string
  /**
   * The session to continue; the row for the derived one carries it too, and a
   * page control carries none.
   */
  readonly session?: string | undefined
  /** The page to draw; absent when the row itself is the subject. */
  readonly page?: number | undefined
  /**
   * The workspace the row was offered under, when the card that carried it
   * named one.
   *
   * Carried so a press can be checked against the directory the CARD showed. A
   * card outlives the conversation's directory: `/cd` moves it, and a press on
   * the older card would otherwise continue a session from the workspace the
   * chat has left — the exact sandbox move the picker filters against.
   */
  readonly workspace?: string | undefined
}

/**
 * Narrow an arbitrary card-action value to this module's payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function sessionActionValue(value: unknown): SessionActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== SESSIONS_ACTION) return undefined
  if (typeof record.a !== 'string' || record.a === '') return undefined
  if (record.session !== undefined && (typeof record.session !== 'string' || record.session === '')) return undefined
  if (record.page !== undefined
    && (typeof record.page !== 'number' || !Number.isSafeInteger(record.page) || record.page < 0)) return undefined
  // A button that names neither is inert, and accepting it would authorize a
  // press that can do nothing.
  if (record.session === undefined && record.page === undefined) return undefined
  if (typeof record.key !== 'string' || record.key === '') return undefined
  if (typeof record.chatId !== 'string' || typeof record.chatType !== 'string') return undefined
  if (record.owner !== undefined && typeof record.owner !== 'string') return undefined
  if (record.workspace !== undefined && typeof record.workspace !== 'string') return undefined
  return {
    kind: SESSIONS_ACTION,
    a: record.a,
    ...record.session === undefined ? {} : { session: record.session },
    ...record.page === undefined ? {} : { page: record.page },
    key: record.key,
    chatId: record.chatId,
    chatType: record.chatType,
    ...record.owner === undefined ? {} : { owner: record.owner },
    ...record.workspace === undefined ? {} : { workspace: record.workspace },
  }
}

/** Construction options for {@link ChatSessionPointers}. */
export interface ChatSessionPointersOptions {
  /** Persisted anchor-id → session id; an empty entry means the derived session. */
  readonly entries?: Record<string, string> | undefined
  /** Deep-merge one patch into the plugin's settings section; false = not composed. */
  readonly persist?: ((patch: { chatSessions: Record<string, string> }) => Promise<boolean>) | undefined
  /** Operator console line. */
  readonly report?: ((line: string) => void) | undefined
}

/**
 * Which session each conversation-and-directory currently runs, against "the
 * one it derives" meaning no entry.
 *
 * One map for the two ways a conversation's session can be chosen: `/sessions`
 * points it at a session that already exists, and `/new` points it at an id
 * minted for the occasion. Keyed by the conversation's anchor id — the id it
 * derives before any suffix — so each directory keeps its own thread: a `/cd`
 * away and back returns to the session that directory was left on, which is
 * what folding an epoch into the id used to buy, without a counter to lose.
 *
 * Pure state plus injected persistence, mirroring the workspace and model
 * stores.
 */
export class ChatSessionPointers {
  private readonly entries: Map<string, string>
  private readonly persist: (patch: { chatSessions: Record<string, string> }) => Promise<boolean>
  private readonly report: (line: string) => void
  private warnedNotDurable = false

  constructor(options: ChatSessionPointersOptions = {}) {
    this.entries = new Map(Object.entries(options.entries ?? {}))
    this.persist = options.persist ?? (async () => false)
    this.report = options.report ?? (() => {})
  }

  /**
   * The session one conversation-and-directory currently runs.
   * @param anchorId - the id that conversation derives at this directory.
   * @returns the pointed-at id, or undefined when it runs on its derived one.
   */
  pointerFor(anchorId: string): string | undefined {
    const entry = this.entries.get(anchorId)
    return entry === undefined || entry === NO_PICK ? undefined : entry
  }

  /**
   * The anchors whose pointer names one session.
   *
   * Asked before anything would CREATE that id: a pointer names a session that
   * already exists, so reaching the create rung under a pointed id means the
   * resume failed — and starting an empty session in its place would answer
   * "continue that conversation" by writing over the one that was asked for.
   * @param sessionId - the session id about to be created.
   * @returns the anchor ids pointing at it, empty when none.
   */
  anchorsPointingAt(sessionId: string): string[] {
    return [...this.entries].filter(([, value]) => value === sessionId).map(([key]) => key)
  }

  /**
   * Every recorded entry, for migrating the keys of an older format.
   * @returns a detached view of the stored anchor-id → session-id pairs.
   */
  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.entries)
  }

  /**
   * Record a pointer, or clear it.
   *
   * Clearing is what `/cd` used to do and what picking a conversation's own
   * session does: a pointer that survived either would quietly win over the
   * very thing the person just asked for.
   * @param anchorId - the conversation-and-directory id.
   * @param sessionId - the session to run; undefined returns to derivation.
   * @returns whether it changed, and whether it survives a restart.
   */
  async set(anchorId: string, sessionId: string | undefined): Promise<{ changed: boolean; durable: boolean }> {
    const value = sessionId ?? NO_PICK
    const changed = (this.entries.get(anchorId) ?? NO_PICK) !== value
    this.entries.set(anchorId, value)
    if (!changed) return { changed: false, durable: true }
    const durable = await this.persist({ chatSessions: { [anchorId]: value } }).catch((error: unknown) => {
      this.report(`lark-channel: persisting the session pointer failed: ${String(error)}`)
      return false
    })
    if (!durable && !this.warnedNotDurable) {
      this.warnedNotDurable = true
      this.report('lark-channel: session pointers are in-memory only (no settings service); they reset on restart')
    }
    return { changed, durable }
  }
}

/**
 * Whether one session is work an agent delegated to itself rather than a
 * conversation someone had.
 *
 * The distinction is the host's, not this channel's invention, and the host
 * draws it firmly: a delegated session opens with an instruction its parent
 * wrote, its approval policy is pinned to `never` so nothing in it can ever
 * ask a human anything, and its own prompt tells it to report limitations back
 * to the parent instead. Nobody was ever in one, which is why offering one as
 * something to "continue" reads as noise — three rows of "你是代码仓库分析专家…"
 * burying the conversation someone is actually looking for.
 *
 * ONLY `origin` says it, because that is the one field the host defines as the
 * classification and the one the Web client reads. The other two header facts
 * are NOT equivalent, and treating them as such hides conversation:
 *
 * - `parentSession` is fork lineage, not delegation. A session forked from
 *   another, or one a tool created under a parent, carries it while remaining
 *   an ordinary conversation a person can open — the Web tree draws it as a
 *   visible row. Excluding those dropped 4 of the 5 sessions a chat could see.
 * - `delegationDepth` counts recursion for the budget that bounds it, and is
 *   `0` on every top-level session. It can only ever agree with `origin`.
 *
 * So the rule is the host's own, matched to the Web client's `sessionVisible`
 * (`packages/client/ui-workspace/src/client/tree.ts`), which is what keeps the
 * two surfaces showing one list.
 * @param record - the corpus record to judge.
 * @returns true when the session belongs to delegated work.
 */
export function isDelegated(record: HostSessionRecord): boolean {
  return record.header?.origin === 'subagent'
}

/**
 * Whether one session id was derived by this channel for the conversation
 * `base` belongs to.
 *
 * Session ids are built by concatenation — `<prefix><key>`, then `--<digest>`
 * for a workspace, and either `--s<random>` for a session `/new` minted or
 * `--e<n>` for one an older release counted — so a conversation's own family is
 * exactly the ids that start with its base.
 * @param id - the session id to test.
 * @param base - this conversation's own id before any suffix.
 * @returns true when the id belongs to this conversation.
 */
function isOwnSession(id: string, base: string): boolean {
  return id === base || id.startsWith(`${base}--`)
}

/**
 * Whether one session id was derived for SOME conversation of this channel.
 *
 * Every prefix this channel derives with begins with the channel's own marker,
 * instance rows included, so anything else came from another surface — the web
 * UI, the CLI — and belongs to nobody's chat.
 * @param id - the session id to test.
 * @param marker - the channel's session-id marker.
 * @returns true when some conversation owns it.
 */
function isChatSession(id: string, marker: string): boolean {
  return id.startsWith(marker)
}

/** What the picker needs to know about the conversation it is built for. */
export interface SessionPickerInput {
  /** This conversation's own base session id, before any suffix. */
  readonly base: string
  /** The session this conversation resolves to right now. */
  readonly current: string
  /** The canonical workspace whose sessions are on offer. */
  readonly workspace: string
  /** The channel's session-id marker, so another surface's sessions can be told apart. */
  readonly marker: string
  /** Optional keyword, matched against titles and ids. */
  readonly keyword?: string | undefined
  /** Sessions the operator archived; the host hides these from every surface. */
  readonly archived?: ReadonlySet<string> | undefined
}

/** What the picker offers a conversation, and what it is leaving out. */
export interface OfferedSessions {
  /**
   * Every session this conversation may continue, newest activity first.
   *
   * A press is authorized against exactly this list, whether or not the card is
   * drawing the row it names — which is why a page is taken from here rather
   * than derived per page.
   */
  readonly rows: readonly SessionChoice[]
  /** Older ones the card does not draw, so it can say how many. Zero when it pages. */
  readonly hidden: number
  /**
   * Whether {@link rows} is the WHOLE list, so a card may page through it.
   *
   * False where no projection cache can label a row without opening its log: the
   * list is then the bounded window this picker has always read, and a page
   * count computed from it would be a lie rather than a budget.
   */
  readonly complete: boolean
  /**
   * Fill in the one fact a cheap block cannot carry — what the conversation was
   * last about — for the rows one page draws.
   *
   * A closure rather than a second pass over the corpus: the outline's state
   * grows with the conversation, so it is read for the drawn rows only, and the
   * derivation already holds the headers that address them. On the log rung the
   * rows arrive described and this returns them unchanged.
   * @param rows - the rows one page draws.
   * @returns the same rows, labelled where the outline could label them.
   */
  readonly label: (rows: readonly SessionChoice[]) => readonly SessionChoice[]
}

/**
 * The rows one page draws, and where it sits.
 *
 * A window that cannot be paged is always its own single page: its rows ARE the
 * card, and the count it leaves out is reported as a number rather than as
 * pages that would move every time a session was opened elsewhere.
 * @param offered - the derivation.
 * @param page - the requested zero-based page; out-of-range values clamp.
 * @returns the rows to draw and the page's position.
 */
export function sessionsPage(offered: OfferedSessions, page: number): Page<SessionChoice> {
  if (!offered.complete) return { rows: offered.rows, page: 0, pages: 1 }
  return paginate(offered.rows, page, SESSIONS_PAGE_ROWS)
}

/** What a deployment composing nothing to list hands back: an empty, pageable list. */
export const EMPTY_OFFER: OfferedSessions = { rows: [], hidden: 0, complete: true, label: drawn => drawn }

/**
 * The sessions one conversation may continue, newest first.
 *
 * Filtering happens here rather than in the card, because what is offered IS
 * the authorization: a row that never appears cannot be pressed, and no other
 * check stands between a press and a resumed session.
 * @param records - the host's corpus listing.
 * @param titles - folded titles by session id.
 * @param input - the conversation the picker is for.
 * @param canonical - resolves one path to its canonical form for comparison.
 * @returns the choices to offer, in card order.
 */
/**
 * Why one record is not offered, when it is not.
 *
 * Named rather than boolean because the filters form a chain and a dropped
 * record says nothing about which link removed it — the one fact an operator
 * needs when the card comes back short.
 */
export type SessionDrop =
  /** The header carries no usable id, so nothing can name it. */
  | 'no-id'
  /** Work an agent delegated to itself, not a conversation someone had. */
  | 'delegated'
  /** The operator archived it; the host hides these from every surface. */
  | 'archived'
  /** Another conversation of this channel owns it. */
  | 'other-chat'
  /** It runs in a different directory, so continuing it would move the sandbox. */
  | 'other-workspace'
  /** A keyword was given and neither its title nor its id matches. */
  | 'keyword'

/** One record's verdict: the choice to offer, or the reason it is withheld. */
export interface SessionVerdict {
  /** The session this verdict is about. */
  readonly id: string
  /** The directory its header carries, absent when it carries none. */
  readonly cwd?: string | undefined
  /** The offered choice, present exactly when `drop` is absent. */
  readonly choice?: SessionChoice | undefined
  /** Why it is withheld, absent when it is offered. */
  readonly drop?: SessionDrop | undefined
}

/**
 * Judge every record once, naming the filter that withheld it.
 *
 * The same rules {@link sessionChoices} applies, but keeping the reason beside
 * each record instead of discarding it with the record. Keyword matching stays
 * out of this: it is the one rule whose input is a title read the caller may
 * not have paid for yet, and folding it in would report "no match" for records
 * whose titles were never fetched.
 * @param records - the host's corpus listing.
 * @param titles - folded titles by session id.
 * @param input - the conversation the picker is for.
 * @param canonical - resolves one path to its canonical form for comparison.
 * @returns one verdict per record, in corpus order.
 */
export function judgeSessions(
  records: readonly HostSessionRecord[],
  titles: ReadonlyMap<string, string>,
  input: SessionPickerInput,
  canonical: (path: string) => string,
): SessionVerdict[] {
  const home = canonical(input.workspace)
  return records.map((record): SessionVerdict => {
    const id = record.header?.id
    const cwd = record.header?.cwd
    const withhold = (drop: SessionDrop): SessionVerdict => ({
      id: typeof id === 'string' ? id : '',
      ...cwd === undefined ? {} : { cwd },
      drop,
    })
    if (typeof id !== 'string' || id === '') return withhold('no-id')
    if (isDelegated(record)) return withhold('delegated')
    // Archived means the operator hid it from every grouping surface. A chat
    // that kept offering it would be the one place that decision did not land.
    if (input.archived?.has(id) === true) return withhold('archived')
    // Own history, or a session no conversation owns. Another chat's session
    // is never offered: its title alone summarizes what was said there.
    if (!isOwnSession(id, input.base) && isChatSession(id, input.marker)) return withhold('other-chat')
    // A session carries the directory it runs in, so one from elsewhere would
    // move this conversation's sandbox without anyone saying so.
    if (cwd === undefined || canonical(cwd) !== home) return withhold('other-workspace')
    const title = titles.get(id)
    return {
      id,
      cwd,
      choice: {
        id,
        ...title === undefined || title === '' ? {} : { title },
        ...record.header?.createdAt === undefined ? {} : { createdAt: record.header.createdAt },
        live: record.live === true,
        own: isOwnSession(id, input.base),
        current: id === input.current,
      },
    }
  })
}

/**
 * The sessions one conversation may continue, in card order.
 * @param records - the host's corpus listing.
 * @param titles - folded titles by session id.
 * @param input - the conversation the picker is for.
 * @param canonical - resolves one path to its canonical form for comparison.
 * @returns the choices to offer, newest first.
 */
export function sessionChoices(
  records: readonly HostSessionRecord[],
  titles: ReadonlyMap<string, string>,
  input: SessionPickerInput,
  canonical: (path: string) => string,
): SessionChoice[] {
  const keyword = input.keyword?.trim().toLowerCase() ?? ''
  const choices = judgeSessions(records, titles, input, canonical)
    .map(verdict => verdict.choice)
    .filter((choice): choice is SessionChoice => choice !== undefined)
    .filter(choice => keyword === ''
      || (choice.title ?? '').toLowerCase().includes(keyword)
      || choice.id.toLowerCase().includes(keyword))
  choices.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
  return choices
}

/**
 * Read the titles of several sessions, tolerating the ones that cannot be read.
 *
 * The host isolates failures per session, so a corpus with one unreadable log
 * still yields every other title — and a session whose title cannot be folded
 * simply shows without one.
 * @param query - the host session-query service.
 * @param ids - the sessions to fold titles for.
 * @param signal - cancellation for the batch.
 * @returns titles by session id; absent for anything unreadable or untitled.
 */
export async function readTitles(
  query: HostSessionQuery,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (ids.length === 0 || query.readTitleSnapshots === undefined) return titles
  const results = await query.readTitleSnapshots(ids, signal).catch(() => [])
  for (const result of results) {
    // The batch's own discriminator: a rejected read carries a reason, not a
    // value, and reading `value` off it would silently look like "no title".
    if (result.status !== 'fulfilled') continue
    const title = result.value?.title?.title
    if (typeof title === 'string' && title !== '') titles.set(result.sessionId, title)
  }
  return titles
}

/** Everything one derivation of the picker needs, and nothing about a chat. */
export interface SessionOffer {
  /** The host's session-query engine. */
  readonly query: HostSessionQuery
  /**
   * Where a row's facts come from, when the deployment folds and stores them.
   *
   * Absent is not an error: the derivation falls back to opening logs, which is
   * what this picker did before such a cache was ever asked for.
   */
  readonly sources?: FactSources | undefined
  /** The conversation the list is built for. */
  readonly scope: SessionPickerInput
  /** Resolves a path to its canonical form, so a symlinked workspace matches. */
  readonly canonical: (path: string) => string
  /** Cancellation for the reads this makes. */
  readonly signal?: AbortSignal | undefined
  /** Where a listing failure is reported; the picker itself degrades to empty. */
  readonly report?: ((line: string) => void) | undefined
  /**
   * Whether to account for every candidate this derivation admits or drops.
   *
   * The filters are silent by construction: a record one of them excludes is
   * simply absent from the card, and nothing tells "the corpus held nothing"
   * apart from "every candidate tripped a rule". That makes a short list
   * unattributable from the chat, which is exactly the question a report has
   * to answer, so the derivation can be asked to describe itself.
   */
  readonly diagnose?: boolean | undefined
}

/** Newest activity first, falling back to creation for a session nothing moved. */
function byRecency(left: SessionChoice, right: SessionChoice): number {
  return (right.lastActive ?? right.createdAt ?? 0) - (left.lastActive ?? left.createdAt ?? 0)
}

/**
 * The sessions one conversation may continue right now.
 *
 * Derived on every call rather than remembered: sessions appear while a chat
 * is idle — the web UI opens one, `/new` leaves one behind — and a list built
 * once would offer yesterday's answer to today's press. That was worth caching
 * only while every row cost a log read; it no longer is.
 *
 * What comes back IS what a press may name, and a press is authorized against
 * exactly this. One list, one boundary.
 * @param offer - the query, the conversation's scope, and how to canonicalize.
 * @returns the rows to offer, newest activity first, and how to finish a page.
 */
export async function offerSessions(offer: SessionOffer): Promise<OfferedSessions> {
  const { query, scope } = offer
  // Canonicalizing is a synchronous filesystem call, and a corpus of hundreds
  // of sessions holds a handful of distinct directories — so it is asked once
  // per directory rather than once per record.
  const canonicalized = new Map<string, string>()
  const canonical = (path: string): string => {
    const seen = canonicalized.get(path)
    if (seen !== undefined) return seen
    const resolved = offer.canonical(path)
    canonicalized.set(path, resolved)
    return resolved
  }
  const records = await query.listSessions(offer.signal).catch((error: unknown) => {
    offer.report?.(`lark-channel: listing sessions failed: ${String(error)}`)
    return [] as readonly HostSessionRecord[]
  })
  const keyword = scope.keyword?.trim() ?? ''
  // The rung is decided once, for the whole corpus: a record whose header cannot
  // witness a stored row cannot be labelled without opening its log, and a list
  // that is half cheap and half read cannot be paged honestly.
  const sources = offer.sources
  const folded = sources?.cache !== undefined && records.every(record => cacheAddressable(record.header))
  if (offer.diagnose === true) {
    // Judged once, keeping each record's verdict: the choices are the same
    // answer, and the withheld ones are what a short card has to be explained by.
    const judged = judgeSessions(records, new Map(), scope, canonical)
    for (const line of accountFor(records, judged, scope, canonical)) offer.report?.(line)
  }
  if (folded && sources !== undefined) return offerFromProjections(offer, sources, records, keyword, canonical)
  return await offerFromLogs(offer, records, keyword, canonical)
}

/**
 * The picker's answer where the host already folded what a row shows.
 *
 * No log is opened, so every candidate can be described rather than a bounded
 * window of them — which is what makes the list pageable and what retires the
 * "older ones" count entirely.
 * @param offer - the derivation.
 * @param sources - the cache faces the cheap and rich keys are read from.
 * @param records - the host's corpus listing.
 * @param keyword - the trimmed filter, empty when none was given.
 * @param canonical - resolves one path to its canonical form.
 * @returns every eligible row, and how to label one page of them.
 */
function offerFromProjections(
  offer: SessionOffer,
  sources: FactSources,
  records: readonly HostSessionRecord[],
  keyword: string,
  canonical: (path: string) => string,
): OfferedSessions {
  const headers = new Map<string, HostSessionRecord['header']>()
  const facts = new Map<string, SessionFacts>()
  const titles = new Map<string, string>()
  for (const record of records) {
    const id = record.header?.id
    if (typeof id !== 'string' || id === '') continue
    const cheap = cheapFacts(projectedFacts(sources, record.header, CHEAP_KEYS)?.values)
    headers.set(id, record.header)
    facts.set(id, cheap)
    if (cheap.title !== undefined) titles.set(id, cheap.title)
  }
  const candidates = sessionChoices(records, titles, { ...offer.scope, keyword: '' }, canonical)
  const shortlist = sessionChoices(records, titles, offer.scope, canonical)
    // A session nothing ever happened in is not a conversation to continue —
    // except this one's own, which is how a picked conversation comes back.
    // Where the host served no row at all the answer is unknown, and an unknown
    // row stays visible: hiding it would drop the sessions this deployment has
    // simply not checkpointed yet.
    .filter(choice => choice.own || facts.get(choice.id)?.blank !== true)
    .map((choice) => {
      const known = facts.get(choice.id)
      return known === undefined ? choice : { ...choice, ...known }
    })
  shortlist.sort(byRecency)
  if (offer.diagnose === true) {
    const pages = Math.max(1, Math.ceil(shortlist.length / SESSIONS_PAGE_ROWS))
    offer.report?.(`lark-channel: session picker: folded records=${records.length}`
      + ` candidates=${candidates.length}`
      + `${keyword === '' ? '' : ` (keyword="${keyword}")`}`
      + ` offered=${shortlist.length} pages=${pages}`)
  }
  return {
    rows: shortlist,
    hidden: 0,
    complete: true,
    label: drawn => drawn.map((choice) => {
      const said = outlineSaid(projectedFacts(sources, headers.get(choice.id), [RICH_KEY])?.values)
      return said === undefined ? choice : { ...choice, lastSaid: said }
    }),
  }
}

/**
 * The picker's answer where no projection cache can label a row.
 *
 * Unchanged from what this picker has always done: a bounded window described
 * from the logs themselves, and a count of the older ones it left out. It is
 * not paged, because a page count derived from a bounded window would move
 * every time a session was opened on another surface.
 * @param offer - the derivation.
 * @param records - the host's corpus listing.
 * @param keyword - the trimmed filter, empty when none was given.
 * @param canonical - resolves one path to its canonical form.
 * @returns the rows to draw, the hidden count, and identity labelling.
 */
async function offerFromLogs(
  offer: SessionOffer,
  records: readonly HostSessionRecord[],
  keyword: string,
  canonical: (path: string) => string,
): Promise<OfferedSessions> {
  const { query, scope } = offer
  const candidates = sessionChoices(records, new Map(), { ...scope, keyword: '' }, canonical)
  // A keyword is matched against titles, so the titles have to exist before the
  // filter runs — the reason a keyword used to match nothing but ids. Bounded,
  // because this is a title read per candidate.
  const searched = keyword === ''
    ? new Map<string, string>()
    : await readTitles(query, candidates.slice(0, SEARCH_MAX).map(choice => choice.id), offer.signal)
  const shortlist = keyword === '' ? candidates : sessionChoices(records, searched, scope, canonical)
  // Described a few wider than the card shows: describing costs a log read per
  // session, and the corpus can hold hundreds — but a window exactly as wide as
  // the card would leave the card SHORT whenever the "nothing ever happened
  // here" rule below drops a row, and would sit a described row under an
  // undescribed one.
  //
  // Bounded tightly, because ONE read is far from cheap: every accessor on the
  // query engine materializes the session's whole log (`_corpus.load`), and a
  // workspace here held a 47 MB session — decompressing and parsing it to count
  // turns costs most of a second. Describing the window in parallel does not
  // hide that from the press that waits on it, and the platform drops a card
  // callback it considers unanswered, so an over-wide window is reported to the
  // presser as a dead service rather than as a slow one.
  const head = shortlist.slice(0, PICKER_ROWS + PICKER_SPARE)
  // Whatever else the window holds, it holds the session this conversation is
  // ON — a quiet one sorts to the back of a busy corpus, and a card that cannot
  // say where you are is worse than one row shorter.
  const parked = shortlist.find(choice => choice.current)
  const window = parked === undefined || head.includes(parked) ? head : [...head, parked]
  const described = await Promise.all(window.map(async (choice) => {
    const facts = await sessionFacts(query, choice.id)
    return {
      ...choice,
      ...facts.lastSaid === undefined ? {} : { lastSaid: facts.lastSaid },
      ...facts.lastActive === undefined ? {} : { lastActive: facts.lastActive },
      turns: facts.turns,
    }
  }))
  // A session nothing ever happened in is not a conversation to continue —
  // except this one's own, which is how a picked conversation comes back. Where
  // the host lends no event listing, nothing ever happened in ANY of them as
  // far as this can tell, and dropping the lot would leave a picker that only
  // ever offers what this chat already had.
  const kept = query.listEvents === undefined
    ? described
    : described.filter(choice => choice.own || (choice.turns ?? 0) > 0)
  // Ordered by the timestamp the row prints. The shortlist could only be cut by
  // creation time, which is what a header knows without opening a log; now that
  // these rows have been read, "3 天前" must not sit above "40 分钟前".
  kept.sort(byRecency)
  const top = kept.slice(0, PICKER_ROWS)
  // "You are here" is not something the card may run out of room for: a
  // conversation sitting on a session it has not spoken in lately would
  // otherwise be shown a list with no indication of where it is. Not under a
  // keyword, where the reader asked for a subset and means it.
  const here = keyword === '' ? kept.find(choice => choice.current) : undefined
  const visible = here === undefined || top.includes(here)
    ? top
    : [here, ...top.slice(0, PICKER_ROWS - 1)]
  // A title is a fallback label, so it is folded only for rows that are drawn
  // AND have nothing a person said — which, among real conversations, is
  // almost none of them.
  const untitled = visible.filter(choice => choice.lastSaid === undefined && choice.title === undefined)
  const titles = await readTitles(query, untitled.map(choice => choice.id), offer.signal)
  const rows = visible.map((choice) => {
    const title = titles.get(choice.id)
    return title === undefined ? choice : { ...choice, title }
  })
  if (offer.diagnose === true) {
    for (const line of accountForStages({ records, candidates, shortlist, described, kept, window, rows, keyword })) {
      offer.report?.(line)
    }
  }
  return {
    rows,
    hidden: kept.length - rows.length + (shortlist.length - window.length),
    complete: false,
    label: drawn => drawn,
  }
}

/**
 * One line per withheld record, plus a per-reason tally.
 *
 * Every id is named because a count alone cannot say WHICH session went
 * missing, and that is the whole question when a list comes back short — a
 * chat that shows one row out of fifteen has to be attributable to a rule and
 * to a session, not merely to arithmetic.
 * @param records - the corpus as listed, for the total.
 * @param judged - one verdict per record.
 * @param scope - the conversation the list is for, so the rules can be stated.
 * @param canonical - resolves one path to its canonical form.
 * @returns the report lines, one per withheld record then the tally.
 */
export function accountFor(
  records: readonly HostSessionRecord[],
  judged: readonly SessionVerdict[],
  scope: SessionPickerInput,
  canonical: (path: string) => string,
): string[] {
  const lines = [`lark-channel: session picker: listed ${records.length} record(s)`]
  lines.push(`lark-channel: session picker:   workspace=${canonical(scope.workspace)} base=${scope.base} current=${scope.current}`)
  const dropped = judged.filter(verdict => verdict.drop !== undefined)
  for (const verdict of dropped) {
    lines.push(`lark-channel: session picker:   DROP ${verdict.id || '<no id>'} (${verdict.drop}) cwd=${verdict.cwd ?? '<none>'}`)
  }
  const tally = new Map<SessionDrop, number>()
  for (const verdict of dropped) {
    if (verdict.drop !== undefined) tally.set(verdict.drop, (tally.get(verdict.drop) ?? 0) + 1)
  }
  const offered = judged.length - dropped.length
  const breakdown = [...tally].map(([reason, count]) => `${reason}=${count}`).join(' ')
  lines.push(`lark-channel: session picker: offered ${offered} of ${judged.length}${breakdown === '' ? '' : `; withheld ${breakdown}`}`)
  return lines
}

/**
 * One line per stage the derivation passes through, then the rows it drew.
 *
 * A short list can shrink at four different places — the corpus listing, the
 * eligibility rules, the describe window, and the "nothing ever happened here"
 * rule — and each has a different owner. Naming the count at every stage is
 * what tells those apart, which a single final number cannot.
 * @param stages - the intermediate counts this derivation observed.
 * @returns the report lines.
 */
export function accountForStages(stages: {
  readonly records: readonly unknown[]
  readonly candidates: readonly unknown[]
  readonly shortlist: readonly SessionChoice[]
  readonly described: readonly SessionChoice[]
  readonly kept: readonly SessionChoice[]
  readonly window: readonly SessionChoice[]
  readonly rows: readonly SessionChoice[]
  readonly keyword: string
}): string[] {
  const lines = [
    `lark-channel: session picker: stages records=${stages.records.length}`
    + ` candidates=${stages.candidates.length}`
    + ` shortlist=${stages.shortlist.length}`
    + `${stages.keyword === '' ? '' : ` (keyword="${stages.keyword}")`}`
    + ` window=${stages.window.length}`
    + ` described=${stages.described.length}`
    + ` kept=${stages.kept.length}`
    + ` rows=${stages.rows.length}`,
  ]
  const lostEmpty = stages.described.length - stages.kept.length
  if (lostEmpty > 0) {
    const empties = stages.described
      .filter(choice => !stages.kept.includes(choice))
      .map(choice => choice.id)
    lines.push(`lark-channel: session picker:   dropped ${lostEmpty} as never-used: ${empties.join(', ')}`)
  }
  lines.push(`lark-channel: session picker: rows drawn: ${stages.rows.map(choice => choice.id).join(', ') || '<none>'}`)
  return lines
}
