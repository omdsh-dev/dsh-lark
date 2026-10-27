/**
 * The settled-question fold this channel's browser half reads off one
 * conversation's own event window.
 *
 * The blocking `ask_user_question` tool writes an ordinary `tool/call` and its
 * `tool/result` into the requesting session's log whatever answers it, and the
 * `userQuestions` projection deliberately tracks neither — it serves the opt-in
 * timed tool, whose calls are the only ones it can key by id. The window is
 * therefore the one channel both surfaces can read without either having to
 * reach the other, which is the same reason the approval half folds the audit
 * pair instead of waiting for a Host event.
 *
 * Every settled call is reported, each carrying the questions it asked and the
 * answers it recorded. Correlation belongs to the consumer, not here: a
 * blocking request carries no call id, so the batch's own questions are the
 * only identity a panel and a call can be matched by, and this fold exists to
 * hand both sides of that comparison over. Reporting only the newest call — the
 * rule this fold used to follow — cannot do it: a question answered while a
 * later one stands open is then invisible, and the panel left behind by it is
 * never retired.
 * @module dsh-lark-channel/client/question-decisions
 */

import type { SessionEventLikeEntry, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** The host tool whose calls and results this fold reads. */
const ASK_USER_QUESTION_TOOL = 'ask_user_question'

/** One answered question. */
export interface SettledQuestionAnswer {
  /** The answered question's own id, as the asker wrote it. */
  readonly id: string
  /** Labels the human chose; empty when they typed instead or skipped it. */
  readonly selected: readonly string[]
  /** Free text the human typed, when they did. */
  readonly custom?: string | undefined
}

/**
 * One question of a settled call, reduced to the facts that identify its batch.
 *
 * A panel holds the same questions — the Host handed it the request it parsed
 * from the same arguments — so a comparison over exactly these members is what
 * says whether a settled call and a presented request are the same ask. Ids
 * alone are not enough: a model writes them, and it reuses them across batches,
 * so an earlier batch's settlement would answer a later request that happens to
 * repeat them.
 */
export interface SettledQuestionSpec {
  /** The asker's own question id. */
  readonly id: string
  /** The question as it was asked. */
  readonly question: string
  /** Short heading the asker grouped it under, when it gave one. */
  readonly header?: string | undefined
  /** Option labels, in the order the asker offered them. */
  readonly optionLabels: readonly string[]
  /** Whether more than one option could be chosen. */
  readonly multiSelect: boolean
}

/** One settled question call, as the browser half needs to know it. */
export interface SettledQuestion {
  /** The `tool/call` identity this answer closes. */
  readonly callId: string
  /** The questions this call asked, in ask order. */
  readonly questions: readonly SettledQuestionSpec[]
  /** The answers the call settled with, one entry per question. */
  readonly answers: readonly SettledQuestionAnswer[]
}

/**
 * Fold one session's event window into every question call the log settled.
 *
 * The window is scanned in full on every read because it is an in-memory array,
 * and because a partial fold would have to track which calls were already
 * consumed — state that buys nothing for a few hundred entries. A call is
 * settled when its own result recorded a successful answer batch; the
 * identities this browser settled itself are excluded by the caller.
 * @param window - the conversation's current event window.
 * @param answeredHere - call identities this browser answered itself.
 * @returns settled calls in log order, oldest first.
 */
export function foldSettledQuestions(
  window: SessionEventWindow,
  answeredHere: ReadonlySet<string>,
): readonly SettledQuestion[] {
  const asked = new Map<string, readonly SettledQuestionSpec[]>()
  const settled: SettledQuestion[] = []
  for (const entry of window.entries) {
    const event = eventOf(entry)
    if (event === undefined) continue
    if (event.type === 'tool/call') {
      if (event.data.name !== ASK_USER_QUESTION_TOOL) continue
      asked.set(event.data.callId, questionsOf(event.data.arguments))
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = event.data.message.toolCallId
    const questions = asked.get(callId)
    // A result for a call this window does not hold is not a settlement it can
    // describe: without the questions there is nothing to match a panel against.
    if (questions === undefined || questions.length === 0) continue
    if (answeredHere.has(callId)) continue
    // A failed call answered nobody: there is no decision to show, and the
    // request it belonged to is the one the Host already gave up on.
    if (event.data.error !== undefined || event.data.message.isError === true) continue
    const answers = answersOf(event.data.message.content)
    if (answers === undefined) continue
    settled.push({ callId, questions, answers })
  }
  return settled
}

/**
 * The questions one logged `ask_user_question` call asked.
 *
 * Read structurally rather than through a schema: this runs in the browser
 * against arguments the Host wrote, and a call whose arguments do not parse is
 * a call no panel can be matched against — reported as asking nothing, which
 * settles nothing.
 * @param argumentsText - the call's arguments, as the log recorded them.
 * @returns the questions, empty when the arguments carry none this reader can use.
 */
function questionsOf(argumentsText: string): readonly SettledQuestionSpec[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch (error) {
    // Arguments that are not JSON carry no question this reader can name.
    void error
    return []
  }
  const questions = (parsed as { questions?: unknown } | null | undefined)?.questions
  if (!Array.isArray(questions)) return []
  return questions.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as {
      id?: unknown
      question?: unknown
      header?: unknown
      options?: unknown
      multi_select?: unknown
      multiSelect?: unknown
    }
    if (typeof record.id !== 'string' || typeof record.question !== 'string') return []
    const options = Array.isArray(record.options) ? record.options : []
    return [{
      id: record.id,
      question: record.question,
      ...typeof record.header === 'string' ? { header: record.header } : {},
      optionLabels: options.flatMap((option) => {
        if (typeof option !== 'object' || option === null) return []
        const label = (option as { label?: unknown }).label
        return typeof label === 'string' ? [label] : []
      }),
      // The blocking tool's schema spells the flag `multi_select`; the timed
      // one's arguments reach here as the Host parsed them.
      multiSelect: record.multi_select === true || record.multiSelect === true,
    }]
  })
}

/**
 * The answer batch one result text carries.
 *
 * Read structurally rather than through a schema: this runs in the browser
 * against a value the Host wrote, and a result that does not parse is simply a
 * result that answered nothing.
 * @param content - the result's model-facing content blocks.
 * @returns the answers, or undefined when the text carries none this reader can use.
 */
function answersOf(content: readonly { readonly type: string; readonly text?: string }[]): readonly SettledQuestionAnswer[] | undefined {
  const text = content.find(block => block.type === 'text')?.text
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // Text that is not an answer JSON carries no batch; the caller shows none.
    void error
    return undefined
  }
  const answers = (parsed as { answers?: unknown } | null | undefined)?.answers
  if (!Array.isArray(answers)) return undefined
  return answers.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as { id?: unknown; selected?: unknown; custom?: unknown }
    if (typeof record.id !== 'string') return []
    return [{
      id: record.id,
      selected: Array.isArray(record.selected) ? record.selected.map(String) : [],
      ...typeof record.custom === 'string' ? { custom: record.custom } : {},
    }]
  })
}

/** The durable Session event behind one window entry, or undefined for a transient frame. */
function eventOf(entry: SessionEventLikeEntry): SessionEvent | undefined {
  return entry.type === 'event' ? entry.event : undefined
}
