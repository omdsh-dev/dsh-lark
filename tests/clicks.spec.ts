import { describe, expect, it } from 'vitest'
import { clickMark, marked } from '../src/clicks.ts'

describe('marking one rendering of a control card', () => {
  it('never issues the same mark twice, even within a millisecond', () => {
    const marks = Array.from({ length: 200 }, () => clickMark())
    expect(new Set(marks).size).toBe(marks.length)
    expect(marks.every((mark) => mark !== '')).toBe(true)
  })

  it('puts the mark where the transport will still see it', () => {
    // The transport identifies an action by the first 128 characters of the
    // serialized payload, and these payloads are longer than that. First by
    // insertion order covers the payload as written; first alphabetically
    // covers anything that re-serializes with sorted keys on the way back.
    const value = marked({ kind: 'dsh-lark-channel/status', key: 'oc_1', chatId: 'oc_1', chatType: 'p2p' })
    expect(Object.keys(value)[0]).toBe('a')
    expect([...Object.keys(value)].sort()[0]).toBe('a')
    expect(JSON.stringify(value).indexOf(value.a)).toBeLessThan(128)
  })

  it('leaves the payload it marks otherwise untouched', () => {
    const original = { kind: 'dsh-lark-channel/permission', preset: 'workspace-write', key: 'oc_1' }
    const { a, ...rest } = marked(original)
    expect(rest).toEqual(original)
    expect(a).not.toBe(marked(original).a)
  })
})
