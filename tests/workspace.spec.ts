import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sessionIdFor } from '../src/session.ts'
import {
  ChatWorkspaces,
  expandHome,
  forbiddenReason,
  probeDirectory,
  runWorkspaceCommand,
  withinRoots,
  workspaceSessionId,
} from '../src/workspace.ts'
import type { WorkspaceProbe } from '../src/workspace.ts'

/** A probe over a fixed set of directories; canonicalization strips a trailing slash. */
function fakeProbe(directories: readonly string[]): WorkspaceProbe {
  return (path) => {
    const canonical = path.endsWith('/') ? path.slice(0, -1) : path
    return directories.includes(canonical) ? { canonical } : { error: '目录不存在' }
  }
}

/** A store over fake directories, recording persisted patches. */
function createStore(options: {
  entries?: Record<string, string>
  roots?: string[]
  directories?: string[]
  persisted?: boolean
  known?: string[]
} = {}) {
  const patches: object[] = []
  const reports: string[] = []
  const store = new ChatWorkspaces({
    defaultPath: '/srv/default',
    entries: options.entries,
    roots: options.roots,
    probe: fakeProbe([
      ...options.directories ?? ['/srv/default', '/srv/alpha', '/srv/beta'],
      ...options.known ?? [],
    ]),
    home: '/home/me',
    known: () => options.known ?? [],
    persist: async (patch) => {
      patches.push(patch)
      return options.persisted ?? true
    },
    report: (line) => { reports.push(line) },
  })
  return { store, patches, reports }
}

describe('workspaceSessionId', () => {
  it('keeps the historical plain id for the default workspace', () => {
    expect(workspaceSessionId('oc_1')).toBe(sessionIdFor('oc_1'))
  })

  it('derives one stable, distinct id per directory', () => {
    const alpha = workspaceSessionId('oc_1', '/srv/alpha')
    expect(alpha).toBe(workspaceSessionId('oc_1', '/srv/alpha'))
    expect(alpha).not.toBe(workspaceSessionId('oc_1'))
    expect(alpha).not.toBe(workspaceSessionId('oc_1', '/srv/beta'))
    expect(alpha).not.toBe(workspaceSessionId('oc_2', '/srv/alpha'))
    expect(alpha.startsWith(`${sessionIdFor('oc_1')}--`)).toBe(true)
  })
})

describe('expandHome', () => {
  it('expands ~ and ~/ against the home, and leaves everything else alone', () => {
    expect(expandHome('~', '/home/me')).toBe('/home/me')
    expect(expandHome('~/work', '/home/me')).toBe('/home/me/work')
    expect(expandHome('/abs/path', '/home/me')).toBe('/abs/path')
    expect(expandHome('relative', '/home/me')).toBe('relative')
  })
})

describe('withinRoots', () => {
  it('allows anywhere on an empty list, and only descendants otherwise', () => {
    expect(withinRoots('/anywhere', [])).toBe(true)
    expect(withinRoots('/srv/alpha/sub', ['/srv/alpha'])).toBe(true)
    expect(withinRoots('/srv/alpha', ['/srv/alpha'])).toBe(true)
    expect(withinRoots('/srv/alphabet', ['/srv/alpha'])).toBe(false)
    expect(withinRoots('/other', ['/srv/alpha', '/srv/beta'])).toBe(false)
  })
})

describe('forbiddenReason', () => {
  it('refuses the filesystem root, the home root, and its parent', () => {
    expect(forbiddenReason('/', '/home/me')).toContain('根目录')
    expect(forbiddenReason('/home/me', '/home/me')).toContain('Home')
    expect(forbiddenReason('/home', '/home/me')).toContain('父级')
    expect(forbiddenReason('/home/me/work', '/home/me')).toBeUndefined()
  })
})

describe('probeDirectory', () => {
  it('canonicalizes a real directory and names what a bad path is', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')))
    expect(probeDirectory(directory)).toEqual({ canonical: directory })
    expect(probeDirectory(join(directory, 'absent'))).toEqual({ error: '目录不存在' })
  })
})

