import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { HostAgentHandle } from '../src/host.ts'
import { ConversationSessions, conversationKey, sessionIdFor } from '../src/session.ts'
import type { SessionLadder, SessionScope } from '../src/session.ts'
import { fakeMessage } from './harness.ts'

/** One rung the ladder was asked for, in call order. */
interface LadderCall {
  readonly rung: 'lookup' | 'resume' | 'create'
  readonly sessionId: string
}

/** How the fake host answers each rung; mutable so a test can flip it mid-run. */
interface LadderBehavior {
  /** Session ids the host already runs an agent for, so `lookup` hits. */
  live?: string[]
  /** Session ids `resume` loads; every other id rejects as unstored. */
  resumable?: string[]
  /** Reject `create` instead of producing an agent. */
  failCreate?: boolean
  /** Reject every produced agent's `dispose`. */
  failDispose?: boolean
}

/**
 * An in-memory {@link SessionLadder} over stub agents, recording every rung,
 * report line, and disposal. Needs no Cordis mount.
 * @param behavior - which rungs answer; by default only `create` does.
 * @returns the ladder, its mutable behavior, and the recorded traffic.
 */
function createFakeLadder(behavior: LadderBehavior = {}) {
  const calls: LadderCall[] = []
  const reports: string[] = []
  const disposals: string[] = []
  const handles = new Map<string, HostAgentHandle>()

  /** One stub agent per session id, so a second rung yields the same handle. */
  const handleFor = (sessionId: string): HostAgentHandle => {
    let handle = handles.get(sessionId)
    if (handle === undefined) {
      handle = {
        agent: {
          id: sessionId,
          session: { id: sessionId },
          // A live-reuse composes the chat-only parts on the agent's scope; the
          // fake scope carries no tools, which is the safe-degradation path.
          ctx: new Context(),
          followup: () => {},
          cancel: () => {},
        },
        dispose: async () => {
          disposals.push(sessionId)
          if (behavior.failDispose === true) throw new Error(`dispose rejected (fake): ${sessionId}`)
        },
      }
      handles.set(sessionId, handle)
    }
    return handle
  }

  const ladder: SessionLadder = {
    lookup(sessionId) {
      calls.push({ rung: 'lookup', sessionId })
      return behavior.live?.includes(sessionId) === true ? handleFor(sessionId) : undefined
    },
    async resume(sessionId) {
      calls.push({ rung: 'resume', sessionId })
      if (behavior.resumable?.includes(sessionId) !== true) throw new Error(`no stored session (fake): ${sessionId}`)
      return handleFor(sessionId)
    },
    async create(sessionId) {
      calls.push({ rung: 'create', sessionId })
      if (behavior.failCreate === true) throw new Error(`create rejected (fake): ${sessionId}`)
      return handleFor(sessionId)
    },
    report(line) { reports.push(line) },
  }

  return {
    ladder,
    behavior,
    calls,
    reports,
    disposals,
    /** Session ids handed to one rung, in call order. */
    asked: (rung: LadderCall['rung']): string[] =>
      calls.filter(call => call.rung === rung).map(call => call.sessionId),
  }
}

