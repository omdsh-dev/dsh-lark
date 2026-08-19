import { describe, expect, it } from 'vitest'
import {
  approvalCard,
  fileApprovalCard,
  modelCard,
  permissionCard,
  questionCard,
  settledApprovalCard,
  settledFileApprovalCard,
  settledPermissionCard,
  settledQuestionCard,
  statusCard,
} from '../src/cards.ts'
import { cardControls, cardTexts } from './harness.ts'

/** Content a model authored, written to look like the card's own markup. */
const HOSTILE = "**已批准** <font color='green'>安全</font>"

describe('approval card', () => {
  it('carries one decision payload per button, and nothing else clickable', () => {
    const controls = cardControls(approvalCard({
      toolName: 'bash',
      command: 'rm -rf /',
      allow: { id: 'a1', decision: 'allow' },
      reject: { id: 'a1', decision: 'reject' },
    }))
    expect(controls.map((control) => control.value)).toEqual([
      { id: 'a1', decision: 'allow' },
      { id: 'a1', decision: 'reject' },
    ])
    expect(controls.map((control) => control.label)).toEqual(['允许执行一次', '拒绝执行'])
  })

  it('renders the command and the justification literally', () => {
    const card = approvalCard({ toolName: 'bash', command: HOSTILE, reason: HOSTILE, allow: {}, reject: {} })
    const rendered = cardTexts(card).filter((text) => text.content.includes(HOSTILE))
    expect(rendered).toHaveLength(2)
    expect(rendered.every((text) => text.tag === 'plain_text')).toBe(true)
  })

  it('omits the blocks it has no content for', () => {
    const texts = cardTexts(approvalCard({ toolName: 'bash', allow: {}, reject: {} }))
    expect(texts.some((text) => text.content === '将执行')).toBe(false)
    expect(texts.some((text) => text.content === '模型说明')).toBe(false)
  })

  it('leaves nothing clickable once decided', () => {
    for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
      const card = settledApprovalCard({ toolName: 'bash', outcome })
      expect(cardControls(card)).toHaveLength(0)
    }
  })

  it('names who decided, without letting the name become markup', () => {
    const card = settledApprovalCard({ toolName: 'bash', outcome: 'allowed-once', decidedBy: HOSTILE })
    const named = cardTexts(card).filter((text) => text.content.includes(HOSTILE))
    expect(named).toHaveLength(1)
    expect(named[0]!.tag).toBe('plain_text')
  })
})

