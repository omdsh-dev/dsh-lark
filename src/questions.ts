/**
 * Intent confirmation in the chat. When a model needs a decision before it can
 * continue, the host's `ask_user_question` reaches for `ctx.userQuestions` —
 * a seam that admits ONE provider per context, which a composed Web app claims
 * for its own clients. A chat agent asking through it would wait on a surface
 * its human is not watching, which is why this channel used to deny the tool
 * outright and tell the model to ask in prose instead.
 *
 * A prose question loses the structure: the options the model weighed, which
 * one the human picked, and the fact that an answer is due at all. So the tool
 * is SHADOWED instead — an agent-scoped registration of the same name, which
 * the host's layered registry resolves before the global one (its registry
 * reserves exactly one name from shadowing, and it is not this one). The
 * question becomes a card with the model's own options as buttons; a click
 * answers it, and so does an ordinary chat reply, because typing an answer is
 * what a person does when none of the buttons fit.
 * @module dsh-lark-channel/questions
 */

import { randomUUID } from 'node:crypto'
import {
  questionCard as buildQuestionCard,
  settledQuestionCard as buildSettledQuestionCard,
} from './cards.ts'

/** Marks this plugin's question buttons apart from other card actions. */
export const QUESTION_ACTION = 'dsh-lark-channel/question'

/** How long a question waits for its human before the tool gives up. */
export const QUESTION_TIMEOUT_MS = 30 * 60 * 1000

/**
 * One press of a question button, as the authorization check needs it.
 *
 * The chat is what makes a press this question's own: a card can be forwarded
 * and its payload travels with it, so nothing inside the payload can say where
 * the press happened.
 */
export interface QuestionClick {
  /** The chat the press arrived in. */
  readonly chatId: string
  /** Who pressed, when the callback named them. */
  readonly operatorId?: string | undefined
}

/** One choice the model offered. */
export interface QuestionOption {
  readonly label: string
  readonly description?: string | undefined
}

/** One question the model wants answered before it continues. */
export interface AskedQuestion {
  /** The model's own id, echoed back in the answer so it can pair them up. */
  readonly id: string
  readonly question: string
  readonly header?: string | undefined
  readonly options?: readonly QuestionOption[] | undefined
  readonly multiSelect?: boolean | undefined
}

/** One answer, in the shape the host's own tool returns. */
export interface QuestionAnswer {
  readonly id: string
  /**
   * Labels the human chose; empty when they typed instead or declined.
   *
   * Read-only because an answer that arrived from another surface is the host's
   * own value: this channel reads it into a card and hands it straight back, so
   * nothing here may write to it.
   */
  readonly selected: readonly string[]
  /** Free text the human typed, when they did. */
  readonly custom?: string | undefined
}

/**
 * One question batch as this channel tracks it while both surfaces are live.
 *
 * `decided` is set the instant the other surface claims the batch, so the loop
 * working through its questions can stop before it opens a card for a question
 * that has already been answered elsewhere.
 */
export interface ChatQuestionBatch {
  /** The conversation whose cards this batch owns. */
  readonly sessionId: string
  /**
   * The question ids this batch opened cards for.
   *
   * A batch is what a settlement belongs to. A model writes question ids and
   * reuses them across batches, so matching a settlement against every open
   * card of a conversation by id alone would settle an older batch's card with
   * a newer batch's answers; this set is the batch's own membership.
   */
  readonly questionIds: readonly string[]
  /** Whether another surface has already answered the batch. */
  decided: boolean
}

/** Card payload carried by one option choice, or by a submitted set of them. */
export interface QuestionActionValue {
  readonly kind: typeof QUESTION_ACTION
  /** Correlation id of the pending question, not the model's own id. */
  readonly id: string
  /**
   * Index into the question's options; -1 on the submit button of a multiple
   * choice, whose chosen set arrives in the action's form value instead.
   */
  readonly option: number
}

/** The index a submit button carries, having no single option of its own. */
export const SUBMIT_OPTION = -1

/**
 * Narrow one card action to a question choice.
 * @param value - the untrusted `action.value` from a card click.
 * @returns the parsed choice, or undefined when the click is not one.
 */
export function questionActionValue(value: unknown): QuestionActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== QUESTION_ACTION) return undefined
  if (typeof record.id !== 'string') return undefined
  if (typeof record.option !== 'number' || !Number.isInteger(record.option)) return undefined
  return { kind: QUESTION_ACTION, id: record.id, option: record.option }
}

/**
 * Build the card for one question. Every model-authored string rides a
 * `plain_text` element: a question and its options are untrusted text, and
 * card markup in them must render literally rather than disguise itself as
 * the card's own words.
 * @param question - the question to ask.
 * @param id - correlation id carried by every option button.
 * @returns a Feishu card object for `send({ card })`.
 */
