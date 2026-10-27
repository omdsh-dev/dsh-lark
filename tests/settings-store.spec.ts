/**
 * The settings seam moved between host generations: an older host registered a
 * namespace against a schema and handed back a scope, while the host this
 * package declares writes a Loader row's volatile config by the row's own id.
 * This binding is what keeps managed state durable on either generation — or
 * says once, in the operator's console, that it cannot be durable at all.
 * These cases pin the three branches, the row id, and the refusal report.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createSettingsBinding, entryIdOf, userSectionOf } from '../src/settings-store.ts'
import { Config } from '../src/config.ts'

const base = { chatWorkspaces: { oc_1: '/work' } }

/** One field's schema node, as the host reads it. */
function fieldOf(key: string): { meta: Record<string, unknown> } {
  const dict = (Config as unknown as { dict: Record<string, { meta: Record<string, unknown> }> }).dict
  return dict[key]!
}

describe('the document section migration reads', () => {
  it('answers the document\'s own contribution for a row the host lists', () => {
    const settings = {
      describe: () => [
        { ns: 'lark-channel', value: { appSecret: 'from-document' }, user: { appSecret: 'from-document' } },
        { ns: 'other', value: {} },
      ],
    }

    expect(userSectionOf(settings, 'lark-channel')).toEqual({ appSecret: 'from-document' })
    // A row the document says nothing about answers an empty section, which is
    // what keeps a composition-injected secret out of the migration.
    expect(userSectionOf(settings, 'other')).toEqual(undefined)
  })

  it('answers nothing for a host that publishes no document section', () => {
    expect(userSectionOf({ update: async () => {} }, 'lark-channel')).toBeUndefined()
    expect(userSectionOf(undefined, 'lark-channel')).toBeUndefined()
    expect(userSectionOf({ describe: () => { throw new Error('no tree') } }, 'lark-channel')).toBeUndefined()
  })
})

describe('the fields the host may write', () => {
  it('marks every managed-state and credential field volatile', () => {
    // The host refuses a patch to a field its schema does not mark volatile
    // (`volatileForm` / `isVolatilePath`), which is exactly what kept this
    // channel's state in memory while the seam looked like it was working.
    for (const key of ['appId', 'appSecret', 'appSecretRef', 'chatWorkspaces', 'chatModels', 'chatEpochs', 'chatSessions']) {
      expect(fieldOf(key).meta.volatile, key).toBe(true)
    }
  })

  it('leaves a field read while an agent is built non-volatile', () => {
    // Editing one of these live is a decision that needs the row to remount.
    for (const key of ['cwd', 'workspaceRoots', 'model', 'sendFiles', 'requireMention']) {
      expect(fieldOf(key).meta.volatile, key).toBeUndefined()
    }
  })
})

describe('the row id a modern write names', () => {
  it('reads the Loader row id off the plugin fiber', () => {
    expect(entryIdOf({ fiber: { entry: { options: { id: 'lark-channel-support' } } } } as unknown as Context))
      .toBe('lark-channel-support')
  })

  it('answers nothing when the tree names no row', () => {
    expect(entryIdOf({} as unknown as Context)).toBeUndefined()
    expect(entryIdOf({ fiber: { entry: { options: { id: '' } } } } as unknown as Context)).toBeUndefined()
    expect(entryIdOf({ fiber: { entry: {} } } as unknown as Context)).toBeUndefined()
  })
})

