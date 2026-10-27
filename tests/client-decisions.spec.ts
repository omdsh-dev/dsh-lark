/**
 * The settled-approval fold reads one conversation's own event window. These
 * cases pin the two facts the panel's automatic settlement rests on: that a
 * decided request stops being pending, and that a request THIS browser answered
 * is never reported back as somebody else's decision.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEventLikeEntry, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { foldSettledElsewhere } from '../src/client/decisions.ts'

/** One durable window entry around a bare event payload. */
function entry(event: Record<string, unknown>): SessionEventLikeEntry {
  return { type: 'event', event } as unknown as SessionEventLikeEntry
}

/** A window over the given entries. */
function window(...entries: SessionEventLikeEntry[]): SessionEventWindow {
  return { entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } }
}

/** One `approval/asked` audit event. */
function asked(id: string, toolName = 'bash', callId?: string) {
  return entry({ type: 'approval/asked', data: { id, toolName, ...(callId === undefined ? {} : { callId }) } })
}

/** One `approval/decided` audit event. */
function decided(id: string, outcome = 'allowed-once') {
  return entry({ type: 'approval/decided', data: { id, outcome } })
}

describe('foldSettledElsewhere', () => {
  it('reads nothing from a window with no approvals', () => {
    expect(foldSettledElsewhere(window(entry({ type: 'turn/start', data: {} })), new Set())).toEqual([])
  })

  it('leaves an unanswered request pending', () => {
    expect(foldSettledElsewhere(window(asked('a')), new Set())).toEqual([])
  })

  it('reports a request decided by somebody else, with the decision it recorded', () => {
    expect(foldSettledElsewhere(window(asked('a'), decided('a')), new Set()))
      .toEqual([{ id: 'a', toolName: 'bash', outcome: 'allowed-once' }])
  })

  it('carries the tool call when the asker named one', () => {
    expect(foldSettledElsewhere(window(asked('a', 'fs_write', 'call_1'), decided('a', 'rejected')), new Set()))
      .toEqual([{ id: 'a', toolName: 'fs_write', callId: 'call_1', outcome: 'rejected' }])
  })

  it('never reports a request this browser answered itself', () => {
    const answered = new Set(['a'])
    expect(foldSettledElsewhere(window(asked('a'), decided('a')), answered)).toEqual([])
  })

  it('keeps reporting the requests this browser did not answer', () => {
    const answered = new Set(['a'])
    expect(foldSettledElsewhere(window(asked('a'), decided('a'), asked('b', 'read'), decided('b')), answered))
      .toEqual([{ id: 'b', toolName: 'read', outcome: 'allowed-once' }])
  })

  it.each(['allowed-once', 'rejected'] as const)(
    'carries the %s outcome the panel has a control for',
    (outcome) => {
      expect(foldSettledElsewhere(window(asked('a'), decided('a', outcome)), new Set()))
        .toEqual([{ id: 'a', toolName: 'bash', outcome }])
    },
  )

  it.each(['cancelled', 'unavailable'] as const)(
    'treats the %s outcome as settled with nothing to re-submit',
    (outcome) => {
      // Fail-closed outcomes have no button in this panel: the copy is closed,
      // and inventing a decision for it would misreport what the Host recorded.
      expect(foldSettledElsewhere(window(asked('a'), decided('a', outcome)), new Set()))
        .toEqual([{ id: 'a', toolName: 'bash' }])
    },
  )

  it('reports several settled requests in ask order', () => {
    const entries = [asked('a'), asked('b', 'read'), asked('c', 'write'), decided('b'), decided('a'), decided('c')]
    expect(foldSettledElsewhere(window(...entries), new Set()).map(value => value.id)).toEqual(['a', 'b', 'c'])
  })

  it('ignores a decision naming a request the window never asked', () => {
    expect(foldSettledElsewhere(window(decided('ghost')), new Set())).toEqual([])
  })

  it('ignores transient frames', () => {
    const transient = { type: 'transient', event: { type: 'assistant/live-chunk' } } as unknown as SessionEventLikeEntry
    expect(foldSettledElsewhere(window(transient, asked('a'), transient, decided('a')), new Set()))
      .toEqual([{ id: 'a', toolName: 'bash', outcome: 'allowed-once' }])
  })
})
