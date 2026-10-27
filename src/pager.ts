/**
 * Paging a list of rows one of which is "where you are".
 *
 * Two pickers page the same way: the workspace picker and the session picker
 * both draw a slice of a list whose current entry must stay legible — a card
 * that cannot say where the conversation is has lost the one fact a reader
 * checks first. So the current row is pinned to the first page, every other row
 * appears on exactly one page, and the arithmetic lives here rather than in
 * each picker: two copies of it would drift, and the drift would show up as a
 * row that is reachable on no page or on two.
 * @module dsh-lark-channel/pager
 */

/** One page of rows that carry a `current` flag, and where it sits in the list. */
export interface Page<T> {
  /** The rows this page draws, at most `size`. */
  readonly rows: readonly T[]
  /** Zero-based page index, clamped into range. */
  readonly page: number
  /** Total pages, never zero — an empty list is still one page. */
  readonly pages: number
}

/**
 * The slice one page shows.
 *
 * The current row is pinned to the first page's first line whatever page was
 * asked for, so every page can say where the conversation is. It is drawn there
 * and nowhere else: a row that appeared on two pages would be two buttons for
 * one destination.
 * @param rows - the rows to paginate, current first.
 * @param page - the requested zero-based page; out-of-range values clamp.
 * @param size - how many rows one page holds.
 * @returns the rows to draw and the page's position.
 */
export function paginate<T extends { readonly current: boolean }>(
  rows: readonly T[],
  page: number,
  size: number,
): Page<T> {
  const pinned = rows.filter(row => row.current)
  const rest = rows.filter(row => !row.current)
  // The pinned row occupies a slot on the FIRST page only. Reserving its slot on
  // every page would draw the same row twice — two buttons for one destination —
  // and would shrink pages that do not carry it.
  const capacity = Math.max(1, size - pinned.length)
  // The first page holds the pinned row plus `capacity` others; every later page
  // holds `size`. Counting the first page as a full `capacity` of `rest` is what
  // makes the pages partition the list exactly once.
  const afterFirst = Math.max(0, rest.length - capacity)
  const pages = Math.max(1, 1 + Math.ceil(afterFirst / size))
  const index = Math.min(Math.max(0, Math.trunc(page)), pages - 1)
  const drawn = index === 0
    ? [...pinned, ...rest.slice(0, capacity)]
    : rest.slice(capacity + (index - 1) * size, capacity + index * size)
  return { rows: drawn, page: index, pages }
}
