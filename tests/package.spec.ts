import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** The manifest fields that name a file a consumer or the host loads directly. */
interface PackedManifest {
  readonly name: string
  readonly main?: string
  readonly types?: string
  readonly bin?: Record<string, string> | string | undefined
  readonly exports?: Record<string, string | { readonly types?: string; readonly default?: string }> | undefined
  readonly dsh?: { readonly bundle?: { readonly patch?: string | string[] } | undefined; readonly client?: unknown } | undefined
}

/**
 * Every file path this manifest tells a consumer or the host to load.
 *
 * Glob entries (`./src/*`) name a directory of files rather than one file, so
 * they are not asserted one by one.
 * @param manifest - the parsed package manifest.
 * @returns the tarball-relative paths, normalized without a leading `./`.
 */
function declaredPaths(manifest: PackedManifest): string[] {
  const paths: (string | undefined)[] = [manifest.main, manifest.types]
  if (typeof manifest.bin === 'string') paths.push(manifest.bin)
  else paths.push(...Object.values(manifest.bin ?? {}))
  for (const target of Object.values(manifest.exports ?? {})) {
    if (typeof target === 'string') paths.push(target)
    else paths.push(target.types, target.default)
  }
  const patch = manifest.dsh?.bundle?.patch
  paths.push(...Array.isArray(patch) ? patch : [patch])
  return paths
    .filter((path): path is string => typeof path === 'string' && !path.includes('*'))
    .map(path => path.replace(/^\.\//, ''))
}

/**
 * The packed artifact is a build output the unit suite never touches, and both
 * crashes that reached a live deployment lived exactly there: a bundler chunk two
 * entries shared (`lib/version-*.js`) that an enumerating `files` list did not
 * ship, so every install crash-looped on ERR_MODULE_NOT_FOUND, and a prepare
 * pipeline that emitted no `lib/client.js` while the manifest still registered
 * `dsh.client`, so the Web panels simply did not exist off a tarball. These tests
 * pack for real and hold the tarball to three invariants: it packs, every path
 * the manifest declares is inside it, and no shipped module imports a relative
 * path the tarball does not carry.
 *
 * The declared paths come from `package.json`, never from the working tree's
 * `lib/`: `pnpm pack` reruns `prepack`, which deletes and rebuilds `lib/`, so
 * comparing the tarball against that directory compares one run with itself.
 */
describe('packed tarball', () => {
  const stage = mkdtempSync(join(tmpdir(), 'pack-'))
  // `pnpm` is an executable only on POSIX: the Windows shim is `pnpm.CMD`, and
  // Node refuses to spawn a `.cmd` without a shell, so the pack goes through the
  // platform shell there. The only value interpolated into that command is the
  // temporary directory this test created.
  const packed = process.platform === 'win32'
    ? spawnSync(`pnpm pack --pack-destination "${stage}"`, { cwd: root, encoding: 'utf8', shell: true })
    : spawnSync('pnpm', ['pack', '--pack-destination', stage], { cwd: root, encoding: 'utf8' })
  const tarball = packed.status === 0 ? readdirSync(stage).find(name => name.endsWith('.tgz')) : undefined
  if (tarball !== undefined) {
    spawnSync('tar', ['-xzf', join(stage, tarball)], { cwd: stage })
  }
  const packageDir = join(stage, 'package')
  const shipped = join(packageDir, 'lib')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackedManifest

  it('packs at all, with the lib directory inside', () => {
    expect(packed.status).toBe(0)
    expect(tarball).toBeDefined()
    expect(existsSync(shipped)).toBe(true)
  })

  it('ships every path the manifest declares', () => {
    // A missing one is a package that installs, declares a surface the host or a
    // consumer resolves by that exact path, and then fails when it is loaded.
    const missing = declaredPaths(manifest).filter(path => !existsSync(join(packageDir, path)))
    expect(missing).toEqual([])
  })

  it('ships a browser half that registers this package', () => {
    // `dsh.client` makes the host fetch `<package>/client.js`; the check on its
    // content stays loose because the loader parses the banner it is wrapped in.
    expect(manifest.dsh?.client).toBeDefined()
    const client = join(shipped, 'client.js')
    expect(existsSync(client)).toBe(true)
    const text = readFileSync(client, 'utf8')
    expect(text).toContain('__ModuleLoader__')
    expect(text).toContain(manifest.name)
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
})
