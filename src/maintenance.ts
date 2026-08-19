/**
 * Running one host command against a conversation, from the agent's own idle
 * phase, one at a time.
 *
 * Every command APPENDS to the session log, and the log takes one writer. This
 * channel learned that twice — once as a torn record that cost a whole session,
 * once as `session append cannot reenter while another append is being
 * published` — and both times the answer looked like timing: watch `turn/end`,
 * step out of the dispatch, retry on a message the host happened to print.
 * That was guesswork about someone else's schedule.
 *
 * The host publishes the real thing. `runMaintenance` claims the true idle
 * phase synchronously, holds later waking input in the inbox until the task
 * settles, and refuses when a turn or another maintenance task already owns the
 * agent; `whenIdle` resolves when the agent has nothing running. So the rule
 * here is: ask the agent for the phase, and let it say when. What this module
 * adds is one queue per conversation, so two clicks are two turns of the queue
 * rather than two writers.
 * @module dsh-lark-channel/maintenance
 */

import type { HostAgent } from './host.ts'

/**
 * How many times one task re-claims the idle phase before giving up. A refusal
 * means an agent took the phase back between `whenIdle` resolving and the
 * claim — a race with the conversation's own traffic, which is worth losing a
 * few times and not worth losing forever.
 */
const CLAIM_ATTEMPTS = 5

/** Why a host cannot run maintenance at all, said the way a chat can read it. */
export const NO_IDLE_PHASE = 'this host does not offer an idle phase to run commands from'

/**
 * Whether one agent can lend its idle phase. Structural rather than versioned:
 * the host contract reaches this plugin as an object, not as a dependency
 * range, so the capability is asked of the object.
 * @param agent - the agent to test.
 * @returns true when both halves of the contract are present.
 */
export function lendsIdlePhase(agent: HostAgent): boolean {
  return typeof agent.whenIdle === 'function' && typeof agent.runMaintenance === 'function'
}

/** One conversation's serialized maintenance work. */
export interface MaintenanceQueue {
  /**
   * Run one task from the conversation's idle phase, after everything already
   * queued for it.
   * @param sessionId - the conversation's session, which is the queue's key.
   * @param agent - the agent whose phase is claimed.
   * @param task - the work; its signal aborts on cancellation and disposal.
   * @returns the task's own result.
   * @throws when the queue is closed, the work is cancelled, the host lends no
   * idle phase, or the task itself fails.
   */
  run<T>(sessionId: string, agent: HostAgent, task: (signal: AbortSignal) => Promise<T>): Promise<T>
  /**
   * Abort what one conversation has queued.
   * @param sessionId - the conversation to stop.
   * @returns when its work has unwound, so a caller may release the agent
   * knowing nothing is about to write to it.
   */
  cancel(sessionId: string): Promise<void>
  /** Abort everything and wait for it to unwind. Idempotent. */
  close(): Promise<void>
}

/**
 * A promise that rejects when the signal aborts, and never settles otherwise.
 * Used to race a wait that has no cancellation of its own.
 * @param signal - the caller's cancellation.
 * @returns the rejecting promise.
 */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error)
      return
    }
    signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
  })
}

/** Cancellation, as its own type so a caller can tell it from a real failure. */
export class MaintenanceCancelled extends Error {
  constructor(sessionId: string) {
    super(`lark-channel: maintenance for ${sessionId} was cancelled`)
  }
}

/**
 * Build a queue. One per bridge: its keys are session ids, which are unique
 * across conversations by construction.
 * @returns the queue.
 */
export function createMaintenanceQueue(): MaintenanceQueue {
  /** The last promise queued per session; the next task chains onto it. */
  const tails = new Map<string, Promise<unknown>>()
  /** Live cancellation handles per session, so a release can abort them. */
  const controllers = new Map<string, Set<AbortController>>()
  let closed = false

  /**
   * Claim the idle phase and run one task in it.
   *
   * A refusal is told from a failure of the task itself by whether the task
   * ever started — the host throws its refusal synchronously, before the
   * callback runs — rather than by reading the message it threw. Matching text
   * is how the last version of this decided things, and a host is free to
   * reword.
   * @param agent - the agent to claim.
   * @param signal - cancellation for the caller's work.
   * @param task - the work to run inside the phase.
   * @returns the task's result.
   */
  const claim = async <T>(
    agent: HostAgent,
    signal: AbortSignal,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (!lendsIdlePhase(agent)) throw new Error(`lark-channel: ${NO_IDLE_PHASE}`)
    for (let attempt = 1; ; attempt += 1) {
      signal.throwIfAborted()
      // Raced against cancellation, not awaited through it: `whenIdle`
      // resolves when the agent stops, which is exactly the thing a release or
      // a disposal is not willing to wait for.
      await Promise.race([agent.whenIdle!(), aborted(signal)])
      signal.throwIfAborted()
      let started = false
      try {
        return await agent.runMaintenance!(async inner => {
          started = true
          return task(AbortSignal.any([signal, inner]))
        })
      } catch (error) {
        // The task ran and failed: that is an answer, not a busy signal.
        if (started || attempt >= CLAIM_ATTEMPTS) throw error
      }
    }
  }

  return {
    async run<T>(sessionId: string, agent: HostAgent, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (closed) throw new MaintenanceCancelled(sessionId)
      const controller = new AbortController()
      const live = controllers.get(sessionId) ?? new Set<AbortController>()
      live.add(controller)
      controllers.set(sessionId, live)

      const previous = tails.get(sessionId) ?? Promise.resolve()
      const next = previous
        .catch(() => undefined)
        .then(() => claim(agent, controller.signal, task))
      // The tail must never reject: it is only a place in line, and a failed
      // task must not fail the one queued behind it.
      const place = next.catch(() => undefined)
      tails.set(sessionId, place)
      try {
        return await next
      } finally {
        live.delete(controller)
        if (live.size === 0) controllers.delete(sessionId)
        // Only the tail that is still ours: a successor already queued behind
        // this one owns the slot now.
        if (tails.get(sessionId) === place) tails.delete(sessionId)
      }
    },
    async cancel(sessionId: string): Promise<void> {
      for (const controller of controllers.get(sessionId) ?? []) controller.abort(new MaintenanceCancelled(sessionId))
      // Settled, not successful: the caller wants the writing to have stopped.
      await Promise.allSettled([tails.get(sessionId)].filter(tail => tail !== undefined))
    },
    async close(): Promise<void> {
      closed = true
      for (const [sessionId, live] of controllers) {
        for (const controller of live) controller.abort(new MaintenanceCancelled(sessionId))
      }
      // Settled, not successful: disposal waits for the work to stop touching
      // the session, and a task that failed on the way out has already stopped.
      await Promise.allSettled([...tails.values()])
      tails.clear()
      controllers.clear()
    },
  }
}
