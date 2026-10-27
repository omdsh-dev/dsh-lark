import { describe, expect, it } from 'vitest'
import {
  ChatSessionPointers,
  offerSessions,
  PICKER_ROWS,
  readTitles,
  sessionActionValue,
  sessionChoices,
  sessionFacts,
  sessionsPage,
  SESSIONS_ACTION,
  SESSIONS_PAGE_ROWS,
} from '../src/sessions.ts'
import type { SessionChoice, SessionPickerInput } from '../src/sessions.ts'
import type { HostSessionProjectionCache, HostSessionQuery, HostSessionRecord } from '../src/host.ts'

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
const HERE: SessionPickerInput = { base: 'lark-oc_1', current: 'lark-oc_1', workspace: '/work', marker: MARKER }

describe('what a conversation may continue', () => {
  it('never offers work an agent delegated to itself', () => {
    // A subagent session opens with an instruction the agent wrote, runs one
    // turn and ends. Listing them buries the conversations a person had.
    const records: HostSessionRecord[] = [
      { header: { id: 'session-real', cwd: '/work', createdAt: 10 } },
      { header: { id: 'session-sub', cwd: '/work', createdAt: 20, origin: 'subagent', delegationDepth: 1 } },
    ]
    expect(sessionChoices(records, new Map(), HERE, path => path).map(choice => choice.id))
      .toEqual(['session-real'])
  })

  it('offers a session that only carries fork lineage, as the Web tree does', () => {
    // `parentSession` is fork lineage, not delegation: the Web client's
    // `sessionVisible` reads `origin` alone, so it draws a forked session as an
    // ordinary row. Treating lineage as delegation hid 4 of the 5 sessions one
    // chat could see in the Web UI while that surface still listed them.
    const records: HostSessionRecord[] = [
      { header: { id: 'session-real', cwd: '/work', createdAt: 10 } },
      { header: { id: 'session-forked', cwd: '/work', createdAt: 30, parentSession: 'session-real' } },
      // A depth with no `origin` is not a classification either; the field is a
      // recursion counter, and the Web tree does not read it for visibility.
      { header: { id: 'session-deep', cwd: '/work', createdAt: 40, delegationDepth: 2 } },
    ]
    expect(sessionChoices(records, new Map(), HERE, path => path).map(choice => choice.id).sort())
      .toEqual(['session-deep', 'session-forked', 'session-real'])
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

describe('the pointer a conversation carries', () => {
  it('records, clears, and persists exactly the changes', async () => {
    const patches: object[] = []
    const pointers = new ChatSessionPointers({ persist: async (patch) => { patches.push(patch); return true } })

    expect(pointers.pointerFor('lark-oc_1--abc')).toBeUndefined()
    expect(await pointers.set('lark-oc_1--abc', 'session-web-ui')).toMatchObject({ changed: true, durable: true })
    expect(pointers.pointerFor('lark-oc_1--abc')).toBe('session-web-ui')
    expect(await pointers.set('lark-oc_1--abc', 'session-web-ui')).toMatchObject({ changed: false })
    expect(await pointers.set('lark-oc_1--abc', undefined)).toMatchObject({ changed: true })
    expect(pointers.pointerFor('lark-oc_1--abc')).toBeUndefined()
    expect(patches).toEqual([
      { chatSessions: { 'lark-oc_1--abc': 'session-web-ui' } },
      { chatSessions: { 'lark-oc_1--abc': '' } },
    ])
  })

  it('reads a stored empty entry as no pointer at all', () => {
    // The stored marker for "no pointer" and a missing key mean the same thing;
    // an empty string reaching the derivation would name a session with no id.
    const pointers = new ChatSessionPointers({ entries: { 'lark-oc_1': '', 'lark-oc_2': 'session-x' } })
    expect(pointers.pointerFor('lark-oc_1')).toBeUndefined()
    expect(pointers.pointerFor('lark-oc_2')).toBe('session-x')
  })

  it('names the anchors pointing at one session', () => {
    const pointers = new ChatSessionPointers({
      entries: { 'lark-oc_1--abc': 'session-x', 'lark-oc_1--def': 'session-x', 'lark-oc_2': 'session-y' },
    })
    expect(pointers.anchorsPointingAt('session-x')).toEqual(['lark-oc_1--abc', 'lark-oc_1--def'])
    expect(pointers.anchorsPointingAt('session-z')).toEqual([])
  })

  it('hands out a detached snapshot, for migrating an older key format', async () => {
    const pointers = new ChatSessionPointers({ entries: { chat: 'session-x' } })
    const snapshot = pointers.snapshot()
    expect([...snapshot]).toEqual([['chat', 'session-x']])
    await pointers.set('chat', undefined)
    // The snapshot is a copy: a migration cannot observe later writes through it.
    expect([...snapshot]).toEqual([['chat', 'session-x']])
  })

  it('says once when pointers will not survive a restart', async () => {
    const reports: string[] = []
    const pointers = new ChatSessionPointers({ persist: async () => false, report: (line) => reports.push(line) })
    await pointers.set('lark-oc_1', 'a')
    await pointers.set('lark-oc_1', 'b')
    expect(reports.filter(line => line.includes('in-memory only'))).toHaveLength(1)
  })
})

describe('the payload a row carries', () => {
  it('accepts only its own well-formed values', () => {
    const value = { kind: SESSIONS_ACTION, a: 'm1', session: 'session-x', key: 'oc_1', chatId: 'oc_1', chatType: 'p2p' }
    expect(sessionActionValue(value)).toEqual(value)
    expect(sessionActionValue({ ...value, owner: 'ou_1' })).toEqual({ ...value, owner: 'ou_1' })
    expect(sessionActionValue({ ...value, kind: 'other' })).toBeUndefined()
    expect(sessionActionValue({ ...value, session: '' })).toBeUndefined()
    expect(sessionActionValue({ ...value, key: undefined })).toBeUndefined()
    expect(sessionActionValue(null)).toBeUndefined()
  })

  it('refuses a payload that names no rendering', () => {
    // Without the mark a press cannot be tied to the card that handed it out,
    // so it cannot be refused once that card has been used — which is the whole
    // point of a single-use picker.
    expect(sessionActionValue({
      kind: SESSIONS_ACTION, session: 'session-x', key: 'oc_1', chatId: 'oc_1', chatType: 'p2p',
    })).toBeUndefined()
    expect(sessionActionValue({
      kind: SESSIONS_ACTION, a: '', session: 'session-x', key: 'oc_1', chatId: 'oc_1', chatType: 'p2p',
    })).toBeUndefined()
  })

  it('carries a page control, and refuses one that names both a row and a page', () => {
    const page = { kind: SESSIONS_ACTION, a: 'm1', page: 2, key: 'oc_1', chatId: 'oc_1', chatType: 'p2p' }
    expect(sessionActionValue(page)).toEqual(page)
    expect(sessionActionValue({ ...page, page: -1 })).toBeUndefined()
    expect(sessionActionValue({ ...page, page: 1.5 })).toBeUndefined()
    // A button that names neither is inert; one that names both has no single
    // subject, and accepting it would authorize a press with two meanings.
    expect(sessionActionValue({
      kind: SESSIONS_ACTION, a: 'm1', key: 'oc_1', chatId: 'oc_1', chatType: 'p2p',
    })).toBeUndefined()
  })

  it('carries the workspace the row was offered under, and drops a non-string one', () => {
    // The press is checked against this value: a card outlives the directory it
    // was drawn in, and `/cd` moves the conversation without repainting it.
    const value = {
      kind: SESSIONS_ACTION, a: 'm1', session: 'session-x', key: 'oc_1', chatId: 'oc_1', chatType: 'p2p',
      workspace: '/work',
    }
    expect(sessionActionValue(value)).toEqual(value)
    expect(sessionActionValue({ ...value, workspace: 7 })).toBeUndefined()
  })

  it('accepts a session id this channel did not mint', () => {
    // The rows a person presses are Web UI sessions named `session-…`, not the
    // channel's own `lark-…` ids. A switch that required the channel's prefix
    // refused every real row with "you may not change this conversation".
    const value = {
      kind: SESSIONS_ACTION, a: 'm1', session: 'session-13690074-5cbe-4801-9408-0fbe983677e6',
      key: 'oc_1', chatId: 'oc_1', chatType: 'p2p',
    }
    expect(sessionActionValue(value)?.session).toBe('session-13690074-5cbe-4801-9408-0fbe983677e6')
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

    expect(offered.rows).toEqual([])
    expect(offered.hidden).toBe(0)
    // A picker that silently shows an empty list looks the same as a workspace
    // with no sessions, and only one of those is worth waking someone for.
    expect(notes.join('\n')).toContain('listing sessions failed')
  })

  it('cannot be paged, and reports what it left out instead', async () => {
    // A page count derived from a bounded window would move every time a session
    // was opened on another surface, so the window says what it is.
    const rows = Array.from({ length: PICKER_ROWS + 6 }, (_, index) => ({
      id: `session-${index}`,
      createdAt: 10_000 - index,
      said: 10_000 - index,
    }))
    const offered = await offer(engine(rows))

    expect(offered.complete).toBe(false)
    expect(offered.hidden).toBeGreaterThan(0)
    expect(sessionsPage(offered, 3)).toEqual({ rows: offered.rows, page: 0, pages: 1 })
  })
})

describe('the picker where the host already folded a row', () => {
  /** One session as the projection cache holds it. */
  interface Folded {
    readonly id: string
    readonly createdAt: number
    readonly title?: string
    readonly turns?: number
    readonly blank?: boolean
    /** When a person last prompted it; what "recent" means in the list. */
    readonly prompted?: number
    /** The newest turn's opening prompt, as the outline recorded it. */
    readonly said?: string
  }

  /**
   * A cache serving fixed rows, over an engine that FAILS the moment its log is
   * read: opening a log is the cost this whole rung exists to avoid, so a test
   * that lets it happen silently is a test that proves nothing.
   */
  function folded(entries: readonly Folded[], live: readonly string[] = []) {
    const attending = new Set(live)
    const rows: HostSessionRecord[] = entries.map(entry => ({
      header: { id: entry.id, cwd: '/work', createdAt: entry.createdAt, version: 4, isSeeded: false },
      live: attending.has(entry.id),
    }))
    const asked: string[][] = []
    const cache = {
      cachedSnapshot: (meta: { id: string }, keys?: readonly string[]) => {
        const entry = entries.find(candidate => candidate.id === meta.id)
        if (entry === undefined) return undefined
        asked.push([...(keys ?? [])])
        const values: Record<string, unknown> = {
          title: entry.title ?? null,
          sessionStats: { turns: entry.turns ?? 0 },
          sessionListMetadata: { blank: entry.blank ?? false, lastPromptAt: entry.prompted ?? null },
        }
        if ((keys ?? []).includes('turnOutline')) {
          values.turnOutline = {
            turns: entry.said === undefined ? [] : [{ turn: 1, seq: 1, prompt: entry.said, response: '' }],
            draft: '',
          }
        }
        return { asOfSeq: 1, values }
      },
    }
    return {
      asked,
      cache,
      query: {
        listSessions: async () => rows,
        listEvents: async () => { throw new Error('the picker opened a log it did not need') },
        readEvent: async () => { throw new Error('the picker opened a log it did not need') },
      },
    }
  }

  /**
   * The derivation this rung is driven through: only the two faces the picker
   * reaches for are named, so an engine standing in for either rung fits.
   */
  interface Rung {
    readonly query: HostSessionQuery
    readonly cache: HostSessionProjectionCache
  }

  const offer = (engine: Rung, scope: SessionPickerInput = HERE) => offerSessions({
    query: engine.query,
    sources: { cache: engine.cache },
    scope,
    canonical: path => path,
  })

  it('describes the whole corpus, newest first, without opening a log', async () => {
    const engine = folded([
      { id: 'session-a', createdAt: 100, prompted: 300, said: '最前面那个' },
      { id: 'session-b', createdAt: 200, prompted: 100, said: '中间那个' },
      { id: 'session-c', createdAt: 300, prompted: 200, said: '最后那个' },
    ])
    const offered = await offer(engine)

    // Every candidate, not a bounded window of them — and therefore pageable.
    expect(offered.complete).toBe(true)
    expect(offered.hidden).toBe(0)
    expect(offered.rows.map(row => row.id)).toEqual(['session-a', 'session-c', 'session-b'])
    expect(offered.rows.map(row => row.turns)).toEqual([0, 0, 0])
  })

  it('reads the outline for the rows a page draws, and only for those', async () => {
    const engine = folded([
      { id: 'session-a', createdAt: 100, prompted: 300, said: '最前面那个' },
      { id: 'session-b', createdAt: 200, prompted: 200, said: '中间那个' },
      { id: 'session-c', createdAt: 300, prompted: 100, said: '最后那个' },
    ])
    const offered = await offer(engine)

    // The cheap pass never asks for the one key whose state grows with the
    // conversation: a fifty-turn session would otherwise be re-validated for
    // every candidate in the corpus.
    expect(engine.asked.every(keys => !keys.includes('turnOutline'))).toBe(true)

    const [drawn] = offered.rows
    const labelled = offered.label([drawn!])
    expect(labelled[0]!.lastSaid).toBe('最前面那个')
    expect(engine.asked.some(keys => keys.includes('turnOutline'))).toBe(true)
  })

  it('drops what nothing ever happened in, but never the conversation\'s own', async () => {
    const engine = folded([
      { id: 'session-never-used', createdAt: 300, blank: true },
      { id: 'lark-oc_1', createdAt: 200, blank: true },
      { id: 'session-real', createdAt: 100, turns: 4, said: '聊过' },
    ])
    const offered = await offer(engine)

    // The derived id is how a picked conversation comes back, so a quiet one of
    // its own is always on offer. Anything else nobody ever spoke in is not a
    // conversation to continue.
    expect(offered.rows.map(row => row.id)).toEqual(['lark-oc_1', 'session-real'])
  })

  it('matches a keyword against the cached titles, still without a log', async () => {
    const engine = folded([
      { id: 'session-a', createdAt: 300, prompted: 300, title: '部署脚本' },
      { id: 'session-b', createdAt: 200, prompted: 200, title: '前端样式' },
    ])
    const offered = await offer(engine, { ...HERE, keyword: '部署' })

    expect(offered.rows.map(row => row.id)).toEqual(['session-a'])
  })

  it('falls back to the log rung when a header cannot witness a stored row', async () => {
    // A listing older than the format-generation field cannot address a cache
    // record, and guessing at one would bind a row to the wrong log.
    const entries = [{ id: 'session-a', createdAt: 100, prompted: 300, said: '说了' }]
    const engine = folded(entries)
    const unaddressable = {
      ...engine,
      query: {
        ...engine.query,
        listSessions: async () => [{ header: { id: 'session-a', cwd: '/work', createdAt: 100 }, live: false }],
        listEvents: async () => [
          { sessionId: 'session-a', seq: 0, type: 'turn/start', time: 300 },
          { sessionId: 'session-a', seq: 1, type: 'user/message', time: 300 },
        ],
        readEvent: async () => ({
          events: [{
            seq: 1,
            type: 'user/message',
            time: 300,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: '从日志里读出来的' }] },
          }],
        }),
      },
    }
    const offered = await offer(unaddressable)

    expect(offered.complete).toBe(false)
    expect(offered.rows[0]!.lastSaid).toBe('从日志里读出来的')
  })
})

describe('how the picker pages', () => {
  /** A complete derivation over `count` rows, all distinct and none current. */
  function complete(count: number) {
    return {
      rows: Array.from({ length: count }, (_, index) => ({
        id: `session-${index}`,
        createdAt: 10_000 - index,
        live: false,
        own: false,
        current: false,
      })),
      hidden: 0,
      complete: true,
      label: (rows: readonly SessionChoice[]) => rows,
    }
  }

  it('draws at most one page worth, and reports how many there are', () => {
    const offered = complete(SESSIONS_PAGE_ROWS * 2)
    const first = sessionsPage(offered, 0)

    expect(first.rows).toHaveLength(SESSIONS_PAGE_ROWS)
    expect(first.pages).toBe(2)
    expect(first.page).toBe(0)
    expect(sessionsPage(offered, 1).rows).toHaveLength(SESSIONS_PAGE_ROWS)
  })

  it('clamps a page past the end onto the last one', () => {
    const offered = complete(SESSIONS_PAGE_ROWS + 1)
    const page = sessionsPage(offered, 99)

    expect(page.page).toBe(page.pages - 1)
    expect(page.rows.length).toBeGreaterThan(0)
  })

  it('keeps the conversation\'s own row on the first page, wherever it sorted', () => {
    const offered = { ...complete(SESSIONS_PAGE_ROWS * 2), rows: [
      ...complete(SESSIONS_PAGE_ROWS * 2).rows.slice(0, 3),
      { id: 'lark-oc_1', createdAt: 1, live: false, own: true, current: true },
      ...complete(SESSIONS_PAGE_ROWS * 2).rows.slice(3),
    ] }
    const first = sessionsPage(offered, 0)

    expect(first.rows[0]!.id).toBe('lark-oc_1')
    expect(sessionsPage(offered, 1).rows.some(row => row.id === 'lark-oc_1')).toBe(false)
  })
})
