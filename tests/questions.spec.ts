import { describe, expect, it, vi } from 'vitest'
import {
  ChatQuestions,
  QUESTION_ACTION,
  questionActionValue,
  questionCard,
  shadowQuestionTool,
  SUBMIT_OPTION,
} from '../src/questions.ts'
import type { AskedQuestion, QuestionAnswer } from '../src/questions.ts'
import { assertRegistrableTool, assertSupportedSchema, cardControls, cardTexts } from './harness.ts'

/** One question with two options, as a model would ask it. */
const asked: AskedQuestion = {
  id: 'q-deploy',
  header: '部署确认',
  question: '要部署到生产环境吗？',
  options: [
    { label: '现在部署', description: '立刻上线' },
    { label: '先跑测试', description: '安全一些' },
  ],
}

/** A store over an in-memory transport, recording what it sent and repainted. */
function createStore() {
  const sent: { chatId: string; card: object }[] = []
  const updated: { messageId: string; card: object }[] = []
  const reports: string[] = []
  const store = new ChatQuestions({
    send: async (chatId, card) => {
      sent.push({ chatId, card })
      return `om_q_${sent.length}`
    },
    update: async (messageId, card) => { updated.push({ messageId, card }) },
    report: (line) => { reports.push(line) },
  })
  return { store, sent, updated, reports }
}

/** The option controls a rendered card carries, whatever shape they take. */
function buttonsOf(card: object): { id: string; option: number; label: string }[] {
  return cardControls(card).flatMap((control) => {
    const value = questionActionValue(control.value)
    return value === undefined ? [] : [{ id: value.id, option: value.option, label: control.label }]
  })
}

/** Every plain_text string a card renders, for containment checks. */
function textOf(card: object): string {
  return JSON.stringify(card)
}

describe('question action values', () => {
  it('accepts only its own well-formed payloads', () => {
    expect(questionActionValue({ kind: QUESTION_ACTION, id: 'q1', option: 0 }))
      .toEqual({ kind: QUESTION_ACTION, id: 'q1', option: 0 })
    expect(questionActionValue({ kind: 'other-plugin', id: 'q1', option: 0 })).toBeUndefined()
    expect(questionActionValue({ kind: QUESTION_ACTION, id: 'q1' })).toBeUndefined()
    expect(questionActionValue({ kind: QUESTION_ACTION, id: 'q1', option: 1.5 })).toBeUndefined()
    expect(questionActionValue(null)).toBeUndefined()
  })
})

describe('question card', () => {
  it('renders one button per option, carrying the correlation id', () => {
    const buttons = buttonsOf(questionCard(asked, 'q1'))
    expect(buttons).toEqual([
      { id: 'q1', option: 0, label: '现在部署' },
      { id: 'q1', option: 1, label: '先跑测试' },
    ])
  })

  it('keeps model-authored text out of markup elements', () => {
    const card = questionCard(
      {
        id: 'q',
        header: '**header**',
        question: '**not bold** <b>x</b>',
        options: [{ label: '<i>opt</i>', description: "<font color='red'>desc</font>" }],
      },
      'q1',
    )
    // Every model string rides plain_text, whichever layout the card chose for
    // it: the question, the header it wrote, and both halves of each option.
    for (const model of ['**header**', '**not bold** <b>x</b>', '<i>opt</i>', "<font color='red'>desc</font>"]) {
      const rendered = cardTexts(card).filter((text) => text.content.includes(model))
      expect(rendered.length).toBeGreaterThan(0)
      expect(rendered.every((text) => text.tag === 'plain_text')).toBe(true)
    }
  })

  it('invites a typed answer, and says so differently when there are no options', () => {
    expect(textOf(questionCard(asked, 'q1'))).toContain('选项都不合适时直接回复消息')
    expect(textOf(questionCard({ id: 'q', question: '叫什么名字？' }, 'q1'))).toContain('直接回复消息作答')
  })
})

