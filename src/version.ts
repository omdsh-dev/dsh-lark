/**
 * This package's own version, shared by the CLI (which pins the plugin it
 * provisions to itself) and the channel (whose `/status` names what is
 * running). Read through `import.meta.url` rather than a bare specifier: the
 * bundler leaves a runtime URL alone, and both `src/` and the published `lib/`
 * sit one directory below the manifest.
 * @module dsh-lark-channel/version
 */

import { readFileSync } from 'node:fs'

/**
 * The version string from this package's manifest.
 * @returns the version, e.g. `0.0.3`.
 */
export function ownVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return manifest.version
}
