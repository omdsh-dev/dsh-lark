import { describe, expect, it } from 'vitest'
import { createMaintenanceQueue, lendsIdlePhase, MaintenanceCancelled, NO_IDLE_PHASE } from '../src/maintenance.ts'
import type { HostAgent } from '../src/host.ts'

/**
 * An agent modelling the host's idle phase: one owner at a time, a refusal
 * THROWN SYNCHRONOUSLY when something already owns it, and `whenIdle`
 * following whatever runs. Both halves matter — the queue tells a refusal from
 * a task failure by whether the task ever started, not by reading a message.
 */
function fakeAgent(id = 's1') {
  let owner: Promise<unknown> | undefined
  let driving = false
  const agent = {
    id,
    session: { id },
    followup: () => {},
    cancel: () => {},
    whenIdle: async () => {
      while (driving || owner !== undefined) {
        if (owner !== undefined) await owner.catch(() => undefined)
        if (driving) await new Promise((done) => { setTimeout(done, 1) })
      }
    },
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      if (driving || owner !== undefined) throw new Error('dsh: an agent activity already owns this agent')
      const controller = new AbortController()
      const running = task(controller.signal)
      owner = running.catch(() => undefined).then(() => { owner = undefined })
      return running
    },
  } as unknown as HostAgent
  return { agent, drive: (next: boolean) => { driving = next } }
}

/** A task that records when it ran and how many ran at once. */
function recorder() {
  const overlaps: number[] = []
  let running = 0
  return {
    overlaps,
    task: (ms = 5) => async () => {
      running += 1
      overlaps.push(running)
      await new Promise((done) => { setTimeout(done, ms) })
      running -= 1
      return 'done'
    },
  }
}

describe('running host commands from the agent idle phase', () => {
  it('runs one at a time per conversation, in the order asked', async () => {
    const queue = createMaintenanceQueue()
    const { agent } = fakeAgent()
    const { overlaps, task } = recorder()
    const order: number[] = []

    await Promise.all([1, 2, 3].map((n) => queue.run('s1', agent, task()).then(() => order.push(n))))

    expect(overlaps).toEqual([1, 1, 1])
    expect(order).toEqual([1, 2, 3])
    await queue.close()
  })

  it('lets two conversations run at the same time', async () => {
    const queue = createMaintenanceQueue()
    const first = fakeAgent('s1')
    const second = fakeAgent('s2')
    const started: string[] = []
    const hold = new Promise<void>((resolve) => { setTimeout(resolve, 20) })

    const one = queue.run('s1', first.agent, async () => { started.push('s1'); await hold })
    const two = queue.run('s2', second.agent, async () => { started.push('s2'); await hold })
    await Promise.all([one, two])

    expect(started.sort()).toEqual(['s1', 's2'])
    await queue.close()
  })

  it('waits for a driving agent instead of writing beside it', async () => {
    const queue = createMaintenanceQueue()
    const { agent, drive } = fakeAgent()
    let ran = false
    drive(true)

    const pending = queue.run('s1', agent, async () => { ran = true })
    await new Promise((done) => { setTimeout(done, 20) })
    expect(ran).toBe(false)

    drive(false)
    await pending
    expect(ran).toBe(true)
    await queue.close()
  })

  it('re-claims the phase when the agent takes it back first', async () => {
    const queue = createMaintenanceQueue()
    const { agent, drive } = fakeAgent()
    let claims = 0
    // Idle when asked, driving by the time the claim lands: the race the retry
    // exists for. It is told from a task failure by whether the task started.
    const original = agent.runMaintenance!.bind(agent)
    ;(agent as { runMaintenance: unknown }).runMaintenance = <T>(task: (s: AbortSignal) => Promise<T>): Promise<T> => {
      claims += 1
      if (claims === 1) throw new Error('dsh: an agent activity already owns this agent')
      return original(task)
    }
    drive(false)

    await expect(queue.run('s1', agent, async () => 'ok')).resolves.toBe('ok')
    expect(claims).toBe(2)
    await queue.close()
  })

  it('reports a task failure as a failure, and keeps the queue usable', async () => {
    const queue = createMaintenanceQueue()
    const { agent } = fakeAgent()

    await expect(queue.run('s1', agent, async () => { throw new Error('no such preset') }))
      .rejects.toThrow('no such preset')
    await expect(queue.run('s1', agent, async () => 'next')).resolves.toBe('next')
    await queue.close()
  })

  it('cancels one conversation without touching another', async () => {
    const queue = createMaintenanceQueue()
    const first = fakeAgent('s1')
    const second = fakeAgent('s2')
    first.drive(true)

    const cancelled = queue.run('s1', first.agent, async () => 'never')
    const kept = queue.run('s2', second.agent, async () => 'fine')
    queue.cancel('s1')

    await expect(cancelled).rejects.toBeInstanceOf(MaintenanceCancelled)
    await expect(kept).resolves.toBe('fine')
    await queue.close()
  })

  it('cancels a task already waiting for the agent to go idle', async () => {
    // The wait that mattered: a driving agent may not go idle for minutes, and
    // a release cannot hold the conversation open for it. Cancellation has to
    // reach INTO the wait, not queue behind it.
    const queue = createMaintenanceQueue()
    const { agent, drive } = fakeAgent()
    let ran = false
    drive(true)

    const waiting = queue.run('s1', agent, async () => { ran = true })
    await new Promise((done) => { setTimeout(done, 10) })
    const cancelled = queue.cancel('s1')

    await expect(waiting).rejects.toBeInstanceOf(MaintenanceCancelled)
    // And `cancel` reports only once the work has stopped, so a caller may
    // release the agent behind it.
    await cancelled
    expect(ran).toBe(false)
    drive(false)
    await new Promise((done) => { setTimeout(done, 10) })
    expect(ran).toBe(false)
    await queue.close()
  })

  it('aborts the running task on close, and waits for it to unwind', async () => {
    const queue = createMaintenanceQueue()
    const { agent } = fakeAgent()
    let aborted = false
    let started = (): void => {}
    const inFlight = new Promise<void>((resolve) => { started = resolve })
    const running = queue.run('s1', agent, (signal) => new Promise<string>((resolve) => {
      started()
      signal.addEventListener('abort', () => { aborted = true; resolve('stopped') }, { once: true })
    }))
    await inFlight

    await queue.close()
    expect(aborted).toBe(true)
    await expect(running).resolves.toBe('stopped')
    // A closed queue takes no new work rather than running it unsupervised.
    await expect(queue.run('s1', agent, async () => 'late')).rejects.toBeInstanceOf(MaintenanceCancelled)
  })

  it('refuses where the host lends no idle phase, rather than writing anyway', async () => {
    const queue = createMaintenanceQueue()
    const bare = { id: 's1', session: { id: 's1' }, followup: () => {}, cancel: () => {} } as unknown as HostAgent
    expect(lendsIdlePhase(bare)).toBe(false)

    await expect(queue.run('s1', bare, async () => 'ran')).rejects.toThrow(NO_IDLE_PHASE)
    await queue.close()
  })
})
