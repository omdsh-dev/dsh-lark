import { describe, expect, it, vi } from 'vitest'
import type { MarkdownStreamController, SendInput, SendOptions, SendResult } from '@larksuite/channel'
import type { HostSessionEvent } from '../src/host.ts'
import { createMessageRenderer, createStreamRenderer } from '../src/outbound.ts'
import type { OutboundPort } from '../src/outbound.ts'

/** The owned chat every renderer under test writes to. */
const CHAT = 'oc_chat_1'

/** One `send` call, with the reply options it carried. */
interface SentCall {
  readonly to: string
  readonly input: SendInput
  readonly opts: SendOptions | undefined
}

/** One streaming card, with the reply options fixed when it opened. */
interface OpenedCard {
  readonly to: string
  readonly opts: SendOptions | undefined
  /** The card's content as the controller applied the renderer's operations. */
  content: string
  /** Whether the producer returned, so the stream settled. */
  closed: boolean
}

/**
 * An in-memory {@link OutboundPort} recording every call's options argument, so
 * a test reads where output went instead of restating the call it just made.
 * @returns the port, its captured traffic, and the stream-rejection switch.
 */
function createCapturingPort() {
  const sends: SentCall[] = []
  const cards: OpenedCard[] = []
  /** `rejectStreams` refuses every card, as a deployment without card permissions would. */
  const state = { rejectStreams: false }
  let counter = 0

  const port: OutboundPort = {
    async send(to, input, opts): Promise<SendResult> {
      sends.push({ to, input, opts })
      counter += 1
      return { messageId: `om_sent_${counter}` }
    },
    async stream(to, input, opts): Promise<SendResult> {
      if (state.rejectStreams) throw new Error('stream rejected (fake)')
      counter += 1
      const card: OpenedCard = { to, opts, content: '', closed: false }
      cards.push(card)
      const controller: MarkdownStreamController = {
        messageId: `om_stream_${counter}`,
        async append(chunk: string) { card.content += chunk },
        async setContent(full: string) { card.content = full },
      }
      // The real SDK drives the producer to completion before resolving.
      await input.markdown(controller)
      card.closed = true
      return { messageId: controller.messageId }
    },
  }

  return { port, sends, cards, state }
}

/**
 * A plain-message renderer over a fresh capturing port.
 * @returns the renderer, its port's captured traffic, and the failure spy.
 */
function messageRenderer() {
  const captured = createCapturingPort()
  const onFailure = vi.fn<(error: unknown) => void>()
  return { ...captured, onFailure, renderer: createMessageRenderer(captured.port, CHAT, onFailure) }
}

/**
 * A streaming renderer over a fresh capturing port, configured as the shipped
 * defaults do.
 * @returns the renderer, its port's captured traffic, and the failure spy.
 */
function streamRenderer() {
  const captured = createCapturingPort()
  const onFailure = vi.fn<(error: unknown) => void>()
  const renderer = createStreamRenderer(captured.port, CHAT, {
    showProcess: true,
    presentCall: name => ({ title: name }),
    onFailure,
  })
  return { ...captured, onFailure, renderer }
}

/** The step boundary that warms one turn's card up. */
function stepStart(turn: number): HostSessionEvent {
  return { type: 'step/start', data: { turn, step: 1 } }
}

/** One raw text delta of `turn`. */
function delta(turn: number, text: string): HostSessionEvent {
  return { type: 'assistant/chunk', data: { turn, chunk: { type: 'text-delta', text } } }
}

/** One committed assistant step of `turn`. */
function committed(turn: number, text: string): HostSessionEvent {
  return { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } }
}

