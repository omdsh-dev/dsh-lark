import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

describe('the sequence a real turn actually emits', () => {
  // Replayed verbatim from a session log, because the order the host really
  // publishes in — `turn/start`, `step/start`, then `user/message` — is not the
  // order the other tests here were written against, and a renderer that only
  // works under the tidier one renders an empty card in production.
  it('renders reasoning, the tool call and its result into the thinking process', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: '看看 cursor 的 changelog' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const created = harness.agents.created[0]!
    const session = created.agent.session
    const consumed = created.agent.followup.mock.calls[0]![0]!.id
    const emit = (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }

    // Copied from a real session log: the order a turn is actually published
    // in, which is not the order the other tests here were written against.
    emit('turn/start', { turn: 55 })
    emit('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [] })
    emit('step/start', { turn: 55, step: 1 })
    emit('user/message', { id: consumed })
    emit('assistant/chunk', { turn: 55, step: 1, chunk: { type: 'block-start', index: 0 } })
    emit('assistant/chunk', { turn: 55, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '用户' } })
    emit('assistant/chunk', { turn: 55, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想看变更日志' } })
    emit('assistant/chunk', { turn: 55, step: 1, chunk: { type: 'block-end', index: 0 } })
    emit('tool/call', { turn: 55, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"curl -s x"}' })
    emit('tool/result', {
      turn: 55,
      step: 1,
      message: { source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }], isError: false }] },
    })
    emit('step/end', { turn: 55, step: 1 })
    emit('turn/end', { turn: 55, reason: { kind: 'completed' } })

    await vi.waitFor(() => {
      const types = harness.fake.cots[0]?.events.map((e) => e.type) ?? []
      expect(types).toContain('REASONING_MESSAGE_CONTENT')
      expect(types).toContain('TOOL_CALL_START')
      expect(types).toContain('TOOL_CALL_RESULT')
    })
    await harness.dispose()
  })
})
