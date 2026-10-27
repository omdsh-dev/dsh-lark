/**
 * The per-session settled-approval source borrows a conversation's window
 * rather than retaining one. These cases pin the behavior the panel depends on:
 * a source created before its conversation is materialized starts empty and
 * attaches on the next subscriber, and marking a request answered here retires
 * it without another decision arriving.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEventLikeEntry, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SettledApprovalsRegistry } from '../src/client/decisions-source.ts'

const SESSION = 'lark-oc_chat_1' as SessionId

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
    /** Publish a new entry set and wake subscribers. */
    push(...added: SessionEventLikeEntry[]) {
      const next = [...current.entries, ...added]
      current = { entries: next, hasMore: false, revision: current.revision + 1, change: { kind: 'append', entries: added } }
      for (const listener of [...listeners]) listener()
    },
    /** How many subscribers currently follow this source. */
    get subscriberCount() { return listeners.size },
  }
}

/** A `ctx.sessions` face whose binding is available only when the test says so. */
function sessionsFace(available: () => SessionBinding | undefined) {
  return { binding: () => available() } as unknown as ISessions
}

/** A binding over one driven window source. */
function bindingOver(source: ReturnType<typeof windowSource>): SessionBinding {
  return { sessionId: SESSION, eventSource: source } as unknown as SessionBinding
}

