import { describe, expect, it } from 'vitest'
import {
  ChatSessionPicks,
  offerSessions,
  PICKER_ROWS,
  readTitles,
  sessionActionValue,
  sessionChoices,
  sessionFacts,
  SESSIONS_ACTION,
} from '../src/sessions.ts'
import type { HostSessionRecord } from '../src/host.ts'

/** The channel's own marker, as `session.ts` brands ids with. */
const MARKER = 'lark-'

/** One conversation's corpus, in the shape the host's engine lists. */
function corpus(...rows: { id: string; cwd?: string; createdAt?: number; live?: boolean }[]): HostSessionRecord[] {
  return rows.map(row => ({
    header: { id: row.id, ...row.cwd === undefined ? {} : { cwd: row.cwd }, createdAt: row.createdAt ?? 0 },
    live: row.live === true,
  }))
}

/** The picker input for a chat whose own base is `lark-oc_1`, in `/work`. */
const HERE = { base: 'lark-oc_1', current: 'lark-oc_1', workspace: '/work', marker: MARKER }

describe('what a conversation may continue', () => {
  it('never offers work an agent delegated to itself', () => {
    // A subagent session opens with an instruction the agent wrote, runs one
    // turn and ends. Listing them buries the conversations a person had.
    const records: HostSessionRecord[] = [
      { header: { id: 'session-real', cwd: '/work', createdAt: 10 } },
      { header: { id: 'session-sub', cwd: '/work', createdAt: 20, origin: 'subagent', delegationDepth: 1 } },
      { header: { id: 'session-forked', cwd: '/work', createdAt: 30, parentSession: 'session-real' } },
    ]
    expect(sessionChoices(records, new Map(), HERE, path => path).map(choice => choice.id))
      .toEqual(['session-real'])
  })

  it('offers its own history and sessions no chat owns, and nothing else', () => {
    const records = corpus(
      { id: 'lark-oc_1', cwd: '/work', createdAt: 30 },
      { id: 'lark-oc_1--e1', cwd: '/work', createdAt: 40 },
      { id: 'session-web-ui', cwd: '/work', createdAt: 50 },
      // Another chat, and another bot row in the same workspace: their titles
      // summarize conversations this room was never part of.
      { id: 'lark-oc_2', cwd: '/work', createdAt: 60 },
      { id: 'lark-support-oc_1', cwd: '/work', createdAt: 70 },
    )
    const offered = sessionChoices(records, new Map(), HERE, path => path)
    expect(offered.map(choice => choice.id)).toEqual(['session-web-ui', 'lark-oc_1--e1', 'lark-oc_1'])
    expect(offered.map(choice => choice.own)).toEqual([false, true, true])
  })

  it('keeps to the conversation\'s workspace, comparing canonical paths', () => {
    const records = corpus(
      { id: 'session-here', cwd: '/tmp/work', createdAt: 10 },
      { id: 'session-elsewhere', cwd: '/other', createdAt: 20 },
      { id: 'session-nowhere', createdAt: 30 },
    )
    // `/tmp` is a link into `/private/var` on macOS, so a session recorded
    // under one spelling must still be recognized under the other — a
    // conversation would otherwise be offered nothing in its own directory.
    const canonical = (path: string) => (path.startsWith('/private/') ? path : `/private${path}`)
    const offered = sessionChoices(records, new Map(), { ...HERE, workspace: '/private/tmp/work' }, canonical)
    expect(offered.map(choice => choice.id)).toEqual(['session-here'])
  })

  it('marks the one in use and the ones another surface is driving', () => {
    const records = corpus(
      { id: 'lark-oc_1', cwd: '/work', createdAt: 10 },
      { id: 'session-web-ui', cwd: '/work', createdAt: 20, live: true },
    )
    const offered = sessionChoices(records, new Map([['session-web-ui', '看一眼部署']]), HERE, path => path)
    expect(offered[0]).toMatchObject({ id: 'session-web-ui', title: '看一眼部署', live: true, current: false })
    expect(offered[1]).toMatchObject({ id: 'lark-oc_1', live: false, current: true })
  })

  it('narrows by keyword over titles and ids', () => {
    const records = corpus(
      { id: 'session-a', cwd: '/work', createdAt: 10 },
      { id: 'session-b', cwd: '/work', createdAt: 20 },
    )
    const titles = new Map([['session-a', '权限预设的设计'], ['session-b', '文件收发']])
    expect(sessionChoices(records, titles, { ...HERE, keyword: '权限' }, path => path).map(c => c.id))
      .toEqual(['session-a'])
    expect(sessionChoices(records, titles, { ...HERE, keyword: 'session-b' }, path => path).map(c => c.id))
      .toEqual(['session-b'])
  })
})

