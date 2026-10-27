import { describe, expect, it } from 'vitest'
import { paginate } from '../src/pager.ts'

/** `count` rows named `/p/<n>`, those at `current` flagged as where you are. */
function rows(count: number, current: readonly number[] = [0]) {
  const flagged = new Set(current)
  return Array.from({ length: count }, (_, index) => ({ name: `/p/${index}`, current: flagged.has(index) }))
}

/** Every row the pages draw, in the order they draw it. */
function walk(all: ReturnType<typeof rows>, size: number): string[] {
  const drawn: string[] = []
  for (let page = 0; page < paginate(all, 0, size).pages; page += 1) {
    for (const row of paginate(all, page, size).rows) drawn.push(row.name)
  }
  return drawn
}

describe('which rows one page draws', () => {
  it('leads with the current row whatever page was asked for', () => {
    const first = paginate(rows(50), 0, 10)
    expect(first.rows[0]!.name).toBe('/p/0')
    expect(first.rows[0]!.current).toBe(true)
  })

  it('draws the current row on the first page only, never twice', () => {
    // A row on two pages would be two buttons for one destination.
    expect(paginate(rows(50), 2, 10).rows.filter(row => row.current)).toHaveLength(0)
  })

  it('fills the first page with the rows the pinned one leaves room for', () => {
    const page = paginate(rows(50), 0, 10)
    expect(page.rows.map(row => row.name)).toEqual(
      ['/p/0', ...Array.from({ length: 9 }, (_, index) => `/p/${index + 1}`)],
    )
  })

  it('walks every row exactly once across the pages', () => {
    const all = rows(25)
    const drawn = walk(all, 10)
    expect(drawn).toHaveLength(all.length)
    expect([...drawn].sort()).toEqual(all.map(row => row.name).sort())
  })

  it('counts the first page as a full page of the rows that are not pinned', () => {
    // The first page holds the pinned row plus `size - 1` others, so a list of
    // exactly `size` rows is one page and one more makes two — the off-by-one
    // that would otherwise leave the last row on a page of its own.
    expect(paginate(rows(10), 0, 10).pages).toBe(1)
    expect(paginate(rows(11), 0, 10).pages).toBe(2)
    expect(paginate(rows(11), 1, 10).rows.map(row => row.name)).toEqual(['/p/10'])
  })

  it('clamps a page past the end onto the last one', () => {
    const page = paginate(rows(25), 99, 10)
    expect(page.page).toBe(page.pages - 1)
  })

  it('clamps a negative page onto the first one', () => {
    expect(paginate(rows(25), -4, 10).page).toBe(0)
  })

  it('reports one page for a list that fits, and one for an empty list', () => {
    expect(paginate(rows(3), 0, 10).pages).toBe(1)
    expect(paginate([], 0, 10)).toEqual({ rows: [], page: 0, pages: 1 })
  })
})

describe('when the list carries more than one current row', () => {
  it('pins them all to the first page and keeps them off the rest', () => {
    const all = rows(30, [0, 1, 2])
    const first = paginate(all, 0, 10)
    expect(first.rows.filter(row => row.current).map(row => row.name)).toEqual(['/p/0', '/p/1', '/p/2'])
    expect(first.rows).toHaveLength(10)
    expect(paginate(all, 1, 10).rows.filter(row => row.current)).toHaveLength(0)
  })

  it('still draws a page when the pinned rows already fill it', () => {
    // Capacity floors at one: a page that could not hold anything would make the
    // list unreachable rather than merely crowded.
    const page = paginate(rows(5, [0, 1, 2, 3, 4]), 0, 2)
    expect(page.rows).toHaveLength(5)
    expect(page.pages).toBe(1)
  })

  it('walks every row exactly once however many are pinned', () => {
    const all = rows(37, [0, 4, 9])
    const drawn = walk(all, 8)
    expect([...drawn].sort()).toEqual(all.map(row => row.name).sort())
  })
})
