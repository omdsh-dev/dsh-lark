/**
 * The plugin's own wiring: one real `apply()` over a Client context whose
 * services are faked at their boundary.
 *
 * The slot fake mirrors `SlotCore.register`'s one load-bearing validation — a
 * contribution into an undeclared slot throws — because that is exactly how this
 * plugin once failed to activate: a bare `register()` into `conversation.composer`
 * throws whenever this fiber activates before `ui-conversation` declares the
 * chain, and a thrown `apply()` is reported as `web boot: 1 entry did not
 * activate / dsh-lark-channel: failed` with the whole browser half missing.
 * Registration therefore goes through `slots.inject`, and these cases drive both
 * declaration orders so a regression to the bare call fails here instead of in a
 * browser.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions, SessionBinding, SessionEventLikeEntry, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

// The presentation half is not the subject here, and importing it would pull
// the shared primitives library (whose own runtime dependencies live in the
// shell, not in this repository). The wiring under test is what the
// registration carries, so the components are replaced by inert stand-ins.
vi.mock('../src/client/ApprovalPanel.tsx', () => ({
  ApprovalPanel: () => null,
}))
vi.mock('../src/client/QuestionPanel.tsx', () => ({
  QuestionPanel: () => null,
}))

const { apply, inject: pluginInject, name: pluginName } = await import('../src/client/index.ts')

const LARK = 'lark-oc_1' as SessionId
const WEB = 'session-web' as SessionId

/** One durable window entry around a bare event payload. */
function entry(event: Record<string, unknown>): SessionEventLikeEntry {
  return { type: 'event', event } as unknown as SessionEventLikeEntry
}