describe('conversation sessions', () => {
  describe('conversation keys', () => {
    it('keys the chat scope by chat id alone', () => {
      expect(conversationKey('chat', fakeMessage({ threadId: 'omt_a', senderId: 'ou_alice' }))).toBe('oc_chat_1')
      expect(conversationKey('chat', fakeMessage({ chatId: 'oc_chat_2' }))).toBe('oc_chat_2')
    })

    it('separates threads and falls back to the chat when a message carries none', () => {
      const inThread = conversationKey('chat-thread', fakeMessage({ chatId: 'oc_topic', threadId: 'omt_a' }))
      expect(inThread).toBe('oc_topic:omt_a')
      expect(conversationKey('chat-thread', fakeMessage({ chatId: 'oc_topic', threadId: 'omt_b' })))
        .not.toBe(inThread)
      // An ordinary group carries no thread; the whole chat is the facet there.
      expect(conversationKey('chat-thread', fakeMessage({ chatId: 'oc_topic' }))).toBe('oc_topic')
    })

    it('separates senders within one chat', () => {
      const alice = conversationKey('chat-sender', fakeMessage({ chatId: 'oc_group', senderId: 'ou_alice' }))
      expect(alice).toBe('oc_group:ou_alice')
      expect(conversationKey('chat-sender', fakeMessage({ chatId: 'oc_group', senderId: 'ou_bob' })))
        .toBe('oc_group:ou_bob')
      // The same person in another chat is another conversation.
      expect(conversationKey('chat-sender', fakeMessage({ chatId: 'oc_other', senderId: 'ou_alice' })))
        .not.toBe(alice)
      // A thread never leaks into the sender facet.
      expect(conversationKey(
        'chat-sender',
        fakeMessage({ chatId: 'oc_group', senderId: 'ou_alice', threadId: 'omt_a' }),
      )).toBe(alice)
    })

    it('throws for a scope outside the union', () => {
      expect(() => conversationKey('chat-group' as unknown as SessionScope, fakeMessage()))
        .toThrow('unknown session scope')
    })
  })

  describe('session ids', () => {
    it('brands a key with the channel prefix', () => {
      expect(sessionIdFor('oc_chat_1')).toBe('lark-oc_chat_1')
      expect(sessionIdFor('oc_chat_1:omt_a')).toBe('lark-oc_chat_1:omt_a')
    })

    it('is deterministic and never collides across facets', () => {
      expect(sessionIdFor('oc_chat_1:omt_a')).toBe(sessionIdFor('oc_chat_1:omt_a'))
      const keys = [
        'oc_chat_1',
        'oc_chat_2',
        'oc_chat_1:omt_a',
        'oc_chat_1:omt_b',
        'oc_chat_1:ou_alice',
        'oc_chat_1-omt_a',
      ]
      expect(new Set(keys.map(key => sessionIdFor(key))).size).toBe(keys.length)
    })
  })

  describe('binding sessions', () => {
    it('binds one session per key and reuses it', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat', host.ladder)

      const first = await sessions.acquire(fakeMessage({ content: 'first' }))
      const second = await sessions.acquire(fakeMessage({ content: 'second' }))
      expect(second).toBe(first)
      expect(host.asked('create')).toEqual([sessionIdFor('oc_chat_1')])
      // A second lookup would mean the cache was consulted too late.
      expect(host.asked('lookup')).toEqual([sessionIdFor('oc_chat_1')])

      await sessions.acquire(fakeMessage({ chatId: 'oc_chat_2' }))
      expect(host.asked('create')).toEqual([sessionIdFor('oc_chat_1'), sessionIdFor('oc_chat_2')])
      expect(sessions.sessionIds).toEqual([sessionIdFor('oc_chat_1'), sessionIdFor('oc_chat_2')])
      expect(sessions.keyOf(sessionIdFor('oc_chat_2'))).toBe('oc_chat_2')
      expect(sessions.keyOf(sessionIdFor('oc_chat_3'))).toBeUndefined()
      await sessions.close()
    })

    it('binds one session per thread under the thread scope', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat-thread', host.ladder)

      await sessions.acquire(fakeMessage({ threadId: 'omt_a' }))
      await sessions.acquire(fakeMessage({ threadId: 'omt_a', content: 'again' }))
      await sessions.acquire(fakeMessage({ threadId: 'omt_b' }))
      expect(host.asked('create')).toEqual([
        sessionIdFor('oc_chat_1:omt_a'),
        sessionIdFor('oc_chat_1:omt_b'),
      ])
      await sessions.close()
    })

    it('opens exactly one session for a concurrent burst on one key', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat', host.ladder)

      const [first, second, third] = await Promise.all([
        sessions.acquire(fakeMessage({ content: 'a' })),
        sessions.acquire(fakeMessage({ content: 'b' })),
        sessions.acquire(fakeMessage({ content: 'c' })),
      ])
      expect(second).toBe(first)
      expect(third).toBe(first)
      expect(host.asked('create')).toEqual([sessionIdFor('oc_chat_1')])
      // A raced second session would have to be disposed to stay consistent.
      expect(host.disposals).toEqual([])
      await sessions.close()
    })

    it('clears the slot after a failed create so the next message retries', async () => {
      const host = createFakeLadder({ failCreate: true })
      const sessions = new ConversationSessions('chat', host.ladder)

      await expect(sessions.acquire(fakeMessage())).rejects.toThrow('create rejected (fake)')
      host.behavior.failCreate = false
      const opened = await sessions.acquire(fakeMessage())
      expect(opened.owned).toBe(true)
      expect(host.asked('create')).toEqual([sessionIdFor('oc_chat_1'), sessionIdFor('oc_chat_1')])
      await sessions.close()
    })

    it('adopts a live agent without owning its disposal', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ live: [sessionId] })
      const sessions = new ConversationSessions('chat', host.ladder)

      const opened = await sessions.acquire(fakeMessage())
      expect(opened.owned).toBe(false)
      expect(opened.handle.agent.session.id).toBe(sessionId)
      expect(host.asked('resume')).toEqual([])
      expect(host.asked('create')).toEqual([])

      await sessions.close()
      // Its own owner takes it down; disposing it here would be a double free.
      expect(host.disposals).toEqual([])
    })

    it('owns a resumed agent', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ resumable: [sessionId] })
      const sessions = new ConversationSessions('chat', host.ladder)

      const opened = await sessions.acquire(fakeMessage())
      expect(opened.owned).toBe(true)
      expect(host.asked('resume')).toEqual([sessionId])
      expect(host.asked('create')).toEqual([])
      expect(host.reports).toEqual([])

      await sessions.close()
      expect(host.disposals).toEqual([sessionId])
    })

    it('reports a failed resume and then creates', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat-sender', host.ladder)
      const sessionId = sessionIdFor('oc_chat_1:ou_sender_1')

      const opened = await sessions.acquire(fakeMessage())
      expect(opened.owned).toBe(true)
      expect(host.asked('resume')).toEqual([sessionId])
      expect(host.asked('create')).toEqual([sessionId])
      // Key and reason both reach the operator: an unreadable log must not pass
      // as a chat nobody ever messaged.
      expect(host.reports).toHaveLength(1)
      expect(host.reports[0]!).toContain('oc_chat_1:ou_sender_1')
      expect(host.reports[0]!).toContain('no stored session (fake)')
      await sessions.close()
    })

    it('propagates the create failure when resume failed too', async () => {
      const host = createFakeLadder({ failCreate: true })
      const sessions = new ConversationSessions('chat', host.ladder)

      await expect(sessions.acquire(fakeMessage())).rejects.toThrow('create rejected (fake)')
      expect(host.reports).toHaveLength(1)
      expect(host.disposals).toEqual([])
    })

    it('disposes owned agents once and refuses later acquisitions', async () => {
      const host = createFakeLadder({ live: [sessionIdFor('oc_chat_2')] })
      const sessions = new ConversationSessions('chat', host.ladder)
      await sessions.acquire(fakeMessage())
      await sessions.acquire(fakeMessage({ chatId: 'oc_chat_2' }))

      await sessions.close()
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1')])
      expect(sessions.sessionIds).toEqual([])
      expect(sessions.keyOf(sessionIdFor('oc_chat_1'))).toBeUndefined()

      await sessions.close()
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1')])
      await expect(sessions.acquire(fakeMessage())).rejects.toThrow('sessions are closed')
    })

    it('surfaces disposal failures as an AggregateError', async () => {
      const host = createFakeLadder({ failDispose: true })
      const sessions = new ConversationSessions('chat', host.ladder)
      await sessions.acquire(fakeMessage())
      await sessions.acquire(fakeMessage({ chatId: 'oc_chat_2' }))

      const failure = await sessions.close().then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toHaveLength(2)
      // Every agent was still asked to go down, not just the first.
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1'), sessionIdFor('oc_chat_2')])
    })

    it('disposes a session that opens after close', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat', host.ladder)
      const opening = sessions.acquire(fakeMessage())

      await sessions.close()
      await expect(opening).rejects.toThrow('closed while opening')
      // The sweep already ran, so nothing else would ever take this agent down.
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1')])
      expect(sessions.sessionIds).toEqual([])
    })

    it('derives ids through an injected deriver, and re-derives after release', async () => {
      const host = createFakeLadder()
      let directory: string | undefined
      const sessions = new ConversationSessions('chat', host.ladder, key =>
        directory === undefined ? sessionIdFor(key) : `${sessionIdFor(key)}--ws`)
      await sessions.acquire(fakeMessage())
      expect(host.asked('create')).toEqual([sessionIdFor('oc_chat_1')])

      directory = '/srv/alpha'
      await sessions.release('oc_chat_1')
      await sessions.acquire(fakeMessage())
      expect(host.asked('create')).toEqual([sessionIdFor('oc_chat_1'), `${sessionIdFor('oc_chat_1')}--ws`])
    })

    it('self-heals a binding whose id derivation changed, without an explicit release', async () => {
      const host = createFakeLadder()
      let suffix = ''
      const sessions = new ConversationSessions('chat', host.ladder, key => `${sessionIdFor(key)}${suffix}`)
      const first = await sessions.acquire(fakeMessage())

      // A recorded switch whose release lost the race: the mapping moved on,
      // the old binding did not. The next message must not reuse it.
      suffix = '--ws'
      const second = await sessions.acquire(fakeMessage())
      expect(second.handle.agent.session.id).toBe(`${sessionIdFor('oc_chat_1')}--ws`)
      expect(second).not.toBe(first)
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1')])

      // Stability restored: the same derivation reuses the same binding.
      expect(await sessions.acquire(fakeMessage())).toBe(second)
      expect(host.disposals).toHaveLength(1)
    })

    it('release disposes an owned agent and unbinds the key', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat', host.ladder)
      const opened = await sessions.acquire(fakeMessage())

      expect(await sessions.release('oc_chat_1')).toBe(true)
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1')])
      expect(sessions.keyOf(opened.handle.agent.session.id)).toBeUndefined()
      expect(sessions.sessionIds).toEqual([])
      expect(await sessions.release('oc_chat_1')).toBe(false)

      // The conversation stays serviceable: the next message rebinds afresh.
      await sessions.acquire(fakeMessage())
      expect(sessions.sessionIds).toEqual([sessionIdFor('oc_chat_1')])
    })

    it('release leaves an adopted agent running but unbinds it', async () => {
      const host = createFakeLadder({ live: [sessionIdFor('oc_chat_1')] })
      const sessions = new ConversationSessions('chat', host.ladder)
      await sessions.acquire(fakeMessage())

      expect(await sessions.release('oc_chat_1')).toBe(true)
      // Whoever created the live agent still owns taking it down.
      expect(host.disposals).toEqual([])
    })

    it('a release during an opening never hands that walk\'s product out', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat', host.ladder)
      const opening = sessions.acquire(fakeMessage())
      const released = sessions.release('oc_chat_1')

      // The superseded walk disposed its own product, and the acquire retried
      // under the new epoch: the caller ends up with a FRESH, live session —
      // never the one the release tore down.
      const resolved = await opening
      expect(await released).toBe(true)
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1')])
      expect(host.asked('create')).toHaveLength(2)
      expect(sessions.sessionIds).toEqual([sessionIdFor('oc_chat_1')])
      expect(sessions.keyOf(resolved.handle.agent.session.id)).toBe('oc_chat_1')
    })

    it('a waiter joining an opening that a release supersedes retries, not reuses', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat', host.ladder)
      const first = sessions.acquire(fakeMessage())
      const released = sessions.release('oc_chat_1')
      const second = sessions.acquire(fakeMessage())

      const [a, b] = await Promise.all([first, second])
      await released
      // Exactly one disposal (the superseded product); both callers share the
      // retried, live session.
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1')])
      expect(a).toBe(b)
      expect(sessions.sessionIds).toEqual([sessionIdFor('oc_chat_1')])
    })
  })
})

