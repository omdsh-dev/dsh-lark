/**
 * Development build config for `dsh-lark-channel`.
 *
 * Two faces, two artifact contracts:
 *
 * - The Node half runs from a real install, so its production dependencies stay
 *   imports and everything else inlines. Its entries are the Host face's emitted
 *   JavaScript, which `tsc -b` already emitted beside the types.
 * - The browser half is the shared contract in `tsdown.client.ts`, which the
 *   prepare pipeline uses unchanged so a Git or tarball install ships the same
 *   artifact this build produces.
 */
import { defineConfig } from 'tsdown'
import { clientBundle, isBareSpecifier } from './tsdown.client.ts'

export default defineConfig([
  {
    entry: {
      index: 'lib/types/index.js',
      cli: 'lib/types/cli.js',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      // The Node half runs from a real install: a production dependency is on
      // disk there and stays an import, everything else inlines.
      neverBundle: (specifier: string) => /^@deepseek-ai\/(schemastery|cordis)(\/|$)/.test(specifier),
      alwaysBundle: (specifier: string) => !isBareSpecifier(specifier),
    },
  },
  clientBundle(),
])