/** A turn that closed cleanly. */
function completed(turn: number): HostSessionEvent {
  return { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
}

/** A turn that closed with the error rendered as {@link FAILURE}. */
function failed(turn: number): HostSessionEvent {
  return { type: 'turn/end', data: { turn, reason: { kind: 'error', error: { code: 'E_MODEL', message: 'boom' } } } }
}

/** The failure line {@link failed} produces; pinned so aiming never rewords it. */
const FAILURE = '⚠️ 本轮任务失败 E_MODEL: boom'

describe('outbound reply targeting', () => {
  describe('plain-message renderer', () => {
    it('sends with no options while nothing is aimed', () => {
      const { renderer, sends } = messageRenderer()
      renderer.handle(committed(1, '你好'))
      renderer.handle(failed(1))

      expect(sends.map(call => call.to)).toStrictEqual([CHAT, CHAT])
      expect(sends.map(call => call.opts)).toStrictEqual([{ resolveMentionsInText: true }, { resolveMentionsInText: true }])
      expect(sends.map(call => call.input)).toStrictEqual([{ markdown: '你好' }, { text: FAILURE }])
    })

    it('replies to the aimed message on every send', () => {
      const { renderer, sends } = messageRenderer()
      renderer.aim({ messageId: 'om_trigger_1' })
      renderer.handle(committed(1, '第一步'))
      renderer.handle(committed(1, '第二步'))
      renderer.handle(failed(1))

      expect(sends).toHaveLength(3)
      // Outside a topic thread the flag is absent, not false.
      for (const call of sends) expect(call.opts).toStrictEqual({ resolveMentionsInText: true, replyTo: 'om_trigger_1' })
      expect(sends.map(call => call.input)).toStrictEqual([
        { markdown: '第一步' },
        { markdown: '第二步' },
        { text: FAILURE },
      ])
    })

    it('keeps a reply inside its topic thread', () => {
      const { renderer, sends } = messageRenderer()
      renderer.aim({ messageId: 'om_trigger_1', threadId: 'omt_thread_1' })
      renderer.handle(committed(1, '你好'))

      expect(sends[0]!.opts).toStrictEqual({ resolveMentionsInText: true, replyTo: 'om_trigger_1', replyInThread: true })
    })

    it('returns to plain chat sends once the target is cleared', () => {
      const { renderer, sends } = messageRenderer()
      renderer.aim({ messageId: 'om_trigger_1' })
      renderer.handle(committed(1, '有目标'))
      renderer.aim(undefined)
      renderer.handle(committed(2, '没目标'))

      expect(sends.map(call => call.opts)).toStrictEqual([{ resolveMentionsInText: true, replyTo: 'om_trigger_1' }, { resolveMentionsInText: true }])
      expect(sends.map(call => call.input)).toStrictEqual([{ markdown: '有目标' }, { markdown: '没目标' }])
    })
  })

  describe('streaming renderer', () => {
    it('opens the card with no options while nothing is aimed', async () => {
      const { renderer, cards, sends } = streamRenderer()
      renderer.handle(stepStart(1))
      renderer.handle(delta(1, '你好'))
      renderer.handle(committed(1, '你好'))
      renderer.handle(completed(1))
      await renderer.close()

      expect(cards).toHaveLength(1)
      expect(cards[0]!.to).toBe(CHAT)
      expect(cards[0]!.opts).toEqual({ resolveMentionsInText: true })
      expect(cards[0]!.content).toBe('你好')
      expect(cards[0]!.closed).toBe(true)
      expect(sends).toHaveLength(0)
    })

    it('opens the card aimed at the message that triggered the turn', async () => {
      const { renderer, cards } = streamRenderer()
      renderer.aim({ messageId: 'om_trigger_1' })
      renderer.handle(stepStart(1))
      renderer.handle(delta(1, '答案'))
      renderer.handle(completed(1))
      await renderer.close()

      expect(cards[0]!.opts).toStrictEqual({ resolveMentionsInText: true, replyTo: 'om_trigger_1' })
      expect(cards[0]!.content).toBe('答案')
    })

    it('keeps a streamed card inside its topic thread', async () => {
      const { renderer, cards } = streamRenderer()
      renderer.aim({ messageId: 'om_trigger_1', threadId: 'omt_thread_1' })
      renderer.handle(stepStart(1))
      renderer.handle(delta(1, '答案'))
      renderer.handle(completed(1))
      await renderer.close()

      expect(cards[0]!.opts).toStrictEqual({ resolveMentionsInText: true, replyTo: 'om_trigger_1', replyInThread: true })
    })

    it('aims the plain message reporting a turn that opened no card', () => {
      const { renderer, cards, sends } = streamRenderer()
      renderer.aim({ messageId: 'om_trigger_1', threadId: 'omt_thread_1' })
      renderer.handle(failed(1))

      expect(cards).toHaveLength(0)
      expect(sends).toHaveLength(1)
      expect(sends[0]!.input).toStrictEqual({ text: FAILURE })
      expect(sends[0]!.opts).toStrictEqual({ resolveMentionsInText: true, replyTo: 'om_trigger_1', replyInThread: true })
    })

    it('falls back to a plain message carrying the options its card opened with', async () => {
      const { renderer, cards, sends, state, onFailure } = streamRenderer()
      state.rejectStreams = true
      renderer.aim({ messageId: 'om_trigger_1', threadId: 'omt_thread_1' })
      renderer.handle(stepStart(1))
      renderer.handle(delta(1, '答案'))
      renderer.handle(committed(1, '答案'))
      // A later turn's target must not follow an already-open card's fallback.
      renderer.aim({ messageId: 'om_trigger_2' })
      renderer.handle(completed(1))
      await renderer.close()

      expect(cards).toHaveLength(0)
      expect(onFailure).toHaveBeenCalledTimes(1)
      expect(sends).toHaveLength(1)
      expect(sends[0]!.input).toStrictEqual({ markdown: '答案' })
      expect(sends[0]!.opts).toStrictEqual({ resolveMentionsInText: true, replyTo: 'om_trigger_1', replyInThread: true })
    })

    it('aims each turn without moving the card already streaming', async () => {
      const { renderer, cards } = streamRenderer()
      renderer.aim({ messageId: 'om_trigger_1' })
      renderer.handle(stepStart(1))
      renderer.handle(delta(1, 'first'))
      // The next turn's target arrives while this card streams.
      renderer.aim({ messageId: 'om_trigger_2' })
      renderer.handle(delta(1, ' half'))
      renderer.handle(completed(1))
      renderer.handle(stepStart(2))
      renderer.handle(delta(2, 'second'))
      renderer.handle(completed(2))
      renderer.aim(undefined)
      renderer.handle(stepStart(3))
      renderer.handle(delta(3, 'third'))
      renderer.handle(completed(3))
      await renderer.close()

      expect(cards.map(card => card.opts)).toStrictEqual([
        { resolveMentionsInText: true, replyTo: 'om_trigger_1' },
        { resolveMentionsInText: true, replyTo: 'om_trigger_2' },
        { resolveMentionsInText: true },
      ])
      expect(cards.map(card => card.content)).toStrictEqual(['first half', 'second', 'third'])
    })
  })
})
