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

import {
  questionCard as buildQuestionCard,
  settledQuestionCard as buildSettledQuestionCard,
} from './cards.ts'

/** Marks this plugin's question buttons apart from other card actions. */
export const QUESTION_ACTION = 'dsh-lark-channel/question'

/** How long a question waits for its human before the tool gives up. */
export const QUESTION_TIMEOUT_MS = 30 * 60 * 1000

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
  /** Labels the human chose; empty when they typed instead or declined. */
  readonly selected: string[]
  /** Free text the human typed, when they did. */
  readonly custom?: string
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
  outcome: { readonly answer?: string | undefined; readonly cancelled?: boolean },
): object {
  return buildSettledQuestionCard({
    question: question.question,
    header: question.header,
    answer: outcome.answer,
    cancelled: outcome.cancelled,
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
}

/** One question waiting for its human. */
interface Pending {
  readonly sessionId: string
  readonly chatId: string
  readonly question: AskedQuestion
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
  private counter = 0

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
  }): Promise<QuestionAnswer> {
    this.counter += 1
    const id = `q${this.counter}`
    let settle!: (answer: QuestionAnswer) => void
    const answered = new Promise<QuestionAnswer>((resolve) => { settle = resolve })
    const entry: Pending = {
      sessionId: input.sessionId,
      chatId: input.chatId,
      question: input.question,
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

    try {
      entry.messageId = await this.ports.send(input.chatId, questionCard(input.question, id))
      if (entry.settled) {
        // Settled while the card was in flight; paint what the platform just
        // rendered so no live buttons are left behind.
        void this.ports.update(entry.messageId, settledQuestionCard(input.question, { cancelled: true }))
      }
    } catch (error) {
      this.ports.report(`lark-channel: sending a question card failed: ${String(error)}`)
      this.finish(id, { id: input.question.id, selected: [] }, false)
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
   * @returns whether it settled a live question.
   */
  answerByClick(value: QuestionActionValue, chosen?: readonly string[]): object | undefined {
    const entry = this.pending.get(value.id)
    if (entry === undefined || entry.settled) return undefined
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
    const picked = [...new Set(chosen)]
      .map(index => options[Number(index)])
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
   * Settle one question exactly once and repaint its card.
   * @param repaint - false when the caller paints the card itself, which a
   * click does through its own response — the only repaint path that cannot
   * fail silently, since the patch API reports business errors in a body the
   * SDK discards rather than by rejecting.
   */
  private finish(id: string, answer: QuestionAnswer, cancelled: boolean, shown?: string, repaint = true): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined || entry.settled) return false
    entry.settled = true
    entry.settle(answer)
    if (repaint && entry.messageId !== undefined) {
      const card = settledQuestionCard(
        entry.question,
        cancelled ? { cancelled: true } : { answer: shown ?? '' },
      )
      void this.ports.update(entry.messageId, card).catch((error: unknown) => {
        this.ports.report(`lark-channel: repainting a settled question failed: ${String(error)}`)
      })
    }
    return true
  }
}

/**
 * The shadow tool definition, declared structurally like every other host
 * contract here so the package keeps building against two published packages
 * alone — the host's `defineTool` would drag its whole runtime closure into
 * this repository to construct one object.
 *
 * Both schemas are therefore written in their COMPILED form: real JSON Schema
 * with `required` as an array on each object. `defineTool` exists to perform
 * exactly that conversion from a per-property spec, and a definition written in
 * the spec form is rejected by the registry — which is the contract that
 * matters, and which validates this at registration.
 *
 * The schema mirrors the host's own `ask_user_question` so a model that learned
 * the tool from any other surface calls this one the same way. Arguments are
 * normalized rather than rejected: a question with a slightly-off shape is
 * still worth asking, where a schema error would just fail the turn.
 * @param ask - asks one question and resolves with its answer.
 * @returns the definition to register in an agent's scope.
 */
export function shadowQuestionTool(
  ask: (questions: readonly AskedQuestion[], agentSessionId: string | undefined) => Promise<QuestionAnswer[]>,
): object {
  return {
    name: 'ask_user_question',
    description:
      'Ask the user a concise question when you need confirmation, a choice, or missing information '
      + 'before proceeding. Each question needs a stable id that is echoed in the answer. Offer options '
      + 'when the choice is between known alternatives; the user may also answer in their own words.',
    parameters: {
      type: 'object',
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to ask the user before continuing.',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['id', 'question'],
            properties: {
              id: { type: 'string', description: 'Stable id for this question; echoed in the answer.' },
              question: { type: 'string', description: 'The specific question to ask.' },
              header: { type: 'string', description: 'Optional short heading.' },
              options: {
                type: 'array',
                description: 'Optional choices to show the user.',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  required: ['label'],
                  properties: {
                    label: { type: 'string', description: 'Short user-facing option label.' },
                    description: { type: 'string', description: 'One sentence on the tradeoff.' },
                  },
                },
              },
              multi_select: { type: 'boolean', description: 'Whether several options may be chosen.' },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answers'],
        properties: {
          answers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'selected'],
              properties: {
                id: { type: 'string' },
                selected: { type: 'array', items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: unknown): Promise<{ answers: QuestionAnswer[] }> {
      // Total by construction. Without `defineTool`'s validating wrapper this
      // body IS the validation, and a malformed call must degrade to asking
      // nothing rather than throwing inside the model's turn.
      const supplied = (args as { questions?: unknown } | null | undefined)?.questions
      const raw = (Array.isArray(supplied) ? supplied : []).filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      )
      const questions: AskedQuestion[] = raw.map(entry => ({
        id: String(entry.id ?? ''),
        question: String(entry.question ?? ''),
        ...typeof entry.header === 'string' ? { header: entry.header } : {},
        ...Array.isArray(entry.options)
          ? {
              options: entry.options
                .filter((option): option is Record<string, unknown> => typeof option === 'object' && option !== null)
                .map(option => ({
                  label: String(option.label ?? ''),
                  ...typeof option.description === 'string' ? { description: option.description } : {},
                })),
            }
          : {},
        ...typeof entry.multi_select === 'boolean' ? { multiSelect: entry.multi_select } : {},
      }))
      const sessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id
      return { answers: await ask(questions, sessionId) }
    },
  }
}
