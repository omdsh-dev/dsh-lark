/**
 * Durable, scope-aware conversation sessions. One conversation facet — the
 * whole chat, one topic thread, or one sender inside a chat — owns exactly one
 * agent session whose id is derived from that facet alone, so a restarted
 * process reaches the conversation's stored session instead of starting it over
 * and a topic group no longer funnels every thread into one agent.
 * @module dsh-lark-channel/session
 */

import type { NormalizedMessage } from '@larksuite/channel'
import { failureDetail } from './format.ts'
import type { HostAgentHandle } from './host.ts'

/** Which conversation facet owns one agent session. */
export type SessionScope = 'chat' | 'chat-thread' | 'chat-sender'

/**
 * Marks a session id as this channel's, in the host agent registry and in the
 * on-disk session log. Stable: changing it orphans every stored conversation.
 */
const SESSION_PREFIX = 'lark-'

/** Separator between a conversation key's facets; absent from Feishu open ids. */
const FACET_SEPARATOR = ':'

/**
 * A walk finished under a generation that a release had already moved past.
 * Not a failure of the conversation — the waiter simply retries under the new
 * state — so it must be distinguishable from a real creation error, which is
 * reported to the chat.
 */
class SupersededError extends Error {
  constructor(key: string) {
    super(`lark-channel: opening for ${key} was superseded by a release`)
  }
}

/**
 * Which conversation a control card governs, and where it was published.
 *
 * A card that changes a conversation's settings has to say which conversation
 * it means, because a click arrives with only a chat and an operator — not the
 * thread or the sender facet the key was derived from. The chat is carried so
 * a FORWARDED card cannot act: the same payload pressed in another room no
 * longer matches the room the card was published to.
 */
export interface ConversationSubject {
  /** The conversation key, from {@link conversationKey}. */
  readonly key: string
  /** The chat the card was published to. */
  readonly chatId: string
  /** That chat's kind, so a click is authorized exactly as a message is. */
  readonly chatType: string
  /** The only operator the click may come from, when the scope is per-sender. */
  readonly owner?: string | undefined
}

/**
 * Derive the stable conversation key one session owns. Pure: the same
 * conversation facet yields the same key in every process.
 * @param scope - the facet a session is bound to.
 * @param msg - normalized inbound chat message.
 * @returns the conversation key.
 * @throws {Error} when `scope` is outside {@link SessionScope}.
 */
export function conversationKey(scope: SessionScope, msg: NormalizedMessage): string {
  switch (scope) {
    case 'chat':
      return msg.chatId
    case 'chat-thread':
      // Only a topic group splits into threads; an ordinary group carries none,
      // and there the whole chat is the finest facet available.
      return msg.threadId === undefined
        ? msg.chatId
        : `${msg.chatId}${FACET_SEPARATOR}${msg.threadId}`
    case 'chat-sender':
      return `${msg.chatId}${FACET_SEPARATOR}${msg.senderId}`
    default: {
      const unhandled: never = scope
      throw new Error(`lark-channel: unknown session scope ${String(unhandled)}`)
    }
  }
}

/**
 * Brand a conversation key as the session id that owns it. Concatenation only,
 * so the mapping is injective by construction: two conversations can never
 * share one session, and one conversation resolves to the same durable session
 * on every boot.
 * @param key - a conversation key from {@link conversationKey}.
 * @returns the session id to look up, resume, or create.
 */
export function sessionIdFor(key: string, prefix: string = SESSION_PREFIX): string {
  return `${prefix}${key}`
}

/** One agent this channel drives, and whether disposing it is this channel's job. */
export interface OpenedSession {
  readonly handle: HostAgentHandle
  /** False when the agent was already live under another owner. */
  readonly owned: boolean
}

/**
 * Host operations the ladder needs, as plain functions: the host `agents`
 * registry satisfies them through the bridge, while tests substitute an
 * in-memory object and need no Cordis mount.
 */
export interface SessionLadder {
  /**
   * Return the live agent for this id, if the host already has one.
   * @param sessionId - the branded session id.
   * @returns the live handle, or undefined when nothing runs on that id.
   */
  lookup(sessionId: string): HostAgentHandle | undefined
  /**
   * Load a persisted session as a live agent.
   * @param sessionId - the branded session id.
   * @returns the resumed handle.
   * @throws when no session is stored under the id, or its log cannot be read.
   */
  resume(sessionId: string): Promise<HostAgentHandle>
  /**
   * Create a fresh agent on this id.
   * @param sessionId - the branded session id.
   * @returns the created handle.
   * @throws when the agent cannot be composed.
   */
  create(sessionId: string): Promise<HostAgentHandle>
  /**
   * Report a failure that is handled rather than propagated. The line is
   * operator-facing and self-describing.
   * @param line - the complete report line.
   */
  report(line: string): void
}

