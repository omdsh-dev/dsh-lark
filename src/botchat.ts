/**
 * Letting two bots talk to each other, without letting them talk forever.
 *
 * A message from a bot used to be dropped outright. That is the safe default
 * and the wrong absolute: two agents in one room comparing notes is a real
 * thing to want, and refusing it is refusing the room's own arrangement. What
 * cannot be allowed is the shape it degenerates into — each answer arriving as
 * the other's next prompt, forever, each hop spending a turn nobody reads.
 *
 * Bot traffic is therefore admitted the way every other reach in this channel
 * is: narrowed, not gated.
 *
 * - **Served by default.** A bot someone added to a room the channel already
 *   serves is part of that room's arrangement, exactly like the people in it —
 *   the same reasoning `senderAllowlist`, `groupAllowlist`, and `approvers`
 *   follow, where empty means "no narrowing" rather than "nobody". A
 *   deployment that wants only certain bots lists them in `botPeers`.
 * - **Budgeted.** Each conversation may run a bounded number of consecutive
 *   bot-sourced turns. A human message refills the budget, because a person
 *   speaking is the signal that the exchange is still wanted. This is the
 *   bound that matters: it is what stops an exchange nobody is reading, and it
 *   applies whether or not anyone narrowed the peers.
 * @module dsh-lark-channel/botchat
 */

/** How many consecutive bot-sourced turns one conversation may run unattended. */
export const DEFAULT_BOT_HOPS = 6

/** The budget one channel keeps, per conversation. */
export interface HopBudget {
  /**
   * Spend one hop for a bot-sourced message.
   * @param key - the conversation the message belongs to.
   * @returns whether the exchange may continue; false once the budget is out.
   */
  take(key: string): boolean
  /**
   * Refill one conversation: a human spoke, so the exchange is wanted again.
   * @param key - the conversation.
   */
  reset(key: string): void
  /**
   * Hops already spent, for reporting.
   * @param key - the conversation.
   * @returns the count since the last human message.
   */
  spent(key: string): number
  /** Drop one conversation's accounting entirely. */
  forget(key: string): void
}

/**
 * Create the per-conversation hop budget.
 * @param limit - consecutive bot-sourced turns allowed; zero admits none.
 * @returns the budget.
 */
export function createHopBudget(limit: number): HopBudget {
  const spent = new Map<string, number>()
  return {
    take(key) {
      const used = spent.get(key) ?? 0
      if (used >= limit) return false
      spent.set(key, used + 1)
      return true
    },
    reset(key) {
      spent.delete(key)
    },
    spent(key) {
      return spent.get(key) ?? 0
    },
    forget(key) {
      spent.delete(key)
    },
  }
}

/** What a bot-sent message may do in one conversation. */
export type BotVerdict =
  | { readonly kind: 'answer' }
  /** Narrowed out by a non-empty peer list; the id is reported for the log. */
  | { readonly kind: 'stranger'; readonly senderId: string }
  /** A listed peer, but this conversation has run out of hops. */
  | { readonly kind: 'exhausted'; readonly spent: number }
  /** This channel's own bot: answering it is a loop with itself. */
  | { readonly kind: 'self' }

/**
 * Decide what one bot-sent message gets.
 * @param input - who sent it, into which conversation, and this bot's own id.
 * @param peers - bot open ids this deployment answers; empty narrows nothing.
 * @param budget - the hop budget to spend from.
 * @returns the verdict, and the hop already spent when it is `answer`.
 */
export function judgeBotMessage(
  input: { readonly senderId: string; readonly key: string; readonly ownBotId?: string | undefined },
  peers: ReadonlySet<string>,
  budget: HopBudget,
): BotVerdict {
  // Never our own voice: a channel that answers itself needs no second bot to
  // loop, and a deployment can list its own id by mistake in one paste.
  if (input.ownBotId !== undefined && input.senderId === input.ownBotId) return { kind: 'self' }
  if (peers.size > 0 && !peers.has(input.senderId)) return { kind: 'stranger', senderId: input.senderId }
  if (!budget.take(input.key)) return { kind: 'exhausted', spent: budget.spent(input.key) }
  return { kind: 'answer' }
}

/**
 * The line naming a bot this channel refused because a peer list narrowed it
 * out. Carries the id, since allowing it is one paste away.
 * @param senderId - the bot's open id.
 * @param chatId - where it spoke.
 * @returns the console line.
 */
export function strangerNotice(senderId: string, chatId: string): string {
  return `lark-channel: ignored a message from bot ${senderId} in ${chatId}`
    + ` — botPeers narrows to other ids; add "${senderId}" to let them talk`
}

/**
 * The line naming a bot this channel is now serving. Said once per bot per
 * chat: who can drive a shell-capable agent is a fact an operator should see,
 * and the answer here is "a bot", which is worth one line.
 * @param senderId - the bot's open id.
 * @param chatId - where it spoke.
 * @returns the console line.
 */
export function servedNotice(senderId: string, chatId: string): string {
  return `lark-channel: answering bot ${senderId} in ${chatId}`
    + ` — narrow with botPeers, bound with botHops`
}

/**
 * What the chat is told when an exchange runs out of hops. Said once per
 * exhaustion rather than per message: the point is to stop talking.
 * @param spent - hops the exchange used.
 * @returns the chat line.
 */
export function exhaustedNotice(spent: number): string {
  return `🤖 机器人之间已连续对话 ${spent} 轮，先停在这里。说句话就能继续。`
}