describe('SettledApprovalsRegistry', () => {
  it('shares one source per session id', () => {
    const source = windowSource()
    const registry = new SettledApprovalsRegistry(sessionsFace(() => bindingOver(source)))
    expect(registry.sourceFor(SESSION)).toBe(registry.sourceFor(SESSION))
  })

  it('reads a borrowed conversation immediately', () => {
    const source = windowSource([
      entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash' } }),
      entry({ type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } }),
    ])
    const registry = new SettledApprovalsRegistry(sessionsFace(() => bindingOver(source)))
    const read = registry.sourceFor(SESSION)
    read.subscribe(() => {})
    expect(read.getSnapshot()).toEqual([{ id: 'a', toolName: 'bash', outcome: 'allowed-once' }])
  })

  it('starts empty and attaches once the conversation materializes', () => {
    const source = windowSource([
      entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash' } }),
      entry({ type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } }),
    ])
    let live: SessionBinding | undefined
    const registry = new SettledApprovalsRegistry(sessionsFace(() => live))
    const read = registry.sourceFor(SESSION)
    read.subscribe(() => {})
    expect(read.getSnapshot()).toEqual([])
    live = bindingOver(source)
    const dispose = read.subscribe(() => {})
    expect(read.getSnapshot()).toEqual([{ id: 'a', toolName: 'bash', outcome: 'allowed-once' }])
    dispose()
  })

  it('follows a replaced conversation generation', () => {
    const retired = windowSource([
      entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash' } }),
    ])
    const replacement = windowSource([
      entry({ type: 'approval/asked', data: { id: 'b', toolName: 'pwsh' } }),
      entry({ type: 'approval/decided', data: { id: 'b', outcome: 'allowed-once' } }),
    ])
    let live: SessionBinding | undefined = bindingOver(retired)
    const registry = new SettledApprovalsRegistry(sessionsFace(() => live))
    const read = registry.sourceFor(SESSION)
    read.subscribe(() => {})
    expect(retired.subscriberCount).toBe(1)

    // Leaving the conversation retires its Client Session; returning builds a
    // new one, and with it a new window the fold has never seen.
    live = bindingOver(replacement)
    read.subscribe(() => {})

    expect(retired.subscriberCount).toBe(0)
    expect(replacement.subscriberCount).toBe(1)
    expect(read.getSnapshot()).toEqual([{ id: 'b', toolName: 'pwsh', outcome: 'allowed-once' }])
  })

  it('clears a stale fold when the replacement reports nothing', () => {
    const retired = windowSource([
      entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash' } }),
      entry({ type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } }),
    ])
    const replacement = windowSource()
    let live: SessionBinding | undefined = bindingOver(retired)
    const registry = new SettledApprovalsRegistry(sessionsFace(() => live))
    const read = registry.sourceFor(SESSION)
    read.subscribe(() => {})
    expect(read.getSnapshot()).toEqual([{ id: 'a', toolName: 'bash', outcome: 'allowed-once' }])

    live = bindingOver(replacement)
    const seen = vi.fn()
    read.subscribe(seen)

    expect(read.getSnapshot()).toEqual([])
    expect(seen).toHaveBeenCalled()
  })

  it('re-resolves the generation when this browser answers', () => {
    const retired = windowSource([
      entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash' } }),
      entry({ type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } }),
    ])
    const replacement = windowSource([
      entry({ type: 'approval/asked', data: { id: 'b', toolName: 'pwsh' } }),
      entry({ type: 'approval/decided', data: { id: 'b', outcome: 'allowed-once' } }),
    ])
    let live: SessionBinding | undefined = bindingOver(retired)
    const registry = new SettledApprovalsRegistry(sessionsFace(() => live))
    const read = registry.sourceFor(SESSION)
    read.subscribe(() => {})
    expect(read.getSnapshot()).toEqual([{ id: 'a', toolName: 'bash', outcome: 'allowed-once' }])

    live = bindingOver(replacement)
    read.markAnsweredHere('b')

    expect(read.getSnapshot()).toEqual([])
  })

  it('publishes a decision that arrives while subscribed', () => {
    const source = windowSource([entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash' } })])
    const registry = new SettledApprovalsRegistry(sessionsFace(() => bindingOver(source)))
    const read = registry.sourceFor(SESSION)
    const seen = vi.fn()
    read.subscribe(seen)
    expect(read.getSnapshot()).toEqual([])
    source.push(entry({ type: 'approval/decided', data: { id: 'a', outcome: 'rejected' } }))
    expect(seen).toHaveBeenCalled()
    // The recorded decision rides along, so closing this browser's copy submits
    // what was actually decided.
    expect(read.getSnapshot()).toEqual([{ id: 'a', toolName: 'bash', outcome: 'rejected' }])
  })

  it('retires a request this browser answered itself', () => {
    const source = windowSource([
      entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash' } }),
      entry({ type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } }),
    ])
    const registry = new SettledApprovalsRegistry(sessionsFace(() => bindingOver(source)))
    const read = registry.sourceFor(SESSION)
    read.subscribe(() => {})
    read.markAnsweredHere('a')
    expect(read.getSnapshot()).toEqual([])
  })

  it('does not publish again when marking the same request twice', () => {
    const source = windowSource()
    const registry = new SettledApprovalsRegistry(sessionsFace(() => bindingOver(source)))
    const read = registry.sourceFor(SESSION)
    read.subscribe(() => {})
    read.markAnsweredHere('a')
    const seen = vi.fn()
    read.subscribe(seen)
    read.markAnsweredHere('a')
    expect(seen).not.toHaveBeenCalled()
  })

  it('keeps a stable snapshot reference while the fold is unchanged', () => {
    const source = windowSource([
      entry({ type: 'approval/asked', data: { id: 'a', toolName: 'bash' } }),
      entry({ type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } }),
    ])
    const registry = new SettledApprovalsRegistry(sessionsFace(() => bindingOver(source)))
    const read = registry.sourceFor(SESSION)
    read.subscribe(() => {})
    const first = read.getSnapshot()
    source.push(entry({ type: 'turn/start', data: {} }))
    expect(read.getSnapshot()).toBe(first)
  })

  it('detaches every subscription on dispose', () => {
    const source = windowSource()
    const registry = new SettledApprovalsRegistry(sessionsFace(() => bindingOver(source)))
    registry.sourceFor(SESSION).subscribe(() => {})
    expect(source.subscriberCount).toBe(1)
    registry.dispose()
    expect(source.subscriberCount).toBe(0)
  })
})
