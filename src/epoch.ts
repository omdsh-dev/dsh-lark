/**
 * Legacy epochs, read-only.
 *
 * A conversation's session id is derived from the chat and the directory. That
 * leaves nothing to vary when someone wants a fresh context without moving, and
 * `/new` used to answer that with an epoch: a small integer per
 * (conversation × directory), stored beside the workspace and model maps and
 * folded into the id as `--e<N>`.
 *
 * Nothing writes that counter any more — `/new` mints an id instead, because a
 * counter makes a new session's identity depend on state that must never be
 * lost, and one dropped write then hands back an id the conversation already
 * ran (see `new-session.ts`). What this module keeps is the arithmetic and the
 * tolerant reader for the entries that were stored: conversations that ran on
 * an epoch id are still on it, and the id is the only pointer to that thread.
 * The stored section stays readable forever; it is simply never advanced.
 * @module dsh-lark-channel/epoch
 */

/** Entry value marking "explicitly the first epoch": a deep-merged patch cannot delete a key. */
const DEFAULT_MARKER = ''

/**
 * Fold a legacy epoch into the session id a conversation derives.
 * @param baseId - the id at epoch zero.
 * @param epoch - the conversation's epoch.
 * @returns the id, unchanged at epoch zero.
 */
export function epochSessionId(baseId: string, epoch: number): string {
  return epoch <= 0 ? baseId : `${baseId}--e${epoch}`
}

/**
 * The legacy epoch one stored conversation still runs on.
 * @param entries - the persisted `chatEpochs` section.
 * @param baseId - the id that conversation derives at epoch zero.
 * @returns the epoch; zero for a conversation that never started over.
 */
export function legacyEpochOf(entries: Record<string, string> | undefined, baseId: string): number {
  const entry = entries?.[baseId]
  if (entry === undefined || entry === DEFAULT_MARKER) return 0
  const parsed = Number.parseInt(entry, 10)
  // A malformed entry reads as the first epoch rather than throwing: a
  // hand-edited settings file must not be able to break every message.
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}
