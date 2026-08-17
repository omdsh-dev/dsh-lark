/**
 * Slash commands in a chat. A line beginning with `/` is a control, not a
 * prompt: the host runs it WITHOUT a model turn, so routing it here is what
 * keeps a `/clear` from reaching the model as prose for it to improvise on.
 *
 * Two commands are the channel's own rather than the host's. `/stop` cancels
 * the running turn — cancellation is an agent method, not a registered command
 * — and `/help` lists what this chat accepts, which no host command provides.
 * @module dsh-lark-channel/commands
 */

import type { HostAgent, HostCommands } from './host.ts'
import { GET_COMMAND } from './outbound-file.ts'
import { CD_COMMAND, WS_COMMAND } from './workspace.ts'
import { MODEL_COMMAND } from './model.ts'
import { STATUS_COMMAND } from './status.ts'
import { NEW_COMMAND } from './epoch.ts'

/** Cancel the running turn. Not a host command: cancellation is an agent method. */
export const STOP_COMMAND = 'stop'

/** List what this chat accepts. Not a host command: the list is per surface. */
export const HELP_COMMAND = 'help'


/** The cause recorded when a chat cancels its own turn. */
const CANCEL_CAUSE = 'user'

/** Leading slash plus the command name, the only part this module parses. */
const COMMAND_LINE = /^\/([a-zA-Z][\w-]*)/

/**
 * The command one line names, if it names one.
 * @param text - the message text exactly as received.
 * @returns the lowercase name without its slash, or undefined for prose.
 */
export function commandName(text: string): string | undefined {
  return COMMAND_LINE.exec(text.trimStart())?.[1]?.toLowerCase()
}

/**
 * Whether one inbound line addresses the channel as a command.
 * @param text - the message text exactly as received.
 * @returns whether it opens with a slash and names something.
 */
export function isCommandLine(text: string): boolean {
  return commandName(text) !== undefined
}

/** What a command line did, for the chat to report. */
export interface CommandOutcome {
  /** Text to send back, empty when the command's own events already tell the story. */
  readonly reply: string
  /** Whether the line resolved at all; an unresolved one is a typo worth naming. */
  readonly resolved: boolean
}

/**
 * Render the help listing for one agent's available commands.
 * @param commands - the host command runtime, when composed.
 * @param agent - the agent whose scope decides what is available.
 * @returns the markdown listing.
 */
export function helpText(commands: HostCommands | undefined, agent: HostAgent): string {
  const own = [
    `\`/${STOP_COMMAND}\` — 停止当前任务`,
    `\`/${CD_COMMAND} <路径>\` — 切换本会话的工作区目录`,
    `\`/${WS_COMMAND}\` — 查看可用工作区`,
    `\`/${GET_COMMAND} <路径>\` — 把工作区里的文件发到聊天`,
    `\`/${MODEL_COMMAND}\` — 查看或切换本会话模型`,
    `\`/${STATUS_COMMAND}\` — 查看本会话状态`,
    `\`/${NEW_COMMAND}\` — 开一个新会话，清空上下文`,
    `\`/${HELP_COMMAND}\` — 显示这条帮助`,
  ]
  const hosted = (commands?.list(agent) ?? [])
    .map(descriptor => `\`/${descriptor.name}\` — ${descriptor.description}`)
  return ['**可用命令**', ...hosted, ...own].join('\n')
}

/**
 * Run one command line for a chat's agent.
 *
 * `/stop` and `/help` are answered here; everything else goes to the host
 * runtime, whose `undefined` means the name never resolved — reported as such
 * with the listing, because silently feeding a typo to the model is how `/stop`
 * became a message the bot ignored.
 * @param line - the complete line, leading slash included.
 * @param agent - the chat's agent.
 * @param commands - the host command runtime, when composed.
 * @param signal - cancellation for the host execution.
 * @returns what to report to the chat.
 */
export async function runCommandLine(
  line: string,
  agent: HostAgent,
  commands: HostCommands | undefined,
  signal: AbortSignal,
): Promise<CommandOutcome> {
  const trimmed = line.trimStart()
  const name = commandName(trimmed) ?? ''
  if (name === STOP_COMMAND) {
    agent.cancel(CANCEL_CAUSE)
    return { reply: '⏹ 已停止当前任务。', resolved: true }
  }
  if (name === HELP_COMMAND) {
    return { reply: helpText(commands, agent), resolved: true }
  }
  if (commands === undefined) {
    return { reply: `⚠️ 本部署没有组合命令运行时，\`/${name}\` 无法执行。`, resolved: false }
  }
  const execution = await commands.execute(agent, trimmed, signal)
  if (execution === undefined) {
    return { reply: `⚠️ 未知命令 \`/${name}\`。\n\n${helpText(commands, agent)}`, resolved: false }
  }
  const { result } = execution
  if (result.kind === 'error') return { reply: `⚠️ \`/${name}\` 执行失败：${result.text}`, resolved: true }
  // A command whose own session events carry the story needs no echo.
  return { reply: result.text ?? '', resolved: true }
}