export function questionCard(question: AskedQuestion, id: string): object {
  return buildQuestionCard({
    question: question.question,
    header: question.header,
    options: question.options ?? [],
    valueFor: index => ({ kind: QUESTION_ACTION, id, option: index } satisfies QuestionActionValue),
    ...question.multiSelect === true
      ? {
          multiSelect: true,
          submit: { kind: QUESTION_ACTION, id, option: SUBMIT_OPTION } satisfies QuestionActionValue,
        }
      : {},
  })
}

/**
 * Rewrite a settled question's card, so a chat scrolled back to later shows
 * what was decided rather than buttons that no longer do anything.
 * @param question - the question that was asked.
 * @param outcome - how it settled.
 * @returns a Feishu card object for `updateCard`.
 */
export function settledQuestionCard(
  question: AskedQuestion,
  outcome: {
    readonly answer?: string | undefined
    readonly cancelled?: boolean
    /** Whether another surface answered, so no press happened in this chat. */
    readonly elsewhere?: boolean | undefined
  },
): object {
  return buildSettledQuestionCard({
    question: question.question,
    header: question.header,
    answer: outcome.answer,
    cancelled: outcome.cancelled,
    ...outcome.elsewhere === true ? { elsewhere: true } : {},
  })
}

/** What the store needs from the transport, so tests need no Feishu. */
export interface QuestionPorts {
  /** Send one question card; resolves with the message it created. */
  send(chatId: string, card: object): Promise<string>
  /** Rewrite a settled question's card. */
  update(messageId: string, card: object): Promise<void>
  /** Operator console line. */
  report(line: string): void
  /**
   * Whether one press may settle a question that carries approver semantics.
   *
   * Asked only for the questions this store was told to gate
   * ({@link ChatQuestions.ask}'s `requiresApprover`), and answered by the same
   * rule an approval click faces: a question that releases a plan is an
   * escalation of sorts, and a deployment that named approvers has said who may
   * grant it. Absent means the deployment composes no such rule, and every press
   * the chat admits counts.
   * @param click - who pressed, and where.
   * @returns the refusal for the operator log, or undefined when the press counts.
   */
  refuseApprover?(click: QuestionClick): string | undefined
}

/** One question waiting for its human. */
interface Pending {
  readonly sessionId: string
  readonly chatId: string
  readonly question: AskedQuestion
  /**
   * Whether this question carries approver semantics.
   *
   * Read at press time, because the rule it names can only be answered by the
   * deployment: a plan review releases a plan the model then executes, which is
   * the one question here that grants something rather than merely informing.
   */
  readonly requiresApprover: boolean
  /**
   * The card this question is on, once a send named one.
   *
   * One id, because a send that rejects is the only way to get a second card —
   * and such a send never names the card it may have rendered. The retry's own
   * card is therefore the one this question knows, and it is repainted on every
   * settle. A first attempt that rendered a card and still rejected leaves one
   * card this store cannot name; the retry is still the right trade, because a
   * rare duplicate beats a question nobody was ever asked.
   */
  messageId?: string | undefined
  settled: boolean
  settle(answer: QuestionAnswer): void
}

/**
 * The questions this channel is waiting on, and the two ways they get
 * answered. One conversation asks one question at a time: the tool awaits each
 * before sending the next, so a chat never shows two open questions whose
 * replies could not be told apart.
 */