describe('reading titles', () => {
  it('takes the fulfilled ones and steps over the rest', async () => {
    const query = {
      listSessions: async () => [],
      readTitleSnapshots: async (ids: readonly string[]) => [
        { sessionId: ids[0]!, status: 'fulfilled' as const, value: { title: { title: '有标题' } } },
        // A rejected read carries no value; reading one off it would look
        // exactly like a session that simply has no title.
        { sessionId: ids[1]!, status: 'rejected' as const, reason: new Error('unreadable') },
        { sessionId: ids[2]!, status: 'fulfilled' as const, value: {} },
      ],
    }
    const titles = await readTitles(query, ['a', 'b', 'c'])
    expect([...titles.entries()]).toEqual([['a', '有标题']])
  })

  it('asks for nothing when there is nothing to ask about', async () => {
    let called = false
    const query = {
      listSessions: async () => [],
      readTitleSnapshots: async () => { called = true; return [] },
    }
    expect((await readTitles(query, [])).size).toBe(0)
    expect(called).toBe(false)
  })
})

describe('the pick a conversation carries', () => {
  it('records, clears, and persists exactly the changes', async () => {
    const patches: object[] = []
    const picks = new ChatSessionPicks({ persist: async (patch) => { patches.push(patch); return true } })

    expect(picks.pickFor('chat')).toBeUndefined()
    expect(await picks.set('chat', 'session-web-ui')).toMatchObject({ changed: true, durable: true })
    expect(picks.pickFor('chat')).toBe('session-web-ui')
    expect(await picks.set('chat', 'session-web-ui')).toMatchObject({ changed: false })
    expect(await picks.set('chat', undefined)).toMatchObject({ changed: true })
    expect(picks.pickFor('chat')).toBeUndefined()
    expect(patches).toEqual([
      { chatSessions: { chat: 'session-web-ui' } },
      { chatSessions: { chat: '' } },
    ])
  })

  it('reads a stored empty entry as no pick at all', () => {
    // The stored marker for "no pick" and a missing key mean the same thing;
    // an empty string reaching the derivation would name a session with no id.
    const picks = new ChatSessionPicks({ entries: { chat: '', other: 'session-x' } })
    expect(picks.pickFor('chat')).toBeUndefined()
    expect(picks.pickFor('other')).toBe('session-x')
  })

  it('says once when picks will not survive a restart', async () => {
    const reports: string[] = []
    const picks = new ChatSessionPicks({ persist: async () => false, report: (line) => reports.push(line) })
    await picks.set('chat', 'a')
    await picks.set('chat', 'b')
    expect(reports.filter(line => line.includes('in-memory only'))).toHaveLength(1)
  })
})

describe('the payload a row carries', () => {
  it('accepts only its own well-formed values', () => {
    const value = { kind: SESSIONS_ACTION, session: 'session-x', key: 'oc_1', chatId: 'oc_1', chatType: 'p2p' }
    expect(sessionActionValue(value)).toEqual(value)
    expect(sessionActionValue({ ...value, owner: 'ou_1' })).toEqual({ ...value, owner: 'ou_1' })
    expect(sessionActionValue({ ...value, kind: 'other' })).toBeUndefined()
    expect(sessionActionValue({ ...value, session: '' })).toBeUndefined()
    expect(sessionActionValue({ ...value, key: undefined })).toBeUndefined()
    expect(sessionActionValue(null)).toBeUndefined()
  })
})

