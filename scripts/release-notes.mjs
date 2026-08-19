#!/usr/bin/env node
/**
 * Print one version's section of the changelog, for a release body.
 *
 * The changelog is already the release notes — written when the change was
 * made, in the words that explained why. Retyping it into a release form is
 * how the two drift, so the form is filled from the file.
 *
 * Usage: node scripts/release-notes.mjs 0.0.6
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
if (version === undefined || version === '') {
  process.stderr.write('usage: release-notes.mjs <version>\n')
  process.exit(1)
}

const changelog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8')
const lines = changelog.split('\n')
const start = lines.findIndex(line => line.startsWith('## ') && line.includes(version))
if (start < 0) {
  process.stderr.write(`no section for ${version} in CHANGELOG.md\n`)
  process.exit(1)
}
const rest = lines.slice(start + 1)
const end = rest.findIndex(line => line.startsWith('## '))
process.stdout.write(`${(end < 0 ? rest : rest.slice(0, end)).join('\n').trim()}\n`)
