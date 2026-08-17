/**
 * The chat↔agent bridge: inbound Lark messages drive per-chat DSH agents,
 * committed assistant output returns as chat messages, and host approval
 * questions become interactive cards answered by button clicks.
 * @module dsh-lark-channel/bridge
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  CardActionEvent,
  CardActionResponse,
  LarkChannelError,
  NormalizedMessage,
  RejectEvent,
  SendResult,
} from '@larksuite/channel'
import {
  approvalCard as buildApprovalCard,
  fileApprovalCard as buildFileApprovalCard,
  QUESTION_SELECT,
  settledApprovalCard as buildSettledApprovalCard,
  settledFileApprovalCard as buildSettledFileApprovalCard,
  toast,
  TOAST,
} from './cards.ts'
import type { ResolvedConfig } from './config.ts'
import type {
  HostAgent,
  HostAgentHandle,
  HostAgentOptions,
  HostAgentPresets,
  HostAttachments,
  HostAgentRegistry,
  HostApprovalOutcome,
  HostApprovalRequest,
  HostDefaultModel,
  HostLlm,
  HostLoader,
  HostSessionEvent,
  HostSessionProjections,
  HostCommands,
  HostContentBlock,
  HostSystemPrompt,
  HostTools,
  HostUserMessage,
  HostWorkspace,
  HostWorkspaceRegistry,
} from './host.ts'
import { isStepStartEvent, isToolCallEvent, isTurnEndEvent, isTurnStartEvent, isUserMessageEvent } from './host.ts'
import { createCotRenderer } from './cot.ts'
import type { CotPort } from './cot.ts'
import { createMessageRenderer, createStreamRenderer, replyOptions } from './outbound.ts'
import type { OutboundPort, OutboundRenderer, ReplyTarget, ToolPresentation } from './outbound.ts'
import { refuseApprovalClick, refuseMessage } from './authorization.ts'
import type { Authorization } from './authorization.ts'
import { commandName, HELP_COMMAND, isCommandLine, runCommandLine, STOP_COMMAND } from './commands.ts'
import { CD_COMMAND, ChatWorkspaces, runWorkspaceCommand, WS_COMMAND } from './workspace.ts'
import { ChatEpochs, NEW_COMMAND, runNewCommand } from './epoch.ts'
import {
  ChatModels,
  formatRoute,
  MODEL_COMMAND,
  modelActionValue,
  modelPickerCard,
  parseRoute,
  runModelCommand,
} from './model.ts'
import type { CatalogEntry, ModelActionValue } from './model.ts'
import { readMeters, renderStatusCard, STATUS_COMMAND, statusActionValue } from './status.ts'
import type { StatusFields } from './status.ts'
import { ChatQuestions, QUESTION_TIMEOUT_MS, questionActionValue, shadowQuestionTool } from './questions.ts'
import { PLAN_TOOL, planReviewQuestion, shadowPlanTool } from './plan.ts'
import type { HostPlanMode, PlanReviewPorts } from './plan.ts'
import type { AskedQuestion, QuestionAnswer } from './questions.ts'
import { ownVersion } from './version.ts'
import { collectImages } from './images.ts'
import type { CollectedImages, ImagePort } from './images.ts'
import { collectInboundFiles } from './files.ts'
import type { CollectedFiles, InboundFilePort } from './files.ts'
import {
  describeReadFailure,
  GET_COMMAND,
  readOutboundFile,
  runGetCommand,
  SEND_FILE_TOOL,
  sendFileTool,
} from './outbound-file.ts'
import type { OutboundFile, SendFilePorts } from './outbound-file.ts'
import { failureDetail } from './format.ts'
import { syncSlashPanel } from './slash-panel.ts'
import type { SlashPanelPort } from './slash-panel.ts'
import { ConversationSessions, conversationKey } from './session.ts'
import type { ConversationSubject, SessionLadder } from './session.ts'
import { createAttemptQuota, createReconnectWatchdog } from './liveness.ts'
import { createHopBudget, exhaustedNotice, judgeBotMessage, servedNotice, strangerNotice } from './botchat.ts'
import { batonNote, PRESENCE_ORDER, PRESENCE_SECTION, presenceSection } from './presence.ts'
import type { BotSelf } from './presence.ts'
import { instanceIdentity } from './instance.ts'

/**
 * The transport surface the bridge drives. `LarkChannel` from
 * `@larksuite/channel` satisfies it structurally; tests substitute a fake.
 */
export interface ChannelPort extends OutboundPort, SlashPanelPort, ImagePort, InboundFilePort, CotPort {
  /** Open the transport (WebSocket long connection by default). */
  connect(): Promise<void>
  /** Close the transport and release its resources. */
  disconnect(): Promise<void>
  /**
   * The transport's own account of its connection, when it offers one. The
   * SDK reports `failed` for its terminal give-up state, which is exactly the
   * state the reconnect watchdog exists to catch.
   */
  getConnectionStatus?(): { readonly state?: string } | undefined
  /** Subscribe one normalized inbound event; returns the unsubscriber. */
  on(name: 'message', handler: (msg: NormalizedMessage) => void | Promise<void>): () => void
  on(
    name: 'cardAction',
    handler: (evt: CardActionEvent) => void | CardActionResponse | Promise<void | CardActionResponse>,
  ): () => void
  /**
   * A message the transport's own policy layer refused. Subscribing is the only
   * way to tell "the bot ignored me" apart from "the bot is broken": a refusal
   * never reaches the `message` handler and is reported nowhere else.
   */
  on(name: 'reject', handler: (evt: RejectEvent) => void): () => void
  /**
   * A transport failure, including one thrown by an inbound handler: those do
   * NOT reject the awaited dispatch, so an unsubscribed channel loses them.
   */
  on(name: 'error', handler: (err: LarkChannelError) => void): () => void
  /** The long connection dropped; events arriving in the gap are not replayed. */
  on(name: 'reconnecting', handler: () => void): () => void
  /** The long connection is live again. */
  on(name: 'reconnected', handler: () => void): () => void
  /**
   * This bot's own identity, resolved during connect. Optional here so a fake
   * port need not implement it; it throws before connect, which callers treat
   * as "not known yet".
   */
  getBotIdentity?(): { readonly openId: string; readonly name?: string }
  /**
   * List a chat's human roster when the transport exposes it. This is optional
   * because older channel implementations can still settle approvals using the
   * callback's open id alone.
   */
  getChatMembers?(chatId: string): Promise<readonly { readonly id: string; readonly name?: string }[]>
  /** Replace a sent card's content in place. */
  updateCard(messageId: string, card: object): Promise<void>
}

/** One conversation's chat and its outbound renderer, keyed by session id. */
interface ChatBinding {
  readonly chatId: string
  /** `p2p` or a group kind; approvals in a group are judged as the room. */
  readonly chatType: string
  readonly renderer: OutboundRenderer
}

/**
 * What one agent creation or resume composes, and the registry view the
 * session's calls are described through. A resumed agent needs the same
 * composition a fresh one gets.
 */
interface AgentComposition {
  /** Recorded on a created session so a later reader knows which preset it joined. */
  readonly presetId?: string
  /** Names what each call of this session's tools does, and its category. */
  readonly presentCall: ToolPresentation
  /** Creation-time composition: the preset join plus this channel's own rows. */
  readonly setup: (agentCtx: Context) => Promise<void>
}

/**
 * The `agents` registry as durable sessions need it. {@link HostAgentRegistry}
 * declares only `create`, so the two further rungs are narrowed here, the way
 * every other host service this bridge consumes is.
 */
interface DurableAgentRegistry extends HostAgentRegistry {
  /**
   * The live agent published on one session id.
   * @param sessionId - the session id to probe.
   * @returns the live agent, or undefined when nothing runs on that id.
   */
  get(sessionId: string): HostAgent | undefined
  /**
   * Load a stored session as a live agent. Takes no `meta`: the stored header
   * already carries the session's cwd and preset.
   * @param options - the session to load, its model route, and its composition.
   * @returns the resumed handle.
   * @throws when no session is stored under the id, or its log cannot be read.
   */
  resume(options: {
    readonly resumeSessionId: string
    readonly agentOptions?: HostAgentOptions
    readonly setup?: (agentCtx: Context) => Promise<void>
  }): Promise<HostAgentHandle>
}

/**
 * The immutable facts of one tool call, copied at ask time. An approval is
 * decided by a human reading these; they must never be re-read from a mutable
 * map after the card exists, or a concurrent turn's write shows one command
 * while another is approved.
 */
interface CallSnapshot {
  readonly sessionId: string
  readonly turn: number
  readonly callId: string
  readonly arguments: string
}

/**
 * One approval question, from before its card is sent until it settles.
 *
 * `sending` — the card send is in flight; a settlement (abort, disposal)
 * resolves the asker immediately and the send's return path paints the card.
 * `open` — the card exists and a click may decide it.
 * `settled` — decided; kept only until the card is painted.
 */
interface PendingApproval {
  readonly chatId: string
  readonly chatType: string
  readonly toolName: string
  /** Captured call facts; undefined when the asker named no call. */
  readonly call?: CallSnapshot | undefined
  /**
   * Paints this question's settled card; captured at ask time so each kind
   * paints its own. A tool escalation and an outbound file settle through the
   * same machinery and must not settle into the same card — the room needs to
   * read what it just decided, not the shape of the last thing decided here.
   */
  readonly paint: (outcome: HostApprovalOutcome, decidedBy?: string) => object
  /** Set once the platform accepted the card. */
  messageId?: string | undefined
  state: 'sending' | 'open' | 'settled'
  outcome?: HostApprovalOutcome | undefined
  decidedBy?: string | undefined
  settle(outcome: HostApprovalOutcome): void
  /** Detaches the abort listener, so a settled question leaks no handler. */
  removeAbort?: (() => void) | undefined
}

/** Marker distinguishing this plugin's approval buttons from other card actions. */
const APPROVAL_ACTION = 'dsh-lark-channel/approval'

/** Card-button payload carried by an approval decision. */
interface ApprovalActionValue {
  readonly kind: typeof APPROVAL_ACTION
  readonly id: string
  readonly decision: 'allow' | 'reject'
}

/**
 * Narrow an arbitrary card-action value to this plugin's approval payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
function approvalActionValue(value: unknown): ApprovalActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== APPROVAL_ACTION) return undefined
  if (typeof record.id !== 'string') return undefined
  if (record.decision !== 'allow' && record.decision !== 'reject') return undefined
  return { kind: APPROVAL_ACTION, id: record.id, decision: record.decision }
}

/**
 * Build the interactive approval card for one permission question.
 * @param toolName - the tool the question is about.
 * @param reason - the asker's explanation, when it gave one.
 * @param id - correlation id carried by both decision buttons.
 * @returns a Feishu card object for `send({ card })`.
 */