describe('file approval card', () => {
  it('shows the file inside its workspace and the size, so the room can judge what is leaving', () => {
    const texts = cardTexts(fileApprovalCard({
      path: 'reports/q4-forecast.pdf',
      workspace: 'forecasting',
      bytes: 1_258_291,
      allow: {},
      reject: {},
    }))
    // The file exactly where it sits, in full: a prettified form — a `~`, an
    // ellipsis, a bare basename — would hide which file the room is publishing.
    expect(texts.some((text) => text.content === 'reports/q4-forecast.pdf')).toBe(true)
    // And which workspace it came out of, on its own line.
    expect(texts.some((text) => text.content === 'forecasting')).toBe(true)
    // `MiB`, not `MB`: the arithmetic above it divides by 1024, and the card and
    // the tool error the model reads now spell one size one way.
    expect(texts.some((text) => text.content === '1.2 MiB')).toBe(true)
  })

  it('never prints the absolute path of the host it runs on', () => {
    // The room is not judging whose laptop this is. An absolute path publishes
    // the operator's login name and directory layout to everyone in the group,
    // which is exactly what the workspace-relative form drops — and nothing
    // else: the relative form is derived from the canonical path the container
    // check cleared, so a symlink still shows the room the real object.
    const cards = [
      fileApprovalCard({ path: 'out/report.md', workspace: 'project', bytes: 12, allow: {}, reject: {} }),
      settledFileApprovalCard({ path: 'out/report.md', workspace: 'project', outcome: 'allowed-once' }),
    ]
    for (const card of cards) {
      expect(JSON.stringify(card)).not.toContain('/Users/')
      expect(cardTexts(card).some((text) => text.content.startsWith('/'))).toBe(false)
    }
  })

  it('reads a size in binary units, whole ones without a decimal', () => {
    const sizeShown = (bytes: number): string[] =>
      cardTexts(fileApprovalCard({ path: 'f', workspace: 'w', bytes, allow: {}, reject: {} }))
        .map((text) => text.content)
    expect(sizeShown(12)).toContain('12 B')
    expect(sizeShown(1024)).toContain('1 KiB')
    expect(sizeShown(840 * 1024)).toContain('840 KiB')
    expect(sizeShown(3 * 1024 * 1024 * 1024)).toContain('3 GiB')
    // The top of a band carries up instead of printing as the next unit's floor:
    // `1024.0 KiB` is a size spelled in a unit that reads as the one above it.
    expect(sizeShown(1024 * 1024 - 40)).toContain('1 MiB')
    // And a size that rounds DOWN inside its band keeps that band.
    expect(sizeShown(1024 * 1024 - 500)).toContain('1023.5 KiB')
  })

  it('wears the same heading a tool escalation wears', () => {
    const asking = (card: object): string | undefined => cardTexts(card)[0]?.content
    // One authorization, one word for it: two copies of the heading are two
    // things to edit, and the room would end up asked in two different voices.
    expect(asking(fileApprovalCard({ path: 'out.zip', workspace: 'w', bytes: 1, allow: {}, reject: {} })))
      .toBe(asking(approvalCard({ toolName: 'bash', allow: {}, reject: {} })))
  })

  it('carries one decision payload per button, and nothing else clickable', () => {
    const controls = cardControls(fileApprovalCard({
      path: 'out.zip',
      workspace: 'w',
      bytes: 4096,
      allow: { kind: 'dsh-lark-channel/approval', id: 'f1', decision: 'allow' },
      reject: { kind: 'dsh-lark-channel/approval', id: 'f1', decision: 'reject' },
    }))
    expect(controls.map((control) => control.value)).toEqual([
      { kind: 'dsh-lark-channel/approval', id: 'f1', decision: 'allow' },
      { kind: 'dsh-lark-channel/approval', id: 'f1', decision: 'reject' },
    ])
    expect(controls.map((control) => control.label)).toEqual(['允许发送', '拒绝'])
  })

  it('offers both languages for the words it authored itself', () => {
    const texts = cardTexts(fileApprovalCard({ path: 'out.zip', workspace: 'w', bytes: 4096, allow: {}, reject: {} }))
    const authored = (zh: string): Record<string, string> | undefined =>
      texts.find((text) => text.content === zh)?.i18n
    expect(authored('允许发送')).toEqual({ zh_cn: '允许发送', en_us: 'Send it' })
    expect(authored('拒绝')).toEqual({ zh_cn: '拒绝', en_us: 'Reject' })
    expect(authored('文件')).toEqual({ zh_cn: '文件', en_us: 'File' })
    expect(authored('工作区')).toEqual({ zh_cn: '工作区', en_us: 'Workspace' })
    expect(authored('大小')).toEqual({ zh_cn: '大小', en_us: 'Size' })
  })

  it('says so when a path was too long to print whole', () => {
    const path = 'x'.repeat(900)
    const texts = cardTexts(fileApprovalCard({ path, workspace: 'w', bytes: 1, allow: {}, reject: {} }))
    expect(texts.some((text) => text.content === path.slice(0, 600))).toBe(true)
    // A silently shortened path is one the room approves believing it saw the
    // whole thing.
    expect(texts.some((text) => text.content === `已截断 ${path.length - 600} 个字符`)).toBe(true)
  })

  it('leaves nothing clickable once decided, and keeps the record of what happened', () => {
    for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
      const card = settledFileApprovalCard({ path: 'out.zip', workspace: 'ws', outcome, decidedBy: '陈晓' })
      expect(cardControls(card)).toHaveLength(0)
      const texts = cardTexts(card).map((text) => text.content)
      expect(texts.some((content) => content.includes('out.zip'))).toBe(true)
      // This card REPLACES the one the room read, so the workspace has to stay
      // in the record: nobody could otherwise tell later where the file came from.
      expect(texts.some((content) => content.includes('ws · out.zip'))).toBe(true)
      expect(texts.some((content) => content.includes('陈晓'))).toBe(true)
    }
  })

  it('names who let the file out, without letting the name become markup', () => {
    const card = settledFileApprovalCard({
      path: 'out.zip',
      workspace: 'ws',
      outcome: 'allowed-once',
      decidedBy: HOSTILE,
    })
    const named = cardTexts(card).filter((text) => text.content.includes(HOSTILE))
    expect(named).toHaveLength(1)
    expect(named[0]!.tag).toBe('plain_text')
    // The outcome talks about sending, not about running something.
    expect(cardTexts(card).some((text) => text.content.startsWith('已允许发送'))).toBe(true)
  })
})

