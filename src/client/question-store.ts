/**
 * The live face one Lark question panel renders from.
 *
 * A chain entry's `select` is a pure function of the owner props, so it cannot
 * ask whether the request it just matched has already been answered. That
 * question needs a live read of the conversation's settled-question fold, so it
 * belongs behind the registration's `inject` face — the one channel through
 * which a registration hands live data to its own component.
 *
 * The panel this drives is the TEMPORARY half of a two-surface question; see the
 * plugin entry for why the durable fix belongs in the gateway.
 * @module dsh-lark-channel/client/question-store
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettledQuestion, SettledQuestionSpec } from './question-decisions.ts'
import type { QuestionDraftAnswer } from './question-drafts.ts'
import type { SettledSourceRegistry } from './decisions-source.ts'

/**
 * One choice a question offers, as the asker wrote it.
 *
 * Declared structurally like every other host contract here: the owning package
 * is not one this channel depends on, so the browser half describes the value it
 * reads rather than importing a second published package to name it.
 */
export interface QuestionOption {
  /** User-facing label the answer echoes back. */
  readonly label: string
  /** Optional extra context a capable UI renders beside the label. */
  readonly description?: string | undefined
}

/** One question of a request. */
export interface QuestionSpec {
  /** Stable asker-provided identity, echoed in the answer. */
  readonly id: string
  /** The question to display. */
  readonly question: string
  /** Optional short heading the asker grouped it under. */
  readonly header?: string | undefined
  /** Optional supporting detail kept out of the option labels. */
  readonly detail?: string | undefined
  /** Choices offered, when the asker named any. */
  readonly options?: readonly QuestionOption[] | undefined
  /** Whether more than one option may be selected. Defaults to single-select. */
  readonly multiSelect?: boolean | undefined
}

/** One answered question, in the shape the Host's tool returns. */
export interface QuestionAnswerItem {
  /** The answered question's own id. */
  readonly id: string
  /** Labels chosen; empty when the human typed instead or skipped it. */
  readonly selected: readonly string[]
  /** Free text the human typed, when they did. */
  readonly custom?: string | undefined
}

/** A complete answer batch, one entry per question asked. */
export interface QuestionAnswerBatch {
  /** The answers, in ask order. */
  readonly answers: readonly QuestionAnswerItem[]
}

/** One question request the panel is asked to present. */
export interface QuestionTarget {
  /** Conversation the request belongs to. */
  readonly sessionId: SessionId
  /** The request's own render identity, which a settlement is recorded against. */
  readonly key: string
  /** The questions to present, in ask order. */
  readonly questions: readonly QuestionSpec[]
}

/**
 * The reactive card state one mounted presentation reads.
 *
 * Mirrors the shipped card snapshot: the projection row's state, the
 * foreground wait presentation, the countdown when the request carried a
 * deadline, the channel a submission would use right now, and whether the card
 * has left the registry.
 */
export interface QuestionCardState {
  /** Mirrors the projection row; `open` until the projection says otherwise. */
  readonly state: 'open' | 'continued'
  /** User-visible foreground wait presentation. */
  readonly waitState: 'counting' | 'focused' | 'editing' | 'waiting' | 'continued'
  /** Foreground countdown, absent for a request that carried no deadline. */
  readonly countdown: { readonly remainingMs: number; readonly running: boolean } | undefined
  /** Channel a submission would use right now. */
  readonly channel: 'waterfall' | 'rpc' | 'none'
  /** Set once the card left the registry; the mounted composer clears its draft on this. */
  readonly closed: boolean
}

/**
 * The face this panel needs off the shipped pending request.
 *
 * Every member beyond `answer` is optional and declared structurally: the
 * published request is the shipped domain's own class instance, whose private
 * fields make only its own instances satisfy that type, so this channel
 * describes the members it reads rather than importing a second presentation
 * package to name them. A projection that one day carries fewer of them still
 * renders — with the corresponding affordance withdrawn rather than broken.
 */
