/**
 * The thinking process as a native CoT message.
 *
 * Feishu carries an agent's process as its own message, driven by AG-UI events,
 * and renders it the way the platform's own agents look: reasoning streams into
 * a thinking area, each tool call gets an icon and a title, each result gets a
 * code block. That vocabulary lines up with the host's session events almost
 * one to one, so this renderer translates rather than draws — and the final
 * answer goes where the platform says it belongs, in an ordinary message.
 * @module dsh-lark-channel/cot
 */

import { formatTokenCount } from './format.ts'
import {
  assistantText,
  foldedTokenCount,
  isAssistantChunkEvent,
  isAssistantMessageEvent,
  isCompactionEndEvent,
  isCompactionStartEvent,
  isCompactionSummaryEvent,
  isStepStartEvent,
  isToolCallEvent,
  isToolResultEvent,
  isTurnEndEvent,
  toolResultText,
  turnErrorDetail,
} from './host.ts'
import { stripToolCallMarkup } from './outbound.ts'
import type { HostSessionEvent, OutboundRenderer, ReplyTarget, ToolPresentation } from './outbound.ts'

/** One AG-UI event, as the write API takes it. */
export interface CotEvent {
  readonly event_type: string
  /** The event's own fields, JSON-encoded; the API caps one at 4096 characters. */
  readonly content: string
  /** Milliseconds, as a string, used by the client to order events. */
  readonly timestamp: string
}

/** A created thinking process, addressed by both ids on every write. */
export interface CotHandle {
  readonly cotId: string
  readonly messageId: string
}

/** The CoT operations this renderer drives. */
export interface CotPort {
  /** Open a thinking process in one chat, optionally aimed at the message that asked. */
  createCot(chatId: string, options: { replyTo?: string; hidden: boolean }): Promise<CotHandle>
  /** Append events to one thinking process, in order. */
  writeCotEvents(handle: CotHandle, events: readonly CotEvent[]): Promise<void>
}

/** How many events one write call may carry, per the API's own bound. */
const MAX_EVENTS_PER_WRITE = 50

/** How long one event's JSON may be, per the API's own bound. */
const MAX_EVENT_CONTENT_CHARS = 4096

/**
 * Tool-call kinds the host reports, mapped to the platform's icon vocabulary.
 * A kind with no counterpart falls through to the platform default rather than
 * guessing at a shape the icon set does not carry.
 */
const TOOL_ICONS: Record<string, string> = {
  read: 'read',
  edit: 'write',
  delete: 'write',
  move: 'write',
  search: 'search',
  fetch: 'search',
  execute: 'bash',
}

/**
 * The last timestamp handed out, so the next one is strictly greater.
 *
 * The client ORDERS events by this value, and a run emits many within one
 * millisecond — a burst of reasoning deltas sharing a timestamp is free to be
 * reordered, which is how one sentence arrives interleaved with the next.
 */
let lastTimestamp = 0

/**
 * Encode one AG-UI event, bounding its payload and stamping it after every
 * event already handed out.
 * @param eventType - the AG-UI event name.
 * @param content - the event's own fields.
 * @returns the event ready to write.
 */
function cotEvent(eventType: string, content: object): CotEvent {
  const encoded = JSON.stringify(content)
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1)
  return {
    event_type: eventType,
    content: encoded.length <= MAX_EVENT_CONTENT_CHARS
      ? encoded
      // Dropping the payload would lose the event; a truncation marker keeps
      // its shape valid while saying that something was cut.
      : JSON.stringify({ ...content as Record<string, unknown>, truncated: true, delta: undefined }),
    timestamp: String(lastTimestamp),
  }
}

