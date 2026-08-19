/**
 * Liveness ownership for the transport. The SDK promises to reconnect, but its
 * recovery loop has terminal states: source-verified give-up paths that end
 * with one error callback, and a hang where a connect phase awaits forever and
 * nothing is scheduled at all — a process that is alive while its lifeline is
 * silently dead. A channel whose whole job is to be reachable cannot outsource
 * that promise, so this watchdog holds the SDK to it: a `reconnecting` that is
 * not followed by `reconnected` within the deadline is presumed dead, and the
 * transport is torn down and reopened through its public API — which the SDK
 * documents as clearing terminal state ("Clear any terminal-error state left
 * over from a previous session").
 *
 * The same doctrine the host writes down (a wait whose transition may never
 * occur must handle that branch explicitly) and the SDK itself applies
 * elsewhere (its meeting sessions run liveness probes for exactly the events
 * that can silently never arrive).
 * @module dsh-lark-channel/liveness
 */

/** Where the watchdog is in one supervision cycle. */
type Phase = 'idle' | 'armed' | 'rebuilding' | 'quarantined'

/**
 * A sliding-window allowance for transport rebuilds.
 *
 * Reconnecting is not free: the platform meters connection attempts and
 * answers a bot that burns through them with a quota error, so a watchdog that
 * retries forever can turn a recoverable outage into a hard lockout. The cure
 * for silent give-up must not become a pathological loop, so rebuilds are
 * budgeted — and the budget refills on its own, because a human is not
 * standing by to lift it.
 *
 * Only rebuilds THIS watchdog performs are counted. The SDK's own internal
 * retries are not observable from here, so the budget governs what we cause,
 * not what the transport does underneath.
 */
export interface AttemptQuota {
  /** Whether another attempt may be made now. */
  allows(): boolean
  /** Record one attempt against the window. */
  record(): void
  /** Epoch ms when the window next frees a slot, when it is exhausted. */
  freeAt(): number | undefined
  /** Attempts still available in the current window. */
  remaining(): number
}

/**
 * A fixed-count, sliding-window quota.
 * @param options - window length, attempt ceiling, and a clock for tests.
 * @returns the quota.
 */
export function createAttemptQuota(options: {
  readonly windowMs: number
  readonly limit: number
  readonly now?: () => number
}): AttemptQuota {
  const now = options.now ?? Date.now
  /** Attempt timestamps inside the window, oldest first. */
  let attempts: number[] = []
  const prune = (): void => {
    const floor = now() - options.windowMs
    attempts = attempts.filter(at => at > floor)
  }
  return {
    allows() {
      prune()
      return attempts.length < options.limit
    },
    record() {
      prune()
      attempts.push(now())
    },
    freeAt() {
      prune()
      if (attempts.length < options.limit) return undefined
      // The oldest attempt leaving the window is what frees the next slot.
      const oldest = attempts[attempts.length - options.limit]
      return oldest === undefined ? undefined : oldest + options.windowMs
    },
    remaining() {
      prune()
      return Math.max(0, options.limit - attempts.length)
    },
  }
}

/** Construction options for {@link createReconnectWatchdog}. */
export interface WatchdogOptions {
  /** How long a `reconnecting` may stand without `reconnected` before acting. */
  readonly deadlineMs: number
  /** Delays between rebuild attempts; the last entry repeats forever. */
  readonly backoffMs: readonly number[]
  /**
   * The transport's own account of its state, when it offers one. Consulted at
   * the deadline so a transport that recovered without an event does not get
   * bounced.
   */
  readonly status: () => string | undefined
  /** Tear the transport down and open it again. A rejection schedules a retry. */
  readonly rebuild: () => Promise<void>
  /** Operator console line. */
  readonly report: (line: string) => void
  /** Rebuild budget; absent leaves rebuilds ungoverned. */
  readonly quota?: AttemptQuota | undefined
  /** Clock, so tests can drive the quota window deterministically. */
  readonly now?: (() => number) | undefined
}

/** The bridge-facing surface: lifecycle events in, one disposal out. */
export interface ReconnectWatchdog {
  /** The transport lost its connection and says it is recovering. */
  onReconnecting(): void
  /** The transport recovered; whichever cycle was open stands down. */
  onReconnected(): void
  /** Stop all timers; the watchdog never acts again. */
  dispose(): void
}

