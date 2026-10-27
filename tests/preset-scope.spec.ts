import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'
import type { HostAgentPresets } from '../src/host.ts'

/**
 * A host that lends each preset's standing view as a revision lease: the shape
 * a roster publishing `acquireScope` has, and the one whose reader this channel
 * used to call by its predecessor's name — which failed agent creation with
 * `presets.standingKeyFor is not a function` before anything reached a chat.
 */
function createLeasePresets() {
  const released: string[] = []
  const presets: HostAgentPresets = {
    async resolve(id) {
      return { id: id ?? 'default' }
    },
    async mount() {
      return undefined
    },
    async acquireScope(id) {
      const key = `lease:${id ?? 'default'}`
      return {
        key,
        async [Symbol.asyncDispose]() {
          released.push(key)
        },
      }
    },
  }
  return { presets, released }
}

describe('a host that lends the standing scope as a lease', () => {
  it('creates an agent rather than failing on the reader it does not publish', async () => {
    const { presets } = createLeasePresets()
    const harness = await mountChannel({}, { presets })
    try {
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      // This host has no `standingKeyFor`, so a failure here is the composition
      // reading the scope, which is the only step the lease sits behind.
      expect(harness.notices.filter(line => line.includes('agent creation failed'))).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  it('gives the lease back when the fiber unwinds', async () => {
    const { presets, released } = createLeasePresets()
    const harness = await mountChannel({}, { presets })
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    // Held while the presenter reads through the key, not returned on the spot.
    expect(released).toEqual([])
    await harness.dispose()
    expect(released).toEqual(['lease:default'])
  })
})