describe('multiple choice', () => {
  /** One question the model marked as taking several answers. */
  const many: AskedQuestion = {
    id: 'q-scope',
    header: '选择范围',
    question: '这次重构覆盖哪些模块？',
    multiSelect: true,
    options: [
      { label: 'bridge', description: '消息与卡片' },
      { label: 'cards', description: '视觉层' },
      { label: 'session' },
    ],
  }

  it('submits a set instead of settling on the first press', () => {
    const card = questionCard(many, 'q1')
    const controls = cardControls(card)
    // One control, and it is the submit: a per-option press would settle a
    // question that may take three answers on the first of them.
    expect(controls).toHaveLength(1)
    expect(questionActionValue(controls[0]!.value)?.option).toBe(SUBMIT_OPTION)
    // Every option is offered by position, so what comes back is an index
    // into the question we asked rather than a string that made a round trip.
    expect(textOf(card)).toContain('"value":"2"')
    expect(cardTexts(card).map((text) => text.content)).toContain('bridge')
  })

  it('answers with every option the submission named', async () => {
    const { store, sent, updated } = createStore()
    const answer = store.ask({ sessionId: 's1', chatId: 'oc_1', question: many })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const submit = questionActionValue(cardControls(sent[0]!.card)[0]!.value)!

    const settled = store.answerByClick(submit, ['0', '2'])
    expect(await answer).toEqual({ id: 'q-scope', selected: ['bridge', 'session'] })
    expect(settled).toBeDefined()
    expect(textOf(settled!)).toContain('bridge、session')
    expect(updated).toHaveLength(0)
  })

  it('refuses a submission that named nothing, leaving the card live', async () => {
    const { store, sent } = createStore()
    const answer = store.ask({ sessionId: 's1', chatId: 'oc_1', question: many })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const submit = questionActionValue(cardControls(sent[0]!.card)[0]!.value)!

    expect(store.answerByClick(submit, [])).toBeUndefined()
    expect(store.answerByClick(submit, ['9'])).toBeUndefined()
    expect(store.awaiting('s1')).toBe(true)
    // Still answerable, by the same means as any other question.
    store.answerByText('s1', '全都要')
    expect(await answer).toEqual({ id: 'q-scope', selected: [], custom: '全都要' })
  })

  it('keeps a single-choice question on buttons', () => {
    const controls = cardControls(questionCard(asked, 'q1'))
    expect(controls.map((control) => questionActionValue(control.value)?.option)).toEqual([0, 1])
  })
})

describe('ChatQuestions', () => {
  it('answers by click, echoing the model\'s own question id', async () => {
    const { store, sent, updated } = createStore()
    const answer = store.ask({ sessionId: 's1', chatId: 'oc_1', question: asked })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(store.awaiting('s1')).toBe(true)

    const [, second] = buttonsOf(sent[0]!.card)
    const settled = store.answerByClick({ kind: QUESTION_ACTION, id: second!.id, option: second!.option })
    expect(await answer).toEqual({ id: 'q-deploy', selected: ['先跑测试'] })
    // The decided card comes BACK from the click, for the caller to return in
    // the callback response — the patch API's refusals are invisible, so a
    // click must not depend on it.
    expect(settled).toBeDefined()
    expect(textOf(settled!)).toContain('已作答')
    expect(cardTexts(settled!).some((text) => text.content === '先跑测试')).toBe(true)
    expect(updated).toHaveLength(0)
    expect(store.awaiting('s1')).toBe(false)
  })

  it('answers by typing, which is what a person does when no option fits', async () => {
    const { store, sent, updated } = createStore()
    const answer = store.ask({ sessionId: 's1', chatId: 'oc_1', question: asked })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })

    expect(store.answerByText('s1', '先部署到预发')).toBe(true)
    expect(await answer).toEqual({ id: 'q-deploy', selected: [], custom: '先部署到预发' })
    expect(textOf(updated[0]!.card)).toContain('先部署到预发')
  })

  it('routes a typed answer to its own session only', async () => {
    const { store, sent } = createStore()
    const answer = store.ask({ sessionId: 's1', chatId: 'oc_1', question: asked })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(store.answerByText('s2', 'not mine')).toBe(false)
    expect(store.awaiting('s1')).toBe(true)
    store.answerByText('s1', 'mine')
    await answer
  })

  it('settles exactly once: a second click or answer is refused', async () => {
    const { store, sent, updated } = createStore()
    const answer = store.ask({ sessionId: 's1', chatId: 'oc_1', question: asked })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const [first] = buttonsOf(sent[0]!.card)
    expect(store.answerByClick({ kind: QUESTION_ACTION, id: first!.id, option: 0 })).toBeDefined()
    expect(store.answerByClick({ kind: QUESTION_ACTION, id: first!.id, option: 1 })).toBeUndefined()
    expect(store.answerByText('s1', 'too late')).toBe(false)
    expect(await answer).toEqual({ id: 'q-deploy', selected: ['现在部署'] })
    // The click painted its own card, so no patch was attempted at all.
    expect(updated).toHaveLength(0)
  })

  it('a cancelled session answers empty and marks the card cancelled', async () => {
    const { store, sent, updated } = createStore()
    const answer = store.ask({ sessionId: 's1', chatId: 'oc_1', question: asked })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    store.cancelSession('s1')
    expect(await answer).toEqual({ id: 'q-deploy', selected: [] })
    expect(textOf(updated[0]!.card)).toContain('已取消')
  })

  it('an aborted turn withdraws the question rather than hanging it', async () => {
    const { store, sent } = createStore()
    const controller = new AbortController()
    const answer = store.ask({ sessionId: 's1', chatId: 'oc_1', question: asked, signal: controller.signal })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    controller.abort()
    expect(await answer).toEqual({ id: 'q-deploy', selected: [] })
  })

  it('an unanswered question times out instead of blocking the turn forever', async () => {
    const { store, reports } = createStore()
    const answer = await store.ask({ sessionId: 's1', chatId: 'oc_1', question: asked, timeoutMs: 5 })
    expect(answer).toEqual({ id: 'q-deploy', selected: [] })
    expect(reports.join('\n')).toContain('went unanswered')
  })

  it('a card that cannot be sent answers empty rather than stalling', async () => {
    const reports: string[] = []
    const store = new ChatQuestions({
      send: async () => { throw new Error('no permission') },
      update: async () => {},
      report: (line) => { reports.push(line) },
    })
    expect(await store.ask({ sessionId: 's1', chatId: 'oc_1', question: asked }))
      .toEqual({ id: 'q-deploy', selected: [] })
    expect(reports.join('\n')).toContain('sending a question card failed')
  })
})

