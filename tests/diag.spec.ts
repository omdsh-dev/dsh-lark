import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileDiag, DEFAULT_DIAG_FILENAME, diagFilePath } from '../src/diag.ts'

/** Directories this spec created, removed after each case. */
const created: string[] = []

/** One fresh scratch directory, registered for teardown. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lark-diag-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('where a diagnostic file lands', () => {
  it('treats a path with an extension as the file itself', () => {
    expect(diagFilePath({ file: '/var/log/lark.log' })).toBe('/var/log/lark.log')
    expect(diagFilePath({ file: '/var/log/diag.txt' })).toBe('/var/log/diag.txt')
  })

  it('treats an extensionless path as a directory for the default name', () => {
    expect(diagFilePath({ file: '/var/log' })).toBe(resolve('/var/log', DEFAULT_DIAG_FILENAME))
    expect(diagFilePath({ file: 'logs', cwd: '/base' })).toBe(resolve('/base/logs', DEFAULT_DIAG_FILENAME))
  })

  it('reads a trailing separator as a directory however the name ends', () => {
    expect(diagFilePath({ file: '/var/logs/' })).toBe(resolve('/var/logs', DEFAULT_DIAG_FILENAME))
  })

  it('does not read a leading dot as an extension', () => {
    // `.hidden` is a directory named that, not a file with extension `hidden`;
    // guessing the other way scatters a log beside the directory intended.
    expect(diagFilePath({ file: '/base/.hidden' })).toBe(resolve('/base/.hidden', DEFAULT_DIAG_FILENAME))
  })

  it('resolves a relative path against the given cwd', () => {
    expect(diagFilePath({ file: 'out/lark.log', cwd: '/base' })).toBe(resolve('/base/out/lark.log'))
  })
})

describe('writing diagnostics to a file', () => {
  it('appends one timestamped line per call, creating the directory', () => {
    const file = join(scratch(), 'nested', 'lark.log')
    const sink = createFileDiag({ file })
    sink('info', 'first')
    sink('warn', 'second')
    // Split on either ending: the file is written with `\n`, but a reader on
    // Windows may still hand back `\r\n` through some editors and tools.
    const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] INFO first$/)
    expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] WARN second$/)
  })

  it('keeps everything at or above the configured floor, and drops the rest', () => {
    const file = join(scratch(), 'lark.log')
    const sink = createFileDiag({ file, level: 'warn' })
    sink('debug', 'trace')
    sink('info', 'note')
    sink('warn', 'trouble')
    sink('error', 'failure')
    const written = readFileSync(file, 'utf8')
    expect(written).toMatch(/WARN trouble/)
    expect(written).toMatch(/ERROR failure/)
    expect(written).not.toMatch(/trace/)
    expect(written).not.toMatch(/note/)
  })

  it('keeps info by default, so an unconfigured deployment still records reports', () => {
    const file = join(scratch(), 'lark.log')
    createFileDiag({ file })('info', 'kept')
    expect(readFileSync(file, 'utf8')).toContain('kept')
  })

  it('reports an unwritable target once, then stops trying', () => {
    // A path whose parent is a FILE cannot be created as a directory, so every
    // append fails. The channel must survive it, so failure is contained to the
    // diagnostic — and reported once, because a sink that announced each failure
    // would flood the console it is failing to write to.
    const dir = scratch()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const failures: string[] = []
    const broken = createFileDiag({ file: join(blocker, 'lark.log') }, reason => failures.push(reason))
    broken('warn', 'one')
    broken('warn', 'two')
    broken('warn', 'three')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('diagnostics cannot be written')
  })

  it('restarts the file once it outgrows its ceiling', () => {
    // An append-only sink is a disk-filling bug with a long fuse: the channel is
    // meant to run for months, and its own reports scale with traffic.
    const file = join(scratch(), 'lark.log')
    createFileDiag({ file, maxBytes: 200 })('warn', 'x'.repeat(400))
    expect(readFileSync(file, 'utf8')).toContain('xxxx')
    // The size check runs at the start of a sink's first write (and every 256
    // lines after), so a fresh sink over the ceiling restarts the file.
    createFileDiag({ file, maxBytes: 200 })('warn', 'after')
    const written = readFileSync(file, 'utf8')
    expect(written).toContain('diagnostics restarted after')
    expect(written).toContain('after')
    expect(written).not.toContain('xxxx')
  })

  it('leaves a file under its ceiling alone', () => {
    const file = join(scratch(), 'lark.log')
    createFileDiag({ file, maxBytes: 10_000 })('warn', 'first')
    createFileDiag({ file, maxBytes: 10_000 })('warn', 'second')
    const written = readFileSync(file, 'utf8')
    expect(written).toContain('first')
    expect(written).toContain('second')
    expect(written).not.toContain('diagnostics restarted')
  })
})