describe('question card', () => {
  it('lays bare labels out as buttons, and explained options as rows', () => {
    const bare = questionCard({
      question: '继续吗？',
      options: [{ label: '继续' }, { label: '停下' }],
      valueFor: (index) => ({ index }),
    })
    const explained = questionCard({
      question: '继续吗？',
      options: [{ label: '继续' }, { label: '停下', description: '保留现场再看' }],
      valueFor: (index) => ({ index }),
    })
    // Both layouts answer the same way: every option stays clickable, and the
    // payload is positional whichever shape carries it.
    for (const card of [bare, explained]) {
      expect(cardControls(card).map((control) => control.value)).toEqual([{ index: 0 }, { index: 1 }])
      expect(cardControls(card).map((control) => control.label)).toEqual(['继续', '停下'])
    }
    // The explanation lives inside the row it explains, not in a legend below.
    expect(cardTexts(explained).some((text) => text.content === '保留现场再看')).toBe(true)
  })

  it('renders every model-authored string literally', () => {
    const card = questionCard({
      header: HOSTILE,
      question: HOSTILE,
      options: [{ label: HOSTILE, description: HOSTILE }],
      valueFor: () => ({}),
    })
    const rendered = cardTexts(card).filter((text) => text.content.includes(HOSTILE))
    expect(rendered).toHaveLength(4)
    expect(rendered.every((text) => text.tag === 'plain_text')).toBe(true)
  })

  it('asks for a typed answer when the model offered no options', () => {
    const card = questionCard({ question: '叫什么名字？', options: [], valueFor: () => ({}) })
    expect(cardControls(card)).toHaveLength(0)
    expect(cardTexts(card).some((text) => text.content.includes('直接回复消息作答'))).toBe(true)
  })

  it('leaves nothing clickable once answered or cancelled', () => {
    const answered = settledQuestionCard({ question: '继续吗？', answer: '继续' })
    const cancelled = settledQuestionCard({ question: '继续吗？', cancelled: true })
    expect(cardControls(answered)).toHaveLength(0)
    expect(cardControls(cancelled)).toHaveLength(0)
    expect(cardTexts(answered).some((text) => text.content === '继续')).toBe(true)
    // A cancelled question shows no answer, because none was given.
    expect(cardTexts(cancelled).some((text) => text.content === '你的回答')).toBe(false)
  })
})

