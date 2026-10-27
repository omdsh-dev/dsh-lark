import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'
import type { AssistantStreamPayload } from '../src/host.ts'

/**
 * A session driven from another surface — the Web UI — and what this channel
 * does with it: live model output arrives as `agent/assistant-stream` frames
 * (the retired `assistant/chunk` is gone), and a browser-minted prompt is
 * mirrored into the chat without this channel's own input echoing back.
 */
describe('a session driven from another surface', () => {
  /** Bind one chat, aim its first turn, and return the session plus an emitter. */
  async function chat(harness: Awaited<ReturnType<typeof mountChannel>>) {
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const created = harness.agents.created[0]!
    const session = created.agent.session
    // The host names the consumed message when the turn takes it up; that
    // claim — not message arrival — is what aims the turn's output.
    const consumed = created.agent.followup.mock.calls[0]![0]
    harness.ctx.emit('session/event', session, { type: 'user/message', data: { id: consumed.id } })
    return {
      session,
      agent: created.agent,
      emit: (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) },
    }
  }

  /** One published frame, named for the agent whose session owns it. */
  function frame(
    agent: AssistantStreamPayload['agent'],
    value: AssistantStreamPayload['frame'],
  ): AssistantStreamPayload {
    return { agent, frame: value }
  }

  /**
   * Every markdown body this channel sent to a chat, in order.
   *
   * `SendInput` is a union of text, markdown, and card sends, so the body is
   * read only off the variants that carry one.
   */
  function sentMarkdown(harness: Awaited<ReturnType<typeof mountChannel>>): string[] {
    return harness.fake.sent
      .map(m => ('markdown' in m.input ? m.input.markdown : undefined))
      .filter((text): text is string => typeof text === 'string' && text !== '')
  }

  it('streams live output from agent/assistant-stream into the process', async () => {
    const harness = await mountChannel()
    const { agent, emit } = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })

    // A turn's live text arrives as a start frame naming the turn, then chunks.
    harness.ctx.emit('agent/assistant-stream', frame(agent, { type: 'start', attemptId: 'a1', turn: 1 }))
    for (const text of ['先看目录', '，再回答。']) {
      harness.ctx.emit('agent/assistant-stream', frame(agent, {
        type: 'chunk',
        attemptId: 'a1',
        chunk: { type: 'reasoning-delta', text },
      }))
    }

    await vi.waitFor(() => {
      const deltas = harness.fake.cots[0]!.events
        .filter(e => e.type === 'REASONING_MESSAGE_CONTENT')
        .map(e => e.content['delta'])
      expect(deltas).toEqual(['先看目录', '，再回答。'])
    })
  })

  it('drops a chunk whose attempt never announced its turn', async () => {
    const harness = await mountChannel()
    const { agent, emit } = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })

    // A process that attached mid-attempt sees chunks with no turn to file them
    // under; guessing one would put another turn's thinking in this process.
    harness.ctx.emit('agent/assistant-stream', frame(agent, {
      type: 'chunk',
      attemptId: 'never-started',
      chunk: { type: 'reasoning-delta', text: '不该出现' },
    }))
    await new Promise(resolve => setTimeout(resolve, 20))

    const deltas = harness.fake.cots[0]!.events.filter(e => e.type === 'REASONING_MESSAGE_CONTENT')
    expect(deltas).toEqual([])
  })

  it('mirrors a browser-minted prompt into the chat', async () => {
    const harness = await mountChannel()
    const { session } = await chat(harness)

    // `rpcId` is what a prompt minted by a browser client carries.
    harness.ctx.emit('session/event', session, {
      type: 'user/message',
      data: {
        id: 'om_web_1',
        source: { kind: 'user', rpcId: 'rpc_1' },
        content: [{ type: 'text', text: '在网页文本框里打的字' }],
      },
    })

    await vi.waitFor(() => {
      expect(sentMarkdown(harness)).toContain('在网页文本框里打的字')
    })
  })

  it('does not echo this channel\'s own input back to the chat', async () => {
    const harness = await mountChannel()
    const { session } = await chat(harness)

    // This channel's own follow-up carries no `rpcId`; echoing it would put the
    // person's line back in the chat they just typed it into — and a host
    // answerer that claimed the question would then see its own text again.
    harness.ctx.emit('session/event', session, {
      type: 'user/message',
      data: { id: 'om_chat_1', source: { kind: 'user' }, content: [{ type: 'text', text: '飞书里打的字' }] },
    })
    // The host's synthetic context (skill catalogs, job notices) carries none.
    harness.ctx.emit('session/event', session, {
      type: 'user/message',
      data: { id: 'om_ctx_1', source: { kind: 'plugin' }, content: [{ type: 'text', text: '技能目录' }] },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(sentMarkdown(harness)).not.toContain('飞书里打的字')
    expect(sentMarkdown(harness)).not.toContain('技能目录')
  })
})
