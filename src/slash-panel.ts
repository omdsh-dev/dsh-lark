/**
 * The bot's native slash-command panel. Feishu shows a chooser when a user
 * types `/`, built from commands registered on the APP rather than sent in a
 * message, so a chat only discovers what this channel accepts if the panel is
 * kept in step with it.
 *
 * The sync reconciles THREE things, not two: what the panel is missing, what
 * this channel no longer offers, and what it offers with text that has since
 * changed. The third was the gap that made a fixed command look unfixed — the
 * panel kept the description it was created with, so `/permission` went on
 * advertising the host's old one-line English summary long after this channel
 * gave it a card, a picker and a Chinese name. The platform has no update
 * route, so a changed description is repaired by removing the entry and
 * registering it again.
 * @module dsh-lark-channel/slash-panel
 */

/** One command already registered on the app. */
export interface PanelCommand {
  readonly command: string
  readonly commandId: string
  /**
   * The description the panel shows for it, when the platform reports one.
   * Absent means "cannot tell": the entry is left alone rather than rewritten
   * against a description nobody managed to read.
   */
  readonly description?: string | undefined
}

/** The panel operations this sync needs from the transport. */
export interface SlashPanelPort {
  /** Every command currently registered on the app. */
  listSlashCommands(): Promise<PanelCommand[]>
  /** Register one command; the platform rejects a duplicate name. */
  createSlashCommand(command: string, description: string): Promise<void>
  /** Remove one command by the id the listing gave it. */
  deleteSlashCommand(commandId: string): Promise<void>
}

/** One command this channel wants the panel to offer. */
export interface DesiredCommand {
  readonly name: string
  readonly description: string
}

/** What one reconciliation changed, for the caller to report. */
export interface PanelSync {
  readonly added: string[]
  /** Entries re-registered because their description no longer matched. */
  readonly updated: string[]
  readonly removed: string[]
}

/**
 * Make the panel offer exactly what this channel accepts, under the text it
 * accepts it with.
 * @param port - the panel operations.
 * @param desired - what this channel accepts.
 * @param notify - operator console line.
 * @returns the names added, re-registered and removed.
 */
export async function syncSlashPanel(
  port: SlashPanelPort,
  desired: readonly DesiredCommand[],
  notify: (line: string) => void,
): Promise<PanelSync> {
  let existing: PanelCommand[]
  try {
    existing = await port.listSlashCommands()
  } catch (error) {
    // Discovery is a convenience; a channel whose app cannot list commands
    // still accepts every one of them typed by hand.
    notify(`lark-channel: slash-command panel not synced: ${error instanceof Error ? error.message : String(error)}`)
    return { added: [], updated: [], removed: [] }
  }
  const known = new Map(existing.map(entry => [entry.command, entry]))
  const wanted = new Set(desired.map(command => command.name))
  const added: string[] = []
  const updated: string[] = []
  const removed: string[] = []
  for (const command of desired) {
    const entry = known.get(command.name)
    if (entry === undefined) {
      try {
        await port.createSlashCommand(command.name, command.description)
        added.push(command.name)
      } catch (error) {
        notify(`lark-channel: could not register /${command.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }
    if (entry.description === undefined || entry.description === command.description) continue
    // Replace, not patch: the platform offers create and delete only. A delete
    // that lands and a create that does not would leave the menu WITHOUT the
    // command, so that half is reported as the loss it is.
    try {
      await port.deleteSlashCommand(entry.commandId)
    } catch (error) {
      notify(`lark-channel: could not refresh /${command.name}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    try {
      await port.createSlashCommand(command.name, command.description)
      updated.push(command.name)
    } catch (error) {
      notify(
        `lark-channel: removed /${command.name} to refresh its text but could not register it again: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  for (const entry of existing) {
    if (wanted.has(entry.command)) continue
    try {
      await port.deleteSlashCommand(entry.commandId)
      removed.push(entry.command)
    } catch (error) {
      notify(`lark-channel: could not remove /${entry.command}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { added, updated, removed }
}