describe('a release still tearing down', () => {
  it('does not hand a fresh acquire the agent it is disposing', async () => {
    // The host registry keeps answering with an agent until its disposal
    // finishes. A walk that starts inside that window finds it through
    // `lookup`, adopts it as someone ELSE's — so it never disposes it — and
    // publishes it as the conversation's binding, which the release then
    // destroys. Nothing shows until the next message drives a dead agent.
    const live: string[] = []
    const disposed: string[] = []
    let releaseDispose = (): void => {}
    const held = new Promise<void>((resolve) => { releaseDispose = resolve })
    let created = 0
    const handles = new Map<string, HostAgentHandle>()
    const handleFor = (sessionId: string, slow: boolean): HostAgentHandle => ({
      agent: { id: sessionId, session: { id: sessionId }, ctx: new Context(), followup: () => {}, cancel: () => {} },
      dispose: async () => {
        // The registry only forgets it once disposal completes, as a host does.
        if (slow) await held
        disposed.push(sessionId)
        const at = live.indexOf(sessionId)
        if (at >= 0) live.splice(at, 1)
      },
    })
    const ladder: SessionLadder = {
      lookup: (sessionId) => (live.includes(sessionId) ? handles.get(sessionId) : undefined),
      resume: async () => { throw new Error('no stored session') },
      create: async (sessionId) => {
        created += 1
        const handle = handleFor(sessionId, created === 1)
        handles.set(sessionId, handle)
        live.push(sessionId)
        return handle
      },
      report: () => {},
    }
    const sessions = new ConversationSessions('chat', ladder)

    const first = await sessions.acquireKey('oc_1')
    const releasing = sessions.release('oc_1')
    // Mid-teardown: the registry still answers, and this is the walk that used
    // to adopt what was being destroyed.
    const acquiring = sessions.acquireKey('oc_1')
    releaseDispose()
    await releasing
    const second = await acquiring

    expect(disposed).toEqual(['lark-oc_1'])
    expect(second.handle).not.toBe(first.handle)
    // Owned, so this conversation will take its own agent down again later.
    expect(second.owned).toBe(true)
    await sessions.close()
  })
})