export interface AnswerableQuestion {
  /**
   * Recorded answers of a call that already settled. Present only on a
   * read-only review card, which the tool call row builds from its own
   * transcript so a finished question can be read back in the panel that asked
   * it. Such a card has no answer channel and no countdown.
   */
  readonly review?: readonly QuestionAnswerItem[] | undefined
  /**
   * What closing the panel does. A card keyed by tool call stays reachable from
   * its tool call row, so closing only withdraws the panel (`hide`) and
   * persists nothing. A card the Host never named has no way back, so closing
   * it ends the request (`cancel`).
   */
  readonly dismissal?: 'hide' | 'cancel' | undefined
  /**
   * Draft keys that are still live in this Session, this card included.
   * @returns keys the draft registry must keep; everything else is stale.
   */
  liveKeys?(): readonly string[]
  /**
   * Read the stable current card state.
   *
   * This is the request object's own public observable face, and the source the
   * shipped renderer binds its `useQuestionCard` seat to; a replacement entry
   * cannot reach that seat, so it reads the same source directly.
   * @returns the current card state, stable between changes.
   */
  getSnapshot?(): QuestionCardState
  /**
   * Subscribe to card state changes.
   * @param listener - called after every published change.
   * @returns disposer removing the listener.
   */
  subscribe?(listener: () => void): () => void
  /**
   * Resolve the waiting Host request.
   * @param batch - the complete answer batch, one entry per question.
   * @returns completion once the batch was submitted.
   */
  answer(batch: QuestionAnswerBatch): Promise<void>
  /**
   * Close the panel: withdraw it from the composer seat, or end the request
   * when nothing could bring it back.
   * @returns completion once the panel was withdrawn or the request cancelled.
   */
  dismiss?(): Promise<void>
  /**
   * Stop this Client's countdown indefinitely; the request then waits like a
   * blocking question. The user's decision is remembered with the draft so a
   * remounted panel re-applies it.
   */
  takeTime?(): void
  /**
   * Keep the first edited draft answerable without a foreground deadline.
   */
  engage?(): void
  /**
   * Freeze a pristine countdown while the answer surface holds focus.
   */
  holdFocus?(): void
  /**
   * Resume a pristine countdown after the answer surface loses focus.
   */
  releaseFocus?(): void
}

/** Live settled-question reads for one panel. */
export interface QuestionFace {
  /**
   * Record one settled request this browser has retired.
   * @param sessionId - conversation whose fold reported the request.
   * @param requestId - the `tool/call` identity this browser settled.
   */
  markAnsweredHere(sessionId: SessionId, requestId: string): void
  /**
   * The conversation's settled questions as a bare observable.
   *
   * This is what the registration hands the renderer's `hooks` compartment, so
   * the component reads it through a framework-bound `use` hook instead of
   * subscribing itself. Identity is stable per session, which the hook cache
   * requires.
   * @param sessionId - conversation to follow.
   * @returns the observable the renderer binds.
   */
  settledSource(sessionId: SessionId): HostObservable<readonly SettledQuestion[]>
}

/**
 * Split the conventional recommendation suffix without changing the answer value.
 * @param label - Original option label returned if selected.
 * @returns Display label plus recommendation state.
 */
export function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

/**
 * The first option of a question, when the asker marked it recommended.
 *
 * The marked choice is an implicit draft, not an answer: it seeds the wizard so
 * a person who agrees only has to submit, and the shipped composer still waits
 * for that press.
 * @param question - the question whose options to inspect.
 * @returns the recommended first option's raw label, or undefined.
 */
export function recommendedFirstOption(question: QuestionSpec): string | undefined {
  const label = question.options?.[0]?.label
  return label !== undefined && parseRecommendedLabel(label).recommended ? label : undefined
}

/**
 * Build the answer batch one submission sends, on the shipped composer's
 * terms.
 *
 * The batch is one entry per question, in ask order. A skipped question
 * answers with an empty selection — the Host reads it as the user skipping.
 * A typed answer is how a person answers when no option fits, so on a
 * single-select question it REPLACES the selection (an option and typed text
 * together travel only on a multi-select, where "these labels, plus more
 * detail" is one answer). Building from the wizard's drafts rather than from
 * press-time arguments also retires the old race: a press only writes its
 * draft, and the batch is assembled when the user submits.
 * @param questions - the questions being answered, in ask order.
 * @param drafts - the wizard's drafts, one per question; a missing entry reads as unanswered.
 * @returns the batch to submit, one entry per question.
 */
