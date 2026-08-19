import { describe, expect, it } from 'vitest'
import { ChatEpochs, epochSessionId, runNewCommand } from '../src/epoch.ts'
import { ChatWorkspaces } from '../src/workspace.ts'

/** A store over an in-memory settings section. */
function createStore(entries: Record<string, string> = {}, persisted = true) {
  const patches: object[] = []
  const reports: string[] = []
  const epochs = new ChatEpochs({
    entries,
    persist: async (patch) => { patches.push(patch); return persisted },
    report: (line) => { reports.push(line) },
  })
  return { epochs, patches, reports }
}

describe('epoch ids', () => {
  it('leaves the first epoch deriving exactly what it always did', () => {
    // A change here orphans every stored conversation, so it is pinned.
    expect(epochSessionId('lark-oc_1', 0)).toBe('lark-oc_1')
    expect(epochSessionId('lark-oc_1--abc123', 0)).toBe('lark-oc_1--abc123')
    expect(epochSessionId('lark-oc_1', 2)).toBe('lark-oc_1--e2')
  })

  it('reads a hand-edited entry without breaking every message', () => {
    const { epochs } = createStore({ 'lark-oc_1': 'nonsense', 'lark-oc_2': '-3', 'lark-oc_3': '4' })
    expect(epochs.epochOf('lark-oc_1')).toBe(0)
    expect(epochs.epochOf('lark-oc_2')).toBe(0)
    expect(epochs.epochOf('lark-oc_3')).toBe(4)
    expect(epochs.epochOf('lark-never-seen')).toBe(0)
  })

  it('counts up per conversation, persisting each move', async () => {
    const { epochs, patches } = createStore()
    expect(await epochs.startNew('lark-oc_1')).toEqual({ epoch: 1, durable: true })
    expect(await epochs.startNew('lark-oc_1')).toEqual({ epoch: 2, durable: true })
    expect(epochs.epochOf('lark-oc_1')).toBe(2)
    // Another conversation is untouched by both.
    expect(epochs.epochOf('lark-oc_2')).toBe(0)
    expect(patches).toEqual([
      { chatEpochs: { 'lark-oc_1': '1' } },
      { chatEpochs: { 'lark-oc_1': '2' } },
    ])
  })

  it('warns once when the move cannot outlive the process', async () => {
    const { epochs, reports } = createStore({}, false)
    await epochs.startNew('lark-oc_1')
    await epochs.startNew('lark-oc_1')
    expect(reports.filter(line => line.includes('in-memory only'))).toHaveLength(1)
  })
})

describe('/new against a workspace', () => {
  /** A workspace store whose epochs come from a real epoch store. */
  function workspaces(epochs: ChatEpochs, entries: Record<string, string> = {}) {
    return new ChatWorkspaces({
      defaultPath: '/srv/work',
      entries,
      epochOf: (baseId) => epochs.epochOf(baseId),
      probe: (path: string) => ({ canonical: path }),
    })
  }

  it('starts a fresh session where the conversation stands, not everywhere', async () => {
    const { epochs } = createStore()
    // The conversation is `/cd`-ed somewhere, so its id already carries a
    // directory digest; `/new` has to move THAT id, not the default one.
    const store = workspaces(epochs, { chat: '/srv/other' })
    const inOther = store.sessionIdFor('chat')
    expect(inOther).toMatch(/^lark-chat--[0-9a-f]{10}$/)

    await epochs.startNew(store.baseSessionIdFor('chat'))
    expect(store.sessionIdFor('chat')).toBe(`${inOther}--e1`)

    // Back at the default directory, the thread that was never reset is intact.
    const atDefault = workspaces(epochs)
    expect(atDefault.sessionIdFor('chat')).toBe('lark-chat')
  })

  it('keeps a named instance apart from the original row', async () => {
    const { epochs } = createStore()
    const second = new ChatWorkspaces({
      defaultPath: '/srv/work',
      sessionPrefix: 'lark-support-',
      epochOf: (baseId) => epochs.epochOf(baseId),
      probe: (path: string) => ({ canonical: path }),
    })
    await epochs.startNew(second.baseSessionIdFor('chat'))
    expect(second.sessionIdFor('chat')).toBe('lark-support-chat--e1')
    // The original row's conversation of the same name never moved.
    expect(workspaces(epochs).sessionIdFor('chat')).toBe('lark-chat')
  })

  it('releases the old agent before answering, and says what is kept', async () => {
    const { epochs } = createStore()
    const released: number[] = []
    const reply = await runNewCommand('lark-oc_1', epochs, async () => { released.push(1) })
    expect(released).toHaveLength(1)
    expect(reply).toContain('已开新会话')
    // Nothing is deleted, and the rest of the conversation's setup stands.
    expect(reply).toContain('之前的记录仍在')
    expect(reply).toContain('工作区和模型设置不变')
  })

  it('says so when the move will not survive a restart', async () => {
    const { epochs } = createStore({}, false)
    const reply = await runNewCommand('lark-oc_1', epochs, async () => {})
    expect(reply).toContain('重启后会回到上一个会话')
  })
})
