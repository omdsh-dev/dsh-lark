/**
 * The settled-approval fold this channel's browser half reads off one
 * conversation's own event window.
 *
 * `ApprovalService` appends an `approval/asked` / `approval/decided` pair to
 * the requesting session's log whatever answers it, so the window already
 * carries every decision that ever settled — including the ones the chat
 * answered. That makes the log the one channel both surfaces can read without
 * either having to reach the other, and it is why this plugin needs no new
 * Host-to-Client event: the browser already holds the evidence.
 *
 * The fold answers one question only: which approvals are settled, and which of
 * those this browser did NOT settle itself. An approval this browser answered
 * needs nothing; one it never answered is a request the chat (or another
 * browser) decided while this page was open, and its composer panel is a
 * leftover press that can no longer decide anything.
 * @module dsh-lark-channel/client/decisions
 */

import type { SessionEventLikeEntry, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Type-only: declaration-merges the approval/asked + approval/decided audit pair
// into SessionEventMap, which is what makes those events readable here at all.
import type {} from '@deepseek-ai/dsh-user-approval'

/** One approval the log settled, as the browser half needs to know it. */
export interface SettledApproval {
  /** The `approval/asked` request identity this decision closes. */
  readonly id: string
  /** The tool the question was about. */
  readonly toolName: string
  /** The exact tool call, when the asker named one. */
  readonly callId?: string
  /**
   * The decision the log recorded, when this panel could have submitted it.
   *
   * Carried so that closing this browser's own copy submits what was actually
   * decided rather than a value of this plugin's choosing: the log's outcome is
   * the fact, and a panel re-submitting `allowed-once` for a request somebody
   * rejected would be inventing a decision. Absent for the fail-closed outcomes
   * this panel has no button for (`cancelled`, `unavailable`), where the copy is
   * closed without submitting anything.
   */
  readonly outcome?: 'allowed-once' | 'rejected' | undefined
}

/**
 * Fold one session's event window into the approvals settled by somebody other
 * than this browser.
 *
 * `answeredHere` carries the request identities this browser submitted a
 * decision for; a settled request absent from it was settled elsewhere. The
 * window is scanned in full on every read because it is an in-memory array, and
 * because a partial fold would have to track which page arrivals were already
 * consumed — state that buys nothing for a few hundred entries.
 * @param window - the conversation's current event window.
 * @param answeredHere - request identities this browser answered itself.
 * @returns settled approvals this browser did not decide, in ask order.
 */
export function foldSettledElsewhere(
  window: SessionEventWindow,
  answeredHere: ReadonlySet<string>,
): readonly SettledApproval[] {
  const asked = new Map<string, SettledApproval>()
  const decided = new Map<string, unknown>()
  for (const entry of window.entries) {
    const event = eventOf(entry)
    if (event === undefined) continue
    if (event.type === 'approval/asked') {
      const data = event.data
      asked.set(data.id, {
        id: data.id,
        toolName: data.toolName,
        ...(data.callId === undefined ? {} : { callId: data.callId }),
      })
      continue
    }
    // Only a real decision counts. The log writes exactly one `approval/decided`
    // per ask, and every outcome it can carry — including the fail-closed
    // `'unavailable'` — means nobody is going to press that panel again. The
    // outcome itself rides along for the ones this panel can re-submit.
    if (event.type === 'approval/decided') decided.set(event.data.id, event.data.outcome)
  }
  const settled: SettledApproval[] = []
  for (const [id, approval] of asked) {
    const outcome = decided.get(id)
    if (outcome === undefined) continue
    if (answeredHere.has(id)) continue
    settled.push({ ...approval, ...submittableOutcome(outcome) })
  }
  return settled
}

/**
 * The log's outcome, when it is one this panel has a control for.
 * @param outcome - the recorded `approval/decided` outcome.
 * @returns the outcome to re-submit, or an empty object for the fail-closed rest.
 */
function submittableOutcome(outcome: unknown): { outcome?: 'allowed-once' | 'rejected' } {
  return outcome === 'allowed-once' || outcome === 'rejected' ? { outcome } : {}
}

/** The durable Session event behind one window entry, or undefined for a transient frame. */
function eventOf(entry: SessionEventLikeEntry): SessionEvent | undefined {
  return entry.type === 'event' ? entry.event : undefined
}
