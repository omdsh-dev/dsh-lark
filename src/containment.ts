/**
 * One question, asked of the filesystem instead of of a string: is this path
 * inside that directory?
 *
 * Both directions of a file transfer have to ask it, and neither can answer it
 * with `resolve`. A path that string-resolves under the workspace still reads
 * and writes wherever a symlink along it points, so the answer has to come from
 * the canonical form of what the filesystem actually holds — outbound before it
 * takes bytes out of a workspace (ADR 0004), inbound before it puts bytes into
 * a directory it just made.
 *
 * The COMPARISON is the filesystem's too, and that is the second thing a string
 * cannot answer. `C:\Work` and `c:\work` are one directory on Windows, one on
 * macOS' default volume, and two on Linux; `===` and `startsWith` answer that
 * question with the rules of whichever platform the author had in mind, which is
 * how an operator's own configured root — or their own home directory — comes
 * back as a foreign path.
 *
 * A platform test will not do either, because the platform is not the volume:
 * `path.relative` folds case on Windows and nowhere else, while macOS' default
 * APFS volume folds it too — and a case-sensitive volume on either host does
 * not. So the question is put to the filesystem itself, which is the only thing
 * that knows: do these two spellings name one object? That answer is an
 * IDENTITY (`stat`'s device and inode), not a spelling, and it holds on every
 * host and on either kind of volume. A spelling with nothing on disk to identify
 * keeps the `relative` comparison, so a configured root that does not exist yet,
 * or a landing directory about to be created, is answered exactly as before.
 * @module dsh-lark-channel/containment
 */

import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * One path's canonical form, or undefined when the filesystem will not produce
 * one — nothing there, a dangling link, a component it will not traverse.
 * @param path - an absolute path.
 * @returns the canonical path, or undefined.
 */
export function canonicalPathOf(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * One path's identity as the filesystem knows it, or undefined when there is
 * nothing there to identify.
 *
 * Device and inode together name one object; two spellings of one directory
 * share them, and two directories never do. Read as bigints because an inode is
 * a 64-bit number on most of the filesystems that matter, and a number that
 * rounded would compare equal to its neighbours.
 * @param path - an absolute path.
 * @returns its identity, or undefined when the filesystem will not produce one.
 */
function identityOf(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true })
    // An inode of 0 is what a filesystem that keeps none reports — some network
    // shares and FAT volumes. Every file there would answer with it, so identity
    // would call two strangers one object, and inside a container it would find
    // the first ancestor "equal" and let anything through. That is not an answer,
    // so the spelling comparison is asked instead, as it is when nothing is there.
    if (stats.ino === 0n) return undefined
    return `${stats.dev}:${stats.ino}`
  } catch {
    return undefined
  }
}

/**
 * Whether two paths name the same location.
 *
 * A path that is not absolute answers false rather than being read against the
 * process working directory: this asks about a place, and a spelling that never
 * named one must not quietly borrow the cwd's meaning. That check comes first,
 * because a relative spelling is exactly what would borrow it.
 * @param left - an absolute path.
 * @param right - an absolute path.
 * @returns true when both name the same location.
 */
export function isSamePath(left: string, right: string): boolean {
  if (!isAbsolute(left) || !isAbsolute(right)) return false
  const leftPath = resolve(left)
  const rightPath = resolve(right)
  const leftId = identityOf(leftPath)
  const rightId = identityOf(rightPath)
  // Both really there: identity is the answer, and the only one that holds on
  // every host and either kind of volume. Nothing else about them is consulted,
  // so `c:\users\me` and `C:\Users\me` are one home wherever the volume says so.
  if (leftId !== undefined && rightId !== undefined) return leftId === rightId
  return relative(leftPath, rightPath) === ''
}

/**
 * Whether one path sits at or inside a container directory.
 *
 * Spelled out here rather than reached for from `workspaceRoots`: an allow-list
 * that reads an empty list as "anywhere at all" has no business under a
 * security check. What IS shared is the comparison itself, so that "is this
 * under that" exists once and cannot be fixed for case folding in one caller
 * and left broken in the other.
 *
 * Both sides are expected CANONICAL — that is what the callers establish with
 * `canonicalPathOf` — and asking the filesystem for identity here does not
 * substitute for that: a spelling whose last component is a link to elsewhere is
 * identified as the elsewhere it points at, while the ancestors walked below are
 * the ones it was spelled with.
 * @param path - an absolute path.
 * @param container - an absolute directory.
 * @returns true when the path is the container or below it.
 */
export function isWithinContainer(path: string, container: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(container)) return false
  // Folded before anything is asked, because the ancestor walk below is lexical:
  // a spelling like `<dir>/..` must be compared as the directory it names, not
  // walked up from the string `..` sits in.
  const target = resolve(path)
  const root = resolve(container)
  const containerId = identityOf(root)
  const pathId = identityOf(target)
  if (containerId !== undefined && pathId !== undefined) {
    // Both really exist, so the walk answers it exactly: the path is inside the
    // container when the container is the path or one of its ancestors, and
    // "one of its ancestors" is asked by identity so that a differently cased
    // spelling of the very same directory still counts.
    if (pathId === containerId) return true
    for (let ancestor = dirname(target); ;) {
      if (identityOf(ancestor) === containerId) return true
      const above = dirname(ancestor)
      // The filesystem root is its own parent: nothing above it can be the container.
      if (above === ancestor) return false
      ancestor = above
    }
  }
  const within = relative(root, target)
  // A path on another drive comes back absolute rather than relative: Windows
  // has no `..` that reaches across one.
  return within === '' || (!isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`))
}