describe('binding managed state to the settings seam', () => {
  it('writes through the modern seam, keyed by the row id', async () => {
    const update = vi.fn(async () => {})
    const lines: string[] = []
    const binding = createSettingsBinding({
      settings: { describe: () => [], update },
      entryId: 'lark-channel',
      namespace: 'lark-channel',
      schema: {},
      base,
      report: line => lines.push(line),
    })
    expect(binding.resolved).toBeUndefined()
    expect(await binding.persist({ chatWorkspaces: { oc_1: '/next' } })).toBe(true)
    expect(update).toHaveBeenCalledWith('lark-channel', { chatWorkspaces: { oc_1: '/next' } })
    expect(lines).toEqual([])
  })

  it('drops a field the row does not declare rather than losing the whole patch', async () => {
    // A host that validates refuses the WHOLE patch over one undeclared key —
    // which is how a registration once lost the credentials it had just
    // created, because the same patch also reported who scanned the code.
    const update = vi.fn(async () => {})
    const lines: string[] = []
    const binding = createSettingsBinding({
      settings: { describe: () => [], update },
      entryId: 'lark-channel',
      namespace: 'lark-channel',
      schema: Config,
      base,
      report: line => lines.push(line),
    })

    expect(await binding.persist({ appId: 'cli_1', appSecretRef: 'LARK_APP_SECRET', registeredBy: 'ou_x' })).toBe(true)
    expect(update).toHaveBeenCalledWith('lark-channel', { appId: 'cli_1', appSecretRef: 'LARK_APP_SECRET' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('registeredBy')

    // Nothing this row owns: there is no write to make, and it says why once.
    expect(await binding.persist({ registeredBy: 'ou_y' })).toBe(false)
    expect(update).toHaveBeenCalledTimes(1)
    expect(lines).toHaveLength(1)
  })

  it('writes every field when the schema is unreadable, as an older host passes none', async () => {
    const update = vi.fn(async () => {})
    const binding = createSettingsBinding({
      settings: { describe: () => [], update },
      entryId: 'lark-channel',
      namespace: 'lark-channel',
      schema: {},
      base,
      report: () => {},
    })

    expect(await binding.persist({ chatWorkspaces: { oc_1: '/next' }, extra: true })).toBe(true)
    expect(update).toHaveBeenCalledWith('lark-channel', { chatWorkspaces: { oc_1: '/next' }, extra: true })
  })

  it("reports a refused write once, in the host's own words", async () => {
    // "not volatile" and "overridden by a home patch" are fixes the operator can
    // make; a channel that quietly kept the state in memory is the failure this
    // binding exists to end.
    const update = vi.fn(async () => {
      throw new Error('Config field "chatWorkspaces" is not volatile')
    })
    const lines: string[] = []
    const binding = createSettingsBinding({
      settings: { describe: () => [], update },
      entryId: 'lark-channel',
      namespace: 'lark-channel',
      schema: {},
      base,
      report: line => lines.push(line),
    })
    expect(await binding.persist({ chatWorkspaces: {} })).toBe(false)
    expect(await binding.persist({ chatWorkspaces: {} })).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('not volatile')
  })

  it('uses the older seam when it is the only one composed', async () => {
    const updates: object[] = []
    const registered: string[] = []
    const binding = createSettingsBinding({
      settings: {
        register: (ns: string, _schema: unknown, options?: { base?: unknown }) => {
          registered.push(ns)
          return {
            get: () => ({ ...(options?.base as object), chatModels: { oc_1: 'a/b' } }),
            update: async (patch: object) => { updates.push(patch) },
          }
        },
      },
      entryId: 'lark-channel',
      namespace: 'lark-channel',
      schema: {},
      base,
      report: () => {},
    })
    expect(registered).toEqual(['lark-channel'])
    expect(binding.resolved).toEqual({ ...base, chatModels: { oc_1: 'a/b' } })
    expect(await binding.persist({ chatModels: { oc_1: 'c/d' } })).toBe(true)
    expect(updates).toEqual([{ chatModels: { oc_1: 'c/d' } }])
  })

  it('keeps the channel in memory and says so when no seam is usable', async () => {
    const lines: string[] = []
    const binding = createSettingsBinding({
      settings: {},
      entryId: 'lark-channel',
      namespace: 'lark-channel',
      schema: {},
      base,
      report: line => lines.push(line),
    })
    expect(await binding.persist({ chatWorkspaces: {} })).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('in memory only')
  })

  it('names the missing row id when the write path exists without one', async () => {
    const lines: string[] = []
    const binding = createSettingsBinding({
      settings: { update: async () => {} },
      entryId: undefined,
      namespace: 'lark-channel',
      schema: {},
      base,
      report: line => lines.push(line),
    })

    // The operator fix is to name the row, so that is what the line says —
    // rather than claiming the host offers no settings seam at all.
    expect(await binding.persist({ chatWorkspaces: {} })).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('row id')
  })

  it('says so when no settings service is composed at all', () => {
    const lines: string[] = []
    createSettingsBinding({
      settings: undefined,
      entryId: undefined,
      namespace: 'lark-channel',
      schema: {},
      base,
      report: line => lines.push(line),
    })
    expect(lines).toEqual([expect.stringContaining('no settings service is composed')])
  })

  it('reports a namespace an older host refuses to register', () => {
    const lines: string[] = []
    createSettingsBinding({
      settings: {
        register: () => { throw new Error('duplicate namespace') },
      },
      entryId: 'lark-channel',
      namespace: 'lark-channel',
      schema: {},
      base,
      report: line => lines.push(line),
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('duplicate namespace')
  })
})
