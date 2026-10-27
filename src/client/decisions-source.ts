/**
 * Live settled-request reads for the conversations this channel drives.
 *
 * One source per session id, created on first use and kept for the page's
 * lifetime: a conversation the browser has open may settle a request at any
 * moment, and a source that is torn down between panels would have to replay
 * the window to answer the same question again. Keeping it obliges it to
 * re-follow the conversation's CURRENT generation on every attach: a Client
 * Session scope is retired and re-materialized when its retain count reaches
 * zero — leaving a conversation and returning builds a new Session, and with it
 * a new event source — so a fold still following the retired one would freeze at
 * its last value and silently stop reporting decisions.
 *
 * The skeleton — borrow the binding, follow its window, recompute, publish only
 * on change, remember what this page settled itself — is the same for every
 * domain this channel answers on two surfaces. What differs is only how the
 * window folds and what identifies one settled item, so those two are injected
 * through {@link SettledRead} and the rest is shared.
 *
 * Every consumer here is the TEMPORARY browser half of a two-surface request;
 * see the plugin entry for why the durable fix belongs in the gateway.
 * @module dsh-lark-channel/client/decisions-source
 */

import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { foldSettledElsewhere, type SettledApproval } from './decisions.ts'

/**
 * How one conversation's settled set is folded out of its own event window.
 *
 * `answeredHere` carries the identities this browser settled itself; a settled
 * request absent from it was settled by another surface, which is the only
 * thing any panel here acts on.
 */
export interface SettledRead<T> {
  /**
   * Fold one conversation's window.
   * @param window - the conversation's current event window.
   * @param answeredHere - identities this browser decided itself.
   * @returns settled requests this browser did not decide, in ask order.
   */
  read(window: SessionEventWindow, answeredHere: ReadonlySet<string>): readonly T[]
  /**
   * The identity one settled request is retired by.
   * @param item - a settled request from this read.
   * @returns the identity to record against, and to compare folds by.
   */
  identityOf(item: T): string
}

/**
 * Read-only source of the requests one conversation settled elsewhere.
 *
 * `markAnsweredHere` records a request this browser decided itself, so the
 * panel it just closed does not come back described as somebody else's
 * decision. It is deliberately process-local: the fact it records is about
 * this page's own presses, not about the session.
 */
export interface SettledSource<T> {
  /**
   * The most recent fold.
   * @returns settled requests this browser did not decide, in ask order.
   */
  getSnapshot(): readonly T[]
  /**
   * Observe fold changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void
  /**
   * Record one request identity this browser answered, retiring it from the fold.
   * @param requestId - the identity this browser decided.
   */
  markAnsweredHere(requestId: string): void
  /** Detach from the conversation's window. */
  dispose(): void
}

/**
 * Own the per-session reads for one Client assembly.
 *
 * A session whose binding is not currently materialized reads as empty rather
 * than retaining one: the panel only renders under a conversation the view
 * already holds, so by the time an answer is needed the binding exists. Reading
 * through `binding()` keeps this plugin out of the reference counts that decide
 * whether a conversation stays open.
 */
export class SettledSourceRegistry<T> {
  private readonly sources = new Map<string, SettledSource<T>>()

  /**
   * @param sessions - the Client Session object layer this registry reads through.
   * @param read - how one conversation's window folds, and what identifies an item.
   */
  constructor(
    private readonly sessions: ISessions,
    private readonly read: SettledRead<T>,
  ) {}

  /**
   * The settled-set source for one conversation, created on first use.
   * @param sessionId - Session identity whose window supplies the fold.
   * @returns the shared source for that session.
   */
  sourceFor(sessionId: SessionId): SettledSource<T> {
    const existing = this.sources.get(sessionId)
    if (existing !== undefined) return existing
    const created = new SessionSettled(this.sessions, sessionId, this.read)
    this.sources.set(sessionId, created)
    return created
  }