export function answerBatchOf(
  questions: readonly QuestionSpec[],
  drafts: readonly QuestionDraftAnswer[],
): QuestionAnswerBatch {
  return {
    answers: questions.map((question, index) => {
      const draft = drafts[index] ?? { selected: [], custom: '', skipped: false }
      if (draft.skipped) return { id: question.id, selected: [] }
      const custom = draft.custom.trim()
      return {
        id: question.id,
        selected: custom === '' || question.multiSelect === true ? [...draft.selected] : [],
        ...(custom === '' ? {} : { custom }),
      }
    }),
  }
}

/**
 * Whether one settled call asked exactly the questions a panel presents.
 *
 * This is the correlation a blocking question has to use, because the request
 * carries no call id: the batch's own questions — how many, their ids, their
 * texts, their headings, their option labels in order, and whether more than
 * one could be chosen — are the only identity both sides share. Ids alone would
 * not do: a model writes them and reuses them across batches, so an earlier
 * batch's settlement would answer a later request that happens to repeat them,
 * which is the misdelivery this comparison exists to prevent.
 * @param settled - the questions one settled call asked, in ask order.
 * @param presented - the questions the panel presents, in ask order.
 * @returns whether the two are the same ask.
 */
export function sameQuestionBatch(
  settled: readonly SettledQuestionSpec[],
  presented: readonly QuestionSpec[],
): boolean {
  if (settled.length !== presented.length) return false
  return settled.every((question, index) => {
    const shown = presented[index]
    if (shown === undefined) return false
    if (question.id !== shown.id || question.question !== shown.question) return false
    if ((question.header ?? '') !== (shown.header ?? '')) return false
    if (question.multiSelect !== (shown.multiSelect === true)) return false
    const labels = (shown.options ?? []).map(option => option.label)
    return labels.length === question.optionLabels.length
      && labels.every((label, position) => label === question.optionLabels[position])
  })
}

/**
 * The settled call that answers the questions one panel presents, if the log
 * holds one.
 *
 * The newest match wins: the same batch asked twice can only be told apart by
 * the later call's own result being in the same window, because a settlement
 * this window does not hold cannot be considered at all — the window is a page
 * of the conversation, and a call that fell out of it is invisible here.
 * Nothing matched means nothing to retire — the panel then waits for a press
 * exactly as the shipped one does, which is the honest read of a log that does
 * not describe this request.
 * @param settled - settled calls from the conversation's window, oldest first.
 * @param presented - the questions the panel presents, in ask order.
 * @returns the matching settlement, or undefined when none answers this request.
 */
export function settledForQuestions(
  settled: readonly SettledQuestion[],
  presented: readonly QuestionSpec[],
): SettledQuestion | undefined {
  for (let index = settled.length - 1; index >= 0; index -= 1) {
    const candidate = settled[index]
    if (candidate !== undefined && sameQuestionBatch(candidate.questions, presented)) return candidate
  }
  return undefined
}

/** The settlement one panel retires without waiting for a press. */
export interface ElsewhereRetirement {
  /** The `tool/call` identity to record as settled by another surface. */
  readonly callId: string
  /** The batch the log recorded, which is what the card closes with. */
  readonly answers: readonly QuestionAnswerItem[]
}

/**
 * What one panel retires, given the log's settled calls and the request it
 * presents.
 *
 * A request the Client no longer presents needs nothing: the shipped class
 * rejects a second settlement, which is the expected outcome here rather than a
 * failure. A review card presents a call that already settled — its own
 * recorded answers ARE the settlement — so it retires nothing.
 * @param settled - settled calls from the conversation's window, oldest first.
 * @param presented - the questions the panel presents, in ask order.
 * @param pending - the request the Client currently presents, if any.
 * @returns the settlement to retire, or undefined when there is nothing to retire.
 */
