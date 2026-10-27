import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

function packageFile(packageName, relativePath) {
  return join(dirname(require.resolve(`${packageName}/package.json`)), relativePath)
}

// Two compiler faces, then the bundle: the Host face's declarations, the Client
// face's declarations AND its JavaScript (the browser bundle is built from that
// JavaScript in both pipelines, and `src/client` needs jsx and the DOM libs the
// Host face must not have), and finally the runtime bundle that reads both.
const steps = [
  ['tsc', packageFile('typescript', 'bin/tsc'), ['-p', 'tsconfig.prepare.dts.json']],
  ['tsc', packageFile('typescript', 'bin/tsc'), ['-p', 'tsconfig.prepare.client.json']],
  ['tsdown', packageFile('tsdown', 'dist/run.mjs'), ['--config', 'tsdown.prepare.config.ts']],
]

rmSync(join(root, 'lib'), { recursive: true, force: true })

for (const [name, entry, args] of steps) {
  if (!existsSync(entry)) {
    console.error(`prepare: missing local executable ${entry}; run pnpm install first`)
    process.exit(1)
  }
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) {
    console.error(`prepare: failed to run ${name}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