/** Bound a value a tool produced before it rides an event. */
function boundResult(text: string): string {
  const limit = 1500
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** Options for {@link createCotRenderer}. */
export interface CotRendererOptions {
  /** Whether the agent's reasoning and tool calls appear at all. */
  readonly showProcess: boolean
  /** Whether the platform hides the process once the run finishes. */
  readonly hidden: boolean
  /** The tool's own label and kind for one call. */
  readonly presentCall: ToolPresentation
  /** Report a handled failure to the operator. */
  readonly onFailure: (error: unknown) => void
  /** Renders the answer itself; the thinking process deliberately carries none. */
  readonly answer: OutboundRenderer
}

/** The thinking process of one turn, and the queue feeding it. */
interface LiveRun {
  readonly turn: number
  readonly opening: Promise<CotHandle | undefined>
  /** Events awaiting a write; drained in arrival order. */
  readonly pending: CotEvent[]
  /** Settles when the queue is idle, so disposal can wait for it. */
  draining: Promise<void>
  /** Whether a reasoning block is open, so its deltas append to one area. */
  reasoningOpen: boolean
  /** Whether the run was already closed by a terminal event. */
  finished: boolean
}

/** One compaction the host has opened and not yet closed. */
interface OpenBracket {
  readonly id: string
  /**
   * The owner named by this bracket's own `start`: a number for the automatic
   * kind, `null` for a manual `/compact`. Read from the `start` rather than the
   * `end` that closes it, even though both carry the field, because ownership is
   * what the host took its lock under — and if the two ever disagreed, the line
   * belongs in the turn that was open while history was being folded, not in
   * whatever turn happens to be open when the close lands.
   */
  readonly turn: number | null
  /** What the `summary` folded away, when the bracket summarized at all. */
  folded?: number | undefined
}

/** Whether a compaction is the automatic kind — the only kind with no other trace. */
function isAutomaticCompaction(turn: number | null): turn is number {
  return turn !== null
}

/**
 * What one closed compaction leaves in the process, or nothing when it has
 * nothing to say.
 *
 * The failure line deliberately carries no detail. `error` is the host's own
 * internal wording about its own transaction: a reader of the chat can neither
 * act on it nor place it, and it is a path for text nobody vetted to reach a
 * conversation. What the reader needs is the one bit that changes what they do
 * next — history was not folded, so the agent still remembers everything.
 * @param folded - the amount the bracket's summary reported, if any.
 * @param error - the failure the bracket's close reported, if any.
 * @returns the line, or `undefined` when the bracket stays silent.
 */
function compactionLine(folded: number | undefined, error: string | undefined): string | undefined {
  if (error !== undefined) return '上下文压缩失败'
  // No summary means nothing was folded: the transaction pruned its way back
  // under safe pressure and the conversation reads the same as before. Saying
  // "compacted" here would answer a question the reader never asked with a
  // claim that is not true of this bracket.
  if (folded === undefined) return undefined
  return `上下文已压缩 · 折叠 ${formatTokenCount(folded)}`
}

/**
 * Renderer that shows the process as a native CoT message and leaves the answer
 * to `answer`. Falling back is the caller's job: when {@link CotPort.createCot}
 * rejects, this renderer reports it and the turn still answers, because the
 * answer never depended on the thinking process existing.
 * @param port - the CoT operations.
 * @param chatId - the owned chat.
 * @param options - what to show, and where the answer goes.
 * @returns the renderer.
 */
export function createCotRenderer(
  port: CotPort,
  chatId: string,
  options: CotRendererOptions,
): OutboundRenderer {
  const { showProcess, hidden, presentCall, onFailure, answer } = options
  let live: LiveRun | undefined
  let aimed: ReplyTarget | undefined
  /**
   * The turn's latest committed text, held because only the LAST one is the
   * answer. An agent narrates between tool calls — "let me look at the packages
   * first" — and every one of those commits would otherwise become its own
   * chat message, which is a wall of replies to a single question. Held at the
   * renderer, not on a run: the answer does not depend on a process existing.
   */
  let held: { turn: number; event: HostSessionEvent } | undefined
  /**
   * The compaction bracket currently open, if one is. One slot rather than a
   * map: this renderer is per session, and a live unmatched `compaction/start`
   * IS the host's durable lock, so a session has at most one open bracket. The
   * slot needs no cleanup — a bracket whose `end` never arrives dies with the
   * renderer.
   */
  let bracket: OpenBracket | undefined
  const closing = new Set<Promise<void>>()

  /** Drain one run's queue, respecting the API's per-call event bound. */
  const drain = async (run: LiveRun): Promise<void> => {
    const handle = await run.opening
    if (handle === undefined) {
      run.pending.length = 0
      return
    }
    while (run.pending.length > 0) {
      const batch = run.pending.splice(0, MAX_EVENTS_PER_WRITE)
      await port.writeCotEvents(handle, batch).catch(onFailure)
    }
  }

  const enqueue = (run: LiveRun, ...events: CotEvent[]): void => {
    run.pending.push(...events)
    run.draining = run.draining.then(() => drain(run)).catch(onFailure)
  }

  /** The run for `turn`, opening one when the turn is new. */
  const ensure = (turn: number): LiveRun => {
    if (live !== undefined && live.turn === turn) return live
    if (live !== undefined) closeRun(live)
    const opening = port
      .createCot(chatId, { ...aimed === undefined ? {} : { replyTo: aimed.messageId }, hidden })
      .catch((error: unknown) => {
        // The process is presentation; the answer still arrives without it.
        onFailure(error)
        return undefined
      })
    live = {
      turn,
      opening,
      pending: [],
      draining: Promise.resolve(),
      reasoningOpen: false,
      finished: false,
    }
    enqueue(live, cotEvent('RUN_STARTED', { threadId: chatId, runId: `turn-${turn}` }))
    return live
  }

  /** Finish one run, closing whatever it left open. */
  const closeRun = (run: LiveRun, failure?: string): void => {
    if (run.finished) return
    run.finished = true
    if (run.reasoningOpen) {
      enqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId: `reasoning-${run.turn}` }))
      run.reasoningOpen = false
    }
    enqueue(run, failure === undefined
      ? cotEvent('RUN_FINISHED', { threadId: chatId, runId: `turn-${run.turn}`, status: 'done' })
      : cotEvent('RUN_ERROR', { message: failure, code: 'TURN_FAILED' }))
    const settled = run.draining
    closing.add(settled)
    void settled.finally(() => closing.delete(settled))
  }

  return {
    aim(target) {
      aimed = target
      answer.aim(target)
    },
    handle(event) {
      if (isAssistantMessageEvent(event)) {
        const text = stripToolCallMarkup(assistantText(event.data))
        if (text === '') return
        const superseded = held?.turn === event.data.turn ? held.event : undefined
        held = { turn: event.data.turn, event }
        // The text this one replaces was narration, not an answer: it belongs
        // in the process, where the platform shows it as the agent's own words.
        if (superseded === undefined || !showProcess || !isAssistantMessageEvent(superseded)) return
        const run = ensure(event.data.turn)
        const messageId = `text-${run.turn}-${run.pending.length}`
        enqueue(
          run,
          cotEvent('TEXT_MESSAGE_START', { messageId, role: 'assistant' }),
          cotEvent('TEXT_MESSAGE_CONTENT', {
            messageId,
            delta: stripToolCallMarkup(assistantText(superseded.data)),
          }),
          cotEvent('TEXT_MESSAGE_END', { messageId }),
        )
        return
      }
      // Failures reach the chat through the answer half.
      if (isTurnEndEvent(event)) answer.handle(event)

      if (isStepStartEvent(event)) {
        // With the process off, nothing here is ever shown — so no process is
        // opened either, and the chat carries answers alone.
        if (!showProcess) return
        // Opening the process here overlaps its round trip with the model's
        // time to first token. No STEP event is written: a step is one
        // iteration of the agent's own loop, and a reader who sees "step 1
        // … step 8" listed above the work learns nothing from the numbering
        // that the reasoning and tool calls do not already say.
        ensure(event.data.turn)
        return
      }
      if (isAssistantChunkEvent(event)) {
        const { chunk } = event.data
        // Only reasoning belongs here: the platform reserves this message for
        // the process, and the answer is sent as its own message.
        if (!showProcess || chunk.type !== 'reasoning-delta') return
        if (chunk.text === undefined || chunk.text === '') return
        const run = ensure(event.data.turn)
        const messageId = `reasoning-${run.turn}`
        if (!run.reasoningOpen) {
          run.reasoningOpen = true
          enqueue(run, cotEvent('REASONING_MESSAGE_START', { messageId, role: 'reasoning' }))
        }
        enqueue(run, cotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta: chunk.text }))
        return
      }
      if (isToolCallEvent(event)) {
        if (!showProcess) return
        const run = ensure(event.data.turn)
        const shown = presentCall(event.data.name, event.data.arguments)
        const toolCallId = event.data.callId
        if (run.reasoningOpen) {
          run.reasoningOpen = false
          enqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId: `reasoning-${run.turn}` }))
        }
        enqueue(
          run,
          cotEvent('TOOL_CALL_START', {
            toolCallId,
            icon: TOOL_ICONS[shown.kind ?? ''] ?? 'default',
            title: shown.title,
            toolCallName: event.data.name,
          }),
          cotEvent('TOOL_CALL_ARGS', { toolCallId, delta: event.data.arguments }),
          cotEvent('TOOL_CALL_END', { toolCallId }),
        )
        return
      }
      if (isToolResultEvent(event)) {
        if (!showProcess) return
        const { callId, text } = toolResultText(event.data)
        if (callId === undefined) return
        const run = ensure(event.data.turn)
        enqueue(run, cotEvent('TOOL_CALL_RESULT', {
          messageId: `result-${callId}`,
          toolCallId: callId,
          role: 'tool',
          // A command's output reads as output, not prose.
          content: { type: 'code', code: boundResult(text) },
          ...event.data.error === undefined ? {} : { error: event.data.error.code },
        }))
        return
      }
      if (isCompactionStartEvent(event)) {
        // With the process off there is nowhere to say this, so the bracket is
        // never opened and its `summary` and `end` find nothing to close.
        if (!showProcess) return
        // Assignment, not a guard against one already being open: the host can
        // deliberately leave a blocking orphan when a close fails, and the next
        // `start` is exactly where that orphan stops mattering.
        bracket = { id: event.data.compactionId, turn: event.data.turn }
        return
      }
      if (isCompactionSummaryEvent(event)) {
        if (bracket === undefined || bracket.id !== event.data.compactionId) return
        // Held rather than shown: the folded amount is reported here and the
        // verdict only on `end`, and a summary that landed before a failed
        // close changed nothing about the conversation.
        bracket.folded = foldedTokenCount(event.data)
        return
      }
      if (isCompactionEndEvent(event)) {
        if (bracket === undefined || bracket.id !== event.data.compactionId) return
        const { turn, folded } = bracket
        bracket = undefined
        // A manual `/compact` says nothing here: its command reply already
        // reported what it replaced, and that reply is in the chat.
        if (!isAutomaticCompaction(turn)) return
        const line = compactionLine(folded, event.data.error)
        if (line === undefined) return
        // The process opens here rather than waiting for `step/start`, because
        // compaction is appended in the pre-step waterfall and a first-step
        // compaction arrives before any step does. Opening at `step/start` was
        // only ever about overlapping the create round trip with the model's
        // time to first token; opening earlier overlaps more of it.
        //
        // STEP_STARTED because a compaction is what AG-UI calls a step: a phase
        // of a run that is neither a message nor a tool call. The neighbouring
        // vocabularies would both lie — TOOL_CALL_* claims the agent called a
        // tool it never called, and TEXT_MESSAGE_* already means "narration a
        // later commit replaced", so the agent would appear to have said this.
        //
        // Chinese alone. Everything outside a card is hard-coded Chinese here
        // (`failureLine`, `IDLE_TURN_NOTE`); only the status card is bilingual.
        // Two surfaces with two rules, not one surface being inconsistent.
        //
        // Accepted side effect: a compaction inside a turn that a pre-step gate
        // then rejects leaves a thinking process whose only content is this
        // line. `turn/end` still closes it, and the line is true.
        enqueue(ensure(turn), cotEvent('STEP_STARTED', { stepName: line }))
        return
      }
      if (isTurnEndEvent(event)) {
        // One message per turn: the text the turn ended on.
        if (held?.turn === event.data.turn) {
          answer.handle(held.event)
          held = undefined
        }
        if (live === undefined || live.turn !== event.data.turn) return
        const run = live
        live = undefined
        const detail = turnErrorDetail(event.data)
        closeRun(run, detail === '' ? undefined : detail)
      }
    },
    async close() {
      if (held !== undefined) {
        answer.handle(held.event)
        held = undefined
      }
      if (live !== undefined) {
        const run = live
        live = undefined
        closeRun(run)
      }
      await Promise.allSettled([...closing, answer.close()])
    },
  }
}