/**
 * Get, resume, or create the agent bound to one conversation key, deduplicated
 * per key so a burst of messages cannot race two sessions into existence.
 * Bindings live until {@link ConversationSessions.close}, which disposes every
 * agent this store owns.
 */
export class ConversationSessions {
  /** Resolved sessions by conversation key. */
  private readonly opened = new Map<string, OpenedSession>()
  /** Conversation key per live session id, in binding order. */
  private readonly keys = new Map<string, string>()
  /** Acquisitions still walking the ladder, joined by concurrent messages. */
  private readonly opening = new Map<string, Promise<OpenedSession>>()
  /**
   * Release epoch per key. A release advances it SYNCHRONOUSLY before any
   * await, so every walk that started earlier can tell its result is stale —
   * a waiter that merely joined a shared opening promise would otherwise be
   * handed the very agent the release is about to dispose.
   */
  private readonly generations = new Map<string, number>()
  private closed = false

  /**
   * @param scope - the conversation facet every session is keyed by.
   * @param ladder - the host operations to walk.
   * @param idFor - session id per conversation key; the default is the plain
   * branding, and a workspace-aware channel injects a deriver that
   * discriminates by directory too.
   */
  constructor(
    private readonly scope: SessionScope,
    private readonly ladder: SessionLadder,
    private readonly idFor: (key: string) => string = sessionIdFor,
  ) {}

  /** Session ids currently bound, in insertion order. */
  get sessionIds(): string[] {
    return [...this.keys.keys()]
  }

  /**
   * The conversation key a live session id serves.
   * @param sessionId - a session id, as carried by a host session event.
   * @returns the key, or undefined when this store does not drive the session.
   */
  keyOf(sessionId: string): string | undefined {
    return this.keys.get(sessionId)
  }

  /**
   * Resolve the agent for one inbound message.
   * @param msg - normalized inbound chat message.
   * @returns the bound session, the same object for every later message of its key.
   * @throws {Error} when this store is closed, or when no ladder rung yielded an agent.
   */
  async acquire(msg: NormalizedMessage): Promise<OpenedSession> {
    return this.acquireKey(conversationKey(this.scope, msg))
  }

  /**
   * Resolve the agent for one conversation key. A loop rather than a single
   * walk: every await is a window for a release or a switch to move the
   * conversation on, and a result that no longer matches the key's current
   * state is retried under the new state instead of being handed out stale.
   * @param key - the conversation key.
   * @returns the bound session, the same object for every later call of its key.
   * @throws {Error} when this store is closed, or when creation genuinely fails.
   */
  async acquireKey(key: string): Promise<OpenedSession> {
    for (;;) {
      if (this.closed) throw new Error('lark-channel: sessions are closed')
      const generation = this.generation(key)
      const bound = this.opened.get(key)
      if (bound !== undefined) {
        // Reusable only while it still IS this key's session: a workspace
        // switch re-derives the id, and a stale binding is released — a second
        // release is a no-op — before walking under the new state.
        if (bound.handle.agent.session.id === this.idFor(key)) return bound
        await this.release(key)
        continue
      }
      let opening = this.opening.get(key)
      if (opening === undefined) {
        opening = this.bind(key, generation)
        this.opening.set(key, opening)
        // Failure clears the slot so the next message retries — but only the
        // failure that still owns the slot, never a successor's promise.
        opening.catch(() => {
          if (this.opening.get(key) === opening) this.opening.delete(key)
        })
      }
      let result: OpenedSession
      try {
        result = await opening
      } catch (error) {
        if (error instanceof SupersededError) continue
        throw error
      }
      // Joined waiters validate what they were handed: the generation still
      // current, the binding still published, the id still this key's.
      if (
        this.generation(key) === generation
        && this.opened.get(key) === result
        && result.handle.agent.session.id === this.idFor(key)
      ) return result
    }
  }

  /** The release epoch one key is currently in. */
  private generation(key: string): number {
    return this.generations.get(key) ?? 0
  }

