import { describe, expect, it } from 'vitest'
import { isFreshSessionId, mintFreshSessionId, runNewCommand } from '../src/new-session.ts'
import { ChatSessionPointers } from '../src/sessions.ts'

describe('minting a fresh session', () => {
  it('never names a session the conversation already ran', () => {
    // The counter this replaced could hand back an id the conversation had
    // already used, and an archived one at that. Randomness is what makes that
    // impossible, so distinct calls must produce distinct ids.
    const ids = new Set(Array.from({ length: 64 }, () => mintFreshSessionId('lark-oc_1--abc123')))
    expect(ids.size).toBe(64)
    for (const id of ids) {
      expect(id).toMatch(/^lark-oc_1--abc123--s[0-9a-f]{8}$/)
      expect(isFreshSessionId(id)).toBe(true)
    }
  })

  it('keeps a minted id apart from a derived or legacy one', () => {
    expect(isFreshSessionId('lark-oc_1')).toBe(false)
    expect(isFreshSessionId('lark-oc_1--abc123')).toBe(false)
    expect(isFreshSessionId('lark-oc_1--e3')).toBe(false)
    expect(isFreshSessionId('session-1234')).toBe(false)
  })
})

describe('/new', () => {
  /** A pointer store over an in-memory settings section. */
  function pointers(entries: Record<string, string> = {}, persisted = true) {
    const patches: object[] = []
    const reports: string[] = []
    const store = new ChatSessionPointers({
      entries,
      persist: async (patch) => { patches.push(patch); return persisted },
      report: (line) => { reports.push(line) },
    })
    return { store, patches, reports }
  }

  it('mints under its anchor, points there, and releases the old agent', async () => {
    const { store, patches, reports } = pointers()
    const released: number[] = []
    const started = await runNewCommand({
      anchorId: 'lark-oc_1--abc123',
      pointer: store,
      release: async () => { released.push(1) },
      random: () => 'ffffffff-0000-4000-8000-000000000000',
      report: (line) => { reports.push(line) },
    })

    expect(started.sessionId).toBe('lark-oc_1--abc123--sffffffff')
    expect(started.durable).toBe(true)
    expect(store.pointerFor('lark-oc_1--abc123')).toBe(started.sessionId)
    expect(patches).toEqual([{ chatSessions: { 'lark-oc_1--abc123': started.sessionId } }])
    expect(released).toHaveLength(1)
    expect(started.reply).toContain('已开新会话')
    expect(started.reply).toContain('--sffffffff')
    // Nothing is deleted, and the rest of the conversation's setup stands.
    expect(started.reply).toContain('之前的记录仍在')
    expect(started.reply).toContain('工作区和模型设置不变')
    expect(reports.some(line => line.includes(started.sessionId))).toBe(true)
  })

  it('starts a blank session even when the pointer cannot be stored', async () => {
    const { store, reports } = pointers({}, false)
    const started = await runNewCommand({
      anchorId: 'lark-oc_1',
      pointer: store,
      release: async () => {},
      report: (line) => { reports.push(line) },
    })

    // The in-memory move stands, so the next message still starts blank — the
    // worst case is the session this conversation was already on.
    expect(store.pointerFor('lark-oc_1')).toBe(started.sessionId)
    expect(started.durable).toBe(false)
    expect(started.reply).toContain('重启后会回到上一个会话')
    expect(reports.some(line => line.includes('in-memory only'))).toBe(true)
  })

  it('moves only the directory it was asked for', async () => {
    const { store } = pointers({ 'lark-oc_1--abc123': 'session-web-ui', 'lark-oc_1--def456': 'session-other' })
    const started = await runNewCommand({ anchorId: 'lark-oc_1--abc123', pointer: store, release: async () => {} })

    expect(store.pointerFor('lark-oc_1--abc123')).toBe(started.sessionId)
    // The thread of a directory the conversation is not in is left alone.
    expect(store.pointerFor('lark-oc_1--def456')).toBe('session-other')
  })

  it('records the pointer before releasing, so a crash lands on the blank session', async () => {
    const { store } = pointers()
    const seen: (string | undefined)[] = []
    const started = await runNewCommand({
      anchorId: 'lark-oc_1',
      pointer: store,
      release: async () => { seen.push(store.pointerFor('lark-oc_1')) },
    })

    expect(seen).toEqual([started.sessionId])
  })
})
