import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

/** Every event written to the first thinking process, in order. */
function events(harness: Awaited<ReturnType<typeof mountChannel>>) {
  return harness.fake.cots[0]?.events ?? []
}

/** The content of the first event of one type. */
function contentOf(harness: Awaited<ReturnType<typeof mountChannel>>, type: string) {
  return events(harness).find((e) => e.type === type)?.content
}

describe('thinking process (CoT)', () => {
  /** Bind one chat and return an emitter for its session events. */
  async function chat(harness: Awaited<ReturnType<typeof mountChannel>>) {
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session
    // The host names the consumed message when the turn takes it up; that
    // claim — not message arrival — is what aims the turn's output.
    const consumed = harness.agents.created[0]!.agent.followup.mock.calls[0]![0]
    harness.ctx.emit('session/event', session, { type: 'user/message', data: { id: consumed.id } })
    return (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }
  }

  it('is the default output, opened per turn and aimed at the asking message', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })

    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
    const cot = harness.fake.cots[0]!
    expect(cot.chatId).toBe('oc_chat_1')
    // The process belongs to the message that asked for it.
    expect(cot.replyTo).toBe('om_in_1')
    await vi.waitFor(() => { expect(events(harness).map((e) => e.type)).toContain('RUN_STARTED') })
    // No STEP event for a plain step: a step is one iteration of the agent's
    // loop, and "step 1 … step 8" listed above the work tells a reader nothing
    // the reasoning and tool calls do not. The rule bans the NUMBERING, not the
    // event — meaningful phases do get one, which is how a compaction says it
    // happened (ADR 0014). This turn has no such phase, so it has no STEP.
    expect(events(harness).map((e) => e.type)).not.toContain('STEP_STARTED')
    await harness.dispose()
  })

  it('streams reasoning into the thinking area, not the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '先看目录' } })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '，再回答。' } })

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')).toHaveLength(2)
    })
    expect(events(harness).map((e) => e.type)).toContain('REASONING_MESSAGE_START')
    expect(contentOf(harness, 'REASONING_MESSAGE_CONTENT')).toMatchObject({ delta: '先看目录' })
    // Reasoning never becomes a chat message.
    expect(harness.fake.sent).toHaveLength(0)
    await harness.dispose()
  })

  it('stamps every event after the one before it', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    for (const delta of ['一', '二', '三', '四', '五', '六', '七', '八']) {
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: delta } })
    }

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')).toHaveLength(8)
    })
    // The client ORDERS by timestamp, and a burst shares a millisecond — equal
    // stamps are free to be reordered, which arrives as interleaved sentences.
    const stamps = harness.fake.cots[0]!.timestamps.map(Number)
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
    expect(new Set(stamps).size).toBe(stamps.length)
    await harness.dispose()
  })

  it('reports a tool call with the platform icon its kind maps to', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_START')).toBeDefined() })
    // With no presenter composed the label is the bare name and the icon the default.
    expect(contentOf(harness, 'TOOL_CALL_START')).toMatchObject({
      toolCallId: 'c1', toolCallName: 'bash', icon: 'default', title: 'bash',
    })
    const written = events(harness).map((e) => e.type)
    expect(written).toContain('TOOL_CALL_ARGS')
    expect(written).toContain('TOOL_CALL_END')
    expect(contentOf(harness, 'TOOL_CALL_ARGS')).toMatchObject({ delta: '{"command":"ls -la"}' })
    await harness.dispose()
  })

  it("renders a tool's output as a code block", async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/result', {
      turn: 1,
      message: {
        source: { callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'total 24' }] }],
      },
    })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_RESULT')).toBeDefined() })
    expect(contentOf(harness, 'TOOL_CALL_RESULT')).toMatchObject({
      toolCallId: 'c1', role: 'tool', content: { type: 'code', code: 'total 24' },
    })
    await harness.dispose()
  })

  it('sends the answer as an ordinary message, never into the process', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '想一下' } })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '你好！' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // The platform reserves the process for thinking; the answer is its own message.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '你好！')).toBe(true)
    })
    expect(events(harness).map((e) => e.type)).not.toContain('TEXT_MESSAGE_CONTENT')
    await harness.dispose()
  })

  it('answers a many-step turn once, with the narration in the process', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // An agentic turn narrates between tool calls: every one of these commits
    // used to become its own reply, which is a wall of them for one question.
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '先做整体探索。' }] } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '继续看核心文档。' }] } })
    emit('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '分析完成，结论如下。' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
    // The chat carries the text the turn ended on, once.
    expect((harness.fake.sent[0]!.input as { markdown: string }).markdown).toBe('分析完成，结论如下。')
    // The narration it replaced is in the process instead; writes are queued,
    // so this is where the queue has drained.
    await vi.waitFor(() => {
      const narration = events(harness)
        .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
        .map((e) => e.content.delta)
      expect(narration).toEqual(['先做整体探索。', '继续看核心文档。'])
    })
    await harness.dispose()
  })

  it('closes the run, ending an open thinking block first', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '想到一半' } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(events(harness).map((e) => e.type)).toContain('RUN_FINISHED') })
    const written = events(harness).map((e) => e.type)
    expect(written.indexOf('REASONING_MESSAGE_END')).toBeLessThan(written.indexOf('RUN_FINISHED'))
    expect(contentOf(harness, 'RUN_FINISHED')).toMatchObject({ status: 'done' })
    await harness.dispose()
  })

  it('marks a failed turn as a failed run', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    emit('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_MODEL', message: 'boom' } } })

    await vi.waitFor(() => { expect(contentOf(harness, 'RUN_ERROR')).toBeDefined() })
    expect(contentOf(harness, 'RUN_ERROR')).toMatchObject({ message: 'E_MODEL: boom' })
    // The chat is told too, by the answer half.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'text' in m.input && m.input.text.includes('E_MODEL'))).toBe(true)
    })
    await harness.dispose()
  })

  it('opens one process per turn', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    emit('step/start', { turn: 2, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(2) })
    await harness.dispose()
  })

  it('still answers when the platform refuses the process', async () => {
    const harness = await mountChannel()
    harness.fake.state.failCotCreate = true
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '想' } })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '答案' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // The answer never depended on the thinking process existing.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '答案')).toBe(true)
    })
    expect(harness.notices.some((line) => line.includes('outbound send failed'))).toBe(true)
    await harness.dispose()
  })

  it('asks the platform to drop the process when the run ends', async () => {
    const harness = await mountChannel({ hideProcessWhenDone: true })
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
    expect(harness.fake.cots[0]!.hidden).toBe(true)
    await harness.dispose()
  })

  it('opens no process at all when it is switched off', async () => {
    const harness = await mountChannel({ showProcess: false })
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '不该出现' } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '答案' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // The answer still arrives; an empty process would be worse than none.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '答案')).toBe(true)
    })
    expect(harness.fake.cots).toEqual([])
    await harness.dispose()
  })

  it('says a compaction happened, and how much history it folded away', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // Without this line the replacement of a session's history by a summary
    // leaves no trace anywhere in the chat, and "it forgot what we agreed on"
    // is indistinguishable from "it got dumber" — which is the whole point.
    emit('compaction/start', { compactionId: 'k1', turn: 1 })
    emit('compaction/summary', { compactionId: 'k1', shadowedTokenCount: 48200 })
    emit('compaction/end', { compactionId: 'k1', turn: 1 })

    await vi.waitFor(() => { expect(contentOf(harness, 'STEP_STARTED')).toBeDefined() })
    // The amount is held from the `summary` until the `end` says it counted:
    // it is reported on one event and the verdict only on the other.
    expect(contentOf(harness, 'STEP_STARTED')).toMatchObject({ stepName: '上下文已压缩 · 折叠 48.2k' })
    await harness.dispose()
  })

  it('reports a failed compaction without repeating the host error', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('compaction/start', { compactionId: 'k1', turn: 1 })
    emit('compaction/end', { compactionId: 'k1', turn: 1, error: 'summarizer HTTP 502 at provider/xyz' })

    await vi.waitFor(() => { expect(contentOf(harness, 'STEP_STARTED')).toBeDefined() })
    const { stepName } = contentOf(harness, 'STEP_STARTED') as { stepName: string }
    // Saying it failed is what changes the reader's next move — nothing was
    // folded, so the agent still remembers everything.
    expect(stepName).toBe('上下文压缩失败')
    // The host's own wording about its own transaction is not for this chat:
    // unreadable to whoever is in it, and a path for unvetted text to land in a
    // conversation.
    expect(stepName).not.toContain('502')
    expect(stepName).not.toContain('provider/xyz')
    await harness.dispose()
  })

  it('stays quiet about a manual compaction, which already reported itself', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // A `null` turn is a standalone `compactNow()` — a manual `/compact`, whose
    // command reply is already in the chat saying what it replaced. Saying it
    // twice in two voices reads as two compactions.
    emit('compaction/start', { compactionId: 'k1', turn: null })
    emit('compaction/summary', { compactionId: 'k1', shadowedTokenCount: 48200 })
    emit('compaction/end', { compactionId: 'k1', turn: null })
    emit('step/start', { turn: 1, step: 1 })

    // Asserted against a process that does exist, so the absence is a decision
    // and not just an empty transcript.
    await vi.waitFor(() => { expect(events(harness).map((e) => e.type)).toContain('RUN_STARTED') })
    expect(events(harness).map((e) => e.type)).not.toContain('STEP_STARTED')
    await harness.dispose()
  })

  it('stays quiet when a compaction only pruned and never summarized', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // Pruning back under safe pressure closes the bracket with no `summary`:
    // no history was folded, so "已压缩" would be a claim about this bracket
    // that is not true of it. The prune event itself must pass through without
    // being mistaken for one.
    emit('compaction/start', { compactionId: 'k1', turn: 1 })
    emit('compaction/prune', { shadowedRange: [1, 4], shadowedSeqs: [1, 2], shadowedTokenCount: 900 })
    emit('compaction/end', { compactionId: 'k1', turn: 1 })
    emit('step/start', { turn: 1, step: 1 })

    await vi.waitFor(() => { expect(events(harness).map((e) => e.type)).toContain('RUN_STARTED') })
    expect(events(harness).map((e) => e.type)).not.toContain('STEP_STARTED')
    // An unknown shape reaching the renderer must not throw: the bridge would
    // report it and the turn would carry a process that goes silent.
    expect(harness.notices.some((line) => line.includes('rendering'))).toBe(false)
    await harness.dispose()
  })

  it('treats an unusable folded amount as no amount at all', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // A negative or non-finite count is a number nobody can act on, and a line
    // reading `折叠 0` is the kind of lie an operator acts on anyway.
    emit('compaction/start', { compactionId: 'k1', turn: 1 })
    emit('compaction/summary', { compactionId: 'k1', shadowedTokenCount: -1 })
    emit('compaction/end', { compactionId: 'k1', turn: 1 })
    emit('compaction/start', { compactionId: 'k2', turn: 1 })
    emit('compaction/summary', { compactionId: 'k2', shadowedTokenCount: Number.NaN })
    emit('compaction/end', { compactionId: 'k2', turn: 1 })
    emit('step/start', { turn: 1, step: 1 })

    await vi.waitFor(() => { expect(events(harness).map((e) => e.type)).toContain('RUN_STARTED') })
    expect(events(harness).map((e) => e.type)).not.toContain('STEP_STARTED')
    await harness.dispose()
  })

  it('opens no process at all for a compaction when the process is switched off', async () => {
    const harness = await mountChannel({ showProcess: false })
    const emit = await chat(harness)
    emit('compaction/start', { compactionId: 'k1', turn: 1 })
    emit('compaction/summary', { compactionId: 'k1', shadowedTokenCount: 48200 })
    emit('compaction/end', { compactionId: 'k1', turn: 1 })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '答案' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // "I only want the answer" is a statement about the whole surface: a
    // process holding one compaction line is still a process nobody asked for.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '答案')).toBe(true)
    })
    expect(harness.fake.cots).toEqual([])
    await harness.dispose()
  })

  it('opens the process for a compaction that arrives before the first step', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // Compaction is appended in the pre-step waterfall, so a first-step
    // compaction lands before any `step/start`. The line has to open the
    // process itself — and the step that follows must reuse that same run,
    // or one turn would show up as two thinking processes.
    emit('compaction/start', { compactionId: 'k1', turn: 1 })
    emit('compaction/summary', { compactionId: 'k1', shadowedTokenCount: 12000 })
    emit('compaction/end', { compactionId: 'k1', turn: 1 })

    await vi.waitFor(() => { expect(contentOf(harness, 'STEP_STARTED')).toBeDefined() })
    emit('step/start', { turn: 1, step: 1 })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '继续想' } })

    await vi.waitFor(() => {
      expect(events(harness).map((e) => e.type)).toContain('REASONING_MESSAGE_CONTENT')
    })
    expect(harness.fake.cots).toHaveLength(1)
    expect(events(harness).filter((e) => e.type === 'RUN_STARTED')).toHaveLength(1)
    await harness.dispose()
  })
})
