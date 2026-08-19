/**
 * Continuing a session this conversation did not start.
 *
 * A conversation's session id is DERIVED — chat, workspace, epoch — and that is
 * what makes a restarted process find the same conversation again. The one
 * thing derivation cannot express is "carry on with that other session": the
 * one left behind by `/new`, or the one opened on a laptop in the web UI and
 * now wanted on a phone.
 *
 * So a pick is an override on the derivation, and the whole design here follows
 * from what a chat can safely be shown and safely be given:
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
 * @module dsh-lark-channel/sessions
 */

import type { HostEventRecord, HostSessionQuery, HostSessionRecord } from './host.ts'
import type { ConversationSubject } from './session.ts'

/** List the sessions this conversation may continue. Channel-owned: needs no agent. */
export const SESSIONS_COMMAND = 'sessions'

/** Marks this plugin's session rows apart from other card actions. */
export const SESSIONS_ACTION = 'dsh-lark-channel/sessions'

/** How many rows the picker offers before it asks for a keyword instead. */
export const PICKER_ROWS = 8

/**
 * How many candidates beyond the visible rows are described anyway.
 *
 * Describing costs a log read per session, so the window is bounded — but a
 * window exactly as wide as the card runs the card short whenever a candidate
 * turns out to be a session nothing ever happened in.
 */
export const PICKER_SPARE = 4