describe('a release whose walk is still running', () => {
  /**
   * A ladder that behaves the way the host does: `create` PUBLISHES the agent
   * to the registry before this store ever sees the handle, and `lookup`
   * answers with it from that moment until its disposal finishes.
   */
  function publishingLadder() {
    const live = new Map<string, HostAgentHandle>()
    const disposed: string[] = []
    let releaseCreate = (): void => {}
    const created: string[] = []
    const ladder: SessionLadder = {
      lookup: (sessionId) => live.get(sessionId),
      resume: async () => { throw new Error('no stored session') },
      create: async (sessionId) => {
        created.push(sessionId)
        const handle: HostAgentHandle = {
          agent: { id: sessionId, session: { id: sessionId }, ctx: new Context(), followup: () => {}, cancel: () => {} },
          dispose: async () => {
            disposed.push(sessionId)
            // Per AGENT, not per id: disposing a retired one must not evict the
            // agent that replaced it, which is how a host behaves too.
            if (live.get(sessionId) === handle) live.delete(sessionId)
          },
        }
        // Published first, handed over second — with a gap in between, which
        // is where the first `create` of this test parks.
        live.set(sessionId, handle)
        if (created.length === 1) await new Promise<void>((resolve) => { releaseCreate = resolve })
        return handle
      },
      report: () => {},
    }
    return { ladder, live, disposed, created, finishFirstCreate: () => { releaseCreate() } }
  }

  it('does not let a fresh walk adopt what the detached one is about to dispose', async () => {
    const { ladder, live, disposed, finishFirstCreate } = publishingLadder()
    const sessions = new ConversationSessions('chat', ladder)

    // First walk: parked inside `create`, already published to the registry.
    const first = sessions.acquireKey('oc_1')
    await new Promise((done) => { setTimeout(done, 5) })
    // Released before it ever bound, then asked for again — the window where
    // the registry holds an agent nobody in this store owns yet.
    const releasing = sessions.release('oc_1')
    const acquiring = sessions.acquireKey('oc_1')
    finishFirstCreate()

    // A detached walk does not fail its caller: it retries under the new
    // state, so both callers end up on the same binding.
    const [retried, bound] = await Promise.all([first, acquiring])
    await releasing
    expect(retried.handle).toBe(bound.handle)

    // And the agent they hold is the live one, not the object the stale walk
    // disposed on its way out.
    expect(live.get('lark-oc_1')).toBe(bound.handle)
    expect(disposed).toEqual(['lark-oc_1'])
    expect(bound.owned).toBe(true)
    await sessions.close()
  })

  it('closes only once a release in flight has finished disposing', async () => {
    // A release takes its binding out of `opened` before it disposes, so a
    // close that only walks `opened` would return while that agent is still
    // being torn down — and "closed" has to mean closed.
    const disposed: string[] = []
    let releaseDispose = (): void => {}
    const held = new Promise<void>((resolve) => { releaseDispose = resolve })
    const ladder: SessionLadder = {
      lookup: () => undefined,
      resume: async () => { throw new Error('no stored session') },
      create: async (sessionId) => ({
        agent: { id: sessionId, session: { id: sessionId }, ctx: new Context(), followup: () => {}, cancel: () => {} },
        dispose: async () => { await held; disposed.push(sessionId) },
      }),
      report: () => {},
    }
    const sessions = new ConversationSessions('chat', ladder)
    await sessions.acquireKey('oc_1')

    const releasing = sessions.release('oc_1')
    await new Promise((done) => { setTimeout(done, 5) })
    let closed = false
    const closing = sessions.close().then(() => { closed = true })
    await new Promise((done) => { setTimeout(done, 10) })
    expect(closed).toBe(false)

    releaseDispose()
    await Promise.all([releasing, closing])
    expect(disposed).toEqual(['lark-oc_1'])
  })
})