describe('what makes one session recognizable', () => {
  /**
   * A query engine over one session's raw log. The `user/message` stream holds
   * injected context beside what a person typed, exactly as a real one does.
   */
  function engine(events: readonly { type: string; time: number; text?: string; from?: string }[]) {
    const raw = events.map((event, seq) => ({
      seq,
      type: event.type,
      time: event.time,
      data: {
        source: { kind: event.from ?? 'user' },
        ...event.text === undefined ? {} : { content: [{ type: 'text', text: event.text }] },
      },
    }))
    return {
      listSessions: async () => [],
      listEvents: async () => raw.map(({ seq, type, time }) => ({ seq, type, time })),
      readEvent: async (request: { seq: number; before?: number }) => ({
        events: raw.slice(Math.max(0, request.seq - (request.before ?? 0)), request.seq + 1),
      }),
    }
  }

  it('counts turns and takes the time it last moved', async () => {
    const facts = await sessionFacts(engine([
      { type: 'turn/start', time: 1_000 },
      { type: 'user/message', time: 1_000, text: 'first' },
      { type: 'turn/start', time: 5_000 },
      { type: 'user/message', time: 5_000, text: 'second' },
    ]), 's1')
    expect(facts).toMatchObject({ turns: 2, lastActive: 5_000, lastSaid: 'second' })
  })

  it('labels by the last thing a PERSON said, stepping over injected context', async () => {
    // A session's `user/message` stream carries system prompt snapshots, skill
    // catalogs and job notices. Any of them can be the newest entry, and a row
    // labelled with one names nothing a reader recognizes.
    const facts = await sessionFacts(engine([
      { type: 'turn/start', time: 1 },
      { type: 'user/message', time: 2, text: '把文档写完' },
      { type: 'user/message', time: 3, text: '<system-reminder> workspace…', from: 'plugin' },
      { type: 'user/message', time: 4, text: 'Current runtime context…', from: 'agent-instructions' },
    ]), 's1')
    expect(facts.lastSaid).toBe('把文档写完')
  })

  it('walks back past a keystroke for a line that names the conversation', async () => {
    // "？" is an honest answer to "what was said last" and a useless answer to
    // "which conversation is this".
    const facts = await sessionFacts(engine([
      { type: 'user/message', time: 1, text: '把权限卡片改成按行为描述' },
      { type: 'user/message', time: 2, text: '？' },
      { type: 'user/message', time: 3, text: '1' },
    ]), 's1')
    expect(facts.lastSaid).toBe('把权限卡片改成按行为描述')
  })

  it('settles for the short line when a conversation holds nothing else', async () => {
    const facts = await sessionFacts(engine([{ type: 'user/message', time: 1, text: '？' }]), 's1')
    expect(facts.lastSaid).toBe('？')
  })

  it('clips a long line to a label rather than a paragraph', async () => {
    const long = '这一轮我们先把权限预设的切换路径梳理清楚，然后再回头看卡片的展示问题，最后把测试补齐再提交'
    const facts = await sessionFacts(engine([{ type: 'user/message', time: 1, text: long }]), 's1')
    expect(facts.lastSaid!.length).toBeLessThanOrEqual(41)
    expect(facts.lastSaid!.endsWith('…')).toBe(true)
  })

  it('says nothing rather than guessing when the engine offers no listing', async () => {
    expect(await sessionFacts({ listSessions: async () => [] }, 's1')).toEqual({ turns: 0 })
  })
})

