/**
 * A diagnostic file this channel owns.
 *
 * `notify` and `ctx.logger` both reach the process's terminal and nothing else:
 * the shipped profiles compose no logger exporter, the one exporter the harness
 * vendors writes to stdout, and cordis's own default exporter keeps a 1000-entry
 * in-memory ring. So a report about a chat's behaviour is gone the moment the
 * window that ran the bot is closed — which is precisely when someone asks why
 * the card came back short, hours later.
 *
 * This is that missing sink, and it is deliberately the channel's OWN file: a
 * deployment that composes no logger still gets a durable record, and nothing
 * about the answer depends on how the host's logging happens to be configured.
 *
 * Appending one line at a time through `appendFileSync` rather than holding a
 * stream: a diagnostic is written rarely, and a stream would have to be opened,
 * flushed, and closed around the plugin's disposal to be trustworthy at the
 * moment a crash is being investigated.
 * @module dsh-lark-channel/diag
 */

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/** Where diagnostics land when no deployment overrides the location. */
export const DEFAULT_DIAG_FILENAME = 'dsh-lark-diagnostics.log'

/**
 * Ceiling on the diagnostics file, in bytes.
 *
 * A sink that only ever appends is a disk-filling bug with a long fuse: this
 * channel's own reports scale with traffic (`diagnoseSessions` writes a line per
 * withheld session, `debug` traces every interaction), and a bot is meant to run
 * for months. Past the ceiling the file is restarted with a line saying why.
 */
export const DIAG_MAX_BYTES = 5 * 1024 * 1024

/**
 * Writes between two size checks. The sink sits on the reporting path, so a
 * `statSync` per line would charge every report for bookkeeping; a file that
 * outgrows the ceiling is noticed within this many lines, long before it could
 * matter.
 */
const SIZE_CHECK_EVERY = 256

/** Severity of one diagnostic line, ordered as the levels are. */
export type DiagLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * One diagnostic sink. A function rather than an object because every call site
 * wants exactly this and nothing else, and a deployment substitutes a test
 * double by passing a different function.
 */
export type DiagSink = (level: DiagLevel, line: string) => void

/** Construction options for {@link createFileDiag}. */
export interface FileDiagOptions {
  /**
   * Absolute path of the file, or a directory to place
   * {@link DEFAULT_DIAG_FILENAME} in. Relative paths resolve against `cwd`.
   */
  readonly file: string
  /** The directory a relative `file` resolves against; defaults to the process cwd. */
  readonly cwd?: string | undefined
  /** Floor below which a line is dropped; defaults to `info`. */
  readonly level?: DiagLevel | undefined
  /**
   * Whether a path with no extension names a directory to put the default
   * filename in. True, because an operator writing `--diag ./logs` means the
   * directory, and guessing wrong would scatter files beside it.
   */
  readonly directoryWhenExtensionless?: boolean | undefined
  /** Ceiling in bytes before the file is restarted; defaults to {@link DIAG_MAX_BYTES}. */
  readonly maxBytes?: number | undefined
}

/**
 * Restart the file once it has grown past its ceiling.
 *
 * Truncated in place, with one line saying why, rather than rotated: this is a
 * file the operator reads at a path they configured, and a rotation would leave
 * them reading a path that no longer receives anything. A file that cannot be
 * measured yet — the first write of a process — is left to the append below,
 * which creates it.
 * @param path - the diagnostics file.
 * @param ceiling - the byte ceiling.
 */
function restartIfOversized(path: string, ceiling: number): void {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    // Nothing there yet: the append that follows creates the file.
    return
  }
  if (size <= ceiling) return
  writeFileSync(
    path,
    `[${new Date().toISOString()}] WARN lark-channel: diagnostics restarted after `
    + `${String(size)} bytes exceeded the ${String(ceiling)}-byte ceiling\n`,
    'utf8',
  )
}

/** Numeric rank per level, so a floor can be compared. */
const RANK: Record<DiagLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * Resolve the configured value to the file it names.
 * @param options - the configured path and the cwd relative paths resolve against.
 * @returns the absolute path to append to.
 */
export function diagFilePath(options: FileDiagOptions): string {
  const base = options.cwd ?? process.cwd()
  const configured = isAbsolute(options.file) ? options.file : resolve(base, options.file)
  // An explicit trailing separator settles it: that is a directory, whatever
  // follows the last separator.
  const last = configured.split(/[/\\]/).filter(part => part !== '').pop() ?? ''
  // Otherwise a name carrying an extension is the file. A LEADING dot does not
  // count — `.hidden` is a directory name, not an extension — so the dot has to
  // appear after the first character.
  const asDirectory = options.directoryWhenExtensionless !== false
    && (configured.endsWith('/') || configured.endsWith('\\') || !/\.[^.]*$/.test(last.slice(1)))
  return asDirectory ? resolve(configured, DEFAULT_DIAG_FILENAME) : configured
}

/**
 * Build a sink that appends to one file, creating its directory on first write.
 *
 * Failure is contained to the diagnostic: a read-only directory or a full disk
 * must not take down the channel that was asked to record something. The first
 * failure is reported once through `onFailure`, and later ones are dropped —
 * a sink that reports its own failure through itself would recurse, and one
 * that wrote a line per failure would fill the disk it just ran out of.
 * @param options - where to write, and which levels to keep.
 * @param onFailure - told once, with the reason, when the file cannot be written.
 * @returns the sink.
 */
export function createFileDiag(
  options: FileDiagOptions,
  onFailure?: (reason: string) => void,
): DiagSink {
  const path = diagFilePath(options)
  const floor = RANK[options.level ?? 'info']
  const ceiling = options.maxBytes ?? DIAG_MAX_BYTES
  let disabled = false
  let announced = false
  /** Lines written since the last size check. */
  let sinceCheck = 0
  return (level, line) => {
    if (disabled || RANK[level] < floor) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      if (sinceCheck === 0) restartIfOversized(path, ceiling)
      appendFileSync(path, `[${new Date().toISOString()}] ${level.toUpperCase()} ${line}\n`, 'utf8')
      sinceCheck = (sinceCheck + 1) % SIZE_CHECK_EVERY
    } catch (error: unknown) {
      disabled = true
      if (!announced) {
        announced = true
        onFailure?.(`lark-channel: diagnostics cannot be written to ${path}: ${String(error)}`)
      }
    }
  }
}
