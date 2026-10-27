import { describe, expect, it } from 'vitest'
import { epochSessionId, legacyEpochOf } from '../src/epoch.ts'

describe('legacy epoch ids', () => {
  it('leaves the first epoch deriving exactly what it always did', () => {
    // A change here orphans every stored conversation, so it is pinned.
    expect(epochSessionId('lark-oc_1', 0)).toBe('lark-oc_1')
    expect(epochSessionId('lark-oc_1--abc123', 0)).toBe('lark-oc_1--abc123')
    expect(epochSessionId('lark-oc_1', 2)).toBe('lark-oc_1--e2')
  })

  it('reads a hand-edited entry without breaking every message', () => {
    const entries = { 'lark-oc_1': 'nonsense', 'lark-oc_2': '-3', 'lark-oc_3': '4', 'lark-oc_4': '' }
    expect(legacyEpochOf(entries, 'lark-oc_1')).toBe(0)
    expect(legacyEpochOf(entries, 'lark-oc_2')).toBe(0)
    expect(legacyEpochOf(entries, 'lark-oc_3')).toBe(4)
    expect(legacyEpochOf(entries, 'lark-oc_4')).toBe(0)
    expect(legacyEpochOf(entries, 'lark-never-seen')).toBe(0)
    expect(legacyEpochOf(undefined, 'lark-oc_1')).toBe(0)
  })
})
