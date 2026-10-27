/**
 * The bundle patch's registration surface.
 *
 * A `dsh.client` browser half is registered by the PACKAGE, not by a second
 * row: the client module system serves `<package>/client.js` for every loader
 * row whose package declares `dsh.client`, and a row spelled
 * `'dsh-lark-channel/client'` is invisible to that scan (a subpath is not a
 * package root) while the HOST Loader still imports it — evaluating a browser
 * bundle that calls `window.__ModuleLoader__.load` in Node and failing the
 * entry. These cases pin the patch to one row carrying the package name.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const patch = readFileSync(`${root}cordis.patch.yml`, 'utf8')
const manifest = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  name: string
  exports: Record<string, unknown>
  dsh?: { client?: { platform?: string } }
}

/** Every `name:` value the patch's inserted rows carry. */
function patchedRowNames(document: string): string[] {
  return [...document.matchAll(/^\s+name:\s*'([^']+)'\s*$/gmu)].map(match => match[1] as string)
}

describe('cordis.patch.yml', () => {
  it('registers the package by name, never by a subpath', () => {
    const names = patchedRowNames(patch)
    expect(names).toContain(manifest.name)
    for (const name of names) {
      expect(name, `patch row '${name}' must name a package, not a subpath`).not.toContain('/')
    }
  })

  it('adds no browser-half row of its own', () => {
    // The `dsh.client` declaration is the whole registration for the browser
    // half; a second row would be skipped by the scan and imported by the host.
    const names = patchedRowNames(patch)
    expect(names.filter(name => name === manifest.name)).toHaveLength(1)
    expect(names.some(name => name.endsWith('/client'))).toBe(false)
  })

  it('declares the browser half on the package the patch already names', () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(Object.hasOwn(manifest.exports, './client')).toBe(true)
  })
})