export function retirementForQuestion(
  settled: readonly SettledQuestion[],
  presented: readonly QuestionSpec[],
  pending: AnswerableQuestion | undefined,
): ElsewhereRetirement | undefined {
  if (pending === undefined || pending.review !== undefined) return undefined
  const match = settledForQuestions(settled, presented)
  return match === undefined ? undefined : { callId: match.callId, answers: match.answers }
}

/**
 * Build the live face one panel renders from.
 * @param settled - the per-session settled-question reads.
 * @returns the face the panel settles through.
 */
export function createQuestionFace(settled: SettledSourceRegistry<SettledQuestion>): QuestionFace {
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
 * Narrow one Client pending interaction to the answerable question face.
 *
 * The parameter is structural rather than the merged union: the shipped request
 * is a class with private fields, so only its own instances satisfy that type,
 * and a caller reading the status snapshot has an opaque projected value. The
 * discriminator is `kind`, not `instanceof` — the shipped class is a
 * bundle-local value the browser half cannot import, and `kind` is the
 * domain-owned presentation tag the shared projection documents for exactly
 * this purpose. `plan-review` is excluded: this channel still reviews plans
 * through its own shadowed tool, so the shipped panel keeps that one.
 * @param pending - a pending interaction from the Client status snapshot.
 * @returns the answerable request, or undefined when it is not a question.
 */
export function asPendingQuestion(
  pending: { readonly kind: string } | undefined,
): AnswerableQuestion | undefined {
  if (pending === undefined || pending.kind !== 'question') return undefined
  // `answer` is called synchronously out of a click and key handler, so a
  // projection that omits it would throw past the caller's `.catch`.
  // Withdrawing the affordances is the honest read of a request this panel
  // cannot answer.
  const face = pending as { readonly answer?: unknown }
  if (typeof face.answer !== 'function') return undefined
  return pending as unknown as AnswerableQuestion
}

/**
 * The one submission a question panel admits at a time.
 *
 * Two activations can land in one batch — an option row's Enter plus the submit
 * button, or a key repeat — before a re-render disables either control, and the
 * second would send the same batch again. The shipped class rejects that
 * duplicate, and the rejection would surface to the user as a raw failure on an
 * answer that did land, so a mount admits one submission at a time.
 *
 * The guard also carries the one reason a submission is re-opened. A waterfall
 * answer the gateway dropped leaves the card open with its draft intact, and the
 * panel re-arms its controls so the same draft can go through again; re-arming
 * therefore RELEASES the guard and retires the token of whatever was in flight.
 * That retirement is what keeps the two apart: the superseded submission's
 * completion can neither clear the state of the submission that replaced it nor
 * block it, and a dropped answer that later rejects is not reported as the
 * failure of the retry.
 */
export interface SubmissionGuard {
  /**
   * Begin one submission.
   * @returns the token identifying it, or undefined when one is already in flight.
   */
  begin(): number | undefined
  /**
   * Release the guard for a re-armed panel, retiring whatever was in flight.
   */
  rearm(): void
  /**
   * Whether one submission still owns the guard.
   * @param token - the token {@link SubmissionGuard.begin} returned.
   * @returns true when no re-arm retired it.
   */
  owns(token: number): boolean
  /**
   * Release the guard for a submission that finished.
   * @param token - the token {@link SubmissionGuard.begin} returned.
   * @returns true when it still owned the guard, so its outcome is the one the
   * panel must report.
   */
  finish(token: number): boolean
}

/**
 * Create one panel mount's submission guard.
 * @returns the guard.
 */
export function createSubmissionGuard(): SubmissionGuard {
  let issued = 0
  let current: number | undefined
  return {
    begin() {
      if (current !== undefined) return undefined
      issued += 1
      current = issued
      return current
    },
    rearm() {
      current = undefined
    },
    owns(token) {
      return current === token
    },
    finish(token) {
      if (current !== token) return false
      current = undefined
      return true
    },
  }
}
