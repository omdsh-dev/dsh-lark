/**
 * Command extraction for the panel's correlated Tool call.
 *
 * These cases pin the rules the panel shares with the shipped
 * `conversation.approval.detail` renderer — a call whose arguments have not
 * arrived answers nothing, and the search continues to the dispatched call with
 * the same id — plus the one the shipped renderer does not cover: a call that
 * has already settled keeps the command it was approved for in its own result
 * record, which is what a panel that outlived its call still shows.
 */
import { describe, expect, it } from 'vitest'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { commandForCall, commandOfArguments } from '../src/client/approval-command.ts'

/** One Chat snapshot whose node map answers the extractor's iteration. */
function snapshotOf(nodes: readonly unknown[]): ChatSnapshot {
  return { nodes: { values: () => nodes } } as unknown as ChatSnapshot
}

/** A dispatched Tool call carrying one shell command. */
function started(callId: string, command: string): unknown {
  return { kind: 'tool-call', data: { root: { phase: 'start', callId, name: 'pwsh', argsRaw: JSON.stringify({ command }) } } }
}

/** A named Tool call whose arguments have not arrived yet. */
function preparing(callId: string): unknown {
  return { kind: 'tool-call', data: { root: { phase: 'preparing', callId, name: 'pwsh' } } }
}

/** A settled Tool call whose result backfilled its call head. */
function settled(callId: string, command: string | undefined): unknown {
  return {
    kind: 'tool-call',
    data: {
      root: {
        kind: 'tool-result',
        callId,
        call: command === undefined ? null : { name: 'pwsh', argsRaw: JSON.stringify({ command }) },
      },
    },
  }
}

describe('commandOfArguments', () => {
  it('accepts only a string command from valid JSON arguments', () => {
    expect(commandOfArguments(undefined)).toBeUndefined()
    expect(commandOfArguments('{')).toBeUndefined()
    expect(commandOfArguments('{}')).toBeUndefined()
    expect(commandOfArguments('{"command":42}')).toBeUndefined()
    expect(commandOfArguments('{"command":"pnpm test"}')).toBe('pnpm test')
  })
})

describe('commandForCall', () => {
  it('declines without a correlated call id', () => {
    expect(commandForCall(snapshotOf([started('call-1', 'pnpm test')]), undefined)).toBeUndefined()
  })

  it('ignores rows that are not Tool calls and calls correlated with something else', () => {
    expect(commandForCall(snapshotOf([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: undefined } },
      started('other', 'wrong'),
    ]), 'call-1')).toBeUndefined()
  })

  it('keeps looking past a call whose arguments have not arrived', () => {
    // A preparing row carries no arguments; the dispatched call with the same id
    // is the one holding the command, exactly as the shipped detail reads it.
    expect(commandForCall(snapshotOf([
      preparing('call-1'),
      started('call-1', 'pnpm test'),
    ]), 'call-1')).toBe('pnpm test')
    expect(commandForCall(snapshotOf([preparing('call-1')]), 'call-1')).toBeUndefined()
  })

  it('reads the command a settled call kept in its result record', () => {
    expect(commandForCall(snapshotOf([settled('call-1', 'pnpm test')]), 'call-1')).toBe('pnpm test')
    // A result whose call head fell outside the window has no command to show.
    expect(commandForCall(snapshotOf([settled('call-1', undefined)]), 'call-1')).toBeUndefined()
  })
})