function approvalCard(
  toolName: string,
  reason: string | undefined,
  command: string | undefined,
  id: string,
): object {
  return buildApprovalCard({
    toolName,
    reason,
    command,
    allow: { kind: APPROVAL_ACTION, id, decision: 'allow' },
    reject: { kind: APPROVAL_ACTION, id, decision: 'reject' },
  })
}

/**
 * Build the static replacement card shown after an approval settles.
 * @param toolName - the tool the question was about.
 * @param outcome - the closed decision.
 * @param decidedBy - who pressed, when a person did. Named rather than
 * withheld: with approvals open to a room, the room should see whose press
 * granted the escalation.
 * @returns a Feishu card object for `updateCard`.
 */
function settledCard(toolName: string, outcome: HostApprovalOutcome, decidedBy?: string): object {
  return buildSettledApprovalCard({ toolName, outcome, decidedBy })
}

/**
 * Build the interactive card asking a group to authorize one outbound file.
 *
 * What the room is shown is the file's place inside the workspace and the
 * workspace's own name, never {@link OutboundFile.path}: the canonical path is
 * an absolute host path, and putting one in a group publishes the operator's
 * home directory and login name to everyone in it. Both come off the canonical
 * path the container check already cleared, so nothing about what the room is
 * judging changes — only the prefix that identifies the machine goes.
 * @param file - the file the workspace check cleared.
 * @param bytes - the length of the buffer that will go out if this is allowed.
 * Taken from the buffer rather than from the verdict, so the size on the card
 * measures the artefact being approved and not whatever was on disk before it
 * was read.
 * @param id - correlation id carried by both decision buttons.
 * @returns a Feishu card object for `send({ card })`.
 */
function fileApprovalCard(file: OutboundFile, bytes: number, id: string): object {
  return buildFileApprovalCard({
    path: file.pathInWorkspace,
    workspace: file.workspaceName,
    bytes,
    allow: { kind: APPROVAL_ACTION, id, decision: 'allow' },
    reject: { kind: APPROVAL_ACTION, id, decision: 'reject' },
  })
}

/**
 * Build the static replacement card shown after a file approval settles.
 * @param file - the file that was offered, kept so the record says what was
 * decided — named the same way the live card named it, and for the same reason.
 * @param outcome - the closed decision; a timeout arrives here as `cancelled`.
 * @param decidedBy - who pressed, when a person did.
 * @returns a Feishu card object for `updateCard`.
 */
function settledFileCard(file: OutboundFile, outcome: HostApprovalOutcome, decidedBy?: string): object {
  return buildSettledFileApprovalCard({
    path: file.pathInWorkspace,
    workspace: file.workspaceName,
    outcome,
    decidedBy,
  })
}

/**
 * The transport's own failure code, when the rejection carried one.
 *
 * Read structurally rather than through `instanceof`: `LarkChannelError` is a
 * type-only import here, and the code is the half of the failure the model can
 * act on — `rate_limited` means try later, `permission_denied` never will.
 * @param error - the rejection value, which need not be an `Error`.
 * @returns the code, or undefined when the failure named none.
 */
function channelErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/** How long one tool-activity label may be before it is ellipsized. */
const ACTIVITY_LABEL_MAX_CHARS = 90

/**
 * How long a `reconnecting` may stand before the watchdog presumes the SDK's
 * recovery dead. Generous on purpose: the SDK's own flapping cycles recover in
 * seconds, and a false rebuild bounces a connection that was about to live.
 */
const RECONNECT_DEADLINE_MS = 3 * 60 * 1000

/** Rebuild retry delays; the last entry repeats forever. */
const RECONNECT_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const

/**
 * Rebuild budget. The platform meters connection attempts, so an outage that
 * never resolves must not have this watchdog hammering it: under the backoff
 * above a genuinely degraded link uses roughly eight attempts an hour, which
 * this admits, while a tight rebuild-drop loop trips it and pauses.
 */
const RECONNECT_QUOTA_WINDOW_MS = 30 * 60 * 1000
const RECONNECT_QUOTA_LIMIT = 10

/** The host tool this channel shadows so questions become chat cards. */
const QUESTION_TOOL = 'ask_user_question'

/**
 * How long an unanswered approval stands, in the whole minutes the sentence the
 * model reads quotes. Derived rather than restated, so the number in the
 * sentence cannot drift from the timer.
 */
const TIMEOUT_MINUTES = Math.round(QUESTION_TIMEOUT_MS / 60_000)

/**
 * How many outbound files one group chat may have waiting on a decision at once.
 *
 * This is a MEMORY ceiling before it is a courtesy. A group send reads the whole
 * file into a `Buffer` before the room is asked (ADR 0004, and `deliverFile` on
 * why the order cannot be the other way round), so every undecided card pins up
 * to `maxSendFileBytes` — 20 MiB by default — for as long as the approval
 * timeout allows, half an hour. The per-file ceiling bounds one of those; this
 * bounds how many a chat can hold at once, and without it the product has no
 * bound at all: a file dropped into a workspace can carry "send these twenty
 * files", the model can raise twenty parallel calls off one injected
 * instruction, and 400 MiB of pinned heap per chat is a process the operator
 * loses rather than a card someone declines.
 *
 * Three, because it is the count that has to survive both readings: enough that
 * a turn legitimately handing over a diff, a log and a screenshot never meets
 * the wall, and few enough that a room is never asked to triage a stack of
 * decisions — an approver facing ten cards approves them, which is precisely the
 * fatigue ADR 0002 declined to build. Not configurable, for that second reason:
 * a deployment raising it to fifty would be buying back the fatigue and the
 * heap together.
 */
const MAX_PENDING_FILE_SENDS = 3

/**
 * How many unclaimed reply targets may wait for their `user/message` event. A
 * target is claimed within one turn ordinarily; the cap only matters when an
 * agent dies between accepting a followup and starting its turn.
 */
const MAX_PENDING_TARGETS = 500

/**
 * Reduce one presentation title to a single safe card line: the value is
 * model-influenced (a search pattern, a command) and rides a markdown card, so
 * newlines and code fences — the two things that could restructure the card —
 * come out, and the rest is bounded.
 * @param title - the tool's own label for this call.
 * @returns the label as one bounded line.
 */