describe('shadow tool definition', () => {
  it('declares schemas the registry accepts, in compiled form', () => {
    // Production rejected the first version of this definition: both schemas
    // were written in the per-property spec form that `defineTool` compiles,
    // while the registry validates real JSON Schema. Agent creation failed
    // outright, so the chat could not start at all.
    const definition = shadowQuestionTool(async () => []) as {
      name: string
      parameters: unknown
      output: { schema: unknown }
    }
    expect(() => { assertRegistrableTool(definition) }).not.toThrow()
    expect(definition.parameters).toMatchObject({ type: 'object', required: ['questions'] })
    expect(definition.output.schema).toMatchObject({ type: 'object', required: ['answers'] })
  })

  it('the checker that guards it rejects the exact shape that shipped', () => {
    // The spec form the host compiles — required as a per-property flag.
    expect(() => {
      assertSupportedSchema({
        type: 'object',
        properties: { answers: { type: 'array', required: true, items: { type: 'string' } } },
      })
    }).toThrow(/required must be an array/)
  })

  it('normalizes a malformed call rather than failing the turn', async () => {
    const definition = shadowQuestionTool(async () => []) as {
      execute(args: unknown, exec: unknown): Promise<{ answers: unknown[] }>
    }
    expect(await definition.execute({ questions: 'not-an-array' }, {})).toEqual({ answers: [] })
  })

  it('declares the host contract the registry validates', () => {
    const definition = shadowQuestionTool(async () => []) as {
      name: string
      description: string
      parameters: Record<string, unknown>
      output: { schema: object; render: (a: unknown, v: unknown) => unknown[] }
      execute: (args: unknown, exec: unknown) => Promise<unknown>
    }
    expect(definition.name).toBe('ask_user_question')
    expect((definition.parameters as { properties: Record<string, unknown> }).properties.questions).toBeDefined()
    expect(typeof definition.output.render).toBe('function')
    expect(definition.output.render({}, { answers: [] })).toEqual([{ type: 'text', text: '{"answers":[]}' }])
  })

  it('normalizes the model\'s arguments and carries the session through', async () => {
    const seen: { questions: readonly AskedQuestion[]; sessionId: string | undefined }[] = []
    const definition = shadowQuestionTool(async (questions, sessionId) => {
      seen.push({ questions, sessionId })
      return questions.map((question): QuestionAnswer => ({ id: question.id, selected: ['ok'] }))
    }) as { execute: (args: unknown, exec: unknown) => Promise<{ answers: QuestionAnswer[] }> }

    const result = await definition.execute(
      {
        questions: [{
          id: 'q1',
          question: '继续？',
          header: '确认',
          multi_select: true,
          options: [{ label: '是', description: '继续执行' }, { label: '否' }],
        }],
      },
      { agent: { session: { id: 'lark-oc_1' } } },
    )
    expect(result).toEqual({ answers: [{ id: 'q1', selected: ['ok'] }] })
    expect(seen[0]!.sessionId).toBe('lark-oc_1')
    expect(seen[0]!.questions[0]).toEqual({
      id: 'q1',
      question: '继续？',
      header: '确认',
      multiSelect: true,
      options: [{ label: '是', description: '继续执行' }, { label: '否' }],
    })
  })

  it('survives a call with no questions and no agent', async () => {
    const definition = shadowQuestionTool(async () => []) as {
      execute: (args: unknown, exec: unknown) => Promise<{ answers: QuestionAnswer[] }>
    }
    expect(await definition.execute({}, {})).toEqual({ answers: [] })
  })
})
