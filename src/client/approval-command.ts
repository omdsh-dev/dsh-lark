/**
 * The shell command one approval is about, read out of the Chat store.
 *
 * The shipped `conversation.approval.detail` renderer extracts this command from
 * the same snapshot, but that slot is declared by the host and a plugin cannot
 * declare it again, so a replacement panel extracts the command itself and keeps
 * the shipped rules: a call whose arguments have not arrived yet answers
 * nothing, and a call that has already settled keeps the command it was approved
 * for in its own result record — which is what lets a panel that outlived its
 * call still show what was approved.
 * @module dsh-lark-channel/client/approval-command
 */

import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'

/**
 * Extract a shell command from one Tool call's raw arguments.
 * @param argsRaw - the call's raw argument JSON, when the call carries any.
 * @returns command text, or undefined for absent, malformed, or unrelated arguments.
 */
export function commandOfArguments(argsRaw: string | undefined): string | undefined {
  if (typeof argsRaw !== 'string') return undefined
  try {
    const args = JSON.parse(argsRaw) as Record<string, unknown>
    return typeof args.command === 'string' ? args.command : undefined
  } catch {
    // Arguments that are not JSON carry no command to show; the panel still
    // presents the decision, only without a quoted command.
    return undefined
  }
}

/**
 * The command of the Tool call correlated with an approval, in whatever phase
 * that call currently reads.
 * @param snapshot - the conversation's Chat store snapshot.
 * @param callId - the approval's correlated Tool call, when the asker named one.
 * @returns command text, or undefined when no correlated call carries one.
 */
export function commandForCall(snapshot: ChatSnapshot, callId: string | undefined): string | undefined {
  if (callId === undefined) return undefined
  for (const node of snapshot.nodes.values()) {
    // The node union does not discriminate its payload, so the correlated kind
    // is named explicitly.
    const root = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
    if (root === undefined || root.callId !== callId) continue
    // A named call whose arguments have not arrived yet carries no command. The
    // shipped detail keeps looking instead of answering nothing, because the
    // dispatched call with the same id is the one holding the arguments.
    if (!('kind' in root)) {
      if (root.phase !== 'start') continue
      return commandOfArguments(root.argsRaw)
    }
    // A settled call keeps its command in the result's own call record, which is
    // null when window truncation left the call head outside.
    return commandOfArguments(root.call?.argsRaw)
  }
  return undefined
}
