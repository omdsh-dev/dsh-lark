import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAttemptQuota, createReconnectWatchdog } from '../src/liveness.ts'

/** A watchdog over instrumented ports, with controllable rebuild outcomes. */
function build(options: {
  deadlineMs?: number
  backoffMs?: number[]
  state?: () => string | undefined
  quota?: { windowMs: number; limit: number }
} = {}) {
  const reports: string[] = []
  const rebuilds: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
  const watchdog = createReconnectWatchdog({
    deadlineMs: options.deadlineMs ?? 1000,
    backoffMs: options.backoffMs ?? [100, 200],
    status: options.state ?? (() => undefined),
    ...options.quota === undefined ? {} : { quota: createAttemptQuota(options.quota) },
    rebuild: () => new Promise<void>((resolve, reject) => { rebuilds.push({ resolve, reject }) }),
    report: (line) => { reports.push(line) },
  })
  return { watchdog, reports, rebuilds }
}

/** Settle floated promise chains queued behind resolved rebuilds. */
const flush = async () => { await vi.advanceTimersByTimeAsync(0) }

describe('attempt quota', () => {
  it('admits up to the limit, then reports when a slot frees', () => {
    let clock = 1_000
    const quota = createAttemptQuota({ windowMs: 1000, limit: 2, now: () => clock })
    expect(quota.remaining()).toBe(2)
    quota.record()
    clock += 400
    quota.record()
    expect(quota.allows()).toBe(false)
    expect(quota.remaining()).toBe(0)
    // The oldest attempt leaving the window is what frees the next slot.
    expect(quota.freeAt()).toBe(2000)

    clock = 2001
    expect(quota.allows()).toBe(true)
    expect(quota.freeAt()).toBeUndefined()
    expect(quota.remaining()).toBe(1)
  })

  it('slides rather than resets: a steady trickle stays admitted', () => {
    let clock = 0
    const quota = createAttemptQuota({ windowMs: 1000, limit: 2, now: () => clock })
    for (let round = 0; round < 5; round += 1) {
      expect(quota.allows()).toBe(true)
      quota.record()
      clock += 600
    }
  })
})

describe('reconnect watchdog', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('stands down silently when the transport recovers within the deadline', async () => {
    const { watchdog, reports, rebuilds } = build()
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(999)
    watchdog.onReconnected()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rebuilds).toHaveLength(0)
    expect(reports).toEqual([])
  })

  it('keeps the earliest deadline when reconnecting repeats', async () => {
    const { watchdog, rebuilds } = build()
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(600)
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(400)
    expect(rebuilds).toHaveLength(1)
  })

  it('does not bounce a transport that reports connected at the deadline', async () => {
    const { watchdog, reports, rebuilds } = build({ state: () => 'connected' })
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(1000)
    expect(rebuilds).toHaveLength(0)
    expect(reports.join('\n')).toContain('standing down')
    // The cycle is closed: a later reconnecting arms a fresh one.
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(1000)
    expect(rebuilds).toHaveLength(0)
  })

  it('rebuilds when the deadline passes, and reports the recovery', async () => {
    const { watchdog, reports, rebuilds } = build()
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(1000)
    expect(rebuilds).toHaveLength(1)
    expect(reports.join('\n')).toContain('reconnect stalled')
    rebuilds[0]!.resolve()
    await flush()
    expect(reports.join('\n')).toContain('rebuilt the transport after 1 attempt')
  })

  it('retries under capped backoff and never gives up on its own', async () => {
    const { watchdog, rebuilds } = build({ backoffMs: [100, 200] })
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(1000)
    for (const [index, delay] of [100, 200, 200, 200].entries()) {
      rebuilds[index]!.reject(new Error('still down'))
      await flush()
      expect(rebuilds).toHaveLength(index + 1)
      await vi.advanceTimersByTimeAsync(delay)
      expect(rebuilds).toHaveLength(index + 2)
    }
  })

  it('stands down when the SDK recovers during the backoff wait', async () => {
    const { watchdog, reports, rebuilds } = build()
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(1000)
    rebuilds[0]!.reject(new Error('still down'))
    await flush()
    watchdog.onReconnected()
    expect(reports.join('\n')).toContain('recovered; watchdog standing down')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rebuilds).toHaveLength(1)
  })

  it('claims no credit when recovery races an in-flight rebuild', async () => {
    const { watchdog, reports, rebuilds } = build()
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(1000)
    // The SDK's own reconnected lands while our rebuild is still awaited.
    watchdog.onReconnected()
    rebuilds[0]!.resolve()
    await flush()
    const log = reports.join('\n')
    expect(log).toContain('recovered; watchdog standing down')
    expect(log).not.toContain('rebuilt the transport')
  })

  it('pauses when the rebuild budget is exhausted, then resumes on its own', async () => {
    const { watchdog, reports, rebuilds } = build({
      backoffMs: [100],
      quota: { windowMs: 10_000, limit: 2 },
    })
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(1000)

    // Two rebuilds are the whole budget; the third must not be attempted.
    rebuilds[0]!.reject(new Error('down'))
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    expect(rebuilds).toHaveLength(2)
    rebuilds[1]!.reject(new Error('down'))
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    expect(rebuilds).toHaveLength(2)
    expect(reports.join('\n')).toContain('rebuild budget exhausted')

    // Waiting out the backoff alone does not resume — the budget governs.
    await vi.advanceTimersByTimeAsync(5000)
    expect(rebuilds).toHaveLength(2)

    // Once the window slides past the first attempt, it resumes by itself.
    await vi.advanceTimersByTimeAsync(6000)
    expect(reports.join('\n')).toContain('budget refilled')
    expect(rebuilds).toHaveLength(3)
  })

  it('a quarantined watchdog stands down when the transport recovers', async () => {
    const { watchdog, reports, rebuilds } = build({
      backoffMs: [100],
      quota: { windowMs: 10_000, limit: 1 },
    })
    watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(1000)
    rebuilds[0]!.reject(new Error('down'))
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    expect(reports.join('\n')).toContain('rebuild budget exhausted')

    watchdog.onReconnected()
    expect(reports.join('\n')).toContain('recovered; watchdog standing down')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rebuilds).toHaveLength(1)
  })

  it('a disposed watchdog never fires or retries', async () => {
    const armed = build()
    armed.watchdog.onReconnecting()
    armed.watchdog.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(armed.rebuilds).toHaveLength(0)

    const retrying = build()
    retrying.watchdog.onReconnecting()
    await vi.advanceTimersByTimeAsync(1000)
    retrying.rebuilds[0]!.reject(new Error('down'))
    await flush()
    retrying.watchdog.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(retrying.rebuilds).toHaveLength(1)
  })
})
