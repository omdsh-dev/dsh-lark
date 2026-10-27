/**
 * The live face one Lark approval panel renders from.
 *
 * A chain entry's `select` is a pure function of the owner props, so it cannot
 * ask whether the request it just matched has already been decided. That
 * question needs a live read of the conversation's settled-approval fold, so it
 * belongs behind the registration's `inject` face — the one channel through
 * which a registration hands live data to its own component.
 *
 * The Client's own pending-interaction status is NOT read here: the component
 * reaches it through the framework's `useSessionStatus` seat, which is the
 * sanctioned way for a render body to follow a standard source.
 *
 * The panel this drives is the TEMPORARY half of a two-surface approval; see
 * the plugin entry for why the durable fix belongs in the gateway.
 * @module dsh-lark-channel/client/panel-store
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApprovalPresentationRequest } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { SettledApproval } from './decisions.ts'
import type { SettledApprovalsRegistry } from './decisions-source.ts'

/**
 * The asker's localized presentation copy.
 *
 * Named through the shipped request type rather than the locale package's own
 * alias, which that package uses internally but does not export from its client
 * entry.
 */
export type DisplayReason = NonNullable<ApprovalPresentationRequest['displayReason']>

/** One approval the panel is asked to present. */
export interface PanelTarget {
  /** Conversation the request belongs to. */
  readonly sessionId: SessionId
  /**
   * The request's own render identity.
   *
   * Carried because the shipped panel publishes it as the panel's DOM key, and
   * other Client code — the conversation's Escape routing among it — recognizes
   * an approval surface by that attribute.
   */
  readonly key: string
  /** Tool the question is about. */
  readonly toolName: string
  /** The exact tool call, when the asker named one. */
  readonly callId?: string
  /** The asker's explanation of WHY it is asking, when it gave one. */
  readonly reason?: string
  /** Localized presentation copy for that explanation, when the asker supplied it. */
  readonly displayReason?: DisplayReason
}

/** The minimal answerable face this panel needs off the shipped pending request. */
export interface AnswerablePending {
  /** Whether the request can still accept a decision. */
  readonly answerable: boolean
  /**
   * Resolve the waiting Host request.
   * @param outcome - the interactive decision to submit.
   * @returns completion once the decision was submitted.
   */
  answer(outcome: 'allowed-once' | 'rejected'): Promise<void>
}

/**
 * Live settled-approval reads for one panel.
 *
 * The correlation is by tool call, falling back to the tool name when the asker
 * named no call: the shipped presentation exposes no request id, so the log's
 * own identity cannot be read off it. A call id is exact; a bare tool name is
 * the best available and is only reached when the asker gave no call.
 */
export interface PanelFace {
  /**
   * Record one settled request this browser has retired.
   * @param sessionId - conversation whose fold reported the request.
   * @param requestId - the `approval/asked` identity this browser settled.
   */
  markAnsweredHere(sessionId: SessionId, requestId: string): void
  /**
   * The conversation's settled approvals as a bare observable.
   *
   * This is what the registration hands the renderer's `hooks` compartment, so
   * the component reads it through a framework-bound `use` hook instead of
   * subscribing itself. Identity is stable per session, which the hook cache
   * requires.
   * @param sessionId - conversation to follow.
   * @returns the observable the renderer binds.
   */
  settledSource(sessionId: SessionId): HostObservable<readonly SettledApproval[]>
}

/**
 * The settled requests that answer one panel's question.
 *
 * The correlation is by tool CALL and never by tool name. An approval's own
 * identity is the call it is about, and the log records that call on both the
 * ask and the decision; a request whose asker named no call therefore has no
 * identity the log can tie a settlement to. Matching such a request by tool
 * name would find any older decision about the same tool and treat it as this
 * panel's answer — the panel would then say "decided elsewhere" over a request
 * nobody has answered, and retire it on the user's behalf. Answering nothing is
 * the honest read, and it leaves the panel waiting for a press exactly as the
 * shipped one does.
 * @param settled - the conversation's settled approvals.
 * @param target - the request the panel presents.
 * @returns matching settled approvals, empty when the request names no call.
 */
export function settledForTarget(
  settled: readonly SettledApproval[],
  target: PanelTarget,
): readonly SettledApproval[] {
  if (target.callId === undefined) return []
  return settled.filter(approval => approval.callId === target.callId)
}

/**
 * The log identities a panel should retire without waiting for a press.
 *
 * A panel retires nothing unless the conversation's fold answers its own
 * question AND the Client still presents an answerable request: a request
 * another surface settled in the same tick, or one the Client has already
 * withdrawn, needs no second settlement — the shipped class rejects it, and a
 * rejection there is the expected outcome rather than a failure.
 * @param settled - the settled requests matching this panel.
 * @param pending - the request the Client currently presents, if answerable.
 * @returns the identities to record, empty when there is nothing to retire.
 */
export function retirementFor(
  settled: readonly SettledApproval[],
  pending: AnswerablePending | undefined,
): readonly string[] {
  if (settled.length === 0) return []
  if (pending === undefined || !pending.answerable) return []
  return settled.map(approval => approval.id)
}

/**
 * Build the live face one panel renders from.
 * @param settled - the per-session settled-approval reads.
 * @returns the face the panel settles through.
 */
export function createPanelFace(settled: SettledApprovalsRegistry): PanelFace {
  return {
    markAnsweredHere(sessionId, requestId) {
      settled.sourceFor(sessionId).markAnsweredHere(requestId)
    },
    settledSource(sessionId) {
      return settled.sourceFor(sessionId)
    },
  }
}

/**
 * Narrow one Client pending interaction to the answerable approval face.
 *
 * The parameter is structural rather than the merged union: the shipped request
 * is a class with private fields, so only its own instances satisfy that type,
 * and a caller reading the status snapshot has an opaque projected value. The
 * discriminator is `kind`, not `instanceof` — the shipped class is a
 * bundle-local value the browser half cannot import, and `kind` is the
 * domain-owned presentation tag the shared projection documents for exactly
 * this purpose.
 * @param pending - a pending interaction from the Client status snapshot.
 * @returns the answerable request, or undefined when it is not an approval.
 */
export function asPendingApproval(
  pending: { readonly kind: string } | undefined,
): AnswerablePending | undefined {
  if (pending === undefined || pending.kind !== 'approval') return undefined
  // `answer` is called synchronously out of a click and key handler, so a
  // projection that omits it would throw past the caller's `.catch`, and
  // `answerable` is what the press guard tests, so a non-boolean would decide
  // from a value nobody defined. Withdrawing the affordances is the honest read
  // of a request this panel cannot answer.
  const face = pending as { readonly answer?: unknown; readonly answerable?: unknown }
  if (typeof face.answer !== 'function') return undefined
  if (typeof face.answerable !== 'boolean') return undefined
  return pending as unknown as AnswerablePending
}