export class ChatQuestions {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly ports: QuestionPorts) {}

  /** Whether this session has a question waiting for a typed answer. */
  awaiting(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId && !entry.settled) return true
    }
    return false
  }

  /**
   * Ask one question and wait for the human.
   * @param input - the question, and where to ask it.
   * @returns the answer; an aborted or timed-out question answers empty.
   */
  async ask(input: {
    readonly sessionId: string
    readonly chatId: string
    readonly question: AskedQuestion
    readonly signal?: AbortSignal | undefined
    readonly timeoutMs?: number | undefined
    /**
     * Whether a press must also satisfy the deployment's approver rule.
     *
     * Set for the questions that grant something — the plan review releases the
     * plan the model then executes — so a deployment that narrowed who may
     * approve an escalation gets the same narrowing here. Ordinary questions
     * leave it off: they inform a decision the chat is already allowed to make.
     */
    readonly requiresApprover?: boolean | undefined
  }): Promise<QuestionAnswer> {
    // A turn that was already cancelled must not be asked: `AbortSignal` does
    // not replay for a listener added late, so without this the card would go
    // out, the tool would park for its whole timeout, and a press in that
    // window would decide a turn nobody is running. The sibling askers in
    // `bridge.ts` guard the same way, for the same reason.
    if (input.signal?.aborted === true) return { id: input.question.id, selected: [] }
    const id = `q-${randomUUID()}`
    let settle!: (answer: QuestionAnswer) => void
    const answered = new Promise<QuestionAnswer>((resolve) => { settle = resolve })
    const entry: Pending = {
      sessionId: input.sessionId,
      chatId: input.chatId,
      question: input.question,
      requiresApprover: input.requiresApprover === true,
      settled: false,
      settle,
    }
    // Registered before the send, so a click on a card the platform has
    // already rendered is never met with "that question is gone".
    this.pending.set(id, entry)

    const abort = (): void => { this.finish(id, { id: input.question.id, selected: [] }, true) }
    input.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => {
        this.ports.report(`lark-channel: question in ${input.chatId} went unanswered; continuing without it`)
        abort()
      },
      input.timeoutMs ?? QUESTION_TIMEOUT_MS,
    )
    timer.unref?.()

    /**
     * Send one card, remember it, and repaint it at once when the question
     * settled while the send was in flight.
     *
     * Shared by the first attempt and its retry: the retry used to skip this
     * repaint, so a question settled during a slow second send left a freshly
     * rendered card offering a press that could no longer decide anything.
     */
    const post = async (): Promise<void> => {
      const messageId = await this.ports.send(input.chatId, questionCard(input.question, id))
      entry.messageId = messageId
      if (!entry.settled) return
      // Settled while the card was in flight; paint what the platform just
      // rendered so no live buttons are left behind. Caught like the repaint in
      // `finish`: this runs off no caller's await, and an unhandled rejection
      // here is a process-level fault for one failed card.
      void this.ports.update(messageId, settledQuestionCard(input.question, { cancelled: true }))
        .catch((error: unknown) => {
          this.ports.report(`lark-channel: repainting a settled question failed: ${String(error)}`)
        })
    }

    try {
      await post()
    } catch (error) {
      // One retry, because a card send fails transiently far more often than it
      // fails permanently. A question that still cannot be delivered answers
      // empty — the host's answer shape carries no error channel, and putting
      // this channel's words into the human's answer would be worse than the
      // silence — so the operator gets the reason here, which is the only place
      // that can hold it.
      this.ports.report(`lark-channel: sending a question card failed, retrying once: ${String(error)}`)
      try {
        await post()
      } catch (retry: unknown) {
        this.ports.report(`lark-channel: sending a question card failed again, so no answer was asked for: ${String(retry)}`)
        this.finish(id, { id: input.question.id, selected: [] }, false)
      }
    }

    try {
      return await answered
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
      this.pending.delete(id)
    }
  }

  /**
   * Answer by clicking an option.
   * @param value - the parsed card action.
   * @param click - who pressed, and the chat the press arrived in.
   * @param chosen - option positions a form submission carried, when it did.
   * @returns whether it settled a live question.
   */
  answerByClick(value: QuestionActionValue, click: QuestionClick, chosen?: readonly string[]): object | undefined {
    const entry = this.pending.get(value.id)
    if (entry === undefined || entry.settled) return undefined
    // The press has to arrive in the chat the card was published to. A card can
    // be forwarded and its payload travels with it, so the chat is the one
    // check a forwarded press cannot satisfy — and without it a press in another
    // room would answer a question this room was asked.
    if (click.chatId !== entry.chatId) {
      this.ports.report(
        `lark-channel: ignored a question click from chat ${click.chatId}; the card was published to ${entry.chatId}`,
      )
      return undefined
    }
    // A question that grants something also faces the deployment's approver
    // rule, which is the same narrowing an approval click meets. Asked here
    // rather than at the dispatch site because the chat check above is the only
    // other thing this press has to satisfy, and both belong to the store that
    // owns the pending entry.
    if (entry.requiresApprover) {
      const refusal = this.ports.refuseApprover?.(click)
      if (refusal !== undefined) {
        this.ports.report(`lark-channel: rejected a question click: ${refusal}`)
        return undefined
      }
    }
    if (value.option === SUBMIT_OPTION) return this.answerBySubmission(value.id, entry, chosen ?? [])
    const option = (entry.question.options ?? [])[value.option]
    if (option === undefined) return undefined
    const question = entry.question
    if (!this.finish(value.id, { id: question.id, selected: [option.label] }, false, option.label, false)) {
      return undefined
    }
    // The settled card goes back in the click's own response: the platform
    // repaints it from that, immediately, with no second API call to fail.
    return settledQuestionCard(question, { answer: option.label })
  }

  /**
   * Settle a multiple choice from what its form submitted.
   *
   * The submission carries positions rather than labels, so an empty or
   * unreadable set is a submission that named nothing this question offered —
   * refused rather than answered, leaving the card live for another try.
   * @param id - the pending question's correlation id.
   * @param entry - the question awaiting an answer.
   * @param chosen - option indices, as the form returned them.
   * @returns the settled card to paint, or undefined when nothing was chosen.
   */
  private answerBySubmission(id: string, entry: Pending, chosen: readonly string[]): object | undefined {
    const options = entry.question.options ?? []
    // Read as positions and only as positions: `Number('')` is 0 and
    // `Number('0x1')` is 1, so a non-canonical entry would otherwise select the
    // FIRST option — the approve label, on a plan card — while this method's
    // contract says an unreadable submission is refused rather than answered.
    const positions = chosen
      .map(position => (/^(?:0|[1-9][0-9]*)$/.test(position) ? Number(position) : Number.NaN))
      .filter(position => Number.isSafeInteger(position))
    const picked = [...new Set(positions)]
      .map(position => options[position])
      .filter((option): option is QuestionOption => option !== undefined)
      .map(option => option.label)
    if (picked.length === 0) return undefined
    const shown = picked.join('、')
    if (!this.finish(id, { id: entry.question.id, selected: picked }, false, shown, false)) return undefined
    return settledQuestionCard(entry.question, { answer: shown })
  }

  /**
   * Answer with typed text — what a person does when no button fits.
   * @param sessionId - the conversation's session.
   * @param text - exactly what they wrote.
   * @returns whether it settled a live question.
   */
  answerByText(sessionId: string, text: string): boolean {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId || entry.settled) continue
      return this.finish(id, { id: entry.question.id, selected: [], custom: text }, false, text)
    }
    return false
  }

  /**
   * Withdraw every question of one session — its agent is going away, so
   * nothing is left waiting on a card nobody will answer.
   * @param sessionId - the conversation's session.
   */
  cancelSession(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId === sessionId && !entry.settled) {
        this.finish(id, { id: entry.question.id, selected: [] }, true)
      }
    }
  }

  /**
   * Retire this chat's cards for one batch because another surface answered it.
   *
   * The same question is offered in the chat and on whatever surface the host
   * asks besides it — the Web app's panel, in the deployment this was built for
   * — and the first answer is the one the tool receives. When the other one
   * wins, the card left here can no longer decide anything, so it is settled
   * into the answer that actually arrived rather than left inviting a press that
   * would be discarded.
   *
   * `run.decided` is set FIRST: the batch loop shares this object and must stop
   * before it opens a card for a question the other surface has already
   * answered. A batch claimed mid-flight therefore has fewer cards than
   * questions, which is correct — the remaining ones were never shown.
   *
   * Only this batch's own cards are touched: membership is the ids the batch
   * opened, not every card the conversation happens to hold. A model reuses
   * question ids, so matching a settlement against the conversation at large
   * would settle an older batch's card with this batch's answers.
   * @param run - the batch being offered, marked decided by this call.
   * @param answers - the answers the other surface gave, by question id.
   */
  settleElsewhere(run: ChatQuestionBatch, answers: readonly QuestionAnswer[]): void {
    run.decided = true
    const own = new Set(run.questionIds)
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== run.sessionId || entry.settled) continue
      // Only the cards THIS batch opened. Another batch's card in the same
      // conversation is a different request, and closing it here would paint
      // answers nobody gave it onto a question that is still waiting.
      if (!own.has(entry.question.id)) continue
      const settled = answers.find(candidate => candidate.id === entry.question.id)
        ?? { id: entry.question.id, selected: [] }
      this.finish(id, settled, false, shownAnswer(settled), true, true)
    }
  }

  /**
   * Settle one question exactly once and repaint its card.
   * @param repaint - false when the caller paints the card itself, which a
   * click does through its own response — the only repaint path that cannot
   * fail silently, since the patch API reports business errors in a body the
   * SDK discards rather than by rejecting.
   * @param elsewhere - whether another surface gave this answer, so the card
   * names where it came from instead of implying a press happened here.
   */
  private finish(
    id: string,
    answer: QuestionAnswer,
    cancelled: boolean,
    shown?: string,
    repaint = true,
    elsewhere = false,
  ): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined || entry.settled) return false
    entry.settled = true
    entry.settle(answer)
    if (repaint && entry.messageId !== undefined) {
      const card = settledQuestionCard(
        entry.question,
        cancelled
          ? { cancelled: true }
          : { answer: shown ?? '', ...elsewhere ? { elsewhere: true } : {} },
      )
      void this.ports.update(entry.messageId, card).catch((error: unknown) => {
        this.ports.report(`lark-channel: repainting a settled question failed: ${String(error)}`)
      })
    }
    return true
  }
}

/**
 * How one settled answer reads on its card.
 * @param answer - the answer that arrived.
 * @returns the labels joined for display, or the typed text when it chose none.
 */
function shownAnswer(answer: QuestionAnswer): string {
  return answer.selected.length > 0 ? answer.selected.join('、') : answer.custom ?? ''
}
