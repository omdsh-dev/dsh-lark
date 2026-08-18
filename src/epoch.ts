/**
 * Starting over in the same place.
 *
 * A conversation's session id is derived, not allocated: the same chat (and,
 * after `/cd`, the same directory) resolves to the same id on every boot,
 * which is what lets a restarted process pick a conversation back up. That
 * leaves nothing to vary when someone wants a FRESH context without moving
 * anywhere — the reason `/new` did not exist.
 *
 * An epoch is that varying part: a small integer per (conversation ×
 * directory), stored beside the workspace and model maps and folded into the
 * id. Absent means zero, and zero derives exactly the id it always did, so no
 * stored conversation moves and nothing needs migrating.
 *
 * It is per directory rather than per conversation on purpose: `/cd` already
 * gives each directory its own thread, and resetting the thread you are in
 * should not silently discard the one you would return to.
 *
 * Nothing is deleted. A session log is written when an agent is created, so an
 * epoch nobody speaks into costs nothing at all, and the previous session
 * stays on disk where the host's own tools can still reach it — a chat command
 * should not be able to destroy a record.
 * @module dsh-lark-channel/epoch
 */

/** Start a fresh session for this conversation. Channel-owned: needs no agent. */
export const NEW_COMMAND = 'new'

/** Entry value marking "explicitly the first epoch": a deep-merged patch cannot delete a key. */
const DEFAULT_MARKER = ''

/** Construction options for {@link ChatEpochs}. */
export interface ChatEpochsOptions {
  /** Persisted base-session-id → epoch; {@link DEFAULT_MARKER} means the first. */
  readonly entries?: Record<string, string> | undefined
  /** Deep-merge one patch into the plugin's settings section; false = not composed. */
  readonly persist?: ((patch: { chatEpochs: Record<string, string> }) => Promise<boolean>) | undefined
  /** Operator console line. */
  readonly report?: ((line: string) => void) | undefined
}

/** What one `/new` concluded. */
export interface EpochChange {
  /** The epoch the conversation now runs on. */
  readonly epoch: number
  /** Whether the move survives a restart. */
  readonly durable: boolean
}

/**
 * How many times each conversation has started over, keyed by the session id
 * it would derive at epoch zero. Pure state plus injected persistence,
 * mirroring the workspace and model stores.
 */
export class ChatEpochs {
  private readonly entries: Map<string, string>
  private readonly persist: (patch: { chatEpochs: Record<string, string> }) => Promise<boolean>
  private readonly report: (line: string) => void
  /** The non-durable warning is orientation; once is enough. */
  private warnedNotDurable = false

  constructor(options: ChatEpochsOptions = {}) {
    this.entries = new Map(Object.entries(options.entries ?? {}))
    this.persist = options.persist ?? (async () => false)
    this.report = options.report ?? (() => {})
  }

  /**
   * The epoch one base session id runs on.
   * @param baseId - the id that conversation derives at epoch zero.
   * @returns the epoch; zero for a conversation that never started over.
   */
  epochOf(baseId: string): number {
    const entry = this.entries.get(baseId)
    if (entry === undefined || entry === DEFAULT_MARKER) return 0
    const parsed = Number.parseInt(entry, 10)
    // A malformed entry reads as the first epoch rather than throwing: a
    // hand-edited settings file must not be able to break every message.
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
  }

  /**
   * Move one conversation to a fresh session.
   * @param baseId - the id that conversation derives at epoch zero.
   * @returns the new epoch, and whether it will survive a restart.
   */
  async startNew(baseId: string): Promise<EpochChange> {
    const epoch = this.epochOf(baseId) + 1
    this.entries.set(baseId, String(epoch))
    const durable = await this.persist({ chatEpochs: { [baseId]: String(epoch) } }).catch((error: unknown) => {
      this.report(`lark-channel: persisting the new session failed: ${String(error)}`)
      return false
    })
    if (!durable && !this.warnedNotDurable) {
      this.warnedNotDurable = true
      this.report('lark-channel: new sessions are in-memory only (no settings service); they reset on restart')
    }
    return { epoch, durable }
  }
}

/**
 * Fold an epoch into the session id a conversation derives.
 * @param baseId - the id at epoch zero.
 * @param epoch - the conversation's epoch.
 * @returns the id, unchanged at epoch zero.
 */
export function epochSessionId(baseId: string, epoch: number): string {
  return epoch <= 0 ? baseId : `${baseId}--e${epoch}`
}

/**
 * Run `/new` and produce the chat reply.
 * @param baseId - the conversation's id at epoch zero.
 * @param epochs - the epoch state.
 * @param release - disposes the conversation's current agent; awaited first.
 * @returns markdown for the chat.
 */
export async function runNewCommand(
  baseId: string,
  epochs: ChatEpochs,
  release: () => Promise<void>,
): Promise<string> {
  const result = await epochs.startNew(baseId)
  await release()
  const durability = result.durable ? '' : '\n（本部署未组合 settings，重启后会回到上一个会话。）'
  return '🤖 已开新会话，下一条消息从空白上下文开始。\n已解除会话绑定，回到自动路由；之前的记录仍在，工作区和模型设置不变。' + durability
}
