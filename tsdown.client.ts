/**
 * The browser half's bundle contract, shared by both build pipelines.
 *
 * `pnpm build` bundles the Client face from the JavaScript `tsc -b` emitted, and
 * `prepare` — which serves Git and tarball installs without any repository
 * project references — emits that JavaScript itself and bundles the same file.
 * One artifact, so the entry is the same and only the compile step differs.
 *
 * The browser half is fetched by the Web shell as a classic script and registers
 * itself through `window.__ModuleLoader__.load`, so it must be a CommonJS body
 * inside that factory — never top-level ESM. Bare specifiers stay `require()`
 * calls the module table answers; package-local modules and CSS Modules inline,
 * because a relative require the table cannot answer is a guaranteed runtime
 * throw.
 * @module dsh-lark-channel/tsdown.client
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path'
import { defineConfig, type TsdownPlugin } from 'tsdown'
import { transform } from 'lightningcss'

/** Package name; the module table keys this bundle by it, so the two must agree. */
export const CLIENT_ID = 'dsh-lark-channel'

/** The Client face's entry as `tsc` emits it, which is what both pipelines bundle. */
export const CLIENT_ENTRY = 'lib/types-client/client/index.js'

/** Virtual-id wrapper keeping module CSS off tsdown's own stylesheet pipeline. */
const CSS_PREFIX = '\0dsh-lark-css:'
const CSS_SUFFIX = '.mjs'

/** Whether a specifier names a package rather than a file beside its importer. */
export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('\0') && !isAbsolute(specifier)
}

/**
 * Emit one plugin-owned style injector plus its CSS Modules class map.
 *
 * The class map is what the component imports, so hashing happens here rather
 * than in the browser: two plugins using the same local name must not collide.
 * @param id - package name stamped onto the injected tag for HMR bookkeeping.
 * @param fileId - absolute stylesheet path, used as the tag identity.
 * @param css - compiled stylesheet text.
 * @param classMap - local class name to emitted class name.
 * @returns the virtual module source.
 */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap: Readonly<Record<string, string>>,
): string {
  const tagId = `${id}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** Path segment separating the Client face's tsc output from the sources it came from. */
const TYPES_MARKER = `${sep}lib${sep}types-client${sep}`

/**
 * Resolve one stylesheet import against the package sources.
 *
 * The bundle consumes tsc's emitted JavaScript, which imports the sheet by the
 * path it had in `src` — and tsc copies no assets, so the emitted neighbour does
 * not exist. Rebasing the import onto the source tree is what finds it.
 * @param source - relative import specifier as written in the source.
 * @param importer - absolute path of the importing module.
 * @returns the stylesheet on disk.
 */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}

/** Inline `*.module.css` as a hashed class map plus one injected style tag. */
function cssModulesPlugin(): TsdownPlugin {
  return {
    name: 'dsh-lark-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const base = importer === undefined ? process.cwd() : dirname(importer)
      return CSS_PREFIX + sourceAssetPath(source, resolvePath(base, '_')) + CSS_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_PREFIX)) return null
      const fileId = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      // The virtual id hides the physical sheet from the watcher otherwise.
      this.addWatchFile(fileId)
      const { code, exports } = transform({
        filename: fileId,
        code: await readFile(fileId),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      // Sorted by code unit, because lightningcss returns this map in an
      // unspecified order: an artifact whose bytes change from run to run cannot
      // be compared, cached, or reproduced from a published tarball. The emitted
      // class names are unaffected — only the order they are listed in.
      const order = Object.entries(exports ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exported] of order) classMap[local] = exported.name
      return styleInjectionModule(CLIENT_ID, fileId, code.toString(), classMap)
    },
  }
}

/**
 * The browser half's bundle config, for one pipeline to place in its own array.
 *
 * Both pipelines bundle {@link CLIENT_ENTRY}, so the CommonJS factory wrapper,
 * the module-table id and the CSS Modules inlining cannot drift apart between
 * what a checkout runs and what a published tarball ships.
 * @returns the tsdown config entry for `lib/client.js`.
 */
export function clientBundle() {
  return defineConfig({
    entry: { client: CLIENT_ENTRY },
    outDir: 'lib',
    // CommonJS inside the loader factory, never top-level ESM: the shell loads
    // this artifact as a classic script.
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      // A bare specifier is a module-table request the shell answers; anything
      // package-local must inline, or the browser throws on an unresolvable
      // relative require.
      neverBundle: isBareSpecifier,
      alwaysBundle: (specifier: string) => !isBareSpecifier(specifier),
    },
    plugins: [cssModulesPlugin()],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  })
}