  /** Drop every source and its subscription. */
  dispose(): void {
    for (const source of this.sources.values()) source.dispose()
    this.sources.clear()
  }
}

/** The approval-settled registry, which is the generic skeleton over the approval fold. */
export class SettledApprovalsRegistry extends SettledSourceRegistry<SettledApproval> {
  /**
   * @param sessions - the Client Session object layer this registry reads through.
   */
  constructor(sessions: ISessions) {
    super(sessions, {
      read: foldSettledElsewhere,
      identityOf: approval => approval.id,
    })
  }
}

/** One session's fold, published on every window mutation it observes. */
class SessionSettled<T> implements SettledSource<T> {
  private readonly listeners = new Set<() => void>()
  private readonly answeredHere = new Set<string>()
  private read: readonly T[] = []
  private binding: SessionBinding | undefined
  private unsubscribe: (() => void) | undefined
  private released = false

  /**
   * @param sessions - Session object layer supplying the borrowed binding.
   * @param sessionId - conversation this source folds.
   * @param how - how that conversation's window folds.
   */
  constructor(
    private readonly sessions: ISessions,
    private readonly sessionId: SessionId,
    private readonly how: SettledRead<T>,
  ) {}

  /** @returns the most recent fold. */
  getSnapshot(): readonly T[] { return this.read }

  /**
   * Observe fold changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.attach()
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Retire one request this browser answered itself.
   * @param requestId - the identity this browser decided.
   */
  markAnsweredHere(requestId: string): void {
    if (this.answeredHere.has(requestId)) return
    this.answeredHere.add(requestId)
    // A press can land right after the conversation was replaced, so the
    // generation is re-resolved before folding: the new window is the one that
    // answers, not the retired one this source may still have been following.
    this.attach()
    this.republish(this.binding?.eventSource.getSnapshot())
  }

  /** Detach from the conversation's window. */
  dispose(): void {
    this.released = true
    this.detach()
    this.listeners.clear()
  }

  /**
   * Follow the conversation's current generation.
   *
   * The binding is re-resolved on every attach rather than captured on the
   * first one: a Client Session scope is retired and re-materialized when its
   * retain count reaches zero — leaving a conversation and returning builds a
   * new Session, and with it a new event source — and a fold that kept
   * following the retired one would freeze at its last value, silently ceasing
   * to report decisions. Re-following is safe because the fold re-scans the
   * whole window instead of consuming deltas, so nothing depends on having seen
   * every intermediate publication. A binding that is not materialized yet
   * leaves the fold empty; the next attach retries, which is exactly when a
   * panel exists and the conversation is therefore held.
   */
  private attach(): void {
    if (this.released) return
    const binding = this.sessions.binding(this.sessionId)
    if (binding === this.binding) return
    this.detach()
    this.binding = binding
    const source = binding?.eventSource
    if (source === undefined) {
      this.republish(undefined)
      return
    }
    this.republish(source.getSnapshot())
    this.unsubscribe = source.subscribe(() => { this.republish(source.getSnapshot()) })
  }

  /** Stop following the borrowed window, keeping the fold's own state. */
  private detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /**
   * Recompute the fold and publish only when it moved.
   * @param window - the followed window, or undefined while no generation is followed.
   */
  private republish(window: SessionEventWindow | undefined): void {
    if (this.released) return
    const next = window === undefined ? [] : this.how.read(window, this.answeredHere)
    if (sameSet(this.read, next, this.how.identityOf)) return
    this.read = next
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Whether two folds carry the same requests in the same order.
 * @param left - previous fold.
 * @param right - current fold.
 * @param identityOf - the identity to compare one item by.
 * @returns true when nothing a consumer can observe changed.
 */
function sameSet<T>(
  left: readonly T[],
  right: readonly T[],
  identityOf: (item: T) => string,
): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => {
    const other = right[index]
    return other !== undefined && identityOf(value) === identityOf(other)
  })
}