describe('closing while a walk is still running', () => {
  it('settles the agent that walk was still creating', async () => {
    // `bind` sees the closed store, disposes what it made and rejects — but a
    // close that did not wait would already have returned, leaving the host
    // creating and destroying an agent behind a plugin that considers itself
    // gone.
    const created: string[] = []
    const disposed: string[] = []
    let finishCreate = (): void => {}
    const held = new Promise<void>((resolve) => { finishCreate = resolve })
    const ladder: SessionLadder = {
      lookup: () => undefined,
      resume: async () => { throw new Error('no stored session') },
      create: async (sessionId) => {
        created.push(sessionId)
        await held
        return {
          agent: { id: sessionId, session: { id: sessionId }, ctx: new Context(), followup: () => {}, cancel: () => {} },
          dispose: async () => { disposed.push(sessionId) },
        }
      },
      report: () => {},
    }
    const sessions = new ConversationSessions('chat', ladder)

    const opening = sessions.acquireKey('oc_1')
    await vi.waitFor(() => { expect(created).toEqual(['lark-oc_1']) })
    const closing = sessions.close()
    finishCreate()
    await closing

    // Closed means closed: the late product is already disposed.
    expect(disposed).toEqual(['lark-oc_1'])
    await expect(opening).rejects.toThrow()
  })

  it('a second release joins the teardown already running', async () => {
    // Two callers can release one conversation — a `/cd` and a card click
    // landing together. The second must not report "nothing to do" while the
    // first is still disposing.
    const disposed: string[] = []
    let finishDispose = (): void => {}
    const held = new Promise<void>((resolve) => { finishDispose = resolve })
    const ladder: SessionLadder = {
      lookup: () => undefined,
      resume: async () => { throw new Error('no stored session') },
      create: async (sessionId) => ({
        agent: { id: sessionId, session: { id: sessionId }, ctx: new Context(), followup: () => {}, cancel: () => {} },
        dispose: async () => { await held; disposed.push(sessionId) },
      }),
      report: () => {},
    }
    const sessions = new ConversationSessions('chat', ladder)
    await sessions.acquireKey('oc_1')

    const first = sessions.release('oc_1')
    const second = sessions.release('oc_1')
    let secondDone = false
    void second.then(() => { secondDone = true })
    await new Promise((done) => { setTimeout(done, 10) })
    expect(secondDone).toBe(false)

    finishDispose()
    expect(await first).toBe(true)
    // Nothing left of its own to do, but it waited for what was.
    expect(await second).toBe(false)
    expect(disposed).toEqual(['lark-oc_1'])
    await sessions.close()
  })
})

