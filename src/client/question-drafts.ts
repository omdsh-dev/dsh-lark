/**
 * Session-surviving answer drafts for the question wizard this channel renders.
 *
 * The shipped composer keeps a request's in-progress answers in the Slot
 * registry's store seat, so a strict Session entry remount restores the same
 * request without exposing it to another one. This plugin cannot reuse that
 * seat (its store handle type lives in a package this channel does not
 * depend on), so it carries the same contract through its own registrant
 * face: one instance per `apply()`, handed to the panel through the
 * registration's `inject` compartment, disposed with the plugin. Drafts are
 * transient by definition — a plugin reload losing them matches the shipped
 * store's non-persisted semantics.
 *
 * One instance per `apply()` is NOT one instance per Session: the shipped seat
 * is instantiated per Session by the Slot registry, while this face is shared
 * by every conversation the assembled Client renders. Every member therefore
 * names the Session it acts on, and `prune` — whose whole job is dropping what
 * one Session no longer presents — can only see that Session's drafts. Keying
 * the entries by Session rather than trusting request keys to be globally
 * unique is what keeps one conversation's panel from deleting another's typed
 * answers.
 * @module dsh-lark-channel/client/question-drafts
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One in-progress answer, including an explicit skip. */
export interface QuestionDraftAnswer {
  /** Offered labels currently selected. */
  selected: string[]
  /** Human-authored alternative or additional answer. */
  custom: string
  /** Whether the user explicitly skipped this question. */
  skipped: boolean
}

/** Navigation and answer drafts for one pending request. */
export interface QuestionDraftProgress {
  /** Current question index. */
  index: number
  /** One draft per question, in request order. */
  drafts: QuestionDraftAnswer[]
  /**
   * Local indefinite-wait choice restored with the draft, on the shipped
   * store's terms: `waiting` re-applies the user's "take time" decision to a
   * remounted panel, and `editing` re-applies the frozen countdown a first
   * edit already engaged.
   */
  wait?: 'editing' | 'waiting'
}

/**
 * The draft reads and writes one wizard renders from.
 *
 * `read` returns a deep copy: the component owns its state and the registry
 * must never alias it. A stored progress whose shape no longer matches the
 * request (a different question count, or an index past the end after the
 * asker shrank the batch) reads as absent rather than restoring garbage.
 *
 * Every member is scoped by the Session whose panel asks: the registry is
 * shared by every conversation, so a request key alone would let one
 * conversation read or drop another's progress.
 */
export interface QuestionDraftsFace {
  /**
   * The stored progress for one request, when it matches the request's shape.
   * @param sessionId - the conversation whose panel is asking.
   * @param key - the request's render identity.
   * @param questionCount - how many questions the request currently carries.
   * @returns a copy of the stored progress, or undefined when none fits.
   */
  read(sessionId: SessionId, key: string, questionCount: number): QuestionDraftProgress | undefined
  /**
   * Store one request's progress.
   * @param sessionId - the conversation whose panel is writing.
   * @param key - the request's render identity.
   * @param progress - the progress to store; the registry takes ownership.
   */
  replace(sessionId: SessionId, key: string, progress: QuestionDraftProgress): void
  /**
   * Drop one request's progress, once it was answered or cancelled.
   * @param sessionId - the conversation whose panel is closing the request.
   * @param key - the request's render identity.
   */
  clear(sessionId: SessionId, key: string): void
  /**
   * Drop every stored progress a Session no longer presents. The live keys
   * come from the request object, which is the only party that knows which
   * sibling cards its Session still holds.
   * @param sessionId - the Session whose drafts are being reconciled.
   * @param keep - request keys of that Session that are still live.
   */
  prune(sessionId: SessionId, keep: readonly string[]): void
  /** Drop every stored progress. */
  dispose(): void
}

/**
 * Create the draft face one Client assembly's question panels share.
 * @returns a per-apply draft registry, keyed by Session.
 */
export function createQuestionDrafts(): QuestionDraftsFace {
  const stored = new Map<SessionId, Map<string, QuestionDraftProgress>>()

  /** The Session's own sub-map, created on first use. */
  const bucket = (sessionId: SessionId): Map<string, QuestionDraftProgress> => {
    const existing = stored.get(sessionId)
    if (existing !== undefined) return existing
    const created = new Map<string, QuestionDraftProgress>()
    stored.set(sessionId, created)
    return created
  }

  return {
    read(sessionId, key, questionCount) {
      const progress = stored.get(sessionId)?.get(key)
      if (progress === undefined || progress.drafts.length !== questionCount) return undefined
      return {
        index: Math.min(progress.index, questionCount - 1),
        drafts: progress.drafts.map(draft => ({ ...draft, selected: [...draft.selected] })),
        ...(progress.wait === undefined ? {} : { wait: progress.wait }),
      }
    },
    replace(sessionId, key, progress) {
      bucket(sessionId).set(key, progress)
    },
    clear(sessionId, key) {
      const own = stored.get(sessionId)
      if (own === undefined) return
      own.delete(key)
      // Emptied rather than kept at zero: a long-lived Client rendering many
      // conversations must not accumulate one entry per Session ever seen.
      if (own.size === 0) stored.delete(sessionId)
    },
    prune(sessionId, keep) {
      const own = stored.get(sessionId)
      if (own === undefined) return
      const live = new Set(keep)
      for (const key of [...own.keys()]) {
        if (!live.has(key)) own.delete(key)
      }
      if (own.size === 0) stored.delete(sessionId)
    },
    dispose() {
      stored.clear()
    },
  }
}