/**
 * Supervise the reconnect promise of one transport.
 *
 * One cycle: `reconnecting` arms a deadline; `reconnected` disarms it; a
 * deadline that fires with the transport still down starts rebuild attempts
 * under capped backoff that never stop on their own — the silent-give-up
 * being cured here must not be reintroduced by the cure. Every transition is
 * reported, because the incident this exists for was diagnosed off a log that
 * simply stopped.
 * @param options - deadline, backoff, and the transport operations.
 * @returns the watchdog handle.
 */
export function createReconnectWatchdog(options: WatchdogOptions): ReconnectWatchdog {
  let phase: Phase = 'idle'
  let timer: NodeJS.Timeout | undefined
  let attempt = 0
  let disposed = false

  const disarm = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  /** A pending watchdog timer must never be what keeps a process alive. */
  const schedule = (ms: number, task: () => void): void => {
    timer = setTimeout(task, ms)
    timer.unref?.()
  }

  const settle = (): void => {
    phase = 'idle'
    attempt = 0
    disarm()
  }

  const now = options.now ?? Date.now

  /**
   * Hold off until the budget refills. Not a give-up: the wake is scheduled,
   * the reason is stated, and the cycle resumes on its own.
   */
  const quarantine = (freeAt: number | undefined): void => {
    phase = 'quarantined'
    const waitMs = freeAt === undefined ? options.deadlineMs : Math.max(1000, freeAt - now())
    options.report(
      `lark-channel: rebuild budget exhausted — pausing reconnect attempts for `
      + `${Math.round(waitMs / 1000)}s to avoid burning the platform's connection quota`,
    )
    schedule(waitMs, () => {
      if (disposed || phase !== 'quarantined') return
      options.report('lark-channel: rebuild budget refilled; resuming')
      phase = 'rebuilding'
      void attemptRebuild()
    })
  }

  const attemptRebuild = async (): Promise<void> => {
    if (disposed || phase !== 'rebuilding') return
    if (options.quota !== undefined && !options.quota.allows()) {
      quarantine(options.quota.freeAt())
      return
    }
    options.quota?.record()
    attempt += 1
    options.report(`lark-channel: watchdog rebuilding the transport (attempt ${attempt})`)
    try {
      await options.rebuild()
      // The SDK's own `reconnected` may have raced the rebuild and settled the
      // cycle already; a second success line would claim credit twice.
      if (disposed || phase !== 'rebuilding') return
      const attempts = attempt
      settle()
      options.report(`lark-channel: watchdog rebuilt the transport after ${attempts} attempt(s)`)
    } catch (error) {
      if (disposed || phase !== 'rebuilding') return
      const backoff = options.backoffMs[Math.min(attempt - 1, options.backoffMs.length - 1)] ?? options.deadlineMs
      options.report(
        `lark-channel: watchdog rebuild failed (${error instanceof Error ? error.message : String(error)}); `
        + `retrying in ${Math.round(backoff / 1000)}s`,
      )
      schedule(backoff, () => { void attemptRebuild() })
    }
  }

  const fire = (): void => {
    timer = undefined
    if (disposed || phase !== 'armed') return
    const state = options.status()
    if (state === 'connected') {
      // Recovered without the event reaching us — stand down, but say so:
      // a lifecycle surface that skips its own events is worth knowing about.
      settle()
      options.report('lark-channel: reconnect deadline passed but the transport reports connected; standing down')
      return
    }
    phase = 'rebuilding'
    options.report(
      `lark-channel: reconnect stalled for ${Math.round(options.deadlineMs / 1000)}s `
      + `(transport state: ${state ?? 'unknown'}) — rebuilding`,
    )
    void attemptRebuild()
  }

  return {
    onReconnecting() {
      // Armed keeps the earliest deadline; a rebuild cycle already owns recovery.
      if (disposed || phase !== 'idle') return
      phase = 'armed'
      schedule(options.deadlineMs, fire)
    },
    onReconnected() {
      if (disposed || phase === 'idle') return
      const wasActing = phase === 'rebuilding' || phase === 'quarantined'
      settle()
      if (wasActing) options.report('lark-channel: transport recovered; watchdog standing down')
    },
    dispose() {
      disposed = true
      disarm()
      phase = 'idle'
    },
  }
}