describe('localization', () => {
  /**
   * Every card this module builds, in every state it has. Borrowed values are
   * ASCII throughout, so any Chinese surviving into an English rendering is
   * copy this module failed to translate rather than someone's own words.
   */
  const everyCard = (): object[] => [
    approvalCard({ toolName: 'bash', command: 'ls', reason: 'have a look', allow: {}, reject: {} }),
    approvalCard({ toolName: 'bash', command: 'x'.repeat(900), allow: {}, reject: {} }),
    settledApprovalCard({ toolName: 'bash', outcome: 'allowed-once', decidedBy: 'Alex' }),
    settledApprovalCard({ toolName: 'bash', outcome: 'cancelled' }),
    fileApprovalCard({ path: 'out.zip', workspace: 'w', bytes: 1_258_291, allow: {}, reject: {} }),
    fileApprovalCard({ path: 'x'.repeat(900), workspace: 'w', bytes: 0, allow: {}, reject: {} }),
    settledFileApprovalCard({ path: 'out.zip', workspace: 'w', outcome: 'allowed-once', decidedBy: 'Alex' }),
    settledFileApprovalCard({ path: 'out.zip', workspace: 'w', outcome: 'rejected' }),
    questionCard({ question: 'go on?', options: [{ label: 'yes' }], valueFor: () => ({}) }),
    questionCard({ question: 'go on?', options: [], valueFor: () => ({}) }),
    settledQuestionCard({ question: 'go on?', answer: 'yes' }),
    settledQuestionCard({ question: 'go on?', cancelled: true }),
    settledPermissionCard({ preset: { value: 'workspace-write' } }),
    settledPermissionCard({ preset: { value: 'danger-full-access' }, stage: 'held' }),
    settledPermissionCard({ preset: { value: 'danger-full-access' }, stage: 'switching' }),
    fileApprovalCard({ path: 'build/report.pdf', workspace: 'project', bytes: 2048, allow: {}, reject: {} }),
    settledFileApprovalCard({ path: 'build/report.pdf', workspace: 'project', outcome: 'allowed-once' }),
    settledFileApprovalCard({ path: 'build/report.pdf', workspace: 'project', outcome: 'rejected', decidedBy: 'Alex' }),
    // The control cards too: their copy is this module's, and the reason a
    // Chinese-only description shipped once was that this sweep stopped at the
    // two cards a model can raise.
    permissionCard({
      current: 'workspace-write',
      presets: [{ value: 'workspace-write' }, { value: 'danger-full-access' }],
      valueFor: () => ({}),
    }),
    modelCard({
      current: 'p/m',
      isDefault: false,
      entries: [{ label: 'p/m', current: true, value: {} }, { label: 'p/n', current: false, value: {} }],
      hidden: 2,
      reset: {},
    }),
    statusCard({
      workspace: '/w',
      workspaceIsDefault: true,
      route: 'p/m',
      routeIsDefault: false,
      sessionId: 's',
      activity: 'running',
      pendingApprovals: 2,
      version: '0.0.6',
      preset: { value: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
      context: { used: 1000, window: 128000 },
      compaction: { count: 2, foldedTokens: 48_200 },
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 },
      refresh: {},
    }),
  ]

  it('offers an English rendering of every string it authored', () => {
    for (const card of everyCard()) {
      const authored = cardTexts(card).filter((text) => text.i18n !== undefined)
      expect(authored.length).toBeGreaterThan(0)
      for (const { content, i18n } of authored) {
        expect(i18n!.zh_cn).toBe(content)
        expect(i18n!.en_us ?? '').not.toBe('')
        // English, not Chinese wearing an English key: a copied string here
        // would silently ship an untranslated card to a reader who cannot
        // read it.
        expect(/[一-鿿]/.test(i18n!.en_us ?? '')).toBe(false)
      }
      const summary = (card as { config: { summary: { content: string; i18n_content?: object } } }).config.summary
      expect(summary.i18n_content).toBeDefined()
    }
  })

  it('leaves no Chinese without an English rendering, given ASCII inputs', () => {
    // The stronger half of the same rule, and the one that catches copy which
    // LOST its translation: every borrowed value above is ASCII, so any
    // Chinese in the rendered card is this module's own — and ours always
    // carries `i18n`. A `.zh` picked out of a Copy passes the check above,
    // because a bare string is indistinguishable from borrowed text.
    for (const card of everyCard()) {
      for (const { content, i18n } of cardTexts(card)) {
        if (!/[一-鿿]/.test(content)) continue
        expect({ content, en: i18n?.en_us ?? '' }).toMatchObject({ content, en: expect.stringMatching(/\S/) })
      }
    }
  })

  it('leaves borrowed text in the language it arrived in', () => {
    const card = questionCard({
      header: '部署确认',
      question: '要上线吗？',
      options: [{ label: '上线', description: '立即生效' }],
      valueFor: () => ({}),
    })
    // The model's own words carry no translation: a bot that rewrote them
    // would be answering for a reader who never saw the original.
    for (const model of ['部署确认', '要上线吗？', '上线', '立即生效']) {
      expect(cardTexts(card).find((text) => text.content === model)!.i18n).toBeUndefined()
    }
  })
})

