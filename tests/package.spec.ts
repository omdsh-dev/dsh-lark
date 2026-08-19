import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The packed artifact is a build output the unit suite never touches, and the
 * one crash that reached a live deployment lived exactly there: a bundler
 * chunk two entries shared (`lib/version-*.js`) that an enumerating `files`
 * list did not ship, so every install crash-looped on ERR_MODULE_NOT_FOUND.
 * These tests pack for real and hold the tarball to two invariants: nothing
 * the build emitted is missing, and no shipped module imports a relative path
 * the tarball does not carry.
 */
describe('packed tarball', () => {
  const stage = mkdtempSync(join(tmpdir(), 'pack-'))
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', stage], { cwd: root, encoding: 'utf8' })
  const tarball = packed.status === 0 ? readdirSync(stage).find(name => name.endsWith('.tgz')) : undefined
  if (tarball !== undefined) {
    spawnSync('tar', ['-xzf', join(stage, tarball)], { cwd: stage })
  }
  const shipped = join(stage, 'package', 'lib')

  it('packs at all, with the lib directory inside', () => {
    expect(packed.status).toBe(0)
    expect(tarball).toBeDefined()
    expect(existsSync(shipped)).toBe(true)
  })

  it('ships every runtime file the build emitted', () => {
    const built = readdirSync(join(root, 'lib')).filter(name => name.endsWith('.js')).sort()
    const inTarball = readdirSync(shipped).filter(name => name.endsWith('.js')).sort()
    expect(inTarball).toEqual(built)
  })

  it('carries every relative import its shipped modules make', () => {
    const missing: string[] = []
    for (const name of readdirSync(shipped).filter(file => file.endsWith('.js'))) {
      const text = readFileSync(join(shipped, name), 'utf8')
      for (const match of text.matchAll(/from ["'](\.\/[^"']+)["']/g)) {
        const target = match[1]!
        if (!existsSync(join(shipped, target))) missing.push(`${name} -> ${target}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('built entries', () => {
  it('lib/index.js imports and keeps the loader surface', async () => {
    const entry = (await import(join(root, 'lib', 'index.js'))) as Record<string, unknown>
    expect(entry.name).toBe('lark-channel')
    expect(entry.inject).toEqual(['agents'])
    expect(typeof entry.apply).toBe('function')
    expect(entry.Config).toBeDefined()
    expect('default' in entry).toBe(false)
  })

  it('lib/invariant.js imports', async () => {
    const invariant = (await import(join(root, 'lib', 'invariant.js'))) as Record<string, unknown>
    expect(typeof invariant.apply).toBe('function')
  })
})