/**
 * How many candidates a keyword is matched against by title.
 *
 * A title is a log read per session, so a keyword search over a corpus of
 * hundreds cannot read them all. Ordered newest-first, so what it does read is
 * the half of the corpus a person is plausibly looking for.
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

/** What one session's own log says about it, beyond its header. */
export interface SessionFacts {
  /** Turns taken, which is the honest measure of how much is in there. */
  readonly turns: number
  /** When it last moved, which is what "recent" means in a list. */
  readonly lastActive?: number | undefined
  /** The last thing a PERSON said in it. */
  readonly lastSaid?: string | undefined
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
 * Read what makes one session recognizable: how much has happened, when it
 * last moved, and the last thing a person said in it.
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
export async function sessionFacts(query: HostSessionQuery, id: string): Promise<SessionFacts> {
  if (query.listEvents === undefined) return { turns: 0 }
  const events = await query.listEvents(id).catch((): readonly HostEventRecord[] => [])
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

/** Card payload carried by one session row. */
export interface SessionActionValue extends ConversationSubject {
  readonly kind: typeof SESSIONS_ACTION
  /** The session to continue; the row for the derived one carries it too. */
  readonly session: string
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
  if (typeof record.session !== 'string' || record.session === '') return undefined
  if (typeof record.key !== 'string' || record.key === '') return undefined
  if (typeof record.chatId !== 'string' || typeof record.chatType !== 'string') return undefined
  if (record.owner !== undefined && typeof record.owner !== 'string') return undefined
  return {
    kind: SESSIONS_ACTION,
    session: record.session,
    key: record.key,
    chatId: record.chatId,
    chatType: record.chatType,
    ...record.owner === undefined ? {} : { owner: record.owner },
  }
}

/** Construction options for {@link ChatSessionPicks}. */
export interface ChatSessionPicksOptions {
  /** Persisted conversation-key → session id; an empty entry means derived. */
  readonly entries?: Record<string, string> | undefined
  /** Deep-merge one patch into the plugin's settings section; false = not composed. */
  readonly persist?: ((patch: { chatSessions: Record<string, string> }) => Promise<boolean>) | undefined
  /** Operator console line. */
  readonly report?: ((line: string) => void) | undefined
}

/**
 * Which session each conversation was told to continue, against "the one it
 * derives" meaning no entry. Pure state plus injected persistence, mirroring
 * the workspace and model stores.
 */
export class ChatSessionPicks {
  private readonly entries: Map<string, string>
  private readonly persist: (patch: { chatSessions: Record<string, string> }) => Promise<boolean>
  private readonly report: (line: string) => void
  private warnedNotDurable = false

  constructor(options: ChatSessionPicksOptions = {}) {
    this.entries = new Map(Object.entries(options.entries ?? {}))
    this.persist = options.persist ?? (async () => false)
    this.report = options.report ?? (() => {})
  }

  /**
   * The session one conversation was told to continue.
   * @param key - the conversation key.
   * @returns the picked id, or undefined when it runs on its derived one.
   */
  pickFor(key: string): string | undefined {
    const entry = this.entries.get(key)
    return entry === undefined || entry === NO_PICK ? undefined : entry
  }

  /**
   * The conversations that were told to continue one session.
   *
   * Asked before anything would CREATE that id: a pick names a session that
   * already exists, so reaching the create rung under a picked id means the
   * resume failed — and starting an empty session in its place would answer
   * "continue that conversation" by writing over the one that was asked for.
   * @param sessionId - the session id about to be created.
   * @returns the conversation keys picking it, empty when none.
   */
  keysPicking(sessionId: string): string[] {
    return [...this.entries].filter(([, value]) => value === sessionId).map(([key]) => key)
  }

  /**
   * Record a pick, or clear it.
   *
   * Clearing is what `/cd` and `/new` do: both change which session this
   * conversation derives, and a pick that survived them would quietly win over
   * the very thing the person just asked for.
   * @param key - the conversation key.
   * @param sessionId - the session to continue; undefined returns to derivation.
   * @returns whether it changed, and whether it survives a restart.
   */
  async set(key: string, sessionId: string | undefined): Promise<{ changed: boolean; durable: boolean }> {
    const value = sessionId ?? NO_PICK
    const changed = (this.entries.get(key) ?? NO_PICK) !== value
    this.entries.set(key, value)
    if (!changed) return { changed: false, durable: true }
    const durable = await this.persist({ chatSessions: { [key]: value } }).catch((error: unknown) => {
      this.report(`lark-channel: persisting the session pick failed: ${String(error)}`)
      return false
    })
    if (!durable && !this.warnedNotDurable) {
      this.warnedNotDurable = true
      this.report('lark-channel: session picks are in-memory only (no settings service); they reset on restart')
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
 * Three header facts say it, and any of them is enough: a deployment that
 * stamps only one still gets the right answer.
 * @param record - the corpus record to judge.
 * @returns true when the session belongs to delegated work.
 */
export function isDelegated(record: HostSessionRecord): boolean {
  return record.header?.origin === 'subagent'
    || (record.header?.delegationDepth ?? 0) > 0
    || record.header?.parentSession !== undefined
}

/**
 * Whether one session id was derived by this channel for the conversation
 * `base` belongs to.
 *
 * Session ids are built by concatenation — `<prefix><key>`, then `--<digest>`
 * for a workspace and `--e<n>` for an epoch — so a conversation's own family is
 * exactly the ids that start with its base.
 * @param id - the session id to test.
 * @param base - this conversation's own id before workspace and epoch suffixes.
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
  /** This conversation's own base session id, before workspace and epoch suffixes. */
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
  /** Exactly the rows the card draws — and the only ids a press may name. */
  readonly rows: readonly SessionChoice[]
  /** Older ones the card does not draw, so it can say how many. */
  readonly hidden: number
}

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
export function sessionChoices(
  records: readonly HostSessionRecord[],
  titles: ReadonlyMap<string, string>,
  input: SessionPickerInput,
  canonical: (path: string) => string,
): SessionChoice[] {
  const home = canonical(input.workspace)
  const keyword = input.keyword?.trim().toLowerCase() ?? ''
  const choices = records
    .filter(record => typeof record.header?.id === 'string' && record.header.id !== '')
    .filter(record => !isDelegated(record))
    // Archived means the operator hid it from every grouping surface. A chat
    // that kept offering it would be the one place that decision did not land.
    .filter(record => input.archived?.has(record.header!.id!) !== true)
    .filter(record => {
      const id = record.header!.id!
      // Own history, or a session no conversation owns. Another chat's session
      // is never offered: its title alone summarizes what was said there.
      return isOwnSession(id, input.base) || !isChatSession(id, input.marker)
    })
    // A session carries the directory it runs in, so one from elsewhere would
    // move this conversation's sandbox without anyone saying so.
    .filter(record => record.header?.cwd !== undefined && canonical(record.header.cwd) === home)
    .map((record): SessionChoice => {
      const id = record.header!.id!
      const title = titles.get(id)
      return {
        id,
        ...title === undefined || title === '' ? {} : { title },
        ...record.header?.createdAt === undefined ? {} : { createdAt: record.header.createdAt },
        live: record.live === true,
        own: isOwnSession(id, input.base),
        current: id === input.current,
      }
    })
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
  /** The conversation the list is built for. */
  readonly scope: SessionPickerInput
  /** Resolves a path to its canonical form, so a symlinked workspace matches. */
  readonly canonical: (path: string) => string
  /** Cancellation for the reads this makes. */
  readonly signal?: AbortSignal | undefined
  /** Where a listing failure is reported; the picker itself degrades to empty. */
  readonly report?: ((line: string) => void) | undefined
}

/**
 * The sessions one conversation may continue right now, and how many more it
 * has that the card will not show.
 *
 * Derived on every call rather than remembered: sessions appear while a chat
 * is idle — the web UI opens one, `/new` leaves one behind — and a list built
 * once would offer yesterday's answer to today's press.
 *
 * What comes back IS what the card draws, and a press is authorized against
 * exactly this. One list, one boundary.
 * @param offer - the query, the conversation's scope, and how to canonicalize.
 * @returns the rows to offer, newest activity first, and the hidden count.
 */
export async function offerSessions(offer: SessionOffer): Promise<OfferedSessions> {
  const { query, scope } = offer
  // Canonicalizing is a synchronous filesystem call, and a corpus of hundreds
  // of sessions holds a handful of distinct directories — so it is asked once
  // per directory rather than once per record, twice over on a keyword.
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
  kept.sort((left, right) =>
    (right.lastActive ?? right.createdAt ?? 0) - (left.lastActive ?? left.createdAt ?? 0))
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
  return { rows, hidden: kept.length - rows.length + (shortlist.length - window.length) }
}
