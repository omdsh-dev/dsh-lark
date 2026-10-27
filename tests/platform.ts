/**
 * The three fixtures this suite cannot ask for the same way everywhere.
 *
 * A symbolic link, a directory reached through one, and a file the process may
 * not read are all ordinary on POSIX and all spelled differently on Windows:
 * the first needs a privilege an unelevated token does not have, the second has
 * an unprivileged form Windows calls a junction, and the third comes from an
 * ACL rather than from a mode bit. Each helper below names the platform's own
 * mechanism, so a test that states an invariant runs wherever the invariant can
 * be expressed — instead of failing on a fixture it cannot build.
 * @module dsh-lark-channel/tests/platform
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Whether this process may create a symbolic link to a file.
 *
 * Windows grants that only to an elevated token or one with Developer Mode on,
 * so a test whose subject IS a file symlink can run only where the platform
 * allows it. Probed once and remembered: the probe creates a link itself.
 *
 * Only a refusal of the link itself reads as "cannot here". A probe that fails
 * some other way — an unwritable temp directory, a full disk — is this host
 * failing to build the fixture, and answering `false` for it would silently
 * retire two security tests on any platform. Those run, and fail loudly instead.
 * @returns true when {@link symlinkSync} can make a file link here.
 */
export function canSymlinkFile(): boolean {
  if (fileSymlink === undefined) fileSymlink = probeFileSymlink()
  return fileSymlink
}

let fileSymlink: boolean | undefined

/** The errnos by which a platform says "you may not make a link here". */
const LINK_REFUSALS = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'])

/** One file link in a throwaway directory, asked once. */
function probeFileSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'dsh-lark-link-'))
  try {
    writeFileSync(join(probe, 'target'), '')
    symlinkSync(join(probe, 'target'), join(probe, 'link'))
    return true
  } catch (error) {
    return !LINK_REFUSALS.has((error as NodeJS.ErrnoException).code ?? '')
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

/**
 * Make one directory entry that resolves to another directory, on every platform.
 *
 * The two branches are the two platforms' own mechanisms, spelled separately on
 * purpose: `junction` is Windows' unprivileged directory link, and off Windows
 * the call is written exactly as it was before this helper existed — a plain
 * directory symlink with no type. `symlink(2)` has no notion of a link type, so
 * POSIX behaviour here is unchanged by construction rather than by relying on
 * the `type` argument being ignored.
 *
 * `junction` targets must be absolute on Windows; every call site passes one.
 * Both forms are resolved by `realpath`, which is the property the containment
 * checks are written against.
 * @param target - the directory to point at; must be absolute on Windows.
 * @param path - where to create the link.
 */
export function linkDirectory(target: string, path: string): void {
  if (process.platform === 'win32') symlinkSync(target, path, 'junction')
  else symlinkSync(target, path)
}

/**
 * Make `path` a file this process can stat but cannot read.
 *
 * POSIX says so with a mode; Windows has no such bit, so the refusal has to come
 * from an explicit deny. The deny covers Read Data alone rather than generic
 * read, because generic read carries `FILE_READ_ATTRIBUTES` with it — the file
 * would stop looking like a file at all, and the read would never be reached.
 *
 * The deny names the well-known Everyone SID rather than an account, so it does
 * not depend on the display language; and the child runs with ignored stdio,
 * because a confined runner denies the pipes a captured spawn would open.
 * @param path - the file to make unreadable.
 * @throws {Error} when Windows refuses the deny, since the test then has no fixture.
 */
export function denyRead(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o000)
    return
  }
  try {
    execFileSync('icacls', [path, '/deny', '*S-1-1-0:(RD)'], { stdio: 'ignore' })
  } catch (error) {
    throw new Error(`could not deny read on ${path}: ${String(error)}`)
  }
}

/**
 * The errno a denied read carries on this platform.
 *
 * POSIX reserves `EPERM` for other refusals and reports a denied open as
 * `EACCES`; Windows reports it as `EPERM`. Asserting the one this host produces
 * keeps the check exact instead of widening it to "some refusal".
 */
export const READ_DENIED_CODE = process.platform === 'win32' ? 'EPERM' : 'EACCES'
