import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSamePath, isWithinContainer } from '../src/containment.ts'
import { linkDirectory } from './platform.ts'

/**
 * How this host folds path case for a spelling that names nothing on disk.
 *
 * The cases using it compare `/srv/alpha` and `/srv/ALPHA`, and no such
 * directory exists — so there is no object to identify, and the answer comes
 * from `path.relative`, which folds on Windows and nowhere else. That is a
 * different question from "are these two spellings one directory", which only a
 * filesystem can answer: the case with real directories below asks that one, and
 * takes its expectation from the filesystem rather than from the host's name.
 */
const caseFolding = process.platform === 'win32'

/** The basename with every letter's case turned over, the rest of the path untouched. */
function swappedCase(path: string): string {
  const flipped = basename(path).replace(/[a-z]/gi, (letter) => (
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()
  ))
  return join(dirname(path), flipped)
}

/** Whether this spelling names anything at all — the volume's own verdict on it. */
function namesSomething(spelling: string): boolean {
  try {
    statSync(spelling)
    return true
  } catch {
    return false
  }
}

describe('isWithinContainer', () => {
  it('accepts the container itself and its descendants, and nothing beside it', () => {
    expect(isWithinContainer('/srv/alpha', '/srv/alpha')).toBe(true)
    expect(isWithinContainer('/srv/alpha/sub', '/srv/alpha')).toBe(true)
    // Shares the prefix and shares nothing else: a string test says yes here.
    expect(isWithinContainer('/srv/alphabet', '/srv/alpha')).toBe(false)
    expect(isWithinContainer('/other', '/srv/alpha')).toBe(false)
  })

  it('reads the parent marker by component, not by prefix', () => {
    // A child whose NAME begins with two dots is still a child — and the file a
    // prefix test would refuse for "climbing out of the workspace".
    expect(isWithinContainer('/srv/alpha/..foo', '/srv/alpha')).toBe(true)
    expect(isWithinContainer('/srv/alpha/..', '/srv/alpha')).toBe(false)
    expect(isWithinContainer('/srv/alpha/../beta', '/srv/alpha')).toBe(false)
  })

  it('answers case the way the host filesystem does', () => {
    expect(isWithinContainer('/srv/alpha/sub', '/srv/ALPHA')).toBe(caseFolding)
  })

  it('refuses a path that never named a place', () => {
    // Neither side may be read against the process working directory: a
    // relative spelling that happens to sit under the cwd is not evidence.
    expect(isWithinContainer('sub/a.txt', '/srv/alpha')).toBe(false)
    expect(isWithinContainer('/srv/alpha', 'alpha')).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('refuses a container on another drive', () => {
    // No `..` reaches across a drive, and the comparison must not pretend one
    // does by treating a whole absolute path as a relative one.
    expect(isWithinContainer('D:\\work\\a.txt', 'C:\\work')).toBe(false)
  })

  it('settles a real `..` before walking, so a parent is not inside its child', () => {
    // Every case above names `/srv/alpha`, which exists nowhere — so none of them
    // reaches the ancestor walk. These paths are real, and the `..` is built with
    // `sep` because `join` would fold it away before the function ever saw it.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-Parent-')))
    try {
      mkdirSync(join(directory, 'sub'))
      expect(isWithinContainer(`${directory}${sep}..`, directory)).toBe(false)
      expect(isWithinContainer(`${directory}${sep}sub${sep}..`, directory)).toBe(true)
      expect(isWithinContainer(directory, dirname(directory))).toBe(true)
      expect(isWithinContainer(directory, directory)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reads a root spelled as a link alias as the directory it points at', () => {
    // A caller canonicalizes its candidate and an operator writes their root by
    // hand, so a root spelled as a link to the real directory matched nothing at
    // all — on every platform, Linux included. Identity is what a link and its
    // target share, and it is the one thing this pair has in common.
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-Real-')))
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-Alias-')))
    try {
      mkdirSync(join(real, 'sub'))
      linkDirectory(real, join(elsewhere, 'root'))
      const alias = join(elsewhere, 'root')

      expect(isSamePath(alias, real)).toBe(true)
      // The candidate reached by its real name, the root by its alias.
      expect(isWithinContainer(join(real, 'sub'), alias)).toBe(true)
      // And the other way round.
      expect(isWithinContainer(join(alias, 'sub'), real)).toBe(true)
      // A directory beside the target is still outside it.
      expect(isWithinContainer(elsewhere, alias)).toBe(false)
    } finally {
      rmSync(real, { recursive: true, force: true })
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('isSamePath', () => {
  it('is true for one location spelled twice, and false for two', () => {
    expect(isSamePath('/srv/alpha', '/srv/alpha')).toBe(true)
    expect(isSamePath('/srv/alpha', '/srv/beta')).toBe(false)
    expect(isSamePath('/srv/alpha', '/srv/alpha/sub')).toBe(false)
  })

  it('answers case the way the host filesystem does', () => {
    expect(isSamePath('/srv/alpha', '/srv/ALPHA')).toBe(caseFolding)
  })

  it('refuses a spelling that named no absolute place', () => {
    expect(isSamePath('alpha', '/srv/alpha')).toBe(false)
    expect(isSamePath('/srv/alpha', 'alpha')).toBe(false)
  })

  it('asks identity, not spelling: two names for one file are one location', () => {
    // The pair no spelling comparison can get right: a hard link and its
    // original share an inode and share no text at all. Worth pinning on every
    // platform — hard links exist on all three — because it is the assertion
    // that says this predicate decides on what the filesystem holds rather than
    // on how the path was written, which is what the case rule above needs.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-Same-')))
    try {
      writeFileSync(join(directory, 'real.txt'), '')
      linkSync(join(directory, 'real.txt'), join(directory, 'alias.txt'))

      expect(isSamePath(join(directory, 'alias.txt'), join(directory, 'real.txt'))).toBe(true)
      // And a name with nothing behind it is not that file, however it is spelled.
      expect(isSamePath(join(directory, 'other.txt'), join(directory, 'real.txt'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('follows the filesystem when two spellings are one directory', () => {
    // The question `process.platform` cannot answer: a folding volume — Windows,
    // and macOS' default APFS — reads the other spelling as this same directory,
    // while a case-sensitive volume reads it as nothing at all. So the
    // expectation is taken from the filesystem, not from the host's name.
    //
    // Where the volume folds, this is the Home guard firing on a home spelled a
    // way nobody typed; where it does not, the guard must stay quiet, because a
    // differently cased name really is a different place there.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-Case-')))
    try {
      writeFileSync(join(directory, 'child.txt'), '')
      const otherSpelling = swappedCase(directory)
      expect(otherSpelling).not.toBe(directory)
      // A directory of that name cannot exist beside this one — the suffix is
      // random — so naming something at all means naming this directory.
      const oneDirectory = namesSomething(otherSpelling)

      expect(isSamePath(otherSpelling, directory)).toBe(oneDirectory)
      expect(isSamePath(directory, directory)).toBe(true)
      // A child of that directory, reached through the other spelling.
      expect(isWithinContainer(join(otherSpelling, 'child.txt'), directory)).toBe(oneDirectory)
      expect(isWithinContainer(join(directory, 'child.txt'), directory)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