  /**
   * Unbind one conversation and dispose the agent it held, so the next message
   * walks the ladder afresh — which is what makes a workspace switch take
   * effect. An adopted agent (another owner's) is unbound but left running:
   * whoever created it still owns taking it down.
   * @param key - the conversation key to release.
   * @returns whether a binding existed.
   */
  async release(key: string): Promise<boolean> {
    const bound = this.opened.get(key)
    const opening = this.opening.get(key)
    if (bound === undefined && opening === undefined) return false
    // The epoch advances SYNCHRONOUSLY, before any await: from this statement
    // on, every earlier walk is stale and will retry rather than hand out what
    // is being torn down here. Detaching the maps in the same breath means a
    // fresh acquire starts cleanly instead of joining a doomed walk.
    this.generations.set(key, this.generation(key) + 1)
    this.opened.delete(key)
    if (this.opening.get(key) === opening) this.opening.delete(key)
    if (bound !== undefined) {
      this.keys.delete(bound.handle.agent.session.id)
      if (bound.owned) {
        await bound.handle.dispose().catch((error: unknown) => {
          this.ladder.report(`lark-channel: disposing the released session for ${key} failed: ${failureDetail(error)}`)
        })
      }
    }
    // A detached walk cleans up its own product: bind() sees the moved epoch,
    // disposes what it made, and rejects as superseded. Waiting here is only
    // so a caller may treat "released" as "quiescent".
    if (opening !== undefined) await opening.then(() => undefined, () => undefined)
    return true
  }

  /**
   * Stop accepting new work and dispose every owned agent. The bindings are
   * dropped before the first await, so a second call disposes nothing twice.
   * @returns once every owned disposal has settled.
   * @throws {AggregateError} carrying every disposal rejection.
   */
  async close(): Promise<void> {
    this.closed = true
    const owned = [...this.opened.values()].filter(session => session.owned)
    this.opened.clear()
    this.keys.clear()
    this.opening.clear()
    this.generations.clear()
    const settled = await Promise.allSettled(owned.map(session => session.handle.dispose()))
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'lark-channel: session disposal failed')
  }

  /**
   * Walk the ladder for one key and publish the result under it.
   * @param key - the conversation key being bound.
   * @returns the bound session.
   * @throws {Error} when the ladder yielded nothing, or when the store closed
   * mid-walk — the disposal sweep has already run, so the agent it produced is
   * taken down here instead of outliving its owner.
   */
  /**
   * Walk the ladder for one key and publish the result — unless the world
   * moved while walking. A close or a release during the walk makes the
   * product stale; the walk owns its own product, so it disposes what it made
   * and rejects, rather than leaving that to whoever noticed later.
   * @param key - the conversation key being bound.
   * @param generation - the release epoch this walk belongs to.
   */
  private async bind(key: string, generation: number): Promise<OpenedSession> {
    const opened = await this.reach(key)
    if (this.opening.get(key) !== undefined && this.generation(key) === generation && !this.closed) {
      this.opening.delete(key)
      this.opened.set(key, opened)
      this.keys.set(opened.handle.agent.session.id, key)
      return opened
    }
    if (opened.owned) {
      await opened.handle.dispose().catch((error: unknown) => {
        this.ladder.report(`lark-channel: disposing the late session for ${key} failed: ${failureDetail(error)}`)
      })
    }
    if (this.closed) throw new Error(`lark-channel: sessions closed while opening ${key}`)
    throw new SupersededError(key)
  }

  /**
   * Reach the agent for one key: an already live one, else the stored session,
   * else a fresh one.
   * @param key - the conversation key.
   * @returns the first rung that yielded an agent, with its ownership.
   * @throws when creation — the last rung — also fails.
   */
  private async reach(key: string): Promise<OpenedSession> {
    const sessionId = this.idFor(key)
    const live = this.ladder.lookup(sessionId)
    // Whoever created a live agent still owns taking it down.
    if (live !== undefined) return { handle: live, owned: false }
    try {
      return { handle: await this.ladder.resume(sessionId), owned: true }
    } catch (error) {
      // The registry offers no existence probe, so a rejection is the only
      // signal that this conversation was never served here — and an unreadable
      // log looks exactly the same. Reporting it keeps a corrupt session log
      // from passing silently as first contact.
      this.ladder.report(
        `lark-channel: resuming session for ${key} failed, starting a new one: ${failureDetail(error)}`,
      )
    }
    return { handle: await this.ladder.create(sessionId), owned: true }
  }
}