describe('ChatWorkspaces', () => {
  it('resolves the default for unknown keys and for the explicit-default marker', () => {
    const { store } = createStore({ entries: { back: '' } })
    expect(store.pathFor('fresh')).toBe('/srv/default')
    expect(store.pathFor('back')).toBe('/srv/default')
    expect(store.sessionIdFor('fresh')).toBe(sessionIdFor('fresh'))
    expect(store.sessionIdFor('back')).toBe(sessionIdFor('back'))
    expect(store.isDefault('fresh')).toBe(true)
  })

  it('routes an overridden key to its directory and its derived session id', () => {
    const { store } = createStore({ entries: { chat: '/srv/alpha' } })
    expect(store.pathFor('chat')).toBe('/srv/alpha')
    expect(store.sessionIdFor('chat')).toBe(workspaceSessionId('chat', '/srv/alpha'))
    expect(store.isDefault('chat')).toBe(false)
  })

  it('switches to an absolute directory and persists the canonical entry', async () => {
    const { store, patches } = createStore()
    const result = await store.switch('chat', '/srv/alpha/')
    expect(result).toMatchObject({ ok: true, changed: true, toDefault: false, path: '/srv/alpha' })
    expect(store.pathFor('chat')).toBe('/srv/alpha')
    expect(patches).toEqual([{ chatWorkspaces: { chat: '/srv/alpha' } }])
  })

  it('records a switch back to the default as the marker, resolving the plain id again', async () => {
    const { store, patches } = createStore({ entries: { chat: '/srv/alpha' } })
    const result = await store.switch('chat', '/srv/default')
    expect(result).toMatchObject({ ok: true, changed: true, toDefault: true })
    expect(store.sessionIdFor('chat')).toBe(sessionIdFor('chat'))
    expect(patches).toEqual([{ chatWorkspaces: { chat: '' } }])
  })

  it('treats re-switching to the current directory as unchanged and persists nothing', async () => {
    const { store, patches } = createStore({ entries: { chat: '/srv/alpha' } })
    expect(await store.switch('chat', '/srv/alpha')).toMatchObject({ ok: true, changed: false })
    expect(patches).toEqual([])
  })

  it('accepts the unique basename of a known workspace as shorthand', async () => {
    const { store } = createStore({ entries: { other: '/srv/alpha' } })
    const result = await store.switch('chat', 'alpha')
    expect(result).toMatchObject({ ok: true, path: '/srv/alpha' })
  })

  it('refuses an ambiguous or unknown shorthand with directions', async () => {
    const { store } = createStore({
      entries: { a: '/srv/x/dup', b: '/srv/y/dup' },
      directories: ['/srv/default', '/srv/x/dup', '/srv/y/dup'],
    })
    const ambiguous = await store.switch('chat', 'dup')
    expect(ambiguous).toMatchObject({ ok: false })
    if (!ambiguous.ok) expect(ambiguous.reason).toContain('多个目录')
    const unknown = await store.switch('chat', 'nowhere')
    expect(unknown).toMatchObject({ ok: false })
    if (!unknown.ok) expect(unknown.reason).toContain('绝对路径')
  })

  it('refuses a directory outside the configured roots, but never the default', async () => {
    const { store } = createStore({ roots: ['/srv/alpha'] })
    expect(await store.switch('chat', '/srv/beta')).toMatchObject({ ok: false })
    expect(await store.switch('chat', '/srv/alpha')).toMatchObject({ ok: true })
    // The operator chose the default; the roots knob narrows chats, not the deployment.
    expect(await store.switch('chat', '/srv/default')).toMatchObject({ ok: true, toDefault: true })
  })

  it('refuses a missing directory with the probe verdict', async () => {
    const { store } = createStore()
    const result = await store.switch('chat', '/srv/absent')
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('目录不存在')
  })

  it('refuses a forbidden directory even inside the configured roots', async () => {
    const { store } = createStore({ roots: ['/home'], directories: ['/srv/default', '/home/me'] })
    const result = await store.switch('chat', '/home/me')
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('Home')
  })

  it('offers host-registry workspaces for listing and bare-name switching', async () => {
    const { store } = createStore({ known: ['/srv/projects/gamma'] })
    expect(store.knownPaths()).toContain('/srv/projects/gamma')
    const result = await store.switch('chat', 'gamma')
    expect(result).toMatchObject({ ok: true, path: '/srv/projects/gamma' })
  })

  it('reports once when switches are not durable, and marks the result', async () => {
    const { store, reports } = createStore({ persisted: false })
    const first = await store.switch('chat', '/srv/alpha')
    expect(first).toMatchObject({ ok: true, durable: false })
    await store.switch('chat', '/srv/beta')
    expect(reports.filter(line => line.includes('in-memory only'))).toHaveLength(1)
  })
})

describe('runWorkspaceCommand', () => {
  const release = () => {
    releases += 1
    return Promise.resolve()
  }
  let releases = 0

  it('shows the current workspace for a bare /cd', async () => {
    releases = 0
    const { store } = createStore()
    const reply = await runWorkspaceCommand('cd', '/cd', 'chat', store, release)
    expect(reply).toContain('/srv/default')
    expect(reply).toContain('默认')
    expect(releases).toBe(0)
  })

  it('switches on /cd <dir>, releasing the current agent first', async () => {
    releases = 0
    const { store } = createStore()
    const reply = await runWorkspaceCommand('cd', '/cd /srv/alpha', 'chat', store, release)
    expect(reply).toContain('已切换到')
    expect(reply).toContain('/srv/alpha')
    expect(releases).toBe(1)
  })

  it('does not release when the switch failed or changed nothing', async () => {
    releases = 0
    const { store } = createStore({ entries: { chat: '/srv/alpha' } })
    await runWorkspaceCommand('cd', '/cd /srv/absent', 'chat', store, release)
    await runWorkspaceCommand('cd', '/cd /srv/alpha', 'chat', store, release)
    expect(releases).toBe(0)
  })

  it('lists known workspaces with shorthands, marking default and current', async () => {
    releases = 0
    const { store } = createStore({ entries: { chat: '/srv/alpha' } })
    const reply = await runWorkspaceCommand('ws', '/ws', 'chat', store, release)
    expect(reply).toContain(`\`${basename('/srv/default')}\``)
    expect(reply).toContain('默认')
    expect(reply).toContain('/srv/alpha')
    expect(reply).toContain('当前')
  })
})