/** A mutable window source a test drives directly. */
function windowSource(entries: readonly SessionEventLikeEntry[] = []) {
  let current: SessionEventWindow = { entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push(...added: SessionEventLikeEntry[]) {
      const next = [...current.entries, ...added]
      current = { entries: next, hasMore: false, revision: current.revision + 1, change: { kind: 'append', entries: added } }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** One captured `ctx.slots.register` call. */
interface Registration {
  options: Record<string, unknown>
  component: unknown
}

/** When the parent declares the composer chain relative to this plugin's apply. */
type DeclarationOrder = 'before' | 'after'

/** A Client context exposing exactly the services `apply` reaches for. */
function clientContext(source: ReturnType<typeof windowSource>, order: DeclarationOrder = 'before') {
  const registrations: Registration[] = []
  const dictionaries: { ns: string, dicts: unknown }[] = []
  const injected: string[] = []
  // The declared-slot ledger `SlotCore` keeps; a contribution into a name that
  // is absent here is the throw that failed activation.
  const declared = new Set<string>(order === 'before' ? ['conversation.composer'] : [])
  const waiting = new Map<string, (() => void)[]>()
  const sessions = {
    binding: (id: SessionId) => id === LARK
      ? { sessionId: LARK, eventSource: source } as unknown as SessionBinding
      : undefined,
  } as unknown as ISessions
  const slots = {
    register: (options: Record<string, unknown>, component: unknown) => {
      const name = String(options.name)
      if (!declared.has(name)) {
        throw new Error(`slot "${name}" is not declared (a parent entry's children table must declare it)`)
      }
      registrations.push({ options, component })
      return () => {}
    },
    inject: (slotName: string, contribute: () => unknown) => {
      injected.push(slotName)
      const run = () => { contribute() }
      if (declared.has(slotName)) run()
      else waiting.set(slotName, [...waiting.get(slotName) ?? [], run])
      return () => {}
    },
  }
  const ctx = {
    sessions,
    slots,
    locale: {
      register: (ns: string, dicts: unknown) => {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
    },
    effect: (body: () => unknown) => { body(); return () => {} },
  } as unknown as ClientContext
  /** Declare a slot later, releasing any waiting contribution. */
  const declare = (name: string) => {
    declared.add(name)
    for (const run of waiting.get(name) ?? []) run()
    waiting.delete(name)
  }
  return { ctx, registrations, dictionaries, injected, declare }
}

/** The pending approval the Client projects for a session. */
const approvalPending = (toolName: string, callId?: string) => ({
  kind: 'approval',
  sessionId: LARK,
  toolName,
  ...(callId === undefined ? {} : { callId }),
  answerable: true,
  answer: vi.fn(async () => {}),
})

/** The pending question the Client projects for a session. */
const questionPending = (questions: readonly unknown[]) => ({
  kind: 'question',
  key: 'question:1',
  questions,
  answer: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
})

/** The owner props the composer chain hands the selector. */
function ownerProps(sessionId: SessionId, pendingInteraction: unknown) {
  return { sessionId, session: undefined, pendingInteraction }
}

describe('apply', () => {
  it('declares the services and name its registration depends on', () => {
    expect(pluginName).toBe('lark-channel-ui')
    expect(pluginInject).toContain('slots')
    expect(pluginInject).toContain('sessions')
    expect(pluginInject).toContain('locale')
  })

  it('registers its dictionaries under its own namespace', () => {
    const { ctx, dictionaries } = clientContext(windowSource())
    apply(ctx)
    expect(dictionaries.map(entry => entry.ns)).toContain('larkApproval')
  })

  it.each(['before', 'after'] as const)(
    'activates without throwing when the chain is declared %s it',
    (order) => {
      const { ctx, registrations, declare } = clientContext(windowSource(), order)
      expect(() => { apply(ctx) }).not.toThrow()
      if (order === 'after') {
        // Waiting on the declaration is what keeps this from throwing; the
        // contribution lands once the parent declares the chain.
        expect(registrations).toHaveLength(0)
        declare('conversation.composer')
      }
      expect(registrations.map(entry => entry.options.name)).toContain('conversation.composer')
    },
  )

  it('joins the composer chain ahead of the shipped approval panel', () => {
    const { ctx, registrations, injected } = clientContext(windowSource())
    apply(ctx)
    expect(injected).toContain('conversation.composer')
    const registration = registrations.find(entry => entry.options.name === 'conversation.composer')
    expect(registration).toBeDefined()
    // Lower priority is tried first, and the shipped panel registers at 1.
    expect(registration!.options.priority).toBe(0)
    expect(registration!.options.locale).toBe('larkApproval')
    expect(typeof registration!.options.select).toBe('function')
    expect(typeof registration!.options.inject).toBe('function')
    // Declaring a child the shipped panel already owns would throw at load.
    expect(registration!.options.children).toBeUndefined()
  })

  it('claims an approval on a conversation this channel opened', () => {
    const { ctx, registrations } = clientContext(windowSource())
    apply(ctx)
    const select = registrations[0]!.options.select as (owner: unknown) => unknown
    expect(select(ownerProps(LARK, approvalPending('bash', 'call_1'))))
      .toEqual({ sessionId: LARK, toolName: 'bash', callId: 'call_1' })
  })

  it('claims an approval on a conversation this channel merely drives', () => {
    const { ctx, registrations } = clientContext(windowSource())
    apply(ctx)
    const select = registrations[0]!.options.select as (owner: unknown) => unknown
    // `/sessions` lets a chat adopt a session it did not derive, so an id
    // carries no evidence of who drives it. Claiming by name missed these and
    // left the shipped panel's buttons standing after the chat had decided.
    expect(select(ownerProps(WEB, approvalPending('bash', 'call_9'))))
      .toEqual({ sessionId: WEB, toolName: 'bash', callId: 'call_9' })
  })

  it('passes the asker’s reason and its localized copy through to the panel', () => {
    const { ctx, registrations } = clientContext(windowSource())
    apply(ctx)
    const select = registrations[0]!.options.select as (owner: unknown) => unknown
    const displayReason = { en: 'Display reason', zh: '展示原因' }
    expect(select(ownerProps(LARK, { ...approvalPending('bash'), reason: 'audit reason', displayReason })))
      .toEqual({ sessionId: LARK, toolName: 'bash', reason: 'audit reason', displayReason })
  })

  it('declines without a selected conversation', () => {
    const { ctx, registrations } = clientContext(windowSource())
    apply(ctx)
    const select = registrations[0]!.options.select as (owner: unknown) => unknown
    expect(select({ sessionId: undefined, session: undefined, pendingInteraction: approvalPending('bash') })).toBeNull()
  })

  it('declines a pending interaction that is not an approval', () => {
    const { ctx, registrations } = clientContext(windowSource())
    apply(ctx)
    const select = registrations[0]!.options.select as (owner: unknown) => unknown
    expect(select(ownerProps(LARK, { kind: 'question' }))).toBeNull()
  })

  it('declines while nothing is pending', () => {
    const { ctx, registrations } = clientContext(windowSource())
    apply(ctx)
    const select = registrations[0]!.options.select as (owner: unknown) => unknown
    expect(select(ownerProps(LARK, undefined))).toBeNull()
  })

  it('hands the component the settlement face and a per-session settled read', () => {
    const { ctx, registrations } = clientContext(windowSource())
    apply(ctx)
    const inject = registrations[0]!.options.inject as (sessionId: SessionId) => {
      panel: { markAnsweredHere: (sessionId: SessionId, requestId: string) => void }
      hooks: { larkSettled: { getSnapshot: () => unknown } }
    }
    const face = inject(LARK)
    expect(typeof face.panel.markAnsweredHere).toBe('function')
    expect(face.hooks.larkSettled.getSnapshot()).toEqual([])
    // Stable identity is what the renderer's hook cache keys on.
    expect(inject(LARK).hooks.larkSettled).toBe(face.hooks.larkSettled)
  })

  it('reports a request the chat settled through the injected read', () => {
    const source = windowSource([
      entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash', callId: 'call_1' } }),
      entry({ type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } }),
    ])
    const { ctx, registrations } = clientContext(source)
    apply(ctx)
    const inject = registrations[0]!.options.inject as (sessionId: SessionId) => {
      hooks: { larkSettled: { getSnapshot: () => readonly { id: string }[], subscribe: (l: () => void) => () => void } }
    }
    const bound = inject(LARK).hooks.larkSettled
    bound.subscribe(() => {})
    expect(bound.getSnapshot()).toEqual([{ id: 'a', toolName: 'bash', callId: 'call_1', outcome: 'allowed-once' }])
  })

  it('retires a settled request through the injected face', () => {
    const source = windowSource([
      entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash', callId: 'call_1' } }),
      entry({ type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } }),
    ])
    const { ctx, registrations } = clientContext(source)
    apply(ctx)
    const inject = registrations[0]!.options.inject as (sessionId: SessionId) => {
      panel: { markAnsweredHere: (sessionId: SessionId, requestId: string) => void }
      hooks: { larkSettled: { getSnapshot: () => readonly { id: string }[], subscribe: (l: () => void) => () => void } }
    }
    const face = inject(LARK)
    const bound = face.hooks.larkSettled
    bound.subscribe(() => {})
    expect(bound.getSnapshot()).toHaveLength(1)
    face.panel.markAnsweredHere(LARK, 'a')
    expect(bound.getSnapshot()).toEqual([])
  })

  describe('the question takeover it registers beside the approval one', () => {
    const questions = [{ id: 'q1', question: '部署到生产？', options: [{ label: '部署' }] }]

    function questionRegistration() {
      // The question entry is the second contribution into the chain.
      return registrationsOf().find(entry => entry.options.locale === 'larkQuestion')!
    }

    function registrationsOf() {
      // Re-applied per call so each test gets a fresh context; apply() twice on
      // one context would double-register.
      const mounted = clientContext(windowSource())
      apply(mounted.ctx)
      return mounted.registrations
    }

    it('joins the same chain ahead of the shipped question composer, on its own copy', () => {
      const registrations = registrationsOf()
      const registration = registrations.find(entry => entry.options.locale === 'larkQuestion')!
      expect(registration).toBeDefined()
      expect(registration.options.name).toBe('conversation.composer')
      expect(registration.options.priority).toBe(0)
      expect(typeof registration.options.select).toBe('function')
      expect(typeof registration.options.inject).toBe('function')
    })

    it('claims a pending question with its render identity and question list', () => {
      const registration = questionRegistration()
      const select = registration.options.select as (owner: unknown) => unknown
      expect(select(ownerProps(LARK, questionPending(questions))))
        .toEqual({ sessionId: LARK, key: 'question:1', questions })
    })

    it('leaves plan reviews to the shipped panel', () => {
      // This channel answers plans through its own shadowed tool in the chat,
      // so only the generic question flow is claimed here.
      const registration = questionRegistration()
      const select = registration.options.select as (owner: unknown) => unknown
      expect(select(ownerProps(LARK, { kind: 'plan-review', key: 'question:2', questions }))).toBeNull()
    })

    it('declines a pending interaction that is not a question', () => {
      const registration = questionRegistration()
      const select = registration.options.select as (owner: unknown) => unknown
      expect(select(ownerProps(LARK, approvalPending('bash')))).toBeNull()
    })

    it('hands the component the settlement face, the drafts face, and a per-session settled read', () => {
      const registration = questionRegistration()
      const inject = registration.options.inject as (sessionId: SessionId) => {
        panel: { markAnsweredHere: (sessionId: SessionId, requestId: string) => void }
        drafts: { replace: (key: string, progress: unknown) => void, clear: (key: string) => void }
        hooks: { larkQuestionSettled: { getSnapshot: () => unknown } }
      }
      const face = inject(LARK)
      expect(typeof face.panel.markAnsweredHere).toBe('function')
      expect(typeof face.drafts.replace).toBe('function')
      expect(typeof face.drafts.clear).toBe('function')
      expect(face.hooks.larkQuestionSettled.getSnapshot()).toEqual([])
      // The drafts face is shared per apply(): a remount restores, so both
      // mounts of the panel must read the same registry.
      expect(inject(LARK).drafts).toBe(face.drafts)
      // The settled source is per session, stable for the hook cache.
      expect(inject(LARK).hooks.larkQuestionSettled).toBe(face.hooks.larkQuestionSettled)
    })
  })
})