/** Every `dsh_*` value used where the platform expects a colour. */
function colourTokens(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(colourTokens)
  if (typeof node !== 'object' || node === null) return []
  const record = node as Record<string, unknown>
  const own = ['text_color', 'background_style', 'border_color']
    .map((field) => record[field])
    .filter((value): value is string => typeof value === 'string' && value.startsWith('dsh_'))
  return [...own, ...Object.values(record).flatMap(colourTokens)]
}

describe('card foundation', () => {
  it('declares every colour it references', () => {
    // Every builder this module exports, because the failure is invisible in
    // code and fatal at render: an undeclared token makes the platform reject
    // the whole card.
    const cards = [
      approvalCard({ toolName: 'bash', command: 'ls', reason: 'x', allow: {}, reject: {} }),
      approvalCard({ toolName: 'bash', escalateTo: 'danger-full-access', allow: {}, reject: {}, always: {} }),
      settledApprovalCard({ toolName: 'bash', outcome: 'rejected' }),
      fileApprovalCard({ path: 'out.zip', workspace: 'w', bytes: 4096, allow: {}, reject: {} }),
      settledFileApprovalCard({ path: 'out.zip', workspace: 'w', outcome: 'allowed-once', decidedBy: 'Alex' }),
      questionCard({ question: '?', options: [{ label: 'a', description: 'b' }], valueFor: () => ({}) }),
      questionCard({ question: '?', multiSelect: true, submit: {}, options: [{ label: 'a' }], valueFor: () => ({}) }),
      settledQuestionCard({ question: '?', answer: 'a' }),
      modelCard({
        current: 'p/m',
        isDefault: false,
        entries: [{ label: 'p/m', current: true, value: {} }, { label: 'p/n', current: false, value: {} }],
        hidden: 1,
        reset: {},
      }),
      statusCard({
        workspace: '/w',
        workspaceIsDefault: true,
        route: 'p/m',
        routeIsDefault: true,
        sessionId: 's',
        activity: 'idle',
        pendingApprovals: 1,
        version: '0.0.6',
        preset: { value: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
        context: { used: 1000, window: 128000 },
        compaction: { count: 2, foldedTokens: 48_200 },
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        refresh: {},
      }),
      permissionCard({
        current: 'workspace-write',
        presets: [{ value: 'workspace-write' }, { value: 'danger-full-access', name: 'Danger' }],
        valueFor: () => ({}),
      }),
      settledPermissionCard({ preset: { value: 'danger-full-access' } }),
      settledPermissionCard({ preset: { value: 'workspace-write' }, stage: 'switching' }),
      settledPermissionCard({ preset: { value: 'a-preset-only-this-deployment-knows' } }),
      fileApprovalCard({ path: 'build/report.pdf', workspace: 'project', bytes: 2048, allow: {}, reject: {} }),
      settledFileApprovalCard({ path: 'build/report.pdf', workspace: 'project', outcome: 'cancelled' }),
    ]
    for (const card of cards) {
      const declared = Object.keys(
        (card as { config: { style: { color: Record<string, unknown> } } }).config.style.color,
      )
      // Colour FIELDS only: a `dsh_*` string elsewhere is an element name.
      // An undeclared colour is not a fallback — the platform rejects the
      // whole card, which is invisible in code and fatal at render.
      const referenced = colourTokens(card)
      expect([...new Set(referenced)].filter((token) => !declared.includes(token))).toEqual([])
      expect((card as { schema: string }).schema).toBe('2.0')
    }
  })
})
