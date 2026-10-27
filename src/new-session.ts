/**
 * Starting a fresh session in place.
 *
 * A conversation's own session id is derived from the chat and the directory,
 * so a restarted process picks the same conversation back up without storing a
 * mapping. What derivation cannot produce is a session that has NEVER existed —
 * and that is exactly what `/new` promises. Minting one is therefore a
 * separate act from deriving one: the id carries a random suffix, and the
 * conversation's current-session pointer (the same map `/sessions` writes) is
 * moved onto it.
 *
 * Random rather than a counter, for the reason the host's own `session.create`
 * mints `session-<uuid>`: a counter makes a new session's identity depend on
 * state that must never be lost, so one dropped write hands back an id the
 * conversation already ran — possibly an archived one, which the host then
 * refuses to run, silently. A random suffix cannot name anything the
 * conversation ever ran, so a lost pointer degrades to "the previous session"
 * instead of answering a request for a blank context with an old id.
 * @module dsh-lark-channel/new-session
 */

import { randomUUID } from 'node:crypto'

/** Start a fresh session for this conversation. Channel-owned: needs no agent. */
export const NEW_COMMAND = 'new'

/**
 * Random hex characters in a fresh session's suffix.
 *
 * Eight characters is 32 bits, and what it must beat is a collision with the
 * sessions ONE conversation ever ran: a chat would have to start over tens of
 * thousands of times before that is even a coin toss.
 */
const FRESH_SUFFIX_CHARS = 8

/** The suffix that marks an id as minted rather than derived or counted. */
const FRESH_MARKER = '--s'

/** A minted id's whole shape: the marker and exactly the characters minted with it. */
const FRESH_ID = /--s[0-9a-f]{8}$/u

/**
 * The pointer write `/new` performs, as the one method it needs. The channel's
 * session store satisfies it; tests substitute an in-memory object.
 */
export interface SessionPointerWriter {
  /**
   * Point one conversation at a session, or clear it.
   * @param anchorId - the conversation-and-directory id the pointer is keyed by.
   * @param sessionId - the session to run next; undefined returns to derivation.
   * @returns whether it changed, and whether it survives a restart.
   */
  set(anchorId: string, sessionId: string | undefined): Promise<{ changed: boolean; durable: boolean }>
}

/** Construction options for {@link runNewCommand}. */
export interface RunNewCommandOptions {
  /** The conversation-and-directory id a fresh session is minted under. */
  readonly anchorId: string
  /** Where the conversation's current session is recorded. */
  readonly pointer: SessionPointerWriter
  /** Disposes the conversation's current agent; awaited after the pointer moves. */
  readonly release: () => Promise<void>
  /** Source of randomness, so a test can pin the minted id. */
  readonly random?: (() => string) | undefined
  /** Operator console line. */
  readonly report?: ((line: string) => void) | undefined
}

/** What one `/new` concluded. */
export interface NewSessionResult {
  /** The session the conversation now runs on. */
  readonly sessionId: string
  /** Whether the move survives a restart. */
  readonly durable: boolean
  /** Markdown for the chat. */
  readonly reply: string
}

/**
 * Mint a session id under one anchor that no conversation can have used.
 * @param anchorId - the conversation-and-directory id.
 * @param random - UUID source; tests pin it.
 * @returns the fresh session id.
 */
export function mintFreshSessionId(anchorId: string, random: () => string = () => randomUUID()): string {
  return `${anchorId}${FRESH_MARKER}${random().replaceAll('-', '').slice(0, FRESH_SUFFIX_CHARS)}`
}

/**
 * Whether an id was minted by {@link mintFreshSessionId} rather than derived,
 * counted, or picked from the corpus.
 * @param sessionId - the session id to judge.
 * @returns true when the id carries the fresh marker and its minted shape.
 */
export function isFreshSessionId(sessionId: string): boolean {
  return FRESH_ID.test(sessionId)
}

/**
 * Run `/new`: mint a session nothing has run on, point the conversation at it,
 * release the agent it was on, and produce the chat reply.
 * @param options - anchor, pointer, release, and the operator sink.
 * @returns the new session, its durability, and the reply.
 */
export async function runNewCommand(options: RunNewCommandOptions): Promise<NewSessionResult> {
  const sessionId = mintFreshSessionId(options.anchorId, options.random)
  // Recorded before the release: a crash between the two leaves the
  // conversation pointing at a session it has not opened yet — a blank context,
  // which is what was asked for — rather than back on the one it just left.
  const { durable } = await options.pointer.set(options.anchorId, sessionId)
  await options.release()
  options.report?.(
    `lark-channel: started a fresh session ${sessionId}${durable ? '' : ' (in-memory only)'}`,
  )
  return { sessionId, durable, reply: replyFor(sessionId, durable) }
}

/**
 * The chat reply for one `/new`.
 * @param sessionId - the session that was minted.
 * @param durable - whether the pointer write reached storage.
 * @returns markdown for the chat.
 */
function replyFor(sessionId: string, durable: boolean): string {
  const suffix = sessionId.slice(sessionId.lastIndexOf(FRESH_MARKER))
  // The suffix rather than the whole id: `/status` prints the id in full, and
  // this line only has to be enough to match the two up.
  const durability = durable
    ? ''
    : '\n（本部署无法保存会话状态：重启后会回到上一个会话。）'
  return `🤖 已开新会话 \`${suffix}\`，下一条消息从空白上下文开始。\n`
    + '之前的记录仍在，工作区和模型设置不变。'
    + durability
}
