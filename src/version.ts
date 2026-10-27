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
 *
 * The manifest is this package's own, but a published tarball is assembled by
 * other tools: a missing or non-string `version` is a broken install, and the
 * CLI pins the plugin it provisions to this value — so it is checked rather
 * than asserted, and fails where the reason is legible instead of surfacing as
 * a `split` on undefined three calls later.
 * @returns the version, e.g. `0.0.3`.
 * @throws when the manifest cannot be read or carries no usable version.
 */
export function ownVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const version = (manifest as { version?: unknown } | null)?.version
  if (typeof version !== 'string' || version === '') {
    throw new Error('dsh-lark-channel: package.json carries no version')
  }
  return version
}