function activityLabel(title: string): string {
  // One pass over both hazards: any run of whitespace (newlines included) or
  // backticks collapses to a single space, so neither a line break nor a code
  // fence in a model-influenced value can restructure the card.
  const line = title.replace(/[\s`]+/g, ' ').trim()
  return line.length <= ACTIVITY_LABEL_MAX_CHARS
    ? line
    : `${line.slice(0, ACTIVITY_LABEL_MAX_CHARS - 1)}…`
}

/**
 * Build the tool-call describer for one agent's view of the registry. Prefers
 * the tool's own `presentCall` title — the label the host's own surfaces show,
 * so a chat line says what a call does rather than repeating its name — then
 * the model's `description` argument, then the bare name.
 * @param tools - the host tool registry, when composed.
 * @param scope - the viewing scope key holding this agent's tools.
 * @returns a describer safe to call on every `tool/call` event.
 */
function createCallPresenter(tools: HostTools | undefined, scope: unknown): ToolPresentation {
  return (name, argumentsJson) => {
    let args: unknown
    try {
      args = JSON.parse(argumentsJson)
    } catch {
      // Raw model output: malformed JSON is the model's mistake, not a reason
      // to lose the activity line.
      return { title: name }
    }
    try {
      const view = tools?.get(name, scope)?.presentCall?.(args)
      const title = view?.title
      if (typeof title === 'string' && title.trim() !== '') {
        return {
          title: activityLabel(title),
          ...typeof view?.kind === 'string' ? { kind: view.kind } : {},
        }
      }
    } catch {
      // presentCall is contracted pure, but it is another package's code and a
      // throw here must not cost the chat its activity line.
    }
    const described = (args as { description?: unknown } | null)?.description
    return typeof described === 'string' && described.trim() !== ''
      ? { title: `${name} · ${activityLabel(described)}` }
      : { title: name }
  }
}

/**
 * Compose the parts of a chat agent's world this channel owns: the tools it
 * must not call, the one tool this channel adds, and the prompt sentence that
 * tells the model what to do instead. Every registration is scoped to this one
 * agent.
 * @param agentCtx - the agent's scope context, inside creation `setup`.
 * @param config - resolved plugin configuration.
 * @param askQuestions - how a question reaches this agent's chat, when it can.
 * @param planReview - how a plan is reviewed in this agent's chat, when it can be.
 * @param sendFiles - how an artifact reaches this agent's chat, when it may.
 * @param self - the bot account this agent speaks as.
 */
function composeChatAgent(
  agentCtx: Context,
  config: ResolvedConfig,
  askQuestions: ((questions: readonly AskedQuestion[], sessionId: string | undefined) => Promise<QuestionAnswer[]>) | undefined,
  planReview: PlanReviewPorts | undefined,
  sendFiles: SendFilePorts | undefined,
  self: BotSelf,
): void {
  const tools = agentCtx.get('tools') as HostTools | undefined
  const denied = new Set(config.denyTools)

  // Shadow the host's question tool for THIS agent: its answer would otherwise
  // surface on whichever UI claimed the single `userQuestions` provider, while
  // the person who asked is here. Registered before the guard so a deployment
  // that also denies the name still denies it — configuration wins.
  const shadowed = askQuestions !== undefined
    && !denied.has(QUESTION_TOOL)
    && tools?.register !== undefined
  if (shadowed) tools?.register?.(shadowQuestionTool(askQuestions))
  // A registry too old to shadow leaves the host's GUI-only tool in place;
  // denying it keeps the model from asking where no one is watching.
  if (!shadowed && askQuestions !== undefined) denied.add(QUESTION_TOOL)

  // The plan tool is shadowed for the same reason and on the same terms: its
  // review reaches for that same single-provider seam. Only worth registering
  // where a plan service exists to leave plan mode afterwards — without one
  // the host tool is not composed either, so there is nothing to shadow.
  const shadowedPlan = planReview !== undefined
    && planReview.planMode() !== undefined
    && !denied.has(PLAN_TOOL)
    && tools?.register !== undefined
  if (shadowedPlan) tools?.register?.(shadowPlanTool(planReview!))
  if (!shadowedPlan && planReview?.planMode() !== undefined) denied.add(PLAN_TOOL)

  // `send_file` is NOT a shadow — the host has no tool of that name — but it is
  // registered on the same terms, because it is the same kind of thing: a
  // capability that exists only because there is a chat to use it on. Unlike a
  // shadow it is denied whenever it is absent, deployment switch included: a
  // model that reads "unavailable here" writes its findings into the reply,
  // while one that merely never sees the tool keeps offering to send a file.
  const registersSendFile = sendFiles !== undefined
    && !denied.has(SEND_FILE_TOOL)
    && tools?.register !== undefined
  if (registersSendFile) tools?.register?.(sendFileTool(sendFiles!))
  else {
    // A deployment that turned the switch off, or denied the name, decided this
    // and needs no telling. A registry too old to take a per-agent tool did NOT:
    // the capability the deployment configured ON is simply missing, and the
    // console is the only place that fact can surface (§9 of the design).
    if (sendFiles !== undefined && !denied.has(SEND_FILE_TOOL)) {
      sendFiles.report(`lark-channel: ${SEND_FILE_TOOL} could not be registered for this agent `
        + '(this host tool registry takes no per-agent tools), so the model cannot send files in this chat')
    }
    denied.add(SEND_FILE_TOOL)
  }

  // Every chat agent gets its bearings, denials or none: an agent told nothing
  // about where it woke up treats a chat like a ticket queue.
  const prompt = agentCtx.get('systemPrompt') as HostSystemPrompt | undefined
  prompt?.section({
    name: PRESENCE_SECTION,
    order: PRESENCE_ORDER,
    text: presenceSection(self, [...denied], config.receiveFiles),
  })

  if (denied.size === 0) return
  // A guard rather than `tools.restrict()`: restrict validates its names
  // against the inherited registry and THROWS for one this composition does
  // not have, which would fail every chat agent's creation over a tool the
  // deployment simply never composed.
  tools?.guard(execution =>
    denied.has(execution.name) ? denialReason(execution.name) : undefined,
  )
}

/**
 * Why one denied tool cannot run here, in words true of THAT tool.
 *
 * A refusal is what steers the model's next move, so a reason that does not
 * describe its situation is worse than a terse one: telling it to "ask the user
 * directly in your reply" about a file send names an answer that does not exist,
 * and a model that reads it goes looking for a question to ask.
 * @param name - the tool the guard is refusing.
 * @returns the sentence the model reads instead of a result.
 */
function denialReason(name: string): string {
  const unavailable = `${name} is unavailable in this chat channel`
  if (name === QUESTION_TOOL || name === PLAN_TOOL) {
    return `${unavailable}: its answer would surface on a different interface. `
      + 'Ask the user directly in your reply instead, and continue when they answer.'
  }
  if (name === SEND_FILE_TOOL) {
    // Nothing here is waiting for an answer: there is no file channel at all.
    return `${unavailable}: no file can leave the workspace for this chat. `
      + 'Put what matters into your reply — the findings, the excerpt that counts — rather than offering an attachment.'
  }
  // Anything the deployment denied by configuration. It may be a tool with no
  // answer, no interface, and no substitute, so this promises none of those.
  return `${unavailable}. Continue without it, and say in your reply what you could not do.`
}

/**
 * Create an identified user message from one chat input. Group messages carry
 * the sender so the model can tell voices apart; direct messages stay verbatim.
 * @param msg - normalized inbound chat message.
 * @param images - what this message's images became.
 * @param inbound - what this message's files became on disk.
 * @returns a frozen user message for `agent.followup()`.
 */
export function chatUserMessage(
  msg: NormalizedMessage,
  images: CollectedImages,
  inbound: CollectedFiles,
): HostUserMessage {
  const spoken = msg.chatType === 'group'
    ? `${msg.senderName ?? msg.senderId}: ${msg.content}`
    : msg.content
  // Only an agent's message carries the baton note: a human reads everything
  // said in their own chat, mention or not.
  const note = msg.senderIsBot === true ? batonNote(msg.senderId) : ''
  // Notes ride the text so a model that cannot be shown an image still knows
  // one was sent, instead of answering as though it had seen it. Files come
  // first: a path is something the model can act on, while an image note is
  // usually the reason it cannot see one.
  const text = [spoken, note, ...inbound.notes, ...images.notes].filter(line => line !== '').join('\n')
  const content: HostContentBlock[] = [
    ...text === '' ? [] : [{ type: 'text' as const, text }],
    ...images.blocks,
  ]
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze(content),
    source: Object.freeze({ kind: 'user' } as const),
  })
}

/**
 * Install the bridge on a scoped plugin context. Every registration is owned
 * by the context's fiber: disposal disconnects the transport, disposes every
 * agent this channel owns, and settles pending approvals as `'cancelled'`.
 * @param ctx - scoped plugin context carrying the `agents` service.
 * @param config - resolved plugin configuration.
 * @param port - the transport to drive; production passes the real Lark channel.
 */
export function installBridge(
  ctx: Context,
  config: ResolvedConfig,
  port: ChannelPort,
  notify: (line: string) => void,
  authorization: Authorization,
  persistState: (patch: object) => Promise<boolean> = async () => false,
  liveness?: {
    readonly deadlineMs?: number
    readonly backoffMs?: readonly number[]
    readonly quotaWindowMs?: number
    readonly quotaLimit?: number
  },
): void {
  const bySession = new Map<string, ChatBinding>()
  const pendingApprovals = new Map<string, PendingApproval>()
  /**
   * Outbound file sends holding a buffer, per chat id — the group ones, which
   * are the sends that wait on a human while they hold it.
   *
   * A count of live SENDS rather than of open cards, because the buffer is read
   * before the card exists: counting cards would leave every reader of the count
   * blind to exactly the window where the bytes have been read and nobody has
   * been asked yet, and a fistful of parallel calls all pass through that window
   * together. Keyed by chat rather than by session so the several sessions a room
   * can hold — one per thread, or per member — cannot each open their own quota
   * into the same room.
   */
  const heldFileSends = new Map<string, number>()
  /**
   * Tool-call arguments by session, then call id, with the turn that made the
   * call. An approval names the call it decides but not what that call does,
   * and the human cannot judge an escalation without seeing the command. Keyed
   * per session because call ids are only unique within a producer — one flat
   * map let concurrent sessions overwrite each other's entries, showing one
   * session's command on another session's card — and cleaned per (session,
   * turn) because within a session an id is only known unique per turn.
   */
  const callSnapshots = new Map<string, Map<string, { readonly turn: number; readonly arguments: string }>>()
  /**
   * Workspaces already told that inbound files land inside them. Keyed by path
   * rather than by conversation, because the untracked directory is the
   * workspace's problem and not the chat's: two conversations in one directory
   * have one `.gitignore` to edit between them, and a `/cd` into a directory
   * nobody has mentioned yet earns the hint again. Per-bridge state, so a second
   * plugin instance starts with its own — and a test does too.
   */
  const hintedWorkspaces = new Set<string>()
  const defaultCwd = resolve(config.cwd ?? process.cwd())

  /** Which directory each conversation runs in, and the session id that pair owns. */
  const chatEpochs = new ChatEpochs({
    entries: config.chatEpochs,
    persist: persistState,
    report: notify,
  })

  const chatWorkspaces = new ChatWorkspaces({
    defaultPath: defaultCwd,
    entries: config.chatWorkspaces,
    roots: config.workspaceRoots,
    persist: persistState,
    report: notify,
    // Every session id this row derives carries its own prefix, so two bots
    // invited to one group drive two agents rather than fighting over one.
    sessionPrefix: instanceIdentity(config.instance).sessionPrefix,
    // A conversation that started over derives a further id; one that never
    // did derives exactly what it always did.
    epochOf: baseId => chatEpochs.epochOf(baseId),
    // The host registry's listing, read fresh per use: every workspace this
    // human already uses with the host is a `/cd` destination worth offering.
    known: () => {
      const registry = ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
      if (registry?.list === undefined) return []
      try {
        return registry.list().map(workspace => workspace.path)
      } catch {
        return []
      }
    },
  })

  /** Which model route each conversation asked for, against the deployment default. */
  const chatModels = new ChatModels({
    entries: config.chatModels,
    persist: persistState,
    report: notify,
  })

  /**
   * The directory and route each session id was derived for. The ladder is
   * keyed by session id alone, so its rungs read these back here rather than
   * widening every rung's signature with context most of them ignore. A model
   * route is NOT part of the id — the same session resumes under a new route,
   * context intact — so the override map is refreshed on every derivation.
   */
  const pathBySession = new Map<string, string>()
  const routeBySession = new Map<string, HostAgentOptions>()
  const sessionIdForKey = (key: string): string => {
    const id = chatWorkspaces.sessionIdFor(key)
    pathBySession.set(id, chatWorkspaces.pathFor(key))
    const route = chatModels.routeFor(key)
    if (route === undefined) routeBySession.delete(id)
    else routeBySession.set(id, route)
    return id
  }

  /**
   * The workspace record a directory's sessions are accounted under, resolved
   * once per directory. Workspace grouping is an ACCOUNT, not a cwd derivation:
   * a session nobody attaches stays in the GUI's Ungrouped bucket however its
   * cwd reads. Registering the directory when no record exists keeps chat
   * sessions out of that bucket instead of orphaning every one of them.
   */
  const workspaceRecords = new Map<string, Promise<HostWorkspace | undefined>>()
  const workspaceRecordFor = (path: string): Promise<HostWorkspace | undefined> => {
    let pending = workspaceRecords.get(path)
    if (pending === undefined) {
      pending = (async () => {
        const registry = ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
        if (registry === undefined) return undefined
        return (await registry.resolveByPath(path)) ?? await registry.create(path)
      })().catch((error: unknown) => {
        // Grouping is presentation: a chat must still work in a deployment
        // whose registry refuses this directory.
        notify(`lark-channel: workspace lookup failed for ${path}: ${String(error)}`)
        return undefined
      })
      workspaceRecords.set(path, pending)
    }
    return pending
  }

  // Operator-facing, so it goes to the process stream as well as the logger:
  // the shipped profiles compose no logger printer, and a silently swallowed
  // outbound failure is indistinguishable from a hung chat.
  const reportSendFailure = (error: unknown): void => {
    const detail = failureDetail(error)
    notify(`lark-channel: outbound send failed: ${detail}`)
    ctx.logger.warn('outbound send failed: %s', detail)
  }

  /** Resolve the provider/model for a new chat agent; config overrides the host default. */
  const modelSelection = (): HostAgentOptions => {
    if (config.provider !== undefined || config.model !== undefined) {
      return { provider: config.provider, model: config.model }
    }
    const defaults = ctx.get('agentDefaultModel') as HostDefaultModel | undefined
    if (defaults === undefined) {
      throw new Error(
        'lark-channel: no model configured — set config.provider/model or compose the agentDefaultModel service',
      )
    }
    return defaults.currentSelection()
  }

  /** The deployment default's display form; `/status` must not throw where creation may. */
  const deploymentRoute = (): string => {
    try {
      return formatRoute(modelSelection())
    } catch {
      return '未配置'
    }
  }

  /**
   * Every route the host llm registry advertises, flattened. Advisory by that
   * service's own contract, and absent services or throwing adapters degrade
   * to an empty catalog rather than a failed command.
   */
  const modelCatalog = async (): Promise<readonly CatalogEntry[]> => {
    const llm = ctx.get('llm') as HostLlm | undefined
    if (llm === undefined) return []
    try {
      const lists = await Promise.all(llm.listProviders().map(async (provider) => {
        try {
          return await llm.listModels(provider.id)
        } catch {
          return []
        }
      }))
      return lists.flat().map(model => ({ provider: model.provider, id: model.id, name: model.name }))
    } catch {
      return []
    }
  }

  /** Whether each live session is inside a turn right now, for `/status`. */
  const runningBySession = new Map<string, boolean>()

  /**
   * Reply targets by the UUID this bridge stamps on each followup, claimed
   * when the host's `user/message` event echoes that id back inside a turn.
   */
  const targetByMessageId = new Map<string, ReplyTarget>()

  /**
   * Where a session's replies are currently aimed, so an artifact lands under
   * the ask. The renderer already knows this, but it keeps the aim privately
   * inside its own send options, and a file does not go out through it.
   */
  const aimBySession = new Map<string, ReplyTarget>()

  /** Open intent-confirmation questions, and the two ways they get answered. */
  const questions = new ChatQuestions({
    send: async (chatId, card) => (await port.send(chatId, { card })).messageId,
    update: async (messageId, card) => { await port.updateCard(messageId, card) },
    report: notify,
  })

  /**
   * Ask this agent's chat, one question at a time. Sequential on purpose: two
   * open cards in one conversation would leave a typed answer ambiguous.
   */
  const askQuestions = async (
    asked: readonly AskedQuestion[],
    sessionId: string | undefined,
  ): Promise<QuestionAnswer[]> => {
    const binding = sessionId === undefined ? undefined : bySession.get(sessionId)
    if (binding === undefined || sessionId === undefined) {
      // No chat to ask in — answer empty rather than hang the turn.
      return asked.map(question => ({ id: question.id, selected: [] }))
    }
    const answers: QuestionAnswer[] = []
    for (const question of asked) {
      answers.push(await questions.ask({ sessionId, chatId: binding.chatId, question }))
    }
    return answers
  }

  /**
   * Review one plan in its own chat: the plan as an ordinary message, then the
   * decision as a card.
   *
   * The message goes first so the card lands under the thing it is about, and
   * a failed send throws before the card exists — a decision card above a plan
   * nobody can read is worse than a tool error the model can act on.
   */
  const planReview: PlanReviewPorts = {
    publish: async (sessionId, plan) => {
      const binding = bySession.get(sessionId)
      if (binding === undefined) throw new Error('this plan has no chat to present in')
      await port.send(binding.chatId, { markdown: plan })
    },
    review: async (sessionId, heading, signal) => {
      const binding = bySession.get(sessionId)
      if (binding === undefined) throw new Error('this plan has no chat to review it')
      const answer = await questions.ask({
        sessionId,
        chatId: binding.chatId,
        question: planReviewQuestion(heading),
        ...signal === undefined ? {} : { signal },
      })
      return { selected: answer.selected, ...answer.custom === undefined ? {} : { custom: answer.custom } }
    },
    planMode: () => ctx.get('planMode') as HostPlanMode | undefined,
  }

  /**
   * What the model's own `send_file` needs from this bridge, or undefined where
   * the deployment closed that door — which is what makes the tool absent from
   * the agent rather than present and always refusing.
   */
  const sendFilePorts: SendFilePorts | undefined = config.sendFiles
    ? {
        deliver: (sessionId, file, signal) => deliverFile(sessionId, file, signal),
        workspaceOf: (sessionId) => {
          const key = sessions.keyOf(sessionId)
          return key === undefined ? undefined : chatWorkspaces.pathFor(key)
        },
        maxBytes: config.maxSendFileBytes,
        report: notify,
      }
    : undefined

  /** Resolved once; a display nicety must not be able to break activation. */
  let pluginVersion = ''
  try {
    pluginVersion = ownVersion()
  } catch {
    // The row is simply omitted.
  }

  /**
   * Resolve what one agent joins, and the view its calls are described through.
   * A deployment with a preset roster keeps every model-facing row on the agent
   * plane, so an agent that joins nothing reaches the model with NO tools and
   * none of the deployment's prompt sections. The id is resolved up front to
   * record it, and the join happens inside setup so a broken preset rolls the
   * whole creation back instead of publishing a toolless session.
   * @returns the composition every rung of one session's ladder applies.
   * @throws when the roster supplies no such preset.
   */
  const composeAgent = async (): Promise<AgentComposition> => {
    // Loader siblings mount concurrently; await the complete application so a
    // first message arriving during boot never sees a half-composed agent world.
    await (ctx.get('loader') as HostLoader | undefined)?.await()
    const presets = ctx.get('agentPresets') as HostAgentPresets | undefined
    const presetId = presets === undefined ? undefined : (await presets.resolve(config.preset)).id
    // A roster keeps every tool off the global layer, so its standing key is
    // the view that can describe this agent's calls.
    const toolScope = presets === undefined || presetId === undefined
      ? undefined
      : await presets.standingKeyFor(presetId)
    return {
      ...presetId === undefined ? {} : { presetId },
      presentCall: createCallPresenter(ctx.get('tools') as HostTools | undefined, toolScope),
      setup: async (agentCtx: Context) => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
        composeChatAgent(agentCtx, config, askQuestions, planReview, sendFilePorts, botSelf())
      },
    }
  }

  /**
   * One composition per session id, shared by the resume attempt, the create
   * that follows it, and the renderer that describes the session's calls.
   * Resolving a preset re-reads the roster, and a first-contact chat walks every
   * rung, so an uncached ladder would read the roster once per rung.
   */
  const compositions = new Map<string, Promise<AgentComposition>>()
  const compositionFor = (sessionId: string): Promise<AgentComposition> => {
    let pending = compositions.get(sessionId)
    if (pending === undefined) {
      pending = composeAgent()
      compositions.set(sessionId, pending)
      // A rejected composition is not replayed: the next message may arrive
      // after the roster it named was fixed.
      pending.catch(() => { compositions.delete(sessionId) })
    }
    return pending
  }

  const agents = ctx.agents as DurableAgentRegistry

  const ladder: SessionLadder = {
    lookup: (sessionId) => {
      const agent = agents.get(sessionId)
      // An agent another owner published is theirs to dispose.
      return agent === undefined ? undefined : { agent, dispose: () => Promise.resolve() }
    },
    resume: async (sessionId) => {
      const composition = await compositionFor(sessionId)
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: routeBySession.get(sessionId) ?? modelSelection(),
        setup: composition.setup,
      })
      // Resuming publishes too. A chat that already has a durable session
      // NEVER takes the create rung again, so publishing only from there froze
      // the panel at whatever this channel offered the day that session began:
      // every command added afterwards existed, worked when typed, and was
      // invisible to everyone who reached for `/`.
      publishSlashPanel(handle.agent)
      return handle
    },
    create: async (sessionId) => {
      const composition = await compositionFor(sessionId)
      // The workspace's own canonical path, so `attachSession` finds the header
      // cwd it validates against rather than an uncanonicalized variant of it.
      const directory = pathBySession.get(sessionId) ?? defaultCwd
      const workspace = await workspaceRecordFor(directory)
      const handle = await agents.create({
        sessionId,
        meta: {
          cwd: workspace?.path ?? directory,
          ...composition.presetId === undefined ? {} : { agentPreset: composition.presetId },
        },
        agentOptions: routeBySession.get(sessionId) ?? modelSelection(),
        setup: composition.setup,
      })
      if (workspace !== undefined) {
        await workspace.attachSession(sessionId).catch((error: unknown) => {
          notify(`lark-channel: session ${sessionId} stays ungrouped: ${String(error)}`)
        })
      }
      // The panel is app-wide, and the command list is only knowable from an
      // agent's scope, so the first chat to exist is what can publish it.
      publishSlashPanel(handle.agent)
      return handle
    },
    // A rejected resume is the registry's only existence probe, and an
    // unreadable session log looks exactly like a chat nobody ever messaged, so
    // the ladder's handled failures are reported rather than swallowed.
    report: (line) => { ctx.logger.info(line) },
  }

  const sessions = new ConversationSessions(config.sessionScope, ladder, sessionIdForKey)

  /**
   * The renderer for one session, opened on first use and kept until the fiber
   * unwinds: it holds the turn's streaming card, which outlives any one message.
   * @param sessionId - the session whose events it renders.
   * @param msg - the message that reached this session.
   * @returns the binding, the same object for every later message of the session.
   * @throws when the session's composition cannot be resolved.
   */
  /** Set by the disposal sweep, so a binding resolving late closes itself. */
  let unwound = false

  /**
   * In-flight and settled binding creations, one per session id. A plain
   * check-then-create raced two concurrent callers into two renderers, one of
   * them orphaned but still aimed at — the same promise-cache pattern the
   * compositions use makes creation single-flight. A model switch resumes the
   * same session id and REUSES its binding on purpose: the renderer presents
   * calls through the preset's view, which a model change does not alter.
   */
  const bindings = new Map<string, Promise<ChatBinding>>()
  const bindingFor = (sessionId: string, msg: NormalizedMessage): Promise<ChatBinding> => {
    let pending = bindings.get(sessionId)
    if (pending === undefined) {
      pending = (async (): Promise<ChatBinding> => {
        const { presentCall } = await compositionFor(sessionId)
        // The renderer is the composition's last reader; dropping it here leaves
        // the next conversation bound on this id to read the roster fresh.
        compositions.delete(sessionId)
        const binding: ChatBinding = {
          chatId: msg.chatId,
          chatType: msg.chatType,
          renderer: renderFor(msg.chatId, presentCall),
        }
        if (unwound) {
          // The fiber unwound while this was composing; nothing will ever
          // dispatch to this renderer, so it must not hold an open card.
          void binding.renderer.close()
          throw new Error('lark-channel: bridge unwound while binding')
        }
        bySession.set(sessionId, binding)
        return binding
      })()
      bindings.set(sessionId, pending)
      pending.catch(() => {
        // Only the failure that still owns the slot clears it: a stale
        // rejection must not evict a successor's live promise.
        if (bindings.get(sessionId) === pending) bindings.delete(sessionId)
      })
    }
    return pending
  }

  /**
   * The renderer one chat's output goes through.
   *
   * `cot` shows the process as the platform's own agent messages do — reasoning
   * in a thinking area, each tool call with an icon and its result as a code
   * block — and leaves the answer to an ordinary markdown message, which is
   * where the platform says a final answer belongs. `stream` keeps the whole
   * turn in one typewriter card instead, for clients older than that surface.
   * Either way `showProcess` decides whether the process is shown at all.
   * @param chatId - the chat this renderer serves.
   * @param presentCall - the session's tool presenter.
   * @returns the renderer for the configured output.
   */
  const renderFor = (chatId: string, presentCall: ToolPresentation): OutboundRenderer => {
    if (config.output === 'stream') {
      return createStreamRenderer(port, chatId, {
        showProcess: config.showProcess,
        presentCall,
        onFailure: reportSendFailure,
      })
    }
    return createCotRenderer(port, chatId, {
      showProcess: config.showProcess,
      hidden: config.hideProcessWhenDone,
      presentCall,
      onFailure: reportSendFailure,
      answer: createMessageRenderer(port, chatId, reportSendFailure),
    })
  }

  /** Mark a message as being worked on. Best-effort: the app may lack the scope. */
  let panelPublished = false

  /**
   * Publish what this chat accepts to the bot's `/` panel, once. Fire and
   * forget: discovery is a convenience, and every command works typed by hand.
   */
  const publishSlashPanel = (agent: HostAgent): void => {
    if (!config.syncSlashCommands || panelPublished) return
    panelPublished = true
    const hosted = (ctx.get('commands') as HostCommands | undefined)?.list(agent) ?? []
    const desired = [
      ...hosted.map(descriptor => ({ name: descriptor.name, description: descriptor.description })),
      { name: STOP_COMMAND, description: '停止当前任务' },
      { name: CD_COMMAND, description: '切换本会话的工作区目录' },
      { name: WS_COMMAND, description: '查看可用工作区' },
      { name: GET_COMMAND, description: '把工作区里的文件发到聊天' },
      { name: MODEL_COMMAND, description: '查看或切换本会话模型' },
      { name: STATUS_COMMAND, description: '查看本会话状态' },
      { name: NEW_COMMAND, description: '开一个新会话，清空上下文' },
      { name: HELP_COMMAND, description: '显示可用命令' },
    ]
    void syncSlashPanel(port, desired, notify).then(({ added, removed }) => {
      if (added.length > 0) notify(`lark-channel: registered /${added.join(', /')} on the bot's slash panel`)
      if (removed.length > 0) notify(`lark-channel: removed /${removed.join(', /')} from the bot's slash panel`)
    })
  }

  /** Bot senders this channel answers, and the budget their exchanges spend. */
  const botPeers = new Set(config.botPeers)
  const hops = createHopBudget(config.botHops)
  /** Conversations already told their exchange stopped, so it is said once. */
  const exhausted = new Set<string>()
  /** Bots already named on the console, so an unlisted one is reported once per chat. */
  const reportedBots = new Set<string>()
  /**
   * This channel's own bot id, so it can never answer itself. The transport
   * resolves it during connect and THROWS before that, which is a diagnosis
   * this path must not turn into a dropped message.
   */
  const botSelf = (): BotSelf => {
    try {
      const identity = port.getBotIdentity?.()
      return identity === undefined ? {} : { name: identity.name, openId: identity.openId }
    } catch {
      return {}
    }
  }
  const ownBotId = (): string | undefined => botSelf().openId

  /** Aborts in-flight command executions when this bridge unwinds. */
  const commands = new AbortController()
  ctx.effect(() => () => { commands.abort() }, 'lark:commands')
  const commandSignal = (): AbortSignal => commands.signal

  /**
   * Which conversation a control card governs, and where it was published.
   * Only a per-sender scope makes a conversation one person's; under the other
   * scopes the room owns it, exactly as the room owns its approvals.
   */
  const subjectOf = (msg: NormalizedMessage): ConversationSubject => ({
    key: conversationKey(config.sessionScope, msg),
    chatId: msg.chatId,
    chatType: msg.chatType,
    ...config.sessionScope === 'chat-sender' ? { owner: msg.senderId } : {},
  })

  /**
   * Where an answer to one inbound message belongs. A topic thread is part of
   * the address, not a detail: a reply that names only the message leaves the
   * thread and lands in the chat's main channel.
   * @param msg - the message being answered.
   * @returns the reply target for {@link replyOptions}.
   */
  const replyTargetOf = (msg: NormalizedMessage): ReplyTarget => ({
    messageId: msg.messageId,
    ...msg.threadId === undefined ? {} : { threadId: msg.threadId },
  })

  /**
   * Dispose one conversation's agent so the next message walks the ladder
   * again — under a new id after `/cd`, or resuming the same session under a
   * new route after a model switch.
   *
   * The session id is captured HERE, before the caller mutates any mapping:
   * `/cd` re-derives to the new id by release time, and the activity mark to
   * clear belongs to the OLD one. Clearing it now rather than waiting for a
   * `turn/end` is deliberate — this side disposed the agent, so "nothing is
   * running" is a synchronous fact, and the closing event of an aborted turn is
   * not guaranteed to arrive.
   */
  const releaseFor = (key: string): (() => Promise<void>) => {
    const releasedId = chatWorkspaces.sessionIdFor(key)
    return async () => {
      await sessions.release(key)
      runningBySession.delete(releasedId)
      callSnapshots.delete(releasedId)
      aimBySession.delete(releasedId)
      questions.cancelSession(releasedId)
    }
  }

  /** Everything `/status` reports, read fresh from channel state. */
  const statusFieldsFor = (subject: ConversationSubject): StatusFields => {
    const sessionId = chatWorkspaces.sessionIdFor(subject.key)
    const override = chatModels.routeFor(subject.key)
    const route = override === undefined ? deploymentRoute() : formatRoute(override)
    // Meters come off the LIVE session: a conversation whose agent has not been
    // built yet has spent nothing, and reading its stored log to say so would
    // load a log to report a zero.
    const live = (ctx.get('agents') as DurableAgentRegistry | undefined)?.get(sessionId)
    const meters = readMeters(
      ctx.get('sessionProjections') as HostSessionProjections | undefined,
      live?.session,
    )
    return {
      ...meters,
      workspace: chatWorkspaces.pathFor(subject.key),
      workspaceIsDefault: chatWorkspaces.isDefault(subject.key),
      route,
      routeIsDefault: override === undefined,
      sessionId,
      bound: sessions.keyOf(sessionId) !== undefined,
      running: runningBySession.get(sessionId) === true,
      pendingApprovals: [...pendingApprovals.values()]
        .filter(pending => pending.chatId === subject.chatId).length,
      version: pluginVersion,
    }
  }

  /**
   * Whether one click may change the conversation its card names.
   *
   * A control card can be forwarded — the platform allows it and the payload
   * travels with it — so the chat is checked first: the same buttons pressed
   * in another room govern nothing. Beyond that a click is authorized exactly
   * as a message would be, since it changes what the next message does.
   * @param subject - the conversation the card was built for.
   * @param evt - the click.
   * @returns the refusal reason for the operator log, or undefined when allowed.
   */
  const refuseControlClick = (subject: ConversationSubject, evt: CardActionEvent): string | undefined => {
    if (evt.chatId !== subject.chatId) {
      return `click from chat ${evt.chatId} does not match the card's chat ${subject.chatId}`
    }
    if (subject.owner !== undefined && evt.operator.openId !== subject.owner) {
      return `operator ${evt.operator.openId} does not own conversation ${subject.key}`
    }
    return refuseMessage(authorization, {
      senderId: evt.operator.openId,
      chatId: subject.chatId,
      chatType: subject.chatType,
    })
  }


  const handleMessage = async (msg: NormalizedMessage): Promise<void> => {
    // Authorization before anything else: a message here starts a
    // shell-capable agent. Refusals stay silent in the chat — answering would
    // turn the bot into an oracle for who is authorized — and name the sender
    // on the operator console, which is also how an owner finds their own id.
    const refusal = refuseMessage(authorization, msg)
    if (refusal !== undefined) {
      notify(`lark-channel: ignored a message in ${msg.chatId}: ${refusal}`)
      return
    }
    // A message from a bot is answered only where the deployment named that
    // bot and the exchange still has hops left. `undefined` means the event
    // omitted the sender kind, which is "unknown", not "not a bot" — and
    // refusing every unknown sender would refuse ordinary traffic, so only a
    // positive bot signal is judged here.
    const conversation = conversationKey(config.sessionScope, msg)
    if (msg.senderIsBot === true) {
      const verdict = judgeBotMessage(
        { senderId: msg.senderId, key: conversation, ownBotId: ownBotId() },
        botPeers,
        hops,
      )
      if (verdict.kind === 'stranger') {
        // Once per bot per chat: the id is what an operator needs to allow it,
        // and repeating it for every message would bury the rest of the log.
        const seen = `${msg.chatId}/${verdict.senderId}`
        if (!reportedBots.has(seen)) {
          reportedBots.add(seen)
          notify(strangerNotice(verdict.senderId, msg.chatId))
        }
        return
      }
      if (verdict.kind === 'self') return
      if (verdict.kind === 'answer') {
        // Named once per bot per chat: who can drive a shell-capable agent is
        // a fact worth seeing, and here the answer is "a bot".
        const seen = `${msg.chatId}/${msg.senderId}`
        if (!reportedBots.has(seen)) {
          reportedBots.add(seen)
          notify(servedNotice(msg.senderId, msg.chatId))
        }
      }
      if (verdict.kind === 'exhausted') {
        // Said once, in the chat, because the humans there are the ones who
        // can restart it — and saying it again per message is the very noise
        // the budget exists to stop.
        if (!exhausted.has(conversation)) {
          exhausted.add(conversation)
          await port.send(msg.chatId, { text: exhaustedNotice(verdict.spent) }).catch(reportSendFailure)
        }
        return
      }
    } else {
      // A person speaking is the signal that the exchange is still wanted.
      hops.reset(conversation)
      exhausted.delete(conversation)
    }
    // An @-only ping carries no text; starting a turn on an empty prompt spends
    // a turn for nothing. Skipped before the acknowledgement, which would
    // otherwise promise work no turn is doing.
    if (msg.content.trim() === '') return
    // Channel-owned commands need no agent, so they run BEFORE acquisition: a
    // `/cd` in a fresh chat must not first create the session in the directory
    // it is switching away from, and `/status` must answer before a first
    // message exists.
    const channelCommand = commandName(msg.content)
    if (
      channelCommand === CD_COMMAND || channelCommand === WS_COMMAND
      || channelCommand === MODEL_COMMAND || channelCommand === STATUS_COMMAND
      || channelCommand === NEW_COMMAND || channelCommand === GET_COMMAND
    ) {
      try {
        const key = conversation
        // Answered before the release below is even derived: `/get` does not
        // change this conversation's identity — it reads one file out of the
        // directory the conversation already runs in — so releasing its agent
        // would throw away a live context to send an attachment.
        if (channelCommand === GET_COMMAND) {
          const reply = await runGetCommand(
            msg.content,
            chatWorkspaces.pathFor(key),
            config.maxSendFileBytes,
            async (file, bytes) => {
              // No approval card, in a group either (ADR 0002): the human typed
              // the path, and asking him to approve his own command is theatre.
              await port.send(
                msg.chatId,
                { file: { source: bytes, fileName: file.fileName } },
                replyOptions(replyTargetOf(msg)),
              )
            },
          )
          // A delivered file speaks for itself; only a refusal needs words.
          if (reply !== undefined) await port.send(msg.chatId, { markdown: reply }).catch(reportSendFailure)
          return
        }
        // Dispose the conversation's current agent so the next message walks
        // the ladder again — under a new id after `/cd`, or resuming the same
        // session under the new route after `/model use`. The id is captured
        // BEFORE the command mutates the mapping: `/cd` re-derives to the new
        // id by release time, and the activity mark to clear belongs to the
        // OLD one. Clearing here rather than waiting for a `turn/end` is
        // deliberate — this side disposed the agent, so "nothing is running"
        // is a synchronous fact, and the closing event of an aborted turn is
        // not guaranteed to arrive.
        const release = releaseFor(key)
        const subject = subjectOf(msg)
        let reply: { markdown: string } | { card: object }
        if (channelCommand === CD_COMMAND || channelCommand === WS_COMMAND) {
          reply = { markdown: await runWorkspaceCommand(channelCommand, msg.content, key, chatWorkspaces, release) }
        } else if (channelCommand === NEW_COMMAND) {
          reply = { markdown: await runNewCommand(chatWorkspaces.baseSessionIdFor(key), chatEpochs, release) }
        } else if (channelCommand === MODEL_COMMAND) {
          reply = await runModelCommand(msg.content, subject, chatModels, {
            catalog: modelCatalog,
            deploymentRoute,
            release,
          })
        } else {
          reply = { card: renderStatusCard(statusFieldsFor(subject), subject) }
        }
        await port.send(msg.chatId, reply).catch(reportSendFailure)
      } catch (error) {
        notify(`lark-channel: ${channelCommand} command failed in ${msg.chatId}: ${String(error)}`)
        await port
          .send(msg.chatId, { text: `⚠️ 命令执行失败：${failureDetail(error)}` })
          .catch(reportSendFailure)
      }
      return
    }
    try {
      const opened = await sessions.acquire(msg)
      const binding = await bindingFor(opened.handle.agent.session.id, msg)
      // A slash line is a control, not a prompt: the host runs it without a
      // model turn, so it must not be handed to the model as text — and it
      // needs no reply target, since its answer is not an assistant turn.
      if (isCommandLine(msg.content)) {
        const outcome = await runCommandLine(
          msg.content,
          opened.handle.agent,
          ctx.get('commands') as HostCommands | undefined,
          commandSignal(),
        )
        if (outcome.reply !== '') {
          await port.send(binding.chatId, { markdown: outcome.reply }).catch(reportSendFailure)
        }
        return
      }
      // A message answering an open question belongs to that question, not to
      // a new turn: the agent is mid-run waiting for it. Checked AFTER command
      // dispatch, so `/stop` still interrupts a chat that owes an answer.
      if (questions.answerByText(opened.handle.agent.session.id, msg.content)) return

      // Files land only once an agent exists to read them: acquisition is what
      // can still fail here, and a failed one must leave no orphan in someone's
      // repository. The workspace is the conversation's own, so `/cd` moves
      // where the next message's files arrive.
      const workspace = chatWorkspaces.pathFor(conversation)
      let inbound: CollectedFiles = { landed: [], notes: [] }
      let images: CollectedImages = { blocks: [], notes: [] }
      // Its own catch, and not the one below: both collectors handle their own
      // failures today, so a rejection here is latent — but reported as agent
      // creation it would name the wrong cause AND drop the turn, losing the
      // message from the model's view entirely. A collection failure costs the
      // attachments; it must not cost the conversation.
      try {
        inbound = await collectInboundFiles(msg, port, {
          workspace,
          enabled: config.receiveFiles,
          maxFileBytes: config.maxReceiveFileBytes,
          report: notify,
          hintWorkspace: !hintedWorkspaces.has(workspace),
        })
        if (inbound.landed.length > 0) hintedWorkspaces.add(workspace)
        images = await collectImages(
          msg,
          port,
          inbound.landed,
          ctx.get('attachments') as HostAttachments | undefined,
          config.attachImages,
        )
      } catch (error) {
        notify(`lark-channel: collecting the attachments of ${msg.messageId} failed: ${String(error)}`)
        ctx.logger.warn('collecting attachments of %s failed: %s', msg.messageId, error)
      }
      // The reply target is registered by MESSAGE ID and claimed when the
      // host's `user/message` event names it, because a turn is not one
      // message: the react loop drains several queued followups into a single
      // turn, so aiming at arrival — or by turn order — replies to the wrong
      // message the moment two overlap. When a turn consumes several, the last
      // claim wins: a batched answer addresses the latest ask.
      const message = chatUserMessage(msg, images, inbound)
      const target = replyTargetOf(msg)
      if (targetByMessageId.size >= MAX_PENDING_TARGETS) {
        const oldest = targetByMessageId.keys().next().value
        if (oldest !== undefined) targetByMessageId.delete(oldest)
      }
      targetByMessageId.set(message.id, target)
      try {
        opened.handle.agent.followup(message)
      } catch (error) {
        // A rejected followup will never produce the claiming event; its
        // target must not linger to be claimed by an unrelated turn.
        targetByMessageId.delete(message.id)
        throw error
      }
    } catch (error) {
      notify(`lark-channel: agent creation failed for chat ${msg.chatId}: ${String(error)}`)
      ctx.logger.warn('agent creation failed for chat %s: %s', msg.chatId, error)
      await port
        .send(msg.chatId, { text: `⚠️ 无法启动会话：${failureDetail(error)}` })
        .catch(reportSendFailure)
    }
  }

  /**
   * Decide one approval exactly once. The asker is resolved immediately; the
   * card is painted here when it already exists, and by the send's return path
   * when the settlement raced the send — either way exactly one of them does.
   */
  const settleApproval = (
    id: string,
    outcome: HostApprovalOutcome,
    decidedBy?: string,
    repaint = true,
  ): boolean => {
    const pending = pendingApprovals.get(id)
    if (pending === undefined || pending.state === 'settled') return false
    pending.state = 'settled'
    pending.outcome = outcome
    pending.decidedBy = decidedBy
    pending.removeAbort?.()
    pending.settle(outcome)
    if (!repaint) {
      // The caller paints it — a click answers with the decided card, which is
      // the one repaint path that cannot fail unnoticed.
      pendingApprovals.delete(id)
      return true
    }
    if (pending.messageId !== undefined) {
      pendingApprovals.delete(id)
      void port
        .updateCard(pending.messageId, pending.paint(outcome, decidedBy))
        .catch(reportSendFailure)
    }
    return true
  }

  /**
   * Publish one registered approval's card and settle the race the send itself
   * creates: a decision can arrive — an abort, a timeout, disposal — while the
   * platform is still rendering the card, and the asker is answered by then. The
   * card that just appeared must not be left showing live buttons.
   *
   * Shared by both kinds of approval on purpose: this is the delicate half, and
   * two copies of it would drift. What each kind does about a card that never
   * reached the chat is its own business, hence the boolean rather than a policy
   * decided here.
   * @param id - the pending approval's correlation id.
   * @param pending - the registered question, whose `messageId` and `state` this advances.
   * @param card - the live card to send.
   * @returns whether the card reached the chat.
   */
  const sendApprovalCard = async (id: string, pending: PendingApproval, card: object): Promise<boolean> => {
    let sent: SendResult
    try {
      sent = await port.send(pending.chatId, { card })
    } catch (error) {
      reportSendFailure(error)
      return false
    }
    pending.messageId = sent.messageId
    if (pending.state === 'settled') {
      pendingApprovals.delete(id)
      void port
        .updateCard(sent.messageId, pending.paint(pending.outcome ?? 'cancelled', pending.decidedBy))
        .catch(reportSendFailure)
    } else {
      pending.state = 'open'
    }
    return true
  }

  const askViaCard = async (
    binding: ChatBinding,
    request: HostApprovalRequest,
    next: () => Promise<HostApprovalOutcome>,
  ): Promise<HostApprovalOutcome> => {
    // A withdrawn question needs no card — and the abort event does not replay
    // for listeners added late, so the flag is the only signal that survives.
    // Read through a call: the flag mutates across awaits, which control-flow
    // narrowing would otherwise reason away.
    const withdrawn = (): boolean => request.signal?.aborted === true
    if (withdrawn()) return 'cancelled'

    // The call's facts are copied NOW: the source map is mutable shared state,
    // and the card must show exactly what the click will approve.
    const recorded = request.callId === undefined
      ? undefined
      : callSnapshots.get(request.agent.session.id)?.get(request.callId)
    const call: CallSnapshot | undefined = recorded === undefined || request.callId === undefined
      ? undefined
      : {
          sessionId: request.agent.session.id,
          turn: recorded.turn,
          callId: request.callId,
          arguments: recorded.arguments,
        }

    // Registered BEFORE the send: a click can arrive the moment the card
    // renders, and an abort can arrive while the send is in flight — both need
    // the question to already exist here.
    const id = randomUUID()
    let resolveOutcome!: (outcome: HostApprovalOutcome) => void
    const settled = new Promise<HostApprovalOutcome>((resolve) => { resolveOutcome = resolve })
    const onAbort = (): void => { settleApproval(id, 'cancelled') }
    const pending: PendingApproval = {
      chatId: binding.chatId,
      chatType: binding.chatType,
      toolName: request.toolName,
      call,
      paint: (outcome, decidedBy) => settledCard(request.toolName, outcome, decidedBy),
      state: 'sending',
      settle: resolveOutcome,
      removeAbort: () => { request.signal?.removeEventListener('abort', onAbort) },
    }
    pendingApprovals.set(id, pending)
    request.signal?.addEventListener('abort', onAbort, { once: true })

    const published = await sendApprovalCard(
      id,
      pending,
      approvalCard(request.toolName, request.reason, call?.arguments, id),
    )
    if (!published) {
      if (settleApproval(id, 'cancelled') && !withdrawn()) {
        // Nothing reached a human and nothing was withdrawn: let the next
        // composed answerer decide instead of silently cancelling the ask.
        pendingApprovals.delete(id)
        return next()
      }
      pendingApprovals.delete(id)
    }
    return settled
  }

  /**
   * Ask one group to authorize one outbound file, and wait for its answer.
   *
   * Registered in the same `pendingApprovals` the tool escalations use, so it
   * inherits every property that map's machinery already guarantees: settled
   * exactly once, painted by whichever of the click and the send gets there,
   * judged by `refuseApprovalClick`, counted by `/status`, and cancelled when
   * the fiber unwinds. Only the card and the words differ, and those ride the
   * `paint` closure.
   * @param binding - the group chat this file would land in.
   * @param file - the file the workspace check cleared.
   * @param sending - the bytes that will go out if the room allows it, already
   * read: what the card quotes is this buffer's length, so the room is deciding
   * about an artefact that exists rather than about a path that may still change.
   * @param signal - the calling execution's cancellation, so a stopped turn
   * takes its card down with it instead of leaving one that can still release
   * the file long after the turn that asked for it is gone.
   * @returns undefined once it may go out, or the English reason it may not.
   */
  const askFileSend = async (
    binding: ChatBinding,
    file: OutboundFile,
    sending: Buffer,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    // Already cancelled: publishing a card here would ask a room to decide
    // something nobody is waiting for any more.
    if (signal?.aborted === true) {
      return 'That turn was cancelled before this chat could be asked, so the file was not sent.'
    }
    const id = randomUUID()
    let resolveOutcome!: (outcome: HostApprovalOutcome) => void
    const settled = new Promise<HostApprovalOutcome>((resolve) => { resolveOutcome = resolve })
    // A card nobody answers must not hold the model's turn open forever, and it
    // is NOT a refusal: the model is told which of the two happened, because
    // "they said no" and "nobody was looking" call for different next moves.
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      notify(`lark-channel: a file approval in ${binding.chatId} went undecided; ${file.fileName} was not sent`)
      settleApproval(id, 'cancelled')
    }, QUESTION_TIMEOUT_MS)
    timer.unref?.()

    // The same shape the tool escalations use, so the settle is the one that
    // already guarantees a question closes once and its card stops offering
    // buttons — this path adds no judgement of its own about that.
    const onAbort = (): void => { settleApproval(id, 'cancelled') }
    const pending: PendingApproval = {
      chatId: binding.chatId,
      chatType: binding.chatType,
      toolName: SEND_FILE_TOOL,
      paint: (outcome, decidedBy) => settledFileCard(file, outcome, decidedBy),
      state: 'sending',
      settle: resolveOutcome,
      removeAbort: () => { signal?.removeEventListener('abort', onAbort) },
    }
    pendingApprovals.set(id, pending)
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      if (!await sendApprovalCard(id, pending, fileApprovalCard(file, sending.byteLength, id))) {
        settleApproval(id, 'cancelled')
        pendingApprovals.delete(id)
        return 'The approval card could not be sent to this chat, so the file was not sent either.'
      }
      const outcome = await settled
      if (outcome === 'allowed-once') return undefined
      if (expired) {
        return `Nobody in this chat approved sending that file within ${TIMEOUT_MINUTES} minutes, so it was `
          + 'not sent. It was not refused — say what the file contains in your reply instead.'
      }
      if (outcome === 'rejected') {
        return 'Someone in this chat rejected sending that file, so it was not sent. '
          + 'Do not offer it again unless they ask for it.'
      }
      return 'The request to send that file was withdrawn before anyone decided, so it was not sent.'
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Claim one of a chat's file-send slots.
   * @param chatId - the chat the bytes would land in.
   * @returns whether a slot was free; a claim taken must be released.
   */
  const holdFileSend = (chatId: string): boolean => {
    const held = heldFileSends.get(chatId) ?? 0
    if (held >= MAX_PENDING_FILE_SENDS) return false
    heldFileSends.set(chatId, held + 1)
    return true
  }

  /**
   * Give one slot back, once the buffer it accounted for is off the heap.
   * @param chatId - the chat the claim was taken against.
   */
  const releaseFileSend = (chatId: string): void => {
    const left = (heldFileSends.get(chatId) ?? 1) - 1
    // Deleted rather than left at zero: a long-lived process serving many rooms
    // should not accumulate one entry per room it once sent a file to.
    if (left > 0) heldFileSends.set(chatId, left)
    else heldFileSends.delete(chatId)
  }

  /**
   * Read one cleared file, ask the room when the room has to be asked, and put
   * the bytes in the chat.
   *
   * The gating matrix lives here (ADR 0002): a direct message goes straight out,
   * because its only reader is the person already authorized to drive this agent
   * — who could have asked for the contents on screen instead, so the leak
   * boundary is zero and an approval would only breed the fatigue that ends in
   * blind approving. A group is where the leak lives, so a group asks.
   *
   * The bytes are read BEFORE the room is asked, and the buffer in hand is what
   * goes out. Read afterwards, an approval would certify a PATH rather than a
   * file: thirty minutes is ample for a background process the model started to
   * leave a same-size `.env` under the name the card showed, and neither the
   * size re-check in `readOutboundFile` nor the container check — which never
   * runs again on the cleared path — can see that swap. Reading first makes the
   * artefact the room approved and the artefact that leaves one object.
   *
   * That order is what costs memory, and more than ADR 0004 set out to spend:
   * that decision budgeted ONE buffer for the few seconds of a send, while a
   * group send holds one for as long as the room takes to answer. What bounds the
   * sum is the caller's slot, not anything here.
   * @param binding - the chat the file goes to, which also decides whether it is gated.
   * @param sessionId - the agent's session, for the reply target the file lands under.
   * @param file - the file the workspace check cleared.
   * @param signal - the calling execution's cancellation, which also takes down
   * a group approval still waiting on a human.
   * @returns undefined once the file is in the chat, or the English reason it is not.
   */
  const offerFile = async (
    binding: ChatBinding,
    sessionId: string,
    file: OutboundFile,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    // First, so that everything after this point is about bytes that exist.
    let bytes: Buffer
    try {
      bytes = await readOutboundFile(file)
    } catch (error) {
      // Scrubbed, because an fs failure quotes the absolute path it was given and
      // this sentence goes to the model — which `describeRefusalForModel` is
      // careful never to hand a path it did not type itself.
      return `That file could not be read: ${describeReadFailure(error, file)}`
    }
    if (binding.chatType !== 'p2p') {
      const refused = await askFileSend(binding, file, bytes, signal)
      if (refused !== undefined) return refused
    }
    try {
      // A buffer, never a path (ADR 0004), and through the transport's own media
      // path rather than a hand-rolled upload (ADR 0005).
      await port.send(
        binding.chatId,
        { file: { source: bytes, fileName: file.fileName } },
        replyOptions(aimBySession.get(sessionId)),
      )
    } catch (error) {
      // The SDK's own code is the actionable half — `rate_limited` invites a
      // retry, `permission_denied` never will — so it survives to the model
      // instead of being flattened into "the send failed".
      const code = channelErrorCode(error)
      const detail = failureDetail(error)
      notify(`lark-channel: sending ${file.fileName} to ${binding.chatId} failed [${code ?? 'unknown'}]: ${detail}`)
      return `The chat platform refused the upload [${code ?? 'unknown'}]: ${detail}`
    }
    return undefined
  }

  /**
   * Send one cleared file to the chat its session belongs to, gate and quota
   * included.
   *
   * This is the MODEL's way out. `/get` does NOT come through here, and that is
   * the point: a human who typed a path has stated his intent, and making him
   * approve his own command is theatre. It runs its own send in the command
   * dispatch, which is what keeps the human row of the matrix from ever drifting
   * into the model's row — a shared function with a "gate this one" flag is
   * exactly how it would.
   *
   * What this function owns beyond that dispatch is the slot, and the ORDER in
   * which it is taken: before {@link offerFile}, therefore before the file is
   * read. A quota checked afterwards would be counting buffers that are already
   * on the heap, which is the whole cost it exists to refuse — and one injected
   * instruction can raise as many parallel calls as the model will emit, all of
   * them passing a check that runs after their own read. The direct-message path
   * takes no slot: it holds a buffer for the few seconds of a send and waits on
   * nobody, which is exactly the spend ADR 0004 budgeted.
   *
   * Failures come back as a string rather than a throw: the caller is a tool
   * body that turns whatever it gets into the model's error, and one refusal
   * shape for "rejected", "timed out" and "the upload failed" is what keeps
   * that body from having to know which of them happened.
   * @param sessionId - the agent's session, which names the chat.
   * @param file - the file the workspace check cleared.
   * @param signal - the calling execution's cancellation, which also takes down
   * a group approval still waiting on a human.
   * @returns undefined once the file is in the chat, or the English reason it is not.
   */
  const deliverFile = async (
    sessionId: string,
    file: OutboundFile,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const binding = bySession.get(sessionId)
    if (binding === undefined) return 'This session is no longer bound to a chat, so a file has nowhere to go.'
    if (binding.chatType === 'p2p') return offerFile(binding, sessionId, file, signal)
    if (!holdFileSend(binding.chatId)) {
      return `This chat already has ${MAX_PENDING_FILE_SENDS} files waiting for someone to allow them, so this `
        + 'one was not offered. Wait until those are decided before offering another file.'
    }
    try {
      return await offerFile(binding, sessionId, file, signal)
    } finally {
      // Released only once the send is over: the buffer this slot accounts for
      // lives until then, whether the room allowed it, refused it, or the upload
      // failed on the way out.
      releaseFileSend(binding.chatId)
    }
  }

  const handleCardAction = async (evt: CardActionEvent): Promise<CardActionResponse | undefined> => {
    const choice = questionActionValue(evt.action.value)
    if (choice !== undefined) {
      // A question is a choice, not an escalation: anyone the chat serves may
      // answer it, exactly as they could by typing the answer instead.
      //
      // A multiple choice arrives as a form submission, whose chosen set the
      // platform delivers beside the button's own value rather than in it.
      const submitted = (evt.action.formValue as Record<string, unknown> | undefined)?.[QUESTION_SELECT]
      const settled = questions.answerByClick(
        choice,
        Array.isArray(submitted) ? submitted.map(entry => String(entry)) : [],
      )
      return settled === undefined
        ? { toast: toast('info', TOAST.questionGone) }
        : { toast: toast('success', TOAST.answered), card: { type: 'raw', data: settled } }
    }
    const pick = modelActionValue(evt.action.value)
    if (pick !== undefined) return switchModel(pick, evt)
    const refresh = statusActionValue(evt.action.value)
    if (refresh !== undefined) {
      const refusal = refuseControlClick(refresh, evt)
      if (refusal !== undefined) {
        notify(`lark-channel: rejected a status refresh: ${refusal}`)
        return { toast: toast('error', TOAST.notYours) }
      }
      return {
        toast: toast('success', TOAST.refreshed),
        card: { type: 'raw', data: renderStatusCard(statusFieldsFor(refresh), refresh) },
      }
    }
    const value = approvalActionValue(evt.action.value)
    if (value === undefined) return undefined
    return decideApproval(value, evt)
  }

  /**
   * Apply one model pick and hand back the repainted picker.
   *
   * The switch runs the same steps the typed `/model use` runs — record, then
   * release so the next message resumes on the new route — because a click and
   * a typed line must not leave the conversation in two different states.
   * @param pick - the payload the pressed row carried.
   * @param evt - the click, for authorization and the operator log.
   * @returns the toast and the card to paint over the pressed one.
   */
  const switchModel = async (
    pick: ModelActionValue,
    evt: CardActionEvent,
  ): Promise<CardActionResponse> => {
    const refusal = refuseControlClick(pick, evt)
    if (refusal !== undefined) {
      notify(`lark-channel: rejected a model switch: ${refusal}`)
      return { toast: toast('error', TOAST.notYours) }
    }
    const route = pick.route === undefined ? undefined : parseRoute(pick.route)
    if (pick.route !== undefined && route === undefined) {
      notify(`lark-channel: a model card carried an unreadable route: ${pick.route}`)
      return { toast: toast('error', TOAST.modelUnreadable) }
    }
    const release = releaseFor(pick.key)
    const result = route === undefined
      ? await chatModels.reset(pick.key)
      : await chatModels.set(pick.key, route)
    if (result.changed) await release()
    const painted = modelPickerCard(pick, await modelCatalog(), chatModels.routeFor(pick.key), deploymentRoute())
    return {
      toast: toast(
        result.changed ? 'success' : 'info',
        !result.changed ? TOAST.modelUnchanged : route === undefined ? TOAST.modelReset : TOAST.modelSwitched,
      ),
      card: { type: 'raw', data: painted },
    }
  }

  /**
   * Settle one approval from its card's buttons.
   * @param value - the payload the pressed button carried.
   * @param evt - the click, for authorization and the decider's name.
   * @returns the toast and the settled card to paint over the live one.
   */
  const decideApproval = async (value: ApprovalActionValue, evt: CardActionEvent): Promise<CardActionResponse> => {
    const pending = pendingApprovals.get(value.id)
    // Only an OPEN question takes a click: `sending` has no real card yet (a
    // click claiming otherwise is forged or duplicated), and `settled` is
    // merely waiting for its card to be painted.
    if (pending === undefined || pending.state !== 'open') {
      return { toast: toast('info', TOAST.approvalGone) }
    }
    // Anyone who can see the card can press its button — a group may hold
    // people who are not authorized to run anything here, and one press grants
    // the escalation. The decision counts only from an authorized human, in
    // the chat this card was published to.
    const clickRefusal = refuseApprovalClick(
      authorization,
      { operatorId: evt.operator.openId, chatId: evt.chatId },
      pending,
    )
    if (clickRefusal !== undefined) {
      notify(`lark-channel: rejected an approval click: ${clickRefusal}`)
      return { toast: toast('error', TOAST.notApprover) }
    }
    const outcome: HostApprovalOutcome = value.decision === 'allow' ? 'allowed-once' : 'rejected'
    const decidedBy = await resolveApprovalDecider(evt)
    // Captured before settling, which drops the question from the map: what this
    // click paints is decided by the kind of question it answered, not by this
    // dispatch — a tool escalation and an outbound file settle differently.
    const paint = pending.paint
    if (!settleApproval(value.id, outcome, decidedBy, false)) {
      return { toast: toast('info', TOAST.approvalGone) }
    }
    return {
      toast: value.decision === 'allow' ? toast('success', TOAST.allowed) : toast('info', TOAST.rejected),
      // The decided card rides the click's own response. The patch API this
      // otherwise relies on reports refusals in a body the SDK discards, so a
      // failed repaint is invisible — a card left showing live buttons after
      // its decision is worse than any toast.
      card: { type: 'raw', data: paint(outcome, decidedBy) },
    }
  }

  /**
   * Pick the name that a settled approval records without making the approval
   * depend on the optional roster API. Card callbacks do not reliably contain
   * `operator.name`; the channel caches its member roster, so an already-warm
   * chat avoids another remote lookup.
   * @param evt - an already-authorized approval click.
   * @returns the callback name, resolved member name, or safe open-id fallback.
   */
  const resolveApprovalDecider = async (evt: CardActionEvent): Promise<string> => {
    if (evt.operator.name !== undefined && evt.operator.name !== '') return evt.operator.name
    try {
      const members = await port.getChatMembers?.(evt.chatId)
      const name = members?.find(member => member.id === evt.operator.openId)?.name
      if (name !== undefined && name !== '') return name
    } catch (error) {
      // Name decoration must never turn a valid approval into a failed send.
      ctx.logger.debug('could not resolve approval decider name', error)
    }
    return evt.operator.openId
  }

  // Inbound events. Registered before connect so no early event is dropped.
  //
  // The handler's promise is returned to the transport, never voided: the SDK
  // serializes delivery per chat by awaiting it, so voiding the promise was
  // discarding that guarantee — intake for a chat's messages (acquire, image
  // downloads, workspace/model switches) could interleave freely. Serialized
  // intake covers up to `followup()` returning; the turn itself still runs in
  // the background, which is why reply targets bind to turns, not to arrival.
  ctx.effect(() => port.on('message', handleMessage), 'lark:on(message)')
  ctx.effect(() => port.on('cardAction', handleCardAction), 'lark:on(cardAction)')

  // Observability. Without these, the failure modes an operator actually hits —
  // "the bot ignored me", "an inbound handler threw", "the connection dropped" —
  // leave no trace at all, because the transport reports each only as an event.
  ctx.effect(() => port.on('reject', (evt: RejectEvent) => {
    // A missing mention in a group is the configured steady state, not an
    // incident, so it stays off the operator console it would flood.
    if (evt.reason === 'no_mention') {
      ctx.logger.debug('rejected %s in %s: %s', evt.messageId, evt.chatId, evt.reason)
      return
    }
    ctx.logger.info('rejected %s in %s from %s: %s', evt.messageId, evt.chatId, evt.senderId, evt.reason)
    // A tripped loop guard means the bot went quiet on purpose; an operator who
    // does not know that reads it as a hang.
    if (evt.reason === 'bot_loop') {
      notify(`lark-channel: bot loop guard tripped in chat ${evt.chatId} — traffic from bots is being refused`)
    }
  }), 'lark:on(reject)')

  ctx.effect(() => port.on('error', (error: LarkChannelError) => {
    notify(`lark-channel: transport error [${error.code}]: ${error.message}`)
    ctx.logger.warn('transport error [%s]: %s', error.code, error.message)
  }), 'lark:on(error)')

  // A gap in the long connection is a gap in delivery: the transport has no
  // replay and no cursor, so events arriving while it is down are simply lost.
  //
  // The SDK's reconnect promise is supervised rather than trusted: its
  // recovery loop has terminal states (verified give-up paths, and a hang
  // that schedules nothing at all), and a bot whose job is to be reachable
  // owns its own liveness. Rebuilding goes through the transport's public
  // lifecycle, which the SDK documents as clearing terminal state.
  const watchdog = createReconnectWatchdog({
    deadlineMs: liveness?.deadlineMs ?? RECONNECT_DEADLINE_MS,
    backoffMs: liveness?.backoffMs ?? RECONNECT_BACKOFF_MS,
    quota: createAttemptQuota({
      windowMs: liveness?.quotaWindowMs ?? RECONNECT_QUOTA_WINDOW_MS,
      limit: liveness?.quotaLimit ?? RECONNECT_QUOTA_LIMIT,
    }),
    status: () => port.getConnectionStatus?.()?.state,
    rebuild: async () => {
      await port.disconnect().catch(() => {})
      await port.connect()
    },
    report: notify,
  })
  ctx.effect(() => () => { watchdog.dispose() }, 'lark:watchdog')

  ctx.effect(() => port.on('reconnecting', () => {
    watchdog.onReconnecting()
    notify('lark-channel: connection lost, reconnecting — events arriving now are not replayed')
    ctx.logger.warn('connection lost, reconnecting')
  }), 'lark:on(reconnecting)')

  ctx.effect(() => port.on('reconnected', () => {
    watchdog.onReconnected()
    notify('lark-channel: connection restored')
    ctx.logger.info('connection restored')
  }), 'lark:on(reconnected)')

  // Outbound: the owned chat's renderer decides what reaches the chat. The
  // bridge additionally remembers each call's arguments for the approval card,
  // and forgets the turn's calls once it closes.
  ctx.on('session/event', (session, event: HostSessionEvent) => {
    const binding = bySession.get(session.id)
    if (binding === undefined) return
    if (isTurnStartEvent(event)) {
      // Fail closed: a turn that never names one of our messages sends its
      // answer unaimed to the chat. Guessing — reusing the previous target —
      // is how an injected turn's output lands on an unrelated thread. An
      // artifact this turn produces is aimed by the same rule, so the two move
      // together rather than one of them lagging a turn behind.
      binding.renderer.aim(undefined)
      aimBySession.delete(session.id)
    } else if (isUserMessageEvent(event)) {
      const target = event.data.id === undefined ? undefined : targetByMessageId.get(event.data.id)
      if (target !== undefined && event.data.id !== undefined) {
        targetByMessageId.delete(event.data.id)
        binding.renderer.aim(target)
        aimBySession.set(session.id, target)
      }
    } else if (isToolCallEvent(event)) {
      let calls = callSnapshots.get(session.id)
      if (calls === undefined) {
        calls = new Map()
        callSnapshots.set(session.id, calls)
      }
      calls.set(event.data.callId, { turn: event.data.turn, arguments: event.data.arguments })
    } else if (isTurnEndEvent(event)) {
      // Only THIS session's THIS turn: call ids are known unique per turn, so
      // keeping exactly the live turn's entries is what makes an id lookup
      // unambiguous — and other sessions' in-flight turns are none of ours.
      const calls = callSnapshots.get(session.id)
      if (calls !== undefined) {
        for (const [callId, record] of calls) {
          if (record.turn === event.data.turn) calls.delete(callId)
        }
        if (calls.size === 0) callSnapshots.delete(session.id)
      }
      runningBySession.set(session.id, false)
    } else if (isStepStartEvent(event)) {
      runningBySession.set(session.id, true)
    }
    binding.renderer.handle(event)
    // AFTER the renderer: the turn's own closing output (the answer, a failure
    // line) still deserves its target; only what comes later must not.
    if (isTurnEndEvent(event)) {
      binding.renderer.aim(undefined)
      aimBySession.delete(session.id)
    }
  })

  // Approval questions for owned agents become cards; everything else delegates.
  //
  // PREPEND is load-bearing. A host answerer may claim every audited request
  // rather than only the sessions its own clients own — the Web app's BFF does
  // exactly that, pushing the question to browser clients and never calling
  // `next()`. Registered in arrival order this plugin would sit behind it (its
  // rows mount during tree load, this bridge installs after the loader
  // settles), so a chat-driven approval would surface in a browser nobody is
  // watching while the chat waits forever. Answering first is correct on the
  // merits too: the human who typed the request is in the chat, and this
  // listener still delegates every session it does not own.
  ctx.on('approval/request', (request, next) => {
    const binding = bySession.get(request.agent.session.id)
    if (binding === undefined) return next()
    return askViaCard(binding, request, next)
  }, { prepend: true })

  // Owned live state unwinds with the fiber: agents down, open questions
  // closed, open streaming cards settled. The session store owns the agents, so
  // it does the disposing — and it leaves an adopted one running for its owner.
  ctx.effect(() => () => {
    unwound = true
    for (const id of [...pendingApprovals.keys()]) settleApproval(id, 'cancelled')
    pendingApprovals.clear()
    for (const sessionId of [...bySession.keys()]) questions.cancelSession(sessionId)
    const open = [...bySession.values()]
    bySession.clear()
    bindings.clear()
    compositions.clear()
    callSnapshots.clear()
    runningBySession.clear()
    aimBySession.clear()
    return Promise.allSettled([
      sessions.close(),
      ...open.map((binding) => binding.renderer.close()),
    ]).then(() => undefined)
  }, 'lark:agents')

  // Registered last so disposal disconnects the transport first.
  ctx.effect(() => {
    port.connect().catch((error: unknown) => {
      notify(`lark-channel: connect failed: ${failureDetail(error)}`)
      ctx.logger.error('lark channel connect failed: %s', error)
    })
    return () => port.disconnect().catch(reportSendFailure)
  }, 'lark:connect')
}
