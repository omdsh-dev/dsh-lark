/**
 * Consumer-side runtime bundle for Git and tarball installs, emitted by
 * `scripts/prepare.mjs` after the declarations are compiled.
 *
 * Both faces are bundled here, because the package declares both: the Node half
 * from `src` without any repository project references, and the browser half
 * through the same contract the development build uses. A prepared artifact
 * without it would declare `dsh.client` while shipping no `lib/client.js`, so
 * the Web panels would simply not exist there.
 */
import { defineConfig } from 'tsdown'
import { clientBundle } from './tsdown.client.ts'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
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
  },
  // Bundles the Client face's JavaScript, which the prepare script emitted into
  // `lib/types-client` from `tsconfig.prepare.client.json`.
  clientBundle(),
])
