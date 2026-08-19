import { defineConfig } from 'tsdown'

/**
 * Consumer-side runtime bundle for Git and tarball installs. The prepare
 * script emits declarations first, then this config bundles source without any
 * repository project references.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
    cli: 'src/cli.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  tsconfig: 'tsconfig.prepare.json',
})
