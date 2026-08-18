import { describe, expect, it } from 'vitest'
import {
  ChatModels,
  formatRoute,
  MODEL_ACTION,
  parseRoute,
  resolveRouteInput,
  runModelCommand,
} from '../src/model.ts'
import type { CatalogEntry } from '../src/model.ts'
import { readMeters, renderStatusCard, STATUS_ACTION } from '../src/status.ts'
import type { LarkDocCapabilitySnapshot } from '../src/capability.ts'
import { cardControls, cardTexts } from './harness.ts'

const catalog: CatalogEntry[] = [
  { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
  { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  { provider: 'pi', id: 'org/shared-model', name: 'Shared A' },
  { provider: 'qi', id: 'org/shared-model', name: 'Shared B' },
]

const DOCUMENT_CAPABILITIES: LarkDocCapabilitySnapshot = {
  read: { enabled: true, missingScopes: [], scopeMapVerified: true, source: 'scope-list' },
  write: { enabled: true, missingScopes: [], scopeMapVerified: true, source: 'scope-list' },
  comment: { enabled: false, missingScopes: ['docs:document.comment:create'], scopeMapVerified: true, source: 'scope-list' },
}

/** A store recording persisted patches. */
function createStore(options: { entries?: Record<string, string>; persisted?: boolean } = {}) {
  const patches: object[] = []
  const reports: string[] = []
  const store = new ChatModels({
    entries: options.entries,
    persist: async (patch) => {
      patches.push(patch)
      return options.persisted ?? true
    },
    report: (line) => { reports.push(line) },
  })
  return { store, patches, reports }
}

/** Ports over the fixed catalog, counting releases. */
function createPorts(entries: readonly CatalogEntry[] = catalog) {
  const state = { releases: 0 }
  return {
    state,
    ports: {
      catalog: async () => entries,
      deploymentRoute: () => 'deepseek/deepseek-chat',
      release: async () => { state.releases += 1 },
    },
  }
}

describe('routes', () => {
  it('formats full, partial, and absent selections', () => {
    expect(formatRoute({ provider: 'deepseek', model: 'deepseek-chat' })).toBe('deepseek/deepseek-chat')
    expect(formatRoute({ model: 'deepseek-chat' })).toBe('deepseek-chat')
    expect(formatRoute({})).toBe('宿主默认')
  })

  it('parses at the FIRST slash, so org/model ids survive the round trip', () => {
    expect(parseRoute('pi/org/shared-model')).toEqual({ provider: 'pi', model: 'org/shared-model' })
    expect(parseRoute('no-slash')).toBeUndefined()
    expect(parseRoute('/leading')).toBeUndefined()
    expect(parseRoute('trailing/')).toBeUndefined()
  })

  it('resolves a bare model id only when exactly one route advertises it', () => {
    expect(resolveRouteInput('deepseek-reasoner', catalog))
      .toEqual({ route: { provider: 'deepseek', model: 'deepseek-reasoner' }, listed: true })
    const ambiguous = resolveRouteInput('org/shared-model', catalog)
    // A slash form is taken literally, so this reads as provider 'org' — unlisted.
    expect(ambiguous).toMatchObject({ listed: false })
    const missing = resolveRouteInput('nowhere', catalog)
    expect(missing).toMatchObject({ reason: expect.stringContaining('目录里没有') })
    const noCatalog = resolveRouteInput('anything', [])
    expect(noCatalog).toMatchObject({ reason: expect.stringContaining('provider/model') })
  })

  it('flags a full form the catalog does not advertise, without rejecting it', () => {
    expect(resolveRouteInput('deepseek/brand-new-model', catalog))
      .toEqual({ route: { provider: 'deepseek', model: 'brand-new-model' }, listed: false })
  })
})

describe('ChatModels', () => {
  it('resolves overrides, markers, and unknown keys', () => {
    const { store } = createStore({ entries: { chat: 'deepseek/deepseek-reasoner', back: '' } })
    expect(store.routeFor('chat')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(store.routeFor('back')).toBeUndefined()
    expect(store.routeFor('fresh')).toBeUndefined()
    expect(store.isDefault('chat')).toBe(false)
  })

  it('persists a set and a reset, skipping unchanged writes', async () => {
    const { store, patches } = createStore()
    expect(await store.set('chat', { provider: 'deepseek', model: 'deepseek-reasoner' }))
      .toMatchObject({ changed: true, durable: true })
    expect(await store.set('chat', { provider: 'deepseek', model: 'deepseek-reasoner' }))
      .toMatchObject({ changed: false })
    expect(await store.reset('chat')).toMatchObject({ changed: true })
    expect(patches).toEqual([
      { chatModels: { chat: 'deepseek/deepseek-reasoner' } },
      { chatModels: { chat: '' } },
    ])
  })

  it('reports once when switches are not durable', async () => {
    const { store, reports } = createStore({ persisted: false })
    await store.set('chat', { provider: 'a', model: 'b' })
    await store.set('chat', { provider: 'c', model: 'd' })
    expect(reports.filter(line => line.includes('in-memory only'))).toHaveLength(1)
  })
})

/** The conversation a command line is about, as the bridge resolves it. */
const SUBJECT = { key: 'chat', chatId: 'oc_1', chatType: 'p2p' }

/** The markdown one reply carries, for the text forms. */
function markdownOf(reply: { markdown: string } | { card: object }): string {
  if (!('markdown' in reply)) throw new Error('expected a text reply, got a card')
  return reply.markdown
}

/** The card one reply carries, for the picker form. */
function cardOf(reply: { markdown: string } | { card: object }): object {
  if (!('card' in reply)) throw new Error('expected a card reply, got text')
  return reply.card
}

describe('runModelCommand', () => {
  it('answers a bare /model with a picker over the catalog', async () => {
    const { store } = createStore()
    const { ports } = createPorts()
    const card = cardOf(await runModelCommand('/model', SUBJECT, store, ports))
    const texts = cardTexts(card).map((text) => text.content)
    expect(texts).toContain('deepseek/deepseek-reasoner')
    expect(texts).toContain('DeepSeek Reasoner')
    // Every advertised route is one press away, carrying the conversation it
    // switches; on the default there is nothing to reset to.
    expect(cardControls(card).map((control) => control.value)).toContainEqual(
      expect.objectContaining(
        { kind: MODEL_ACTION, key: 'chat', chatId: 'oc_1', chatType: 'p2p', route: 'deepseek/deepseek-reasoner' },
      ),
    )
    expect(cardControls(card).every((control) => (control.value as { route?: string }).route !== undefined)).toBe(true)
  })

  it('offers a way back once a conversation left the default', async () => {
    const { store } = createStore({ entries: { chat: 'deepseek/deepseek-reasoner' } })
    const { ports } = createPorts()
    const card = cardOf(await runModelCommand('/model', SUBJECT, store, ports))
    const controls = cardControls(card)
    expect(controls.some((control) => (control.value as { route?: string }).route === undefined)).toBe(true)
    // The current route is shown without a button: re-picking it does nothing.
    expect(controls.some((control) => (control.value as { route?: string }).route === 'deepseek/deepseek-reasoner'))
      .toBe(false)
  })

  it('carries the clicking rules of a per-sender conversation into its card', async () => {
    const { store } = createStore()
    const { ports } = createPorts()
    const card = cardOf(
      await runModelCommand('/model', { ...SUBJECT, owner: 'ou_owner' }, store, ports),
    )
    expect((cardControls(card)[0]!.value as { owner?: string }).owner).toBe('ou_owner')
  })

  it('switches on use, releasing so the same session resumes on the new route', async () => {
    const { store, patches } = createStore()
    const { ports, state } = createPorts()
    const reply = markdownOf(await runModelCommand('/model use deepseek-reasoner', SUBJECT, store, ports))
    expect(reply).toContain('已切换到 `deepseek/deepseek-reasoner`')
    expect(reply).toContain('上下文保留')
    expect(state.releases).toBe(1)
    expect(patches).toEqual([{ chatModels: { chat: 'deepseek/deepseek-reasoner' } }])
  })

  it('does not release when nothing changed or the input failed to resolve', async () => {
    const { store } = createStore({ entries: { chat: 'deepseek/deepseek-reasoner' } })
    const { ports, state } = createPorts()
    await runModelCommand('/model use deepseek/deepseek-reasoner', SUBJECT, store, ports)
    await runModelCommand('/model use nowhere', SUBJECT, store, ports)
    expect(state.releases).toBe(0)
  })

  it('notes an unlisted route instead of rejecting it, per the advisory contract', async () => {
    const { store } = createStore()
    const { ports } = createPorts()
    const reply = markdownOf(await runModelCommand('/model use deepseek/brand-new', SUBJECT, store, ports))
    expect(reply).toContain('已切换到')
    expect(reply).toContain('目录未列出该路由')
  })

  it('resets to the deployment default, and reports usage for anything else', async () => {
    const { store } = createStore({ entries: { chat: 'deepseek/deepseek-reasoner' } })
    const { ports, state } = createPorts()
    const reply = markdownOf(await runModelCommand('/model reset', SUBJECT, store, ports))
    expect(reply).toContain('已切回默认模型')
    expect(state.releases).toBe(1)
    expect(markdownOf(await runModelCommand('/model reset', SUBJECT, store, ports)))
      .toContain('已在使用默认模型')
    expect(markdownOf(await runModelCommand('/model frobnicate', SUBJECT, store, ports))).toContain('用法')
  })
})

describe('readMeters', () => {
  /** A projection registry answering with one fixed cut. */
  const projections = (values: Record<string, unknown>) => ({
    snapshot: () => ({ asOfSeq: 1, values }),
  })
  const session = { id: 's1' }

  it('reads context occupancy and whole-session tokens', () => {
    const meters = readMeters(
      projections({
        contextPressure: { pressureTokens: 30_000, projectedTokens: 32_500, contextWindow: 128_000 },
        tokenUsage: { uncachedInputTokens: 41_000, outputTokens: 6_200, cacheReadTokens: 12_000, cacheWriteTokens: 0 },
      }),
      session,
    )
    // The projected figure wins: a status report answers for the NEXT message.
    expect(meters.context).toEqual({ used: 32_500, window: 128_000 })
    expect(meters.usage).toEqual({ input: 41_000, output: 6_200, cacheRead: 12_000, cacheWrite: 0 })
  })

  it('says nothing where there is nothing to say', () => {
    // No meter composed, no live session, and a session that has not asked yet.
    expect(readMeters(undefined, session)).toEqual({})
    expect(readMeters(projections({}), undefined)).toEqual({})
    expect(readMeters(projections({}), session)).toEqual({})
    const fresh = readMeters(
      projections({ tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
      session,
    )
    expect(fresh.usage).toBeUndefined()
  })

  it('survives a meter that throws rather than losing the whole report', () => {
    const broken = { snapshot: () => { throw new Error('projection exploded') } }
    expect(readMeters(broken, session)).toEqual({})
  })
})

describe('renderStatusCard', () => {
  /** Every string one status card renders. */
  const shown = (card: object): string[] => cardTexts(card).map((text) => text.content)

  it('states routing, activity, and approvals only when pending', () => {
    const idle = renderStatusCard({
      workspace: '/srv/work',
      workspaceIsDefault: true,
      route: 'deepseek/deepseek-chat',
      routeIsDefault: true,
      sessionId: 'lark-oc_1',
      bound: true,
      running: false,
      pendingApprovals: 0,
      version: '0.0.3',
      documentCapabilities: DOCUMENT_CAPABILITIES,
    }, SUBJECT)
    expect(shown(idle)).toContain('/srv/work')
    // Meters are absent here, so the card claims no numbers at all.
    expect(shown(idle).some((text) => text.includes('上下文'))).toBe(false)
    expect(shown(idle)).toContain('0.0.3')
    expect(shown(idle)).toContain('空闲')
    expect(shown(idle)).toContain('读 ✓　写 ✓　评论 ✗（缺 docs:document.comment:create）')
    expect(shown(idle)).not.toContain('待审批')
    // The refresh button re-reads the same conversation it was built for.
    expect(cardControls(idle).map((control) => control.value))
      .toEqual([expect.objectContaining({ kind: STATUS_ACTION, key: 'chat', chatId: 'oc_1', chatType: 'p2p' })])

    const busy = renderStatusCard({
      workspace: '/srv/other',
      workspaceIsDefault: false,
      route: 'pi/org/shared-model',
      routeIsDefault: false,
      sessionId: 'lark-oc_1--abc',
      bound: true,
      running: true,
      pendingApprovals: 2,
      version: '0.0.3',
      documentCapabilities: DOCUMENT_CAPABILITIES,
    }, SUBJECT)
    expect(shown(busy)).toContain('正在跑一轮任务')
    expect(shown(busy)).toContain('2 个审批卡片等待处理')

    const fresh = renderStatusCard({
      workspace: '/srv/work',
      workspaceIsDefault: true,
      route: 'deepseek/deepseek-chat',
      routeIsDefault: true,
      sessionId: 'lark-oc_2',
      bound: false,
      running: false,
      pendingApprovals: 0,
      version: '',
      documentCapabilities: DOCUMENT_CAPABILITIES,
    }, SUBJECT)
    expect(shown(fresh).some((text) => text.includes('尚未创建'))).toBe(true)
    // An unknown version hides the row rather than printing an empty claim.
    expect(shown(fresh)).not.toContain('版本')
  })
})