describe('one derivation of the picker', () => {
  /** A corpus with a log behind each session, as the host's engine serves it. */
  function engine(rows: readonly { id: string; createdAt: number; said?: number }[], failing = false) {
    return {
      listSessions: async () => {
        if (failing) throw new Error('the corpus is unreadable (fake)')
        return rows.map(row => ({ header: { id: row.id, cwd: '/work', createdAt: row.createdAt }, live: false }))
      },
      listEvents: async (id: string) => {
        const row = rows.find(candidate => candidate.id === id)
        return row?.said === undefined
          ? []
          : [
              { sessionId: id, seq: 0, type: 'turn/start', time: row.said },
              { sessionId: id, seq: 1, type: 'user/message', time: row.said },
            ]
      },
      readEvent: async (request: { sessionId: string; seq: number }) => {
        const row = rows.find(candidate => candidate.id === request.sessionId)
        return row?.said === undefined
          ? { events: [] }
          : {
              events: [{
                seq: 1,
                type: 'user/message',
                time: row.said,
                data: { source: { kind: 'user' }, content: [{ type: 'text', text: `said in ${row.id}` }] },
              }],
            }
      },
    }
  }

  const offer = (query: ReturnType<typeof engine>, report?: (line: string) => void) => offerSessions({
    query,
    scope: HERE,
    canonical: path => path,
    ...report === undefined ? {} : { report },
  })

  it('draws what it read, and counts the rest', async () => {
    const rows = Array.from({ length: PICKER_ROWS + 6 }, (_, index) => ({
      id: `session-${index}`,
      createdAt: 10_000 - index,
      said: 10_000 - index,
    }))
    const offered = await offer(engine(rows))

    expect(offered.rows).toHaveLength(PICKER_ROWS)
    // Everything the card is not drawing, whether it was described or not.
    expect(offered.rows.length + offered.hidden).toBe(rows.length)
    expect(offered.rows.every(row => row.lastSaid !== undefined)).toBe(true)
  })

  it('takes the time a session last moved without spreading its whole log', async () => {
    // `Math.max(...events)` passes every event as an argument, which throws on
    // a long session before it compares anything — and the picker with it.
    const many = Array.from({ length: 200_000 }, (_, seq) => ({
      sessionId: 's1',
      seq,
      type: seq % 2 === 0 ? 'turn/start' : 'user/message',
      time: seq + 1,
    }))
    const facts = await sessionFacts({
      listSessions: async () => [],
      listEvents: async () => many,
    }, 's1')

    expect(facts.lastActive).toBe(200_000)
    expect(facts.turns).toBe(100_000)
  })

  it('asks the filesystem once per directory, not once per session', async () => {
    // Canonicalizing is a synchronous filesystem call on the event loop, and a
    // corpus of hundreds of sessions shares a handful of directories.
    const asked: string[] = []
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `session-${index}`,
      createdAt: 10_000 - index,
      said: 10_000 - index,
    }))
    await offerSessions({
      query: engine(rows),
      scope: { ...HERE, keyword: 'session' },
      canonical: (path) => { asked.push(path); return path },
    })

    expect(new Set(asked).size).toBe(1)
    expect(asked).toHaveLength(1)
  })

  it('keeps every session where the host lends no event listing', async () => {
    // Without `listEvents` nothing ever happened in ANY session as far as this
    // can tell, and dropping them all leaves a picker that offers only what
    // this chat already had — which is the opposite of the point.
    const offered = await offerSessions({
      query: {
        listSessions: async () => [
          { header: { id: 'session-web-ui', cwd: '/work', createdAt: 10 }, live: false },
        ],
      },
      scope: HERE,
      canonical: path => path,
    })

    expect(offered.rows.map(row => row.id)).toEqual(['session-web-ui'])
  })

  it('always shows the conversation where it is, however quiet that session is', async () => {
    // A conversation parked on a session it has not spoken in lately would
    // otherwise be handed a list with no "you are here" on it at all.
    const rows = [
      // More than the window this reads facts for, so the parked one is not
      // merely off the card — it is off the end of what gets described.
      ...Array.from({ length: PICKER_ROWS * 3 }, (_, index) => ({
        id: `session-busy-${index}`,
        createdAt: 90_000 - index,
        said: 90_000 - index,
      })),
      { id: 'session-parked', createdAt: 10, said: 20 },
    ]
    const offered = await offerSessions({
      query: engine(rows),
      scope: { ...HERE, current: 'session-parked' },
      canonical: path => path,
    })

    expect(offered.rows).toHaveLength(PICKER_ROWS)
    expect(offered.rows.map(row => row.id)).toContain('session-parked')
    expect(offered.rows.find(row => row.current)?.id).toBe('session-parked')
  })

  it('offers nothing, and says why, when the corpus cannot be listed', async () => {
    const notes: string[] = []
    const offered = await offer(engine([], true), line => notes.push(line))

    expect(offered).toEqual({ rows: [], hidden: 0 })
    // A picker that silently shows an empty list looks the same as a workspace
    // with no sessions, and only one of those is worth waking someone for.
    expect(notes.join('\n')).toContain('listing sessions failed')
  })
})
