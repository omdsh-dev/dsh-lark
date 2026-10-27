/**
 * The panel face correlates a presented request against the conversation's
 * settled-approval fold. These cases pin the two decisions it makes: which
 * settled request answers a given panel, and that retiring one stops it being
 * reported.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionBinding, SessionEventLikeEntry, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SettledApprovalsRegistry } from '../src/client/decisions-source.ts'
import { asPendingApproval, createPanelFace, retirementFor, settledForTarget } from '../src/client/panel-store.ts'

const SESSION = 'lark-oc_1' as SessionId
const OTHER = 'web-session' as SessionId

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

/** A `ctx.sessions` face over one window. */
function sessionsOver(source: ReturnType<typeof windowSource>) {
  return { binding: () => ({ sessionId: SESSION, eventSource: source }) as unknown as SessionBinding } as unknown as ISessions
}

/** A registry plus its face over one driven window. */
function faceOver(source: ReturnType<typeof windowSource>) {
  const registry = new SettledApprovalsRegistry(sessionsOver(source))
  return { registry, face: createPanelFace(registry) }
}

/** A settled `bash` call under the given log identity. */
const settledBash = (id: string, callId?: string) => [
  entry({ type: 'approval/asked', data: { id, toolName: 'bash', ...(callId === undefined ? {} : { callId }) } }),
  entry({ type: 'approval/decided', data: { id, outcome: 'allowed-once' } }),
]

describe('settledForTarget', () => {
  it('answers a panel by the exact tool call', () => {
    const settled = [{ id: 'a', toolName: 'bash', callId: 'call_1' }]
    expect(settledForTarget(settled, { sessionId: SESSION, key: 'approval:1', toolName: 'bash', callId: 'call_1' }))
      .toEqual([{ id: 'a', toolName: 'bash', callId: 'call_1' }])
  })

  it('does not answer a panel about a different tool call', () => {
    const settled = [{ id: 'a', toolName: 'bash', callId: 'call_1' }]
    expect(settledForTarget(settled, { sessionId: SESSION, key: 'approval:1', toolName: 'bash', callId: 'call_2' })).toEqual([])
  })

  it('answers nothing for a request whose asker named no tool call', () => {
    // A request with no call identity cannot be tied to a settled record: the
    // tool name alone would match any older decision about the same tool, and
    // the panel would retire a request nobody has answered.
    expect(settledForTarget([{ id: 'a', toolName: 'bash' }], { sessionId: SESSION, key: 'approval:1', toolName: 'bash' }))
      .toEqual([])
  })

  it('does not answer a panel about a different tool', () => {
    expect(settledForTarget([{ id: 'a', toolName: 'bash' }], { sessionId: SESSION, key: 'approval:1', toolName: 'read' })).toEqual([])
  })

  it('answers nothing while the request is still open', () => {
    expect(settledForTarget([], { sessionId: SESSION, key: 'approval:1', toolName: 'bash' })).toEqual([])
  })
})

describe('retirementFor', () => {
  const settled = [{ id: 'a', toolName: 'bash' }]
  const answerable = { answerable: true, answer: async () => {} }

  it('retires every settled request that answers the panel', () => {
    expect(retirementFor(settled, answerable)).toEqual(['a'])
  })

  it('retires nothing while the panel is still open', () => {
    expect(retirementFor([], answerable)).toEqual([])
  })

  it('retires nothing without an answerable pending request', () => {
    expect(retirementFor(settled, undefined)).toEqual([])
  })

  it('retires nothing once the request is no longer answerable', () => {
    expect(retirementFor(settled, { answerable: false, answer: async () => {} })).toEqual([])
  })
})

describe('createPanelFace', () => {
  it('publishes the conversation fold through the bound source', () => {
    const source = windowSource([entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash' } })])
    const { face } = faceOver(source)
    const bound = face.settledSource(SESSION)
    const seen = vi.fn()
    bound.subscribe(seen)
    expect(bound.getSnapshot()).toEqual([])
    source.push(entry({ type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } }))
    expect(seen).toHaveBeenCalled()
    // The recorded outcome rides along: closing this browser's copy submits the
    // decision that was actually taken, not one of the panel's choosing.
    expect(bound.getSnapshot()).toEqual([{ id: 'a', toolName: 'bash', outcome: 'allowed-once' }])
  })

  it('retires a settled request once this browser records it', () => {
    const { face } = faceOver(windowSource(settledBash('a')))
    const bound = face.settledSource(SESSION)
    bound.subscribe(() => {})
    expect(bound.getSnapshot()).toHaveLength(1)
    face.markAnsweredHere(SESSION, 'a')
    expect(bound.getSnapshot()).toEqual([])
  })

  it('hands out one stable source per conversation', () => {
    const { face } = faceOver(windowSource(settledBash('a')))
    expect(face.settledSource(SESSION)).toBe(face.settledSource(SESSION))
  })

  it('does not notify for a window change that leaves the fold alone', () => {
    const source = windowSource(settledBash('a'))
    const { face } = faceOver(source)
    const bound = face.settledSource(SESSION)
    const seen = vi.fn()
    bound.subscribe(seen)
    expect(bound.getSnapshot()).toHaveLength(1)
    // The initial attach publishes the first fold; only later changes are the
    // subject here.
    seen.mockClear()
    source.push(entry({ type: 'turn/start', data: {} }))
    expect(seen).not.toHaveBeenCalled()
  })

  it('keeps conversations apart', () => {
    const source = windowSource(settledBash('a'))
    const registry = new SettledApprovalsRegistry({
      binding: (id: SessionId) => id === SESSION
        ? { sessionId: SESSION, eventSource: source } as unknown as SessionBinding
        : undefined,
    } as unknown as ISessions)
    const face = createPanelFace(registry)
    const bound = face.settledSource(OTHER)
    bound.subscribe(() => {})
    expect(bound.getSnapshot()).toEqual([])
  })
})

describe('asPendingApproval', () => {
  it('accepts the shipped approval discriminator', () => {
    const answer = vi.fn(async () => {})
    const pending = { kind: 'approval', answerable: true, answer }
    expect(asPendingApproval(pending)).toMatchObject({ answerable: true })
  })

  it('declines a request whose submission members are not callable facts', () => {
    // `answer` is called synchronously out of a click handler and `answerable`
    // decides whether a press counts, so a projection that omits either must
    // withdraw the affordances rather than throw or decide from nothing.
    const face = (value: Record<string, unknown>): { readonly kind: string } => value as { readonly kind: string }
    expect(asPendingApproval(face({ kind: 'approval', answerable: true }))).toBeUndefined()
    expect(asPendingApproval(face({ kind: 'approval', answer: async () => {} }))).toBeUndefined()
    expect(asPendingApproval(face({ kind: 'approval', answerable: 'yes', answer: async () => {} }))).toBeUndefined()
  })

  it.each([undefined, { kind: 'question' }, { kind: 'plan-review' }])(
    'declines a pending interaction that is not an approval: %j',
    (pending) => {
      expect(asPendingApproval(pending)).toBeUndefined()
    },
  )
})
