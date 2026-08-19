/**
 * The bot's native slash-command panel. Feishu shows a chooser when a user
 * types `/`, built from commands registered on the APP rather than sent in a
 * message, so a chat only discovers what this channel accepts if the panel is
 * kept in step with it.
 *
 * The sync reconciles: it creates what the panel is missing and removes what
 * this channel no longer offers. An additive-only sync was tried first, on the
 * reasoning that the panel belongs to the app and a human might have curated
 * it. Drift turned out to be the real cost — a command removed from the channel
 * stayed in the menu and answered "unknown command" for everyone who picked it
 * — while a deployment that does curate its own menu has `syncSlashCommands`
 * to turn this off.
 * @module dsh-lark-channel/slash-panel
 */

/** One command already registered on the app. */
export interface PanelCommand {
  readonly command: string
  readonly commandId: string
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
  readonly removed: string[]
}

/**
 * Make the panel offer exactly what this channel accepts.
 * @param port - the panel operations.
 * @param desired - what this channel accepts.
 * @param notify - operator console line.
 * @returns the names added and removed.
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
    return { added: [], removed: [] }
  }
  const known = new Set(existing.map(entry => entry.command))
  const wanted = new Set(desired.map(command => command.name))
  const added: string[] = []
  const removed: string[] = []
  for (const command of desired) {
    if (known.has(command.name)) continue
    try {
      await port.createSlashCommand(command.name, command.description)
      added.push(command.name)
    } catch (error) {
      notify(`lark-channel: could not register /${command.name}: ${error instanceof Error ? error.message : String(error)}`)
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
  return { added, removed }
}
