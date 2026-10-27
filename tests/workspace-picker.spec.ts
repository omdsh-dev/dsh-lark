import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_ACTION,
  workspaceActionValue,
  workspaceChoices,
  workspacePage,
  WS_PAGE_ROWS,
} from '../src/workspace.ts'
import type { ChatWorkspaces } from '../src/workspace.ts'

/** A store stand-in: only the three reads the picker makes. */
function store(current: string, known: readonly string[]): ChatWorkspaces {
  return {
    pathFor: () => current,
    knownPaths: () => [...known],
  } as unknown as ChatWorkspaces
}

describe('which directories the picker offers', () => {
  it('leads with the one the conversation is in, then keeps listing order', () => {
    const choices = workspaceChoices(store('/work/b', ['/work/a', '/work/b', '/work/c']), 'chat')
    expect(choices.map(choice => choice.path)).toEqual(['/work/b', '/work/a', '/work/c'])
    expect(choices[0]!.current).toBe(true)
  })

  it('marks the deployment default, which is always the first listed', () => {
    const choices = workspaceChoices(store('/work/a', ['/work/a', '/work/b']), 'chat')
    // The current row leads as well here, so the default marker rides that row.
    expect(choices.find(choice => choice.isDefault)?.path).toBe('/work/a')
  })

  it('names each row by its last segment', () => {
    const choices = workspaceChoices(store('/a', ['/work/deepseek', '/x/y']), 'chat')
    expect(choices.map(choice => choice.name)).toEqual(['deepseek', 'y'])
  })

  it('offers the current directory exactly once, however the listing spells it', () => {
    const noCurrent = workspaceChoices(store('/elsewhere', ['/work/a']), 'chat')
    expect(noCurrent.filter(choice => choice.current)).toHaveLength(0)
  })
})

describe('how the picker pages', () => {
  /** `count` rows, the first of them current, named `/p/<n>`. */
  function rows(count: number) {
    return workspaceChoices(store('/p/0', Array.from({ length: count }, (_, i) => `/p/${i}`)), 'chat')
  }

  it('pins the current directory to the first page whatever page was asked for', () => {
    const first = workspacePage(rows(50), 0)
    expect(first.rows[0]!.path).toBe('/p/0')
    expect(first.rows[0]!.current).toBe(true)
    // Asking for a later page does not move it: it is simply not drawn there,
    // and the first page is where a reader goes to see where they are.
    expect(workspacePage(rows(50), 3).page).toBe(3)
  })

  it('draws the current directory on the first page only, never twice', () => {
    // You decided the current row is pinned to the first page's first line. It
    // is therefore absent from later pages: showing it on each of them would be
    // two buttons for one destination, and would shrink pages that do not carry
    // it for a row they never draw.
    expect(workspacePage(rows(50), 0).rows[0]!.current).toBe(true)
    expect(workspacePage(rows(50), 2).rows.filter(row => row.current)).toHaveLength(0)
  })

  it('fills a page with the rows the pinned one leaves room for', () => {
    const page = workspacePage(rows(50), 0)
    // Ten rows of capacity, one of them taken by the pinned current row.
    expect(page.rows).toHaveLength(WS_PAGE_ROWS)
    expect(page.rows.map(row => row.path)).toEqual(
      ['/p/0', ...Array.from({ length: WS_PAGE_ROWS - 1 }, (_, i) => `/p/${i + 1}`)],
    )
  })

  it('walks every row exactly once across the pages', () => {
    const all = rows(25)
    const seen = new Set<string>()
    for (let page = 0; page < workspacePage(all, 0).pages; page += 1) {
      for (const row of workspacePage(all, page).rows) {
        expect(seen.has(row.path)).toBe(false)
        seen.add(row.path)
      }
    }
    expect([...seen].sort()).toEqual(all.map(row => row.path).sort())
  })

  it('clamps a page past the end onto the last one', () => {
    const page = workspacePage(rows(25), 99)
    expect(page.page).toBe(page.pages - 1)
  })

  it('clamps a negative page onto the first one', () => {
    expect(workspacePage(rows(25), -4).page).toBe(0)
  })

  it('reports one page for a list that fits, and one for an empty list', () => {
    expect(workspacePage(rows(3), 0).pages).toBe(1)
    expect(workspacePage([], 0)).toEqual({ rows: [], page: 0, pages: 1 })
  })

  it('draws every row on one page when the whole list fits', () => {
    const page = workspacePage(rows(9), 0)
    expect(page.rows).toHaveLength(9)
    expect(page.pages).toBe(1)
  })
})

describe('the payload a workspace row carries', () => {
  const base = { kind: WORKSPACE_ACTION, key: 'oc_1', chatId: 'oc_1', chatType: 'p2p' }

  it('accepts a row payload and a page payload', () => {
    expect(workspaceActionValue({ ...base, path: '/work/a' })).toEqual({ ...base, path: '/work/a' })
    expect(workspaceActionValue({ ...base, page: 2 })).toEqual({ ...base, page: 2 })
  })

  it('accepts an owner when the conversation is one person\'s', () => {
    expect(workspaceActionValue({ ...base, path: '/w', owner: 'ou_1' }))
      .toEqual({ ...base, path: '/w', owner: 'ou_1' })
  })

  it('rejects a payload that names neither a row nor a page', () => {
    // Such a button can do nothing, and accepting it would authorize a press
    // whose only possible outcome is a no-op.
    expect(workspaceActionValue(base)).toBeUndefined()
  })

  it('rejects foreign, malformed, and mistyped values', () => {
    expect(workspaceActionValue({ ...base, kind: 'other', path: '/w' })).toBeUndefined()
    expect(workspaceActionValue({ ...base, path: '' })).toBeUndefined()
    expect(workspaceActionValue({ ...base, path: 7 })).toBeUndefined()
    expect(workspaceActionValue({ ...base, page: -1 })).toBeUndefined()
    expect(workspaceActionValue({ ...base, page: 1.5 })).toBeUndefined()
    expect(workspaceActionValue({ ...base, key: '' })).toBeUndefined()
    expect(workspaceActionValue({ ...base, chatType: undefined })).toBeUndefined()
    expect(workspaceActionValue({ ...base, owner: 7, path: '/w' })).toBeUndefined()
    expect(workspaceActionValue(null)).toBeUndefined()
    expect(workspaceActionValue('nope')).toBeUndefined()
  })
})
