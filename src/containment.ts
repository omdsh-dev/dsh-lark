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
 * @module dsh-lark-channel/containment
 */

import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

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
 * Whether one canonical path sits at or inside a canonical container.
 *
 * Spelled out here rather than reached for from `workspace.ts`: `withinRoots`
 * reads an empty list as "anywhere at all", and a predicate carrying an
 * allow-everything mode has no business under a security check.
 * @param path - a canonical path.
 * @param container - a canonical directory.
 * @returns true when the path is the container or below it.
 */
export function isWithinContainer(path: string, container: string): boolean {
  if (path === container) return true
  return path.startsWith(container.endsWith(sep) ? container : `${container}${sep}`)
}
