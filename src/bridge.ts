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
  ARCHIVED_SESSION_NOTICE,
  sessionsCard,
  fileApprovalCard as buildFileApprovalCard,
  QUESTION_SELECT,
  permissionCard,
  settledApprovalCard as buildSettledApprovalCard,
  settledFileApprovalCard as buildSettledFileApprovalCard,
  settledPermissionCard,
  settledSessionsCard,
  toast,
  TOAST,
  workspacesCard,
} from './cards.ts'
import type { SessionCardRow } from './cards.ts'
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
  HostPermissionPresets,
  HostSessionProjectionCache,
  HostSessionQuery,
  HostSessionEvent,
  HostSessionProjections,
  HostCommands,
  HostContentBlock,
  HostSystemPrompt,
  HostTools,
  HostUserMessage,
  HostUserQuestionAnswer,
  HostUserQuestionItem,
  HostUserQuestionRequest,
  HostWorkspace,
  HostWorkspaceRegistry,
} from './host.ts'
import type { AssistantStreamPayload } from './host.ts'
import { standingScopeFor } from './host.ts'
import { isStepStartEvent, isToolCallEvent, isTurnEndEvent, isTurnStartEvent, isUserMessageEvent, userText } from './host.ts'
import { createCotRenderer } from './cot.ts'
import type { CotPort } from './cot.ts'
import { createMessageRenderer, createStreamRenderer, replyOptions } from './outbound.ts'
import type { OutboundPort, OutboundRenderer, ReplyTarget, ToolPresentation } from './outbound.ts'
import { refuseApproverOnly, refuseApprovalClick, refuseMessage } from './authorization.ts'
import {
  cardMarker,
  marked,
} from './clicks.ts'
import { createMaintenanceQueue, lendsIdlePhase, MaintenanceCancelled } from './maintenance.ts'
import type { Authorization } from './authorization.ts'
import { commandName, HELP_COMMAND, isCommandLine, runCommandLine, STOP_COMMAND } from './commands.ts'
import {
  CD_COMMAND,
  ChatWorkspaces,
  runWorkspaceCommand,
  workspaceActionValue,
  workspaceChoices,
  workspacePage,
  WORKSPACE_ACTION,
  WS_COMMAND,
} from './workspace.ts'
import type { WorkspaceActionValue } from './workspace.ts'
import {
  ChatSessionPointers,
  EMPTY_OFFER,
  offerSessions,
  sessionActionValue,
  sessionsPage,
  SESSIONS_ACTION,
  SESSIONS_COMMAND,
} from './sessions.ts'
import type { FactSources, OfferedSessions, SessionActionValue, SessionChoice, SessionOffer } from './sessions.ts'
import { legacyEpochOf } from './epoch.ts'
import { NEW_COMMAND, isFreshSessionId, runNewCommand } from './new-session.ts'
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
import { ChatQuestions, QUESTION_TIMEOUT_MS, questionActionValue } from './questions.ts'
import { PLAN_TOOL, planReviewQuestion, shadowPlanTool } from './plan.ts'
import type { HostPlanMode, PlanReviewPorts } from './plan.ts'
import type { PermissionActionValue, PresetOption } from './permission.ts'
import type { AskedQuestion, ChatQuestionBatch, QuestionAnswer } from './questions.ts'
import { ownVersion } from './version.ts'
import { collectImages } from './images.ts'
import type { CollectedImages, ImagePort } from './images.ts'
import { collectInboundFiles } from './files.ts'
import type { CollectedFiles, InboundFilePort } from './files.ts'
import {
  describeReadFailure,
  GET_COMMAND,
  readOutboundFile,
  readGetTarget,
  SEND_FILE_TOOL,
  sendFileTool,
} from './outbound-file.ts'
import type { OutboundFile, SendFilePorts } from './outbound-file.ts'
import { failureDetail } from './format.ts'
import { syncSlashPanel } from './slash-panel.ts'
import type { SlashPanelPort } from './slash-panel.ts'
import { ConversationSessions, conversationKey, SESSION_PREFIX, sessionIdFor, SessionRefusedError } from './session.ts'
import type { ConversationSubject, SessionLadder } from './session.ts'
import { createAttemptQuota, createReconnectWatchdog } from './liveness.ts'
import { createHopBudget, exhaustedNotice, judgeBotMessage, servedNotice, strangerNotice } from './botchat.ts'
import { batonNote, PRESENCE_ORDER, PRESENCE_SECTION, presenceSection } from './presence.ts'
import type { BotSelf } from './presence.ts'
import { canonicalPathOf } from './containment.ts'
import { createFileDiag } from './diag.ts'
import type { DiagSink } from './diag.ts'
import { instanceIdentity } from './instance.ts'
import {
  isUnconfined,
  loosensSandbox,
  PERMISSION_ACTION,
  PERMISSION_COMMAND,
  permissionActionValue,
  readPresets,
  requestedEscalation,
  switchPreset,
  UNCONFINED_PRESET,
} from './permission.ts'

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
 * The chat facts one outbound-file gate needs.
 *
 * Narrower than {@link ChatBinding} on purpose: `/get` runs before any agent
 * exists, so it has a chat to ask but no renderer to hand over.
 */
interface GateChat {
  readonly chatId: string
  /** `p2p` or a group kind; approvals in a group are judged as the room. */
  readonly chatType: string
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
/** Where one preset switch ended, and what the host said when it did not land. */
interface PresetOutcome {
  readonly ok: boolean
  readonly detail?: string | undefined
  /**
   * True when the conversation moved on before the switch ran — released by
   * `/new`, `/cd`, a model switch, or the plugin unwinding. Not a failure: the
   * chat asked for something and then asked for something else, and telling it
   * "切换失败" (in the queue's own English, session id and all) would be both
   * noise and a lie.
   */
  readonly cancelled?: boolean | undefined
}

/**
 * How long a typed `/permission <name>` waits for its switch before saying it
 * is waiting. Long enough that an idle conversation answers once, short enough
 * that a busy one does not hold its chat's queue.
 */
const QUICK_SWITCH_MS = 1200

/**
 * How many times disposal waits for the background set to empty. Each round
 * settles everything currently in it; a round exists at all because that work
 * can start more of its own.
 */
const BACKGROUND_DRAIN_ROUNDS = 3

/**
 * How long disposal waits for that work in total. Long enough for a send and a
 * repaint against a healthy platform, short enough that unloading a plugin is
 * never something an operator has to wonder about.
 */
const BACKGROUND_DRAIN_MS = 5_000

/**
 * A promise that never settles, used to drop a losing branch out of a race.
 *
 * An approval is offered on two surfaces at once and the first answer wins. A
 * branch that FAILS must not decide, and returning `undefined` from its
 * rejection handler would settle the race immediately with nothing — refusing a
 * question the other surface can still answer. Dropping out is expressed as a
 * promise that never settles.
 */
const NEVER_SETTLES = new Promise<never>(() => {})

interface PendingApproval {
  readonly chatId: string
  readonly chatType: string
  readonly toolName: string
  /** The agent whose turn is waiting; a preset switch runs through it. */
  readonly agent?: HostAgent | undefined
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
  /**
   * Whether the decision came from another surface rather than a press here.
   *
   * The same question is offered in the chat AND to whatever answerer follows
   * this listener — the Web app's, in the deployment this was built for — and
   * whichever decides first wins. When the other one wins, the card must not
   * credit a press that never happened.
   */
  decidedElsewhere?: boolean | undefined
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
  /** Also switch this conversation to the unconfined preset, after settling. */
  readonly always?: boolean
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
  return {
    kind: APPROVAL_ACTION,
    id: record.id,
    decision: record.decision,
    ...record.always === true ? { always: true } : {},
  }
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
  escalateTo?: string | undefined,
): object {
  return buildApprovalCard({
    toolName,
    reason,
    command,
    escalateTo,
    allow: { kind: APPROVAL_ACTION, id, decision: 'allow' },
    reject: { kind: APPROVAL_ACTION, id, decision: 'reject' },
    // Offered only where this call actually asked to be raised: a button that
    // opens the session has no business on a card about an ordinary tool.
    ...escalateTo === undefined
      ? {}
      : { always: { kind: APPROVAL_ACTION, id, decision: 'allow', always: true } satisfies ApprovalActionValue },
  })
}

/**
 * Build the static replacement card shown after an approval settles.
 * @param toolName - the tool the question was about.
 * @param outcome - the closed decision.
 * @param decidedBy - who pressed, when a person did. Named rather than
 * withheld: with approvals open to a room, the room should see whose press
 * granted the escalation.
 * @param decidedElsewhere - whether another surface answered instead, in which
 * case there is no press here to name.
 * @returns a Feishu card object for `updateCard`.
 */
function settledCard(
  toolName: string,
  outcome: HostApprovalOutcome,
  decidedBy?: string,
  decidedElsewhere?: boolean,
): object {
  return buildSettledApprovalCard({
    toolName,
    outcome,
    ...decidedBy === undefined ? {} : { decidedBy },
    ...decidedElsewhere === true ? { decidedElsewhere: true } : {},
  })
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
 * How much of one form submission a question card will carry into an answer.
 *
 * The chosen set arrives beside the button's own value, so its size is the
 * platform's and its strings are whoever submitted them: a set far larger than
 * the options the model offered, or one entry long enough to make the settled
 * card oversized, buys nothing and can cost the click its response. Bounded
 * rather than validated: a position past the offered options is already refused
 * by the store, so the only thing to keep out here is bulk.
 */
const MAX_QUESTION_SUBMISSIONS = 64

/** The longest one submitted position is read as. A position is a small integer. */
const MAX_QUESTION_FIELD_CHARS = 12

/**
 * How many per-key entries one bridge remembers for its own bookkeeping.
 *
 * The sets and caches below exist to say a thing ONCE per key — a `.gitignore`
 * hint per directory, a bot's identity per chat, one workspace lookup per
 * directory — and a process serving a busy tenant for months would otherwise
 * accumulate one entry per key for its whole life. The cap is far above any
 * working set; a "said once" set that reaches it is cleared, which costs at most
 * a repeated notice and never a wrong answer, and the lookup cache evicts its
 * oldest entry, which costs a re-resolve.
 */
const KEYED_STATE_MAX = 512

/**
 * Remember one key in a "said once" set, keeping the set bounded.
 * @param keys - the set of keys already announced.
 * @param key - the key to remember.
 */
function rememberOnce(keys: Set<string>, key: string): void {
  if (keys.size >= KEYED_STATE_MAX) keys.clear()
  keys.add(key)
}

/**
 * The longest speaker name one group message carries into the model's prompt.
 *
 * A display name is its owner's own text and rides the prompt as a line prefix,
 * so it is folded to one bounded line: a name carrying a newline would add a
 * line to the prompt and let its owner put words in another speaker's mouth,
 * which is the misattribution the transport's batch window is closed to prevent.
 */
const SPEAKER_LABEL_MAX_CHARS = 64

/** The longest decider name a settled card records. */
const DECIDER_NAME_MAX_CHARS = 64

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
 * One host question, in the shape this channel's card machinery takes.
 *
 * The host's `detail` and its presentation `intent` have no card affordance
 * here, so a question carrying either is shown as its own text and options — the
 * tool that raises them is shadowed by this channel rather than answered through
 * the waterfall, so neither reaches this path in a composed deployment.
 * @param item - one question of the host's request.
 * @returns the question to hand the card store.
 */
function askedQuestionOf(item: HostUserQuestionItem): AskedQuestion {
  return {
    id: item.id,
    question: item.question,
    ...item.header === undefined ? {} : { header: item.header },
    ...item.options === undefined ? {} : {
      options: item.options.map(option => ({
        label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      })),
    },
    ...item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect },
  }
}

/**
 * Compose the parts of a chat agent's world this channel owns: the tools it
 * must not call, the tools this channel adds, and the prompt sentence that
 * tells the model what to do instead. Every registration is scoped to this one
 * agent.
 * @param agentCtx - the agent's scope context, inside creation `setup`.
 * @param config - resolved plugin configuration.
 * @param planReview - how a plan is reviewed in this agent's chat, when it can be.
 * @param sendFiles - how an artifact reaches this agent's chat, when it may.
 * @param self - the bot account this agent speaks as.
 */
function composeChatAgent(
  agentCtx: Context,
  config: ResolvedConfig,
  planReview: PlanReviewPorts | undefined,
  sendFiles: SendFilePorts | undefined,
  self: BotSelf,
): void {
  const tools = agentCtx.get('tools') as HostTools | undefined
  const denied = new Set(config.denyTools)

  // The host's own `ask_user_question` is NOT shadowed. Its answer used to have
  // to come from whichever UI claimed the single `userQuestions` provider, so a
  // chat whose human was right here replaced the tool to answer it locally. The
  // bridge now answers `user-questions/request` instead, which is the same
  // question raised once for every presentation: the model keeps the tool the
  // deployment composed, the Web app keeps its panel, and this channel adds a
  // card beside it rather than in place of it. Shadowing here would put the tool
  // back to one answerer and take the panel away from the browser.
  //
  // A deployment that denies the name still denies it through the guard below,
  // and that refusal is what keeps a model from asking where nobody is watching.
  if (denied.has(QUESTION_TOOL)) agentCtx.logger.warn(
    '%s is denied by configuration: questions in this channel have no card and no panel',
    QUESTION_TOOL,
  )

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
    ? `${speakerLabel(msg)}: ${msg.content}`
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
 * The speaker label one group message carries into the model's prompt.
 *
 * A member sets their own display name, so it is folded to one bounded line
 * before it rides the text: whitespace runs (newlines included) and control
 * characters collapse to a single space, the label is capped, and a name that
 * leaves nothing usable falls back to the open id — which is the one fact about
 * the speaker that is not theirs to write.
 * @param msg - the inbound message.
 * @returns the label, never empty.
 */
function speakerLabel(msg: NormalizedMessage): string {
  const name = (msg.senderName ?? '').replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim()
  // Cut by code point, so a name of emoji or CJK extension characters is not
  // split into a lone surrogate on its way into the prompt.
  const points = [...name]
  const bounded = points.length <= SPEAKER_LABEL_MAX_CHARS
    ? name
    : `${points.slice(0, SPEAKER_LABEL_MAX_CHARS - 1).join('')}…`
  return bounded === '' ? msg.senderId : bounded
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
  startupNotices: readonly string[] = [],
): void {
  /**
   * The channel's durable diagnostic sink, when the deployment named a file.
   *
   * Absent means the terminal stays the only record, which is the previous
   * behaviour — a report about a short card is then readable only while the
   * window that ran the bot is still open.
   */
  const diag: DiagSink = config.diagnosticsFile === undefined
    ? () => {}
    : createFileDiag(
      {
        file: config.diagnosticsFile,
        ...config.cwd === undefined ? {} : { cwd: config.cwd },
        level: config.diagnosticsLevel,
      },
      reason => notify(reason),
    )
  /**
   * An operator line that also reaches the diagnostic file.
   *
   * Managed state that could not be persisted used to be reported to the
   * terminal alone, which is the one record nobody reads after the fact: a
   * deployment whose session state silently stopped being durable left nothing
   * in this file to say so.
   */
  const report = (line: string): void => {
    notify(line)
    diag('warn', line)
  }
  // Why managed state will not be durable, when the deployment said so during
  // bootstrap — before this file existed to hear it.
  for (const line of startupNotices) report(line)
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
  const chatWorkspaces = new ChatWorkspaces({
    defaultPath: defaultCwd,
    entries: config.chatWorkspaces,
    roots: config.workspaceRoots,
    persist: persistState,
    report,
    // Every session id this row derives carries its own prefix, so two bots
    // invited to one group drive two agents rather than fighting over one.
    sessionPrefix: instanceIdentity(config.instance).sessionPrefix,
    // Read-only: nothing advances the counter any more, but a conversation the
    // old `/new` moved is still on its `--e<N>` session, and that id is the
    // only pointer to the thread it is in.
    epochOf: baseId => legacyEpochOf(config.chatEpochs, baseId),
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
    report,
  })

  /**
   * Which session each conversation-and-directory currently runs, when it was
   * told at all: `/sessions` points it at a session that already exists, and
   * `/new` points it at an id minted for the occasion. Keyed by the anchor id,
   * so each directory keeps its own thread and a `/cd` back returns to the
   * session that directory was left on.
   */
  const sessionPointers = new ChatSessionPointers({
    entries: config.chatSessions,
    persist: persistState,
    report,
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
  /**
   * The id one conversation derives at the directory it is in, before any
   * suffix. What a session minted for that conversation is minted under, and
   * what its pointer is keyed by — which is what keeps one directory's thread
   * untouched by starting over in another.
   * @param key - the conversation key.
   * @returns the anchor id.
   */
  const anchorOf = (key: string): string => chatWorkspaces.baseSessionIdFor(key)

  /**
   * The session one conversation is on: its pointer, or what it derives to.
   *
   * The one answer to that question, because every caller that answered it
   * itself was one edit away from answering it differently — and a caller that
   * reads the derived id while the conversation is on a pointed-at one reads
   * another session's state, or writes to it.
   * @param key - the conversation key.
   * @returns the session id in force right now.
   */
  const sessionIdOf = (key: string): string =>
    sessionPointers.pointerFor(anchorOf(key)) ?? chatWorkspaces.sessionIdFor(key)

  /**
   * Adopt pointers recorded against a bare conversation key onto its anchor.
   *
   * Before the pointer was keyed by anchor, `/sessions` recorded it against the
   * conversation key and `/cd` cleared it, so one stored entry served whichever
   * directory the chat happened to be in. Re-keying keeps a conversation on the
   * session it was already continuing and retires the old entry — which is also
   * what stops that entry from following the chat into another directory.
   * `set` records in memory before it awaits storage, so the moves are visible
   * to the first message; only the writes are in flight.
   */
  const adoptLegacyPointers = (): Promise<unknown>[] => {
    const writes: Promise<unknown>[] = []
    try {
      for (const [key, sessionId] of sessionPointers.snapshot()) {
        // An anchor carries the channel's session prefix; a bare conversation key
        // does not, so the two formats are told apart without guessing.
        if (key.startsWith(SESSION_PREFIX)) continue
        writes.push(sessionPointers.set(anchorOf(key), sessionId))
        writes.push(sessionPointers.set(key, undefined))
      }
    } catch (error: unknown) {
      // A stored entry this code cannot read costs the migration, never the
      // installation: this runs inside `installBridge`, where a synchronous
      // throw leaves a connected transport with no handlers and a chat that
      // answers nothing.
      report(`lark-channel: migrating the stored session pointers failed: ${failureDetail(error)}`)
    }
    return writes
  }
  void Promise.all(adoptLegacyPointers()).catch((error: unknown) => {
    report(`lark-channel: adopting the stored session pointers failed: ${failureDetail(error)}`)
  })

  const sessionIdForKey = (key: string): string => {
    const id = sessionIdOf(key)
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
      // Bounded: the oldest lookup is the one dropped, and dropping it costs a
      // re-resolve rather than a wrong answer.
      if (workspaceRecords.size >= KEYED_STATE_MAX) {
        const oldest = workspaceRecords.keys().next().value
        if (oldest !== undefined) workspaceRecords.delete(oldest)
      }
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

  /**
   * Point one session's output at the message it is answering.
   *
   * Both consumers move together or not at all: the renderer carries the
   * turn's words and this map carries its files, and a turn whose reply lands
   * under the ask while its attachment lands at the bottom of the chat is the
   * bug that having two of them invites.
   * @param sessionId - the session being aimed.
   * @param binding - that session's renderer.
   * @param target - the message to answer, or undefined to stop aiming.
   */
  const aimAt = (sessionId: string, binding: ChatBinding, target: ReplyTarget | undefined): void => {
    binding.renderer.aim(target)
    if (target === undefined) aimBySession.delete(sessionId)
    else aimBySession.set(sessionId, target)
  }

  /** Open intent-confirmation questions, and the two ways they get answered. */
  const questions = new ChatQuestions({
    send: async (chatId, card) => (await port.send(chatId, { card })).messageId,
    update: async (messageId, card) => { await port.updateCard(messageId, card) },
    report: notify,
    // The approver rule a question that GRANTS something faces. Read through
    // `authorization` at press time, so a deployment that narrowed approvals
    // narrows the plan review with the same list — and a deployment that named
    // no approvers keeps the ordinary rule, where whoever may drive the chat may
    // answer it. The chat itself is already checked by the store.
    refuseApprover: click => refuseApproverOnly(authorization, click),
  })

  /**
   * One structured-question batch, offered on both surfaces at once.
   *
   * The chat card and the answerer behind this listener — the Web app's panel,
   * in the deployment this was built for — are two presentations of the SAME
   * request, so neither takes the question away from the other: whichever
   * answer arrives first is the answer the tool receives.
   *
   * The trailing answerer REJECTS instead of resolving a fail-closed outcome,
   * which is where this differs from an approval. A deployment with no browser
   * attached therefore throws rather than handing back something to compare, and
   * that branch has to drop out of the race: treating the throw as an answer
   * would refuse a question the card on screen can still take. Dropping out is
   * expressed as a promise that never settles, the same shape the approval
   * listener uses for its fail-closed value.
   *
   * Racing is also why the batch may stop early: see {@link askInChat}.
   * @param binding - the chat the question is offered in.
   * @param sessionId - the session the question belongs to.
   * @param request - the host's request, as the tool raised it.
   * @param next - the answerer chain behind this listener.
   * @returns the first answer to arrive.
   */
  const askOnBothSurfaces = async (
    binding: ChatBinding,
    sessionId: string,
    request: HostUserQuestionRequest,
    next: () => Promise<HostUserQuestionAnswer>,
  ): Promise<HostUserQuestionAnswer> => {
    const run: ChatQuestionBatch = {
      sessionId,
      // The batch's own membership: a settlement this channel reports back is
      // matched against the cards this batch opened, never against every card
      // the conversation holds.
      questionIds: request.questions.map(item => item.id),
      decided: false,
    }
    const viaChat = askInChat(run, binding, request)
    // Rejection is the chain reporting that nobody claimed the question, so the
    // Web branch drops out rather than failing the whole ask.
    const viaWeb = next().then(
      answer => ({ from: 'web' as const, answer }),
      () => NEVER_SETTLES,
    )
    const winner = await Promise.race([
      viaChat.then(answer => ({ from: 'chat' as const, answer })),
      viaWeb,
    ])
    if (winner.from === 'chat') return winner.answer
    // The Web app answered first. Retire the chat's cards for this batch, saying
    // where the answer came from instead of waiting for a press that would be
    // discarded.
    questions.settleElsewhere(run, winner.answer.answers)
    return winner.answer
  }

  /**
   * Ask this chat one batch, one card at a time.
   *
   * Sequential on purpose: two open cards in one conversation would leave a
   * typed answer ambiguous. The batch stops the moment another surface claims
   * it — the Web panel answers all questions at once, so asking the next one
   * would leave a card with nothing left to decide.
   * @param run - the batch's own state, shared with the retirement path.
   * @param binding - the chat the cards go to.
   * @param request - the host's request.
   * @returns one answer per question actually asked.
   */
  const askInChat = async (
    run: ChatQuestionBatch,
    binding: ChatBinding,
    request: HostUserQuestionRequest,
  ): Promise<HostUserQuestionAnswer> => {
    const answers: QuestionAnswer[] = []
    for (const item of request.questions) {
      if (run.decided) break
      answers.push(await questions.ask({
        sessionId: run.sessionId,
        chatId: binding.chatId,
        question: askedQuestionOf(item),
        ...request.signal === undefined ? {} : { signal: request.signal },
      }))
    }
    return { answers }
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
        // Approving a plan leaves plan mode and starts executing it, so the
        // press is a grant rather than an answer: a deployment that named
        // approvers has said who may make it.
        requiresApprover: true,
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
    // the view that can describe this agent's calls. A host that lends that key
    // as a revision lease keeps the lease here: the presenter below reads
    // through it for as long as this composition lives, so it is given back
    // with the plugin fiber rather than at the end of this call.
    const standing = presets === undefined || presetId === undefined
      ? undefined
      : await standingScopeFor(presets, presetId)
    const releaseStanding = standing?.[Symbol.asyncDispose]
    if (releaseStanding !== undefined) ctx.effect(() => () => releaseStanding())
    return {
      ...presetId === undefined ? {} : { presetId },
      presentCall: createCallPresenter(ctx.get('tools') as HostTools | undefined, standing?.key),
      setup: async (agentCtx: Context) => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
        composeChatAgent(agentCtx, config, planReview, sendFilePorts, botSelf())
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

  /**
   * Why the last resume of one session id was rejected.
   *
   * The ladder's `resume` can only return a handle or throw, so the rejection
   * travels to the `create` rung — the one place a pointed-at id lands and the
   * only place with a human to tell — through this map rather than through the
   * signature. Entries are removed as they are reported, and a minted id never
   * gets one: `/new` names a session nothing has run, so its rejection is the
   * ordinary answer rather than a failure worth keeping.
   */
  const resumeFailure = new Map<string, string>()

  /**
   * Refuse one id the host has archived, in the chat's own words.
   *
   * Archiving is another surface's deliberate decision — the workspace registry
   * hides such a session from every grouping surface, and the host's archive
   * gate rejects every step it proposes. Restoring it here would overrule that
   * decision silently, to a chat that asked for nothing of the kind, and
   * opening an agent under it anyway would write over the session being
   * refused; so the refusal is terminal and reported instead.
   *
   * Asked by the ladder's admission point on every acquisition AND by the
   * resume rung. The rung alone is not enough: it is never reached for a
   * conversation whose binding is already live, and that is precisely the case
   * this channel created by driving a session another surface then archived.
   * @param sessionId - the session about to be driven.
   * @throws {SessionRefusedError} always, when the id is archived.
   */
  const refuseArchived = (sessionId: string): void => {
    if (!archivedSessions().has(sessionId)) return
    report(`lark-channel: refused the archived session ${sessionId}`)
    throw new SessionRefusedError(ARCHIVED_SESSION_NOTICE.zh)
  }

  const ladder: SessionLadder = {
    admit: (sessionId) => { refuseArchived(sessionId) },
    lookup: (sessionId) => {
      const agent = agents.get(sessionId)
      // An agent another owner published is theirs to dispose.
      return agent === undefined ? undefined : { agent, dispose: () => Promise.resolve() }
    },
    resume: async (sessionId) => {
      // The walk's own guard, narrower than admission: an archive that landed
      // while this acquisition was already under way is caught here, before a
      // log is opened and an agent made under an id the gate will refuse.
      refuseArchived(sessionId)
      const composition = await compositionFor(sessionId)
      try {
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
      } catch (error: unknown) {
        // Kept for the create rung, which is where a pointed-at id lands and the
        // only place that can report the reason to a human. The registry's
        // rejection is otherwise lost: this signature returns a handle, not a
        // result, so the ladder's next rung sees only that it failed.
        //
        // A minted id is expected to be absent — `/new` names a session nothing
        // has run — so its rejection is not a failure worth keeping.
        if (!isFreshSessionId(sessionId)) resumeFailure.set(sessionId, failureDetail(error))
        throw error
      }
    },
    create: async (sessionId) => {
      // A pointed-at session that was NOT minted here is one this conversation
      // was told to CONTINUE, so it exists — reaching this rung under it means
      // the resume failed, and creating one would start an empty session under
      // the id of the conversation someone asked to carry on with. The pointer
      // is retired so the next message lands on this conversation's own session
      // rather than failing the same way forever.
      const pointing = sessionPointers.anchorsPointingAt(sessionId)
      if (pointing.length > 0 && !isFreshSessionId(sessionId)) {
        for (const anchor of pointing) await sessionPointers.set(anchor, undefined)
        // The resume rejection is the ONLY account of why this failed, and it
        // used to be dropped here in favour of a guess about a corrupt log —
        // which sent an operator looking for damage that was not there when the
        // real cause was a session this surface may not open at all.
        const reason = resumeFailure.get(sessionId) ?? 'the session could not be loaded'
        resumeFailure.delete(sessionId)
        diag('warn', `lark-channel: resume failed for ${sessionId}: ${reason}`)
        notify(`lark-channel: ${sessionId} could not be resumed (${reason}); retired the pointer held by ${pointing.join(', ')}`)
        throw new Error(`这个会话在这里打不开：${reason}\n已回到本聊天自己的会话，再发一条消息即可继续。`)
      }
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
    // the ladder's handled failures are reported rather than swallowed — to the
    // host's log, and to this channel's own file, which is the record that
    // outlives the window that ran the bot.
    report: (line) => {
      ctx.logger.info(line)
      report(line)
    },
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
   * In-flight and settled binding creations, one per (chat, session). A plain
   * check-then-create raced two concurrent callers into two renderers, one of
   * them orphaned but still aimed at — the same promise-cache pattern the
   * compositions use makes creation single-flight. A model switch resumes the
   * same session id and REUSES its binding on purpose: the renderer presents
   * calls through the preset's view, which a model change does not alter.
   */
  const bindings = new Map<string, Promise<ChatBinding>>()
  /** One chat's watch on one session, as the key of the state that surrounds it. */
  const watchKey = (chatId: string, sessionId: string): string => `${chatId}\u0000${sessionId}`
  /**
   * Binding generation per (chat, session), advanced when that chat stops
   * watching that session.
   *
   * Creation is asynchronous, so a renderer still composing when the
   * conversation moves on would claim the dispatch slot afterwards and start
   * rendering a session the chat has already left. The creation carries the
   * generation it started under; a mismatch settles what it opened and claims
   * nothing.
   */
  const bindingGenerations = new Map<string, number>()
  const bindingFor = (
    sessionId: string,
    chat: { readonly chatId: string; readonly chatType: string },
  ): Promise<ChatBinding> => {
    const watch = watchKey(chat.chatId, sessionId)
    let pending = bindings.get(watch)
    if (pending === undefined) {
      const generation = bindingGenerations.get(watch) ?? 0
      pending = (async (): Promise<ChatBinding> => {
        const { presentCall } = await compositionFor(sessionId)
        // The renderer is the composition's last reader; dropping it here leaves
        // the next conversation bound on this id to read the roster fresh.
        compositions.delete(sessionId)
        const binding: ChatBinding = {
          chatId: chat.chatId,
          chatType: chat.chatType,
          renderer: renderFor(chat.chatId, presentCall),
        }
        if (unwound) {
          // The fiber unwound while this was composing; nothing will ever
          // dispatch to this renderer, so it must not hold an open card.
          void binding.renderer.close()
          throw new Error('lark-channel: bridge unwound while binding')
        }
        if ((bindingGenerations.get(watch) ?? 0) !== generation) {
          // The conversation left this session while its renderer was composing:
          // the chat has already stopped watching it, so this one settles its
          // card and claims nothing.
          void binding.renderer.close()
          return binding
        }
        bySession.set(sessionId, binding)
        return binding
      })()
      bindings.set(watch, pending)
      pending.catch(() => {
        // Only the failure that still owns the slot clears it: a stale
        // rejection must not evict a successor's live promise.
        if (bindings.get(watch) === pending) bindings.delete(watch)
      })
    }
    return pending
  }

  /**
   * Stop one chat watching the session its conversation has left.
   *
   * A binding is what routes a session's events into a chat, and it used to
   * outlive the conversation's own stay: the chat that switched away kept
   * rendering the session it left — its stream, its approvals, its questions —
   * beside the one it moved to, so one chat carried two conversations at once.
   * This is that half of a binding's life, and it runs where the conversation's
   * session identity changes and nowhere else: `/model` resumes the SAME id and
   * reuses its renderer on purpose, so releasing an agent is not by itself a
   * reason to stop watching.
   *
   * The session itself keeps running. It belongs to whoever opened it — a
   * browser, a schedule — and only that owner decides when it stops.
   * @param key - the conversation that moved, resolved fresh so a move that
   * lands on the same session leaves the renderer where it is.
   * @param chatId - the chat whose renderer goes away.
   * @param left - the session id the conversation was on before the move.
   */
  const stopWatching = async (key: string, chatId: string, left: string): Promise<void> => {
    // Not a change of session: `/cd` to the directory the conversation is
    // already in, or a press on the row it is already on.
    if (left === sessionIdOf(key)) return
    const watch = watchKey(chatId, left)
    bindingGenerations.set(watch, (bindingGenerations.get(watch) ?? 0) + 1)
    // Dropped from the creation cache as well, so a later `bindingFor` on this
    // pair builds a renderer of its own instead of handing back this one.
    const abandoned = bindings.get(watch)
    bindings.delete(watch)
    // The bumped generation is read by exactly one party: a creation that was
    // already in flight for this pair, which compares it to the number it
    // captured. Once that creation has settled — and no successor has taken the
    // slot since, whose own baseline is the bumped number — the entry answers
    // nothing, so it is dropped rather than kept for the process's lifetime.
    const drop = (): void => {
      if (bindings.get(watch) === undefined) bindingGenerations.delete(watch)
    }
    if (abandoned === undefined) drop()
    else void abandoned.then(drop, drop)
    const binding = bySession.get(left)
    // Another chat's watch on the same session is that chat's to give up.
    if (binding === undefined || binding.chatId !== chatId) return
    // Out of the dispatch table BEFORE the card settles: an event that lands
    // while the card is closing must find nobody home.
    bySession.delete(left)
    await binding.renderer.close()
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
      { name: WS_COMMAND, description: '选择工作区，点一行即切换' },
      { name: GET_COMMAND, description: '把工作区里的文件发到聊天' },
      { name: MODEL_COMMAND, description: '查看或切换本会话模型' },
      { name: STATUS_COMMAND, description: '查看本会话状态' },
      { name: NEW_COMMAND, description: '开一个新会话，清空上下文' },
      { name: SESSIONS_COMMAND, description: '列出可接续的会话，点一行就切过去' },
      { name: HELP_COMMAND, description: '显示可用命令' },
    ]
    void syncSlashPanel(port, desired, notify).then(({ added, removed }) => {
      if (added.length > 0) notify(`lark-channel: registered /${added.join(', /')} on the bot's slash panel`)
      if (removed.length > 0) notify(`lark-channel: removed /${removed.join(', /')} from the bot's slash panel`)
    })
  }

  /** What the chat is told once a session has been opened up. */
  const PRESET_OPENED = '🔓 本会话已切到 danger-full-access：不再沙箱、不再弹审批卡。'
    + '\n用 `/permission` 可以随时切回。'

  /**
   * What the chat is told when the switch has to wait for a running turn.
   * @param preset - the preset that will be switched to.
   * @returns the message text.
   */
  const presetHeldText = (preset: string): string =>
    `🔓 已记下：当前这轮任务结束后切到 ${preset}。`
    + '\n（会话日志同一时刻只能有一个写入者，所以不在任务中途改。）'

  /**
   * What a group is told while its `/get` waits for the approval card.
   *
   * Named the file, because the sender typed a path one line ago and the room
   * is the party being asked: without the name, a card that arrives a moment
   * later has nothing tying it to the command.
   * @param fileName - the cleared file's name.
   * @returns the message text.
   */
  const getHeldText = (fileName: string): string =>
    `📎 已就 \`${fileName}\` 发起审批：群里发文件要房间同意，通过后就会发出来。`

  /**
   * What a group is told when its `/get` cannot even be offered yet.
   *
   * The cap is per chat and counts everything outstanding in it — the model's
   * own offers and this room's own commands alike — so the sentence names the
   * one thing a person can act on: decide what is already waiting.
   * @returns the message text.
   */
  const getBusyText = (): string =>
    `⏳ 这个群已经有 ${MAX_PENDING_FILE_SENDS} 个文件在等审批，先决定完再发。`

  /** What the chat is told when a switch landed. */
  const presetSwitchedText = (preset: string): string =>
    `🔓 已切到 ${preset}。用 \`/permission\` 可以随时切回。`

  /** What the chat is told when the person asking may not make this change. */
  const PRESET_NOT_YOURS = '⚠️ 你无权把本会话切到这个权限预设。'
    + '\n放开沙箱需要审批人权限；切回更安全的预设则不需要。'

  /**
   * What the chat is told when a switch did not happen. Said in the chat and
   * not only as a toast: a toast is gone in a second, while the card it came
   * from stays, and a card left claiming the old preset beside a switch that
   * silently failed is the one outcome nobody can act on.
   * @param preset - the preset that was asked for.
   * @param detail - what went wrong, when the failure carried a reason.
   * @returns the message text.
   */
  const presetFailedText = (preset: string, detail?: string): string =>
    `⚠️ 切换到 ${preset} 失败${detail === undefined ? '' : `：${detail}`}。\n可以再点一次，或用 \`/permission ${preset}\` 直接切。`

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
    const releasedId = sessionIdOf(key)
    return async () => {
      // Cancelled BEFORE the release, and awaited: releasing is what makes an
      // agent idle, and a switch waiting for exactly that would slip through
      // the window and write to a session being disposed. Shut the writing
      // down first, then take the agent away.
      await maintenance.cancel(releasedId)
      await sessions.release(key)
      runningBySession.delete(releasedId)
      callSnapshots.delete(releasedId)
      aimBySession.delete(releasedId)
      // The directory and route this session id was derived for go with it. A
      // later message re-derives both before any ladder rung reads them, so the
      // entries are only stale state here — and keeping them would leave one
      // pair per session id the process ever derived.
      pathBySession.delete(releasedId)
      routeBySession.delete(releasedId)
      questions.cancelSession(releasedId)
    }
  }

  /** Everything `/status` reports, read fresh from channel state. */
  const statusFieldsFor = (subject: ConversationSubject): StatusFields => {
    const sessionId = sessionIdOf(subject.key)
    const override = chatModels.routeFor(subject.key)
    const route = override === undefined ? deploymentRoute() : formatRoute(override)
    // Meters come off the LIVE session: a conversation whose agent has not been
    // built yet has spent nothing, and reading its stored log to say so would
    // load a log to report a zero.
    const live = (ctx.get('agents') as DurableAgentRegistry | undefined)?.get(sessionId)
    const meters = readMeters(projections(), live?.session)
    const pointed = sessionPointers.pointerFor(anchorOf(subject.key))
    return {
      ...meters,
      workspace: chatWorkspaces.pathFor(subject.key),
      workspaceIsDefault: chatWorkspaces.isDefault(subject.key),
      route,
      routeIsDefault: override === undefined,
      sessionId,
      bound: sessions.keyOf(sessionId) !== undefined,
      // A minted session is not a continuation: it has not been created yet, and
      // the card's own `unbound` wording is what says so.
      switched: pointed !== undefined && !isFreshSessionId(pointed),
      running: runningBySession.get(sessionId) === true,
      // Read every time rather than remembered: the archive set is the host's
      // live state, another surface may lift it the moment after this card is
      // drawn, and the card's refresh button is how a reader asks again.
      archived: archivedSessions().has(sessionId),
      pendingApprovals: [...pendingApprovals.values()]
        .filter(pending => pending.chatId === subject.chatId).length,
      version: pluginVersion,
    }
  }

  /**
   * Switch one conversation's preset, from the agent's own idle phase.
   *
   * Every host command appends to the session log, and the log takes one
   * writer. Rather than infer when that is safe — watch `turn/end`, step out
   * of the dispatch, retry on a message the host printed — the switch asks the
   * agent for its idle phase and waits its turn in this conversation's queue.
   * @param sessionId - the conversation's session, which keys the queue.
   * @param agent - the agent to run the command through.
   * @param preset - the preset to switch to.
   * @returns whether it landed, and what the host said when it did not.
   */
  const applyPreset = async (
    sessionId: string,
    agent: HostAgent,
    preset: string,
  ): Promise<PresetOutcome> => {
    const commands = ctx.get('commands') as HostCommands | undefined
    const outcome: PresetOutcome = await maintenance
      .run(sessionId, agent, (signal: AbortSignal) => switchPreset(agent, commands, preset, signal))
      .catch((error: unknown) => error instanceof MaintenanceCancelled
        ? { ok: false, cancelled: true }
        : { ok: false, detail: failureDetail(error) })
    if (outcome.cancelled === true) {
      notify(`lark-channel: the switch to ${preset} was dropped — ${sessionId} moved on before it ran`)
      return outcome
    }
    notify(outcome.ok
      ? `lark-channel: session ${sessionId} switched to preset ${preset}`
      : `lark-channel: preset switch to ${preset} failed: ${outcome.detail ?? 'unknown'}`)
    return outcome
  }

  /**
   * One queue per conversation for the commands this channel issues, each run
   * from the agent's own idle phase. See {@link createMaintenanceQueue}.
   */
  const maintenance = createMaintenanceQueue()

  /**
   * Work that outlives the call that started it: a click is answered in
   * milliseconds while its switch opens an agent, waits for an idle phase, and
   * repaints a card. Held here so disposal WAITS for it — otherwise a bridge
   * that has unwound is still sending into a transport it no longer owns.
   */
  const background = new Set<Promise<unknown>>()

  /**
   * Run one piece of that work, tracked.
   * @param work - the promise to keep until it settles.
   */
  const spawn = (work: Promise<unknown>): void => {
    // Caught here rather than trusted to each caller: nothing awaits this
    // promise until disposal, so a rejection would sit unhandled — which this
    // runtime turns into a process-level fault, taking every chat down for one
    // failed card repaint. Every path spawned today handles its own failures;
    // this is what keeps that from being a requirement nobody states.
    const tracked = work
      .catch((error: unknown) => { notify(`lark-channel: background work failed: ${failureDetail(error)}`) })
      .finally(() => { background.delete(tracked) })
    background.add(tracked)
  }

  /**
   * Wait for the background work to run out, including whatever it starts on
   * its way down — a switch that failed still has a chat to tell, and a
   * settled card still has a repaint to send. Bounded, because disposal has to
   * end: a set that will not empty is reported rather than waited on forever.
   * @returns when nothing is left, or when the rounds run out.
   */
  const drainBackground = async (): Promise<void> => {
    // A deadline, not just a round count: rounds bound how many times this
    // waits, and one `allSettled` can wait forever on a single task that never
    // settles. Disposal has to end — a fiber that will not unwind is worse for
    // the process than a card that never got repainted.
    const deadline = new Promise<'timeout'>(resolve => {
      const timer = setTimeout(() => { resolve('timeout') }, BACKGROUND_DRAIN_MS)
      timer.unref?.()
    })
    for (let round = 0; round < BACKGROUND_DRAIN_ROUNDS && background.size > 0; round += 1) {
      if (await Promise.race([Promise.allSettled([...background]).then(() => 'done' as const), deadline]) === 'timeout') {
        break
      }
    }
    if (background.size > 0) {
      notify(`lark-channel: ${background.size} background tasks did not settle before disposal`)
    }
  }

  /** The deployment's preset table, when composed; what each preset DOES. */
  const presetTable = (): HostPermissionPresets | undefined =>
    ctx.get('permissionPresets') as HostPermissionPresets | undefined

  /** The projection registry every host-owned read here goes through. */
  const projections = (): HostSessionProjections | undefined =>
    ctx.get('sessionProjections') as HostSessionProjections | undefined

  /**
   * The permission preset one conversation runs under, when there is a live
   * agent to ask through. A conversation with no agent yet has no session to
   * carry a preset, so the row is simply absent rather than guessed.
   * @param subject - the conversation.
   * @returns the preset field, or nothing.
   */
  const presetOf = (subject: ConversationSubject): { preset?: PresetOption } => {
    const agent = sessions.agentFor(sessionIdOf(subject.key))
    if (agent === undefined) return {}
    return { ...currentPreset(agent) === undefined ? {} : { preset: currentPreset(agent)! } }
  }

  /**
   * The preset one conversation runs under, with what it actually does.
   *
   * Read back rather than remembered: what a card should say is what the
   * session ended up on, which is not necessarily the name a button carried —
   * the host resolves its own table, and a deployment can define two names
   * onto one bundle.
   * @param agent - the conversation's agent.
   * @returns the option in force, or undefined when nothing published one.
   */
  const currentPreset = (agent: HostAgent | undefined): PresetOption | undefined => {
    const state = readPresets(projections(), agent, presetTable())
    if (state.current === undefined) return undefined
    return state.available.find(option => option.value === state.current)
      ?? { value: state.current, name: state.current }
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
          rememberOnce(reportedBots, seen)
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
          rememberOnce(reportedBots, seen)
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
      || channelCommand === SESSIONS_COMMAND
    ) {
      try {
        const key = conversation
        // Answered before the release below is even derived: `/get` does not
        // change this conversation's identity — it reads one file out of the
        // directory the conversation already runs in — so releasing its agent
        // would throw away a live context to send an attachment.
        if (channelCommand === GET_COMMAND) {
          const workspace = chatWorkspaces.pathFor(key)
          // A group's `/get` holds the same slot the model's send does, and it
          // is taken BEFORE the read: the bytes are read before anyone is asked,
          // so a room with its cards already outstanding refuses the next
          // command without spending a read or another buffer — which is
          // exactly the bound `deliverFile` keeps for the model's own sends.
          const gated = msg.chatType !== 'p2p'
          if (gated && !holdFileSend(msg.chatId)) {
            await port.send(msg.chatId, { text: getBusyText() }).catch(reportSendFailure)
            return
          }
          // Released by whoever ends up holding the bytes: this arm releases on
          // every early return, and the gated arm hands the claim to the spawned
          // task, which releases it when the room is done with it.
          let held = gated
          try {
            // Read and cleared BEFORE anything is offered, so a refusal and a
            // read failure both answer immediately — and so the bytes a room is
            // asked about are the bytes that leave, exactly as in `deliverFile`.
            const target = await readGetTarget(msg.content, workspace, config.maxSendFileBytes)
            if (!target.ok) {
              await port.send(msg.chatId, { markdown: target.reply }).catch(reportSendFailure)
              return
            }
            // A direct message goes straight out (ADR 0002): its only reader is
            // the person authorized to drive this agent, who could have asked
            // for the contents on screen instead. A GROUP does not: the bytes
            // land in a room, and every other file that reaches a room passes an
            // approval card — so a human's `/get` takes the gate the model's
            // `send_file` takes, and the room decides.
            //
            // The gate is NOT awaited here. This runs inside the transport's
            // per-chat queue, and a card click arrives through that same queue
            // (the SDK serializes a chat's messages and its card actions on one
            // tail), so awaiting it would deadlock the very press it waits for.
            if (gated) {
              // The room asked is the room the command came from, never the chat
              // the session happens to be bound to: a conversation can be adopted
              // by another chat through `/sessions`, and sending a file the first
              // room asked for into the second would move its contents across
              // rooms with nobody saying so.
              const chat: GateChat = { chatId: msg.chatId, chatType: msg.chatType }
              held = false
              spawn(offerGetInGroup(chat, target.file, target.bytes, msg)
                .finally(() => { releaseFileSend(chat.chatId) }))
              await port.send(msg.chatId, { text: getHeldText(target.file.fileName) }).catch(reportSendFailure)
              return
            }
            await sendGetFile(
              { chatId: msg.chatId, chatType: msg.chatType },
              target.file,
              target.bytes,
              msg,
            )
            return
          } finally {
            if (held) releaseFileSend(msg.chatId)
          }
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
        // The session the conversation is on BEFORE the command moves it, for
        // the binding that has to go with it. Captured here for the same reason
        // as the release below: `/cd` and `/new` both re-derive the id, and the
        // id that has to be let go of is the old one.
        const left = sessionIdOf(key)
        const release = releaseFor(key)
        const subject = subjectOf(msg)
        let reply: { markdown: string } | { card: object }
        if (channelCommand === CD_COMMAND) {
          // A directory change moves the conversation to another directory's
          // thread, which is a session change: the pointer of the directory
          // being left stays where it is — so a `/cd` back returns to the
          // session that directory was on — and the new directory resolves to
          // its own pointer or its own derived session. It rides the same
          // callback as the release, which the command runs only where the
          // directory ACTUALLY moved.
          const moved = async (): Promise<void> => {
            await release()
            await stopWatching(key, msg.chatId, left)
          }
          reply = { markdown: await runWorkspaceCommand(channelCommand, msg.content, key, chatWorkspaces, moved) }
        } else if (channelCommand === WS_COMMAND) {
          // Answered with the picker's first page. Reading the list and drawing
          // it touch no session log, so this stays far inside the command's own
          // budget — and a press on a row is what performs the switch, through
          // the same `switch()` a typed `/cd` reaches.
          reply = { card: workspacePicker(subject).card }
        } else if (channelCommand === NEW_COMMAND) {
          // A session that has never existed, which is the opposite of
          // continuing one: the id is minted, not derived, so nothing the
          // conversation already ran can be handed back as "new".
          const moved = async (): Promise<void> => {
            await release()
            await stopWatching(key, msg.chatId, left)
          }
          const started = await runNewCommand({
            anchorId: anchorOf(key),
            pointer: sessionPointers,
            release: moved,
            report,
          })
          reply = { markdown: started.reply }
        } else if (channelCommand === MODEL_COMMAND) {
          reply = await runModelCommand(msg.content, subject, chatModels, {
            catalog: modelCatalog,
            deploymentRoute,
            release,
          })
        } else if (channelCommand === SESSIONS_COMMAND) {
          reply = { card: await sessionPicker(subject, msg.content) }
        } else {
          reply = { card: renderStatusCard({ ...statusFieldsFor(subject), ...presetOf(subject) }, subject) }
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
        if (commandName(msg.content) === PERMISSION_COMMAND) {
          await runPermissionCommand(msg, binding.chatId, opened.handle.agent)
          return
        }
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
        if (inbound.landed.length > 0) rememberOnce(hintedWorkspaces, workspace)
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
      spawn(port.updateCard(pending.messageId, pending.paint(outcome, decidedBy)).catch(reportSendFailure))
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
      spawn(port
        .updateCard(sent.messageId, pending.paint(pending.outcome ?? 'cancelled', pending.decidedBy))
        .catch(reportSendFailure))
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
      agent: request.agent,
      call,
      paint: (outcome, decidedBy) => settledCard(request.toolName, outcome, decidedBy, pending.decidedElsewhere),
      state: 'sending',
      settle: resolveOutcome,
      removeAbort: () => { request.signal?.removeEventListener('abort', onAbort) },
    }
    pendingApprovals.set(id, pending)
    request.signal?.addEventListener('abort', onAbort, { once: true })

    const published = await sendApprovalCard(
      id,
      pending,
      approvalCard(
        request.toolName,
        request.reason,
        call?.arguments,
        id,
        // The host's request names the tool and the reason; the escalation it
        // asks for rides the call's own arguments, which were snapshotted when
        // the question was asked. The button is offered only where the switch
        // it promises can actually happen — a deployment may compose no
        // presets, no `/permission`, or no unconfined one, and a button that
        // grants this call and then fails forever is worse than none.
        canOpenSession(request.agent) ? requestedEscalation(call?.arguments) : undefined,
      ),
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

    // The card is up, so the question is now live in TWO places: this card, and
    // whatever answerer comes after this listener — the Web app's, in the
    // deployment this was built for. Both are shown and whichever decides first
    // is the answer, so the two are raced rather than ranked. That is the whole
    // point: a person at the keyboard answers where they are, and a person away
    // from it answers from the chat, without either surface taking the decision
    // away from the other.
    //
    // Racing is why `next()` is called at all here, and two consequences come
    // with it, both accepted:
    //  - a deployment with no browser attached leaves the forwarded request
    //    pending on the host, because the gateway settles an undelivered request
    //    only when a client replies or the request's own lifetime ends. It is
    //    released with the agent, so it cannot accumulate past one session.
    //  - the browser keeps its own buttons after the chat answers, since that UI
    //    belongs to the host. Its own settled check makes a later press inert.
    const viaWeb = next().then(
      // 'unavailable' is not a decision: it is the waterfall reporting that no
      // answerer took the question, and the innermost chain resolves with it the
      // moment the chain runs out. Treating it as a winner would let a chat card
      // that is still on screen lose to a chain that declined to answer — the
      // press would be discarded and the tool refused. It drops out instead.
      outcome => outcome === 'unavailable' ? NEVER_SETTLES : { from: 'web' as const, outcome },
      // A Web branch that throws did not decide either, and the card is still
      // live. Dropping out is expressed as a promise that never settles.
      () => NEVER_SETTLES,
    )
    const winner = await Promise.race([
      settled.then(outcome => ({ from: 'chat' as const, outcome })),
      viaWeb,
    ])
    if (winner.from === 'chat') return winner.outcome
    // The Web app decided first. Retire the chat's card, saying where the
    // decision actually came from rather than crediting a press that never
    // happened here. `settleApproval` is idempotent, so an answer that landed
    // in the same tick is left as it stands.
    pending.decidedElsewhere = true
    settleApproval(id, winner.outcome)
    return winner.outcome
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
    binding: GateChat,
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
   * Put one cleared file in the chat, with the failures said in the chat.
   *
   * Shared by `/get`'s two arms so the direct-message path and the group's
   * approved path report a refused upload the same way. The bytes come from the
   * caller's own read, never from a path re-resolved here.
   * @param chat - where the bytes go.
   * @param file - the cleared file.
   * @param bytes - its contents, already read.
   * @param msg - the message the command arrived on, for the reply target.
   */
  const sendGetFile = async (
    chat: GateChat,
    file: OutboundFile,
    bytes: Buffer,
    msg: NormalizedMessage,
  ): Promise<void> => {
    try {
      await port.send(chat.chatId, { file: { source: bytes, fileName: file.fileName } }, replyOptions(replyTargetOf(msg)))
    } catch (error) {
      await port.send(chat.chatId, { markdown: `⚠️ 发送 \`${file.fileName}\` 失败：${failureDetail(error)}` })
        .catch(reportSendFailure)
    }
  }

  /**
   * Ask a room before a human's `/get` puts bytes in it, then send what it allowed.
   *
   * Off the message queue by construction (the caller spawns it): the card is
   * settled by a click that arrives on that same queue, so waiting for it there
   * would be waiting for something this chat cannot deliver.
   *
   * The caller owns the chat's file-send slot for as long as this runs, and
   * releases it when this settles: the buffer carried here is exactly what that
   * bound accounts for, and this function knows nothing about the claim.
   * @param chat - the group to ask.
   * @param file - the cleared file.
   * @param bytes - its contents, read before the room was asked.
   * @param msg - the message the command arrived on, for the reply target.
   */
  const offerGetInGroup = async (
    chat: GateChat,
    file: OutboundFile,
    bytes: Buffer,
    msg: NormalizedMessage,
  ): Promise<void> => {
    const refused = await askFileSend(chat, file, bytes)
    if (refused !== undefined) {
      await port.send(chat.chatId, { text: `⚠️ ${refused}` }).catch(reportSendFailure)
      return
    }
    await sendGetFile(chat, file, bytes, msg)
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
      // answer it, exactly as they could by typing the answer instead. The press
      // still has to come from the chat the card was published to, which the
      // store checks against the chat carried here.
      //
      // A multiple choice arrives as a form submission, whose chosen set the
      // platform delivers beside the button's own value rather than in it.
      const submitted = (evt.action.formValue as Record<string, unknown> | undefined)?.[QUESTION_SELECT]
      const settled = questions.answerByClick(
        choice,
        { chatId: evt.chatId, operatorId: evt.operator.openId },
        Array.isArray(submitted)
          ? submitted
            .slice(0, MAX_QUESTION_SUBMISSIONS)
            .map(entry => String(entry).slice(0, MAX_QUESTION_FIELD_CHARS))
          : [],
      )
      return settled === undefined
        ? { toast: toast('info', TOAST.questionGone) }
        : { toast: toast('success', TOAST.answered), card: { type: 'raw', data: settled } }
    }
    const pick = modelActionValue(evt.action.value)
    if (pick !== undefined) return switchModel(pick, evt)
    const preset = permissionActionValue(evt.action.value)
    if (preset !== undefined) return switchPresetFromCard(preset, evt)
    const session = sessionActionValue(evt.action.value)
    if (session !== undefined) return continueSession(session, evt)
    const workspace = workspaceActionValue(evt.action.value)
    if (workspace !== undefined) return handleWorkspaceAction(workspace, evt)
    const refresh = statusActionValue(evt.action.value)
    if (refresh !== undefined) {
      const refusal = refuseControlClick(refresh, evt)
      if (refusal !== undefined) {
        notify(`lark-channel: rejected a status refresh: ${refusal}`)
        return { toast: toast('error', TOAST.notYours) }
      }
      return {
        toast: toast('success', TOAST.refreshed),
        card: {
          type: 'raw',
          data: renderStatusCard({ ...statusFieldsFor(refresh), ...presetOf(refresh) }, refresh),
        },
      }
    }
    const value = approvalActionValue(evt.action.value)
    if (value === undefined) return undefined
    return decideApproval(value, evt)
  }

  /**
   * Switch this conversation's permission preset from the picker.
   *
   * The conversation is resolved from its KEY, the way a message resolves it:
   * derive the session id it currently maps to, then ask for that session's
   * agent. Looking for a binding whose chat matches instead finds whichever
   * session that chat bound FIRST, and a chat that has run `/new` or `/cd` has
   * long since moved off it — the switch would report "no agent" beside a
   * conversation that plainly has one.
   *
   * Authorization is both gates at once: the control gate because a preset
   * changes this conversation, and the approver gate because a preset decides
   * what every later command may reach, which is a larger grant than any
   * single approval and so cannot pass through a looser check.
   * @param value - the payload the pressed row carried.
   * @param evt - the click.
   * @returns the toast and the repainted picker.
   */
  const switchPresetFromCard = (
    value: PermissionActionValue,
    evt: CardActionEvent,
  ): CardActionResponse => {
    const refusal = refusePresetSwitch(value, { senderId: evt.operator.openId, chatId: evt.chatId }, value.preset)
    if (refusal !== undefined) {
      notify(`lark-channel: rejected a permission switch: ${refusal}`)
      return { toast: toast('error', TOAST.notApprover) }
    }
    // Answer now, switch after. The platform waits seconds for this callback
    // and then stops; the switch opens the conversation's agent, waits for its
    // idle phase and runs a host command, which can take longer than that. A
    // response that arrives late is not shown at all, so a switch that worked
    // looked to the chat like a dead button.
    const sessionId = sessionIdOf(value.key)
    const stage = runningBySession.get(sessionId) === true ? 'held' : 'switching'
    spawn(completeSwitch(value, evt.messageId))
    return {
      toast: toast('info', stage === 'held' ? TOAST.presetQueued : TOAST.presetSwitching),
      // Settled the moment it is asked for, not when it lands: a card with
      // live buttons during a switch invites pressing them again, and two
      // presses are two writes to one session log.
      card: {
        type: 'raw',
        data: settledPermissionCard({ preset: presetRowFor(sessions.agentFor(sessionId), value.preset), stage }),
      },
    }
  }

  /**
   * Answer `/permission`, typed bare or with a name.
   *
   * Both forms land here so that a switch is one thing wherever it was asked
   * for: the same authorization, and the same queue. Passing the argument form
   * straight through to the host — which is what this did first — let anyone
   * who could message the bot take the sandbox off, while the card asked for an
   * approver. One of those had to be wrong.
   * @param msg - the message carrying the command.
   * @param chatId - where the answer goes.
   * @param agent - the conversation's agent.
   */
  const runPermissionCommand = async (
    msg: NormalizedMessage,
    chatId: string,
    agent: HostAgent,
  ): Promise<void> => {
    const subject = subjectOf(msg)
    const preset = msg.content.trimStart().replace(/^\/\S+\s*/, '').trim()
    const state = readPresets(projections(), agent, presetTable())
    if (preset === '') {
      await port.send(chatId, {
        card: permissionCard({
          current: state.current,
          presets: state.available,
          valueFor: name => marked({ kind: PERMISSION_ACTION, preset: name, ...subject }),
        }),
      }).catch(reportSendFailure)
      return
    }
    const refusal = refusePresetSwitch(subject, { senderId: msg.senderId, chatId: msg.chatId }, preset)
    if (refusal !== undefined) {
      notify(`lark-channel: rejected a permission switch: ${refusal}`)
      await port.send(chatId, { text: PRESET_NOT_YOURS }).catch(reportSendFailure)
      return
    }
    // Never awaited to the end here. This runs inside the transport's per-chat
    // queue, and a switch waits for the agent's idle phase: awaiting a turn
    // that is itself waiting for an approval card in this chat would block the
    // very click that would end it. A short wait keeps the ordinary case to
    // one message; a slow one is acknowledged and reported when it lands.
    const pending = applyPreset(agent.session.id, agent, preset)
    const say = async (landed: PresetOutcome): Promise<unknown> =>
      // Silent on a dropped switch, the same way the card is: the conversation
      // released its own agent, and it did not fail at anything.
      landed.cancelled === true
        ? undefined
        : port
          .send(chatId, { text: landed.ok ? presetSwitchedText(preset) : presetFailedText(preset, landed.detail) })
          .catch(reportSendFailure)
    // A stopwatch on someone else's work must not be what keeps the process
    // alive, and must not outlive the race it exists for: unref'd while it
    // waits, cleared the moment either side settles.
    let deadline: NodeJS.Timeout | undefined
    const quick = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        deadline = setTimeout(() => { resolve(undefined) }, QUICK_SWITCH_MS)
        deadline.unref?.()
      }),
    ]).finally(() => { if (deadline !== undefined) clearTimeout(deadline) })
    if (quick !== undefined) {
      await say(quick)
      return
    }
    await port.send(chatId, { text: presetHeldText(preset) }).catch(reportSendFailure)
    spawn(pending.then(say))
  }

  /**
   * Act on one press of the workspace picker: switch, or turn a page.
   *
   * Both travel as one payload kind, so this is the single arm that reaches
   * either. A page control changes nothing but what is drawn — no switch, no
   * release, no pick is retired — which is what makes paging safe to press
   * repeatedly while deciding.
   *
   * A row goes through {@link ChatWorkspaces.switch}, the same call a typed
   * `/cd` makes, so every guard a typed path faces — the directory must exist,
   * it must not be a filesystem root or a home directory, it must sit under the
   * configured roots — applies unchanged. The payload's path is not trusted;
   * it is re-probed. What the picker adds is that the directory is usually one
   * the channel already knows, so the press cannot fail for a typo.
   * @param value - the payload the pressed row or control carried.
   * @param evt - the click, for authorization and the operator log.
   * @returns the toast and the repainted picker.
   */
  const handleWorkspaceAction = async (
    value: WorkspaceActionValue,
    evt: CardActionEvent,
  ): Promise<CardActionResponse> => {
    const refusal = refuseControlClick(value, evt)
    if (refusal !== undefined) {
      notify(`lark-channel: rejected a workspace switch: ${refusal}`)
      return { toast: toast('error', TOAST.notYours) }
    }
    if (value.path === undefined) {
      const painted = workspacePicker(subjectOfValue(value), value.page ?? 0)
      return { card: { type: 'raw', data: painted.card } }
    }
    const before = conversationStamp(value.key)
    // The session the conversation is on before the directory moves, so the
    // chat stops watching it: a workspace switch is a session change.
    const left = sessionIdOf(value.key)
    const release = releaseFor(value.key)
    const result = await chatWorkspaces.switch(value.key, value.path)
    if (!result.ok) {
      notify(`lark-channel: rejected a workspace switch in ${value.key}: ${result.reason}`)
      return {
        toast: toast('error', TOAST.workspaceRefused),
        card: { type: 'raw', data: workspacePicker(subjectOfValue(value)).card },
      }
    }
    if (!result.changed) {
      return {
        toast: toast('info', TOAST.workspaceSame),
        card: { type: 'raw', data: workspacePicker(subjectOfValue(value)).card },
      }
    }
    // The directory moved, so this conversation's next message must walk the
    // ladder under the new anchor: each directory keeps its own pointer, and
    // the one being entered resolves to its own session.
    if (conversationStamp(value.key) !== before) notify(`lark-channel: ${value.key} moved twice quickly`)
    await release()
    await stopWatching(value.key, value.chatId, left)
    diag('info', `lark-channel: ${value.key} switched workspace to ${result.path}`)
    notify(`lark-channel: ${value.key} switched to ${result.path}`)
    return {
      toast: toast('success', TOAST.workspaceSwitched),
      card: { type: 'raw', data: workspacePicker(subjectOfValue(value)).card },
    }
  }

  /**
   * The session cards already spent by a pick.
   *
   * A card is single-use: the rows it carries were authorized by one derivation,
   * and the pick retires that card rather than redrawing it with new buttons. A
   * press arriving afterwards — the platform redelivering one, or a card whose
   * terminal repaint never reached the chat — must not resume a list this
   * conversation has already moved on from.
   */
  const spentSessionCards = new Set<string>()

  /** Bound on the marks kept, so a long-lived process cannot grow this forever. */
  const SPENT_CARDS_MAX = 256

  /**
   * Record one rendering as spent, dropping the oldest mark once the bound is
   * reached. Oldest-first is exact: a mark is only ever added once, and the
   * insertion order of a `Set` is the order its keys were added.
   * @param mark - the rendering's mark, as the pressed payload carried it.
   */
  const spendSessionCard = (mark: string): void => {
    if (spentSessionCards.size >= SPENT_CARDS_MAX) {
      const oldest = spentSessionCards.values().next().value
      if (oldest !== undefined) spentSessionCards.delete(oldest)
    }
    spentSessionCards.add(mark)
  }

  /**
   * Answer one session card press: continue a row, or turn a page.
   *
   * The payload's id is not trusted: the same list is derived again and the id
   * must still be in it. A card outlives the state it was drawn from — a
   * session can be archived, a `/cd` can move the conversation elsewhere — and
   * the only thing that may resume a session here is a row this conversation
   * would be offered NOW.
   *
   * Every exit settles the card, including the ones that chose nothing: a card
   * whose press could not land has just proved the list behind it stale, and
   * redrawing it live would invite a second press on that same stale list.
   * @param value - the payload the pressed row or page control carried.
   * @param evt - the click, for authorization and the operator log.
   * @returns the toast and the card the press settles into.
   */
  const continueSession = async (
    value: SessionActionValue,
    evt: CardActionEvent,
  ): Promise<CardActionResponse> => {
    const refusal = refuseControlClick(value, evt)
    if (refusal !== undefined) {
      notify(`lark-channel: rejected a session switch: ${refusal}`)
      return { toast: toast('error', TOAST.notYours) }
    }
    // Checked before the page arm as well: a spent card's page control is a
    // button on a card that is already closed.
    if (spentSessionCards.has(value.a)) {
      notify(`lark-channel: ${value.key} pressed a session card that was already used`)
      return {
        toast: toast('info', TOAST.sessionCardSpent),
        card: {
          type: 'raw',
          data: settledSessionsCard({
            workspace: chatWorkspaces.pathFor(value.key),
            refusal: 'spent',
          }),
        },
      }
    }
    // A page control moves nothing: it repaints the same list, one page along,
    // and reads the corpus again so what it draws is the corpus as it is now.
    if (value.page !== undefined) {
      return { card: { type: 'raw', data: await sessionPicker(subjectOfValue(value), '', value.page) } }
    }
    // What the list was derived under, so what it authorizes can be checked
    // against the conversation as it stands when the pick is actually written.
    const before = conversationStamp(value.key)
    // The session the conversation is on if this press lands, so the chat stops
    // watching the one it leaves at the same moment it starts on the new one.
    const left = sessionIdOf(value.key)
    // ONE derivation per press, and it is a FRESH one. The rows a press may name
    // are exactly the rows this list holds, and a card outlives the corpus it
    // was drawn from — so the list is read now rather than reused from the card.
    const offered = await derive(value.key)
    const choice = offered.rows.find(candidate => candidate.id === value.session)
    if (choice === undefined) {
      notify(`lark-channel: ${String(value.session)} is no longer offered to ${value.key}`)
      return {
        toast: toast('info', TOAST.sessionGone),
        card: {
          type: 'raw',
          data: settledSessionsCard({
            workspace: chatWorkspaces.pathFor(value.key),
            refusal: 'gone',
          }),
        },
      }
    }
    // The workspace still has to be the one this row was offered under. A card
    // outlives the conversation's directory: `/cd` moves it, and a press on the
    // older card would otherwise continue a session from the directory the chat
    // has left — the exact sandbox move the picker filters against.
    if (value.workspace !== undefined && value.workspace !== chatWorkspaces.pathFor(value.key)) {
      notify(`lark-channel: ${value.key} left ${value.workspace} since that card was drawn`)
      return {
        toast: toast('info', TOAST.sessionGone),
        card: {
          type: 'raw',
          data: settledSessionsCard({
            workspace: chatWorkspaces.pathFor(value.key),
            refusal: 'moved',
          }),
        },
      }
    }
    // The derived one is not an override: pressing it is how a conversation
    // goes back, and going back means having no pointer at all.
    const derived = chatWorkspaces.sessionIdFor(value.key)
    // Checked before the release as well as after it: the release disposes a
    // live agent, and a press that has already lost its conversation should not
    // cost the room its running one.
    if (conversationStamp(value.key) === before) await releaseFor(value.key)()
    // A `/cd` or a `/new` may have landed while this was deriving and releasing.
    // Both move what the conversation resolves to, so a pointer written now would
    // override what the person asked for in the meantime — and a `/cd` would put
    // this press's session under the directory it just left.
    if (conversationStamp(value.key) !== before) {
      notify(`lark-channel: ${value.key} moved while a session switch was in flight`)
      return {
        toast: toast('info', TOAST.sessionGone),
        card: {
          type: 'raw',
          data: settledSessionsCard({
            workspace: chatWorkspaces.pathFor(value.key),
            refusal: 'moved',
          }),
        },
      }
    }
    await sessionPointers.set(anchorOf(value.key), choice.id === derived ? undefined : choice.id)
    // And it stops watching the one it left, in the same step. A pick is an
    // override on the derived session, so the conversation it was on before is
    // still live somewhere — a browser, a schedule — and it used to go on
    // rendering into this chat beside the session just picked.
    await stopWatching(value.key, value.chatId, left)
    // The chat now claims that conversation, so it starts watching it here
    // rather than on its next message. A binding is what routes a session's
    // events to this chat, and until one exists every event of that session is
    // dropped — so without this line a turn driven from the Web app on the
    // session this chat just claimed reaches the chat not at all, and only
    // recovers once somebody happens to type here.
    //
    // Only a row that is NOT this conversation's own derived id is bound: those
    // rows come from the corpus listing, so each names a session that already
    // exists. Picking the derived id means going back to a session this chat
    // creates with its next message, and there is nothing to watch yet — the
    // message path binds it then, exactly as it binds every fresh conversation.
    if (choice.id !== derived) {
      await bindingFor(choice.id, { chatId: value.chatId, chatType: value.chatType })
    }
    // The card is spent the moment the pick lands, not before it: a press that
    // failed above must leave the card answerable by another.
    spendSessionCard(value.a)
    // Recorded, not just announced: the press succeeds and the failure arrives
    // later, on the next message, when the pick is finally resumed. Without this
    // line an operator sees a switch that reported success and a chat that then
    // refused to continue, with nothing tying the two together.
    diag('info', `lark-channel: ${value.key} picked ${choice.id === derived ? 'its own session' : choice.id}`)
    notify(`lark-channel: ${value.key} continues ${choice.id}`)
    // The settled card rides the click's own response, exactly as a decided
    // approval does: the patch API reports refusals in a body the SDK discards,
    // so a repaint that failed would be invisible — and a card left showing live
    // buttons after its pick is worse than any toast.
    return {
      toast: toast('success', choice.id === derived ? TOAST.sessionOwn : TOAST.sessionSwitched),
      card: {
        type: 'raw',
        data: settledSessionsCard({
          // Labelled from the same derivation the press was authorized against,
          // so the card cannot name a different conversation than the one the
          // pick wrote.
          picked: cardRowFor(offered.label([choice])[0] ?? choice, chatWorkspaces.sessionIdFor(value.key)),
          workspace: chatWorkspaces.pathFor(value.key),
          // Named only where the conversation is a room's: telling one person
          // their own name back is noise, and the gate that matters is the
          // control gate, not this line.
          ...value.owner === undefined ? { decidedBy: await resolveApprovalDecider(evt) } : {},
        }),
      },
    }
  }

  /**
   * What a conversation resolves to, as one comparable value.
   *
   * The directory and the session it currently runs together: `/cd` moves the
   * first, `/new` and a pick move the second, and either one retires a card
   * that was drawn before it.
   * @param key - the conversation key.
   * @returns a value that changes whenever the conversation does.
   */
  const conversationStamp = (key: string): string =>
    `${chatWorkspaces.pathFor(key)}\u0000${sessionIdOf(key)}`

  /**
   * The conversation a card payload names, without whatever else it carries.
   * @param value - a payload extending {@link ConversationSubject}.
   * @returns just the conversation.
   */
  const subjectOfValue = (value: ConversationSubject): ConversationSubject => ({
    key: value.key,
    chatId: value.chatId,
    chatType: value.chatType,
    ...value.owner === undefined ? {} : { owner: value.owner },
  })

  /**
   * What this conversation may continue, as one derivation.
   * @param key - the conversation key.
   * @param keyword - optional filter over titles and ids.
   * @returns the derivation, or an empty one where nothing can be listed.
   */
  const derive = async (key: string, keyword = ''): Promise<OfferedSessions> => {
    const offer = offerFor(key, keyword)
    return offer === undefined ? EMPTY_OFFER : await offerSessions(offer)
  }

  /**
   * One derived row as the card's own row type.
   * @param choice - the derived row.
   * @param current - the session this conversation resolves to right now.
   * @returns the row the card renders, and the settled card names.
   */
  const cardRowFor = (choice: SessionChoice, current: string): SessionCardRow => ({
    id: choice.id,
    ...choice.title === undefined ? {} : { title: choice.title },
    ...choice.lastSaid === undefined ? {} : { lastSaid: choice.lastSaid },
    ...choice.turns === undefined ? {} : { turns: choice.turns },
    // Last movement, not creation: "recent" in a list of conversations
    // means the one you were just in, not the one you opened first.
    ...(choice.lastActive ?? choice.createdAt) === undefined
      ? {}
      : { when: choice.lastActive ?? choice.createdAt },
    live: choice.live,
    own: choice.own,
    // Read now rather than taken from the row: a repaint follows the press
    // that moved it, and the row was derived before that.
    current: choice.id === current,
  })

  /**
   * The picker for one conversation: what it may continue, and one press each.
   *
   * Everything the card offers is resolved here, because the list IS the
   * authorization — a row that never appears cannot be pressed.
   * @param subject - the conversation the card is built for.
   * @param line - the command line, so a keyword can narrow the list.
   * @param page - the zero-based page to draw; out-of-range values clamp.
   * @param derived - a derivation the caller already made for this conversation,
   * so a repaint after a press does not read the corpus a second time. Only the
   * row marked current is read fresh inside.
   * @returns the card to send.
   */
  const sessionPicker = async (
    subject: ConversationSubject,
    line = '',
    page = 0,
    derived?: OfferedSessions,
  ): Promise<object> => {
    const keyword = line.trimStart().replace(/^\/\S+\s*/, '').trim()
    const listed = derived ?? await derive(subject.key, keyword)
    const sliced = sessionsPage(listed, page)
    // Labelled after the slice: what a conversation was last about is the one
    // fact whose state grows with the session, so it is read for the rows the
    // card draws rather than for the whole corpus.
    const drawn = listed.label(sliced.rows)
    const current = sessionIdOf(subject.key)
    // ONE mark for every control on this rendering, because the card is
    // single-use: the first pick retires it, and a press arriving afterwards
    // has to be recognizable as one of ITS buttons rather than just as some
    // well-formed payload. Turning a page mints a new card, so paging is
    // unaffected.
    const stamp = cardMarker()
    return sessionsCard({
      rows: drawn.map(choice => cardRowFor(choice, current)),
      workspace: chatWorkspaces.pathFor(subject.key),
      page: sliced.page,
      pages: sliced.pages,
      // Only a list that cannot be paged reports what it left out; a paged one
      // draws every row it has, so a count beside it would name nothing.
      hidden: listed.complete ? 0 : listed.hidden,
      ...keyword === '' ? {} : { keyword },
      canList: sessionQuery() !== undefined,
      // The row's own id LAST: a caller may hand in a payload that already
      // carries one — the click handler repaints from the value it was given —
      // and spreading that over the row would point every button at the
      // session someone just pressed.
      valueFor: session => stamp({
        kind: SESSIONS_ACTION,
        ...subject,
        session,
        // The workspace each row was offered under, so a press is authorized
        // against what the card actually showed without re-deriving the list.
        workspace: chatWorkspaces.pathFor(subject.key),
      }),
      // The same payload kind carries a page control, so the dispatcher has one
      // arm to reach and a foreign card cannot forge either.
      pageValueFor: target => stamp({
        kind: SESSIONS_ACTION,
        ...subject,
        page: target,
        workspace: chatWorkspaces.pathFor(subject.key),
      }),
    })
  }

  /** The host's session-query engine, when this deployment composed one. */
  const sessionQuery = (): HostSessionQuery | undefined =>
    ctx.get('sessionQuery') as HostSessionQuery | undefined

  /**
   * The workspace picker: which directory this conversation runs in, and one
   * press each for the rest.
   *
   * Reads nothing but channel state — the known paths are the default, what
   * this conversation switched to, and what the host registry lists — so both
   * drawing it and turning a page answer in well under the callback budget.
   * @param subject - the conversation the card is built for.
   * @param page - the zero-based page to draw; out-of-range values clamp.
   * @returns the card to send, and the page it drew.
   */
  const workspacePicker = (
    subject: ConversationSubject,
    page = 0,
  ): { readonly card: object; readonly page: number } => {
    const choices = workspaceChoices(chatWorkspaces, subject.key)
    const sliced = workspacePage(choices, page)
    const card_ = workspacesCard({
      rows: sliced.rows,
      page: sliced.page,
      pages: sliced.pages,
      current: chatWorkspaces.pathFor(subject.key),
      // Both a row and a page control travel as this one payload kind, so the
      // dispatcher has a single arm to reach and a foreign card cannot forge
      // either: the mark is minted per rendering, and the fields are validated.
      valueFor: target => marked({
        kind: WORKSPACE_ACTION,
        ...subject,
        ...target.path === undefined ? {} : { path: target.path },
        ...target.page === undefined ? {} : { page: target.page },
      }),
    })
    return { card: card_, page: sliced.page }
  }

  /**
   * Sessions the operator archived, which no surface should offer.
   *
   * Archiving is the host's own "hide this from every grouping surface", so a
   * chat that kept offering an archived session would be the one place the
   * decision did not land.
   * @returns the archived ids, empty where no registry is composed.
   */
  const archivedSessions = (): ReadonlySet<string> => {
    const registry = ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
    return new Set(registry?.archivedSessionIds ?? [])
  }

  /**
   * What this conversation may continue right now, as the offer `sessions.ts`
   * derives from.
   *
   * Re-derived on every render and every press rather than reused: the list is
   * the authorization, and a list remembered from an earlier draw authorizes
   * rows the conversation may have outgrown. That was only affordable once the
   * host began handing back what it already folds — a derivation is now one
   * corpus listing and, per drawn row, one stored projection read.
   *
   * The conversation's half of {@link offerSessions}: which chat, which
   * workspace, and what this deployment lets us read. The rule itself lives in
   * `sessions.ts`, where it is a function of its inputs rather than of a
   * running channel.
   * @param key - the conversation key.
   * @param keyword - optional filter over titles and ids.
   * @returns the offer to derive from, or undefined where nothing can be listed.
   */
  const offerFor = (key: string, keyword = ''): SessionOffer | undefined => {
    const query = sessionQuery()
    if (query === undefined) return undefined
    const diagnose = config.diagnoseSessions === true
    return {
      query,
      sources: sessionSources(),
      scope: {
        base: sessionIdFor(key, instanceIdentity(config.instance).sessionPrefix),
        current: sessionIdOf(key),
        workspace: chatWorkspaces.pathFor(key),
        marker: SESSION_PREFIX,
        archived: archivedSessions(),
        ...keyword === '' ? {} : { keyword },
      },
      canonical: path => canonicalPathOf(path) ?? path,
      signal: commandSignal(),
      // The picker's account of itself is a diagnostic, so every line goes to
      // the channel's own file as well as the terminal: the question it answers
      // is usually asked long after the window that ran the bot was closed.
      report: diagnose ? (line) => { diag('warn', line); notify(line) } : notify,
      ...diagnose ? { diagnose: true } : {},
    }
  }

  /**
   * The days of `offerSessions` that live on the host.
   *
   * `liveSession` is what makes a running session's row exact rather than as
   * stale as its last checkpoint: the registry holds the cells of every session
   * this process has attached, and this channel already asks it for other
   * readouts.
   * @returns the cache faces this deployment composes; every one is optional.
   */
  const sessionSources = (): FactSources => ({
    cache: ctx.get('sessionProjectionCache') as HostSessionProjectionCache | undefined,
    projections: projections(),
    liveSession: id => sessions.agentFor(id)?.session,
  })

  /**
   * Whether one preset switch may proceed, wherever it was asked from.
   *
   * One rule for the picker, the typed command and the approval card's third
   * button, because they do the same thing. It is asymmetric on purpose:
   * anyone who may drive the conversation can put the sandbox BACK, while
   * taking it off is a grant and needs whoever may approve one. Gating both
   * ends the same way would have left an ordinary member unable to make their
   * own conversation safer.
   * @param subject - the conversation being changed.
   * @param actor - who asked, and where they asked from.
   * @param preset - the preset being switched to.
   * @returns the refusal for the operator log, or undefined when allowed.
   */
  const refusePresetSwitch = (
    subject: ConversationSubject,
    actor: { readonly senderId: string | undefined; readonly chatId: string },
    preset: string,
  ): string | undefined => {
    if (actor.senderId === undefined) return 'the request carries no sender id'
    if (actor.chatId !== subject.chatId) {
      return `request from chat ${actor.chatId} does not match ${subject.chatId}`
    }
    if (subject.owner !== undefined && actor.senderId !== subject.owner) {
      return `${actor.senderId} does not own conversation ${subject.key}`
    }
    const ordinary = refuseMessage(authorization, {
      senderId: actor.senderId,
      chatId: subject.chatId,
      chatType: subject.chatType,
    })
    if (ordinary !== undefined || !loosensSandbox(preset, presetTable())) return ordinary
    return refuseApprovalClick(
      authorization,
      { operatorId: actor.senderId, chatId: actor.chatId },
      { chatId: subject.chatId, chatType: subject.chatType },
    )
  }

  /**
   * Run the switch a click asked for, and show the chat where it landed.
   *
   * The conversation is OPENED for it rather than required to be open already.
   * A preset belongs to the durable session, which outlives this process, so a
   * card that only worked while an agent happened to be live would be dead
   * after every restart — and opening is what the conversation's next message
   * would do anyway, one step earlier.
   *
   * Off the callback path by design, so nothing here races a deadline: the
   * card is repainted from the state the host reports AFTER the switch, and a
   * failure is said out loud rather than left as a card that quietly disagrees
   * with the session.
   * @param value - the payload the pressed row carried.
   * @param messageId - the card to repaint once the switch lands.
   */
  const completeSwitch = async (value: PermissionActionValue, messageId: string): Promise<void> => {
    let agent: HostAgent
    try {
      agent = (await sessions.acquireKey(value.key)).handle.agent
    } catch (error) {
      notify(`lark-channel: a preset click could not open ${value.key}: ${String(error)}`)
      await port
        .send(value.chatId, {
          text: presetFailedText(value.preset, failureDetail(error)),
        })
        .catch(reportSendFailure)
      return
    }
    const landed = await applyPreset(agent.session.id, agent, value.preset)
    // A dropped switch says nothing: the conversation itself moved on, and the
    // repaint below hands its picker back with the buttons live.
    if (!landed.ok && landed.cancelled !== true) {
      await port.send(value.chatId, { text: presetFailedText(value.preset, landed.detail) }).catch(reportSendFailure)
    }
    // Settled once it landed, pressable again when it did not: there the press
    // still has something to do. What the settled card describes is read back
    // from the session — the button carried a name, and a name is the one
    // thing a deployment is free to redefine.
    await port
      .updateCard(
        messageId,
        landed.ok
          ? settledPermissionCard({ preset: presetRowFor(agent, value.preset), stage: 'done' })
          : repaintPicker(agent, value),
      )
      .catch((error: unknown) => {
        notify(`lark-channel: could not repaint the permission card: ${String(error)}`)
      })
  }

  /**
   * One preset name, with whatever this deployment says it does.
   * @param agent - the conversation's agent, when it has one.
   * @param preset - the preset name to describe.
   * @returns the row a card can speak about.
   */
  const presetRowFor = (agent: HostAgent | undefined, preset: string): PresetOption => {
    const offered = readPresets(projections(), agent, presetTable()).available
      .find(option => option.value === preset)
    return offered ?? { value: preset, name: preset }
  }

  /**
   * The picker as it stands right now, for the same conversation.
   * @param agent - the conversation's agent, when it has one.
   * @param value - the payload the pressed row carried, reused as the subject.
   * @returns a card object.
   */
  const repaintPicker = (agent: HostAgent | undefined, value: PermissionActionValue): object => {
    const state = readPresets(projections(), agent, presetTable())
    return permissionCard({
      current: state.current,
      presets: state.available.length === 0 ? [{ value: value.preset }] : state.available,
      valueFor: preset => marked({ ...value, preset }),
    })
  }

  /**
   * Whether this deployment can actually open a session up.
   * @param agent - the conversation's agent.
   * @returns true when the preset exists, the command runs it, and the host
   * lends the idle phase to run it from.
   */
  const canOpenSession = (agent: HostAgent): boolean => {
    if (!lendsIdlePhase(agent)) return false
    if ((ctx.get('commands') as HostCommands | undefined) === undefined) return false
    const offered = readPresets(projections(), agent, presetTable()).available
      .find(option => option.value === UNCONFINED_PRESET)
    if (offered === undefined) return false
    // The button's copy promises two definite things — no sandbox, and no more
    // asking. A preset whose bundle cannot be read promises neither, so the
    // button is not offered: this is a consent surface, and "probably" is not
    // a thing to grant on. The ordinary allow-once decision is unaffected.
    return isUnconfined(offered)
  }

  /**
   * Switch one conversation to the unconfined preset, after its approval was
   * granted. Fire-and-forget by design: the decision has already been
   * returned to the waiting turn, and a preset that fails to switch must not
   * turn a granted approval into an error.
   * @param pending - the approval that was just granted.
   * @param evt - the click, for the operator log.
   */
  const openSession = async (pending: PendingApproval, evt: CardActionEvent): Promise<void> => {
    const agent = pending.agent
    if (agent === undefined) {
      notify('lark-channel: cannot open the session — the approval carried no agent')
      return
    }
    notify(`lark-channel: ${evt.operator.openId} opened ${pending.chatId} up to ${UNCONFINED_PRESET}`)
    // Said before it runs, because it runs from the agent's idle phase and an
    // approval is answered mid-turn by construction: the switch lands after
    // this turn does, and silence until then would read as nothing happening.
    await port.send(pending.chatId, { text: presetHeldText(UNCONFINED_PRESET) }).catch(reportSendFailure)
    const landed = await applyPreset(agent.session.id, agent, UNCONFINED_PRESET)
    // Dropped means the conversation moved on — `/new`, `/cd`, disposal — and
    // it has already been told what it asked for; a failure line here would be
    // about a switch nobody is still waiting for.
    if (landed.cancelled === true) return
    await port
      .send(pending.chatId, {
        text: landed.ok ? PRESET_OPENED : presetFailedText(UNCONFINED_PRESET, landed.detail),
      })
      .catch(reportSendFailure)
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
    // Settled BEFORE any switch: `danger-full-access` also sets the approval
    // policy to `never`, and `never` refuses what still needs approval — so
    // switching first could reject the very decision being made.
    if (value.always === true && value.decision === 'allow') spawn(openSession(pending, evt))
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
    // Clipped like every other value a card carries: the name is the operator's
    // own text, and the settled card has to stay within what the platform will
    // render.
    const named = (value: string | undefined): string | undefined => {
      const clipped = value?.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, DECIDER_NAME_MAX_CHARS)
      return clipped === undefined || clipped === '' ? undefined : clipped
    }
    const callback = named(evt.operator.name)
    if (callback !== undefined) return callback
    try {
      const members = await port.getChatMembers?.(evt.chatId)
      const member = named(members?.find(candidate => candidate.id === evt.operator.openId)?.name)
      if (member !== undefined) return member
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

  /**
   * Aim a turn at the message it just took out of the inbox.
   *
   * This is where a turn actually decides what it is answering, and it happens
   * BEFORE the turn's first step — the session log's own order is `turn/start`,
   * `step/start`, `user/message`, so aiming on `user/message` arrives after
   * the turn has begun producing. A turn that claims several aims at the last,
   * which is the latest ask.
   */
  ctx.on('agent/inbox/claimed', payload => {
    const sessionId = payload.agent.session.id
    const binding = bySession.get(sessionId)
    const id = payload.message.id
    if (binding === undefined || id === undefined) return
    const claimed = targetByMessageId.get(id)
    if (claimed === undefined) return
    targetByMessageId.delete(id)
    aimAt(sessionId, binding, claimed)
  })

  // Live model output no longer rides the session log: `assistant/chunk` was
  // retired and the loop publishes `agent/assistant-stream` per agent instead.
  // Translate each chunk frame back into the shape the renderers already read,
  // so streaming — and the reasoning area of a thinking process — survives the
  // move without either renderer knowing which host published the text.
  const turnByAttempt = new Map<string, number>()
  ctx.on('agent/assistant-stream', (payload: AssistantStreamPayload) => {
    const sessionId = payload.agent?.session?.id
    if (sessionId === undefined) return
    const binding = bySession.get(sessionId)
    if (binding === undefined) return
    const frame = payload.frame
    if (frame === undefined) return
    if (frame.type === 'start') {
      turnByAttempt.set(frame.attemptId, frame.turn)
      return
    }
    if (frame.type === 'end') {
      // This attempt's frames stop here; the next start re-registers its turn.
      turnByAttempt.delete(frame.attemptId)
      return
    }
    const turn = turnByAttempt.get(frame.attemptId)
    // No start seen: this process attached mid-attempt. A chunk carries no turn
    // of its own, so dropping it beats guessing which turn it belongs to.
    if (turn === undefined) return
    try {
      binding.renderer.handle({ type: 'assistant/chunk', data: { turn, chunk: frame.chunk } })
    } catch (error) {
      notify(`lark-channel: rendering a live chunk of ${sessionId} failed: ${failureDetail(error)}`)
      ctx.logger.warn('rendering a live chunk failed: %s', error)
    }
  })

  // Outbound: the owned chat's renderer decides what reaches the chat. The
  // bridge additionally remembers each call's arguments for the approval card,
  // and forgets the turn's calls once it closes.
  ctx.on('session/event', (session, event: HostSessionEvent) => {
    const binding = bySession.get(session.id)
    if (binding === undefined) return
    if (isTurnStartEvent(event)) {
      // Fail closed: a turn that claims none of our messages sends its answer
      // unaimed rather than at a guessed target — reusing the previous one is
      // how an injected turn's output lands on an unrelated thread.
      // `agent/inbox/claimed` aims it moments later, before the turn's first
      // step. An artifact this turn produces is aimed by the same rule, so the
      // two move together rather than one of them lagging a turn behind.
      aimAt(session.id, binding, undefined)
    } else if (isUserMessageEvent(event)) {
      // The later record of the same claim, kept as the fallback: a host that
      // publishes no `agent/inbox/claimed` still aims its replies here, one
      // beat after the turn opened.
      const claimed = event.data.id === undefined ? undefined : targetByMessageId.get(event.data.id)
      if (claimed !== undefined && event.data.id !== undefined) {
        targetByMessageId.delete(event.data.id)
        aimAt(session.id, binding, claimed)
      }
      // Mirror a prompt typed in another surface: the person driving this
      // session from a browser still wants to read their own line here, beside
      // the answer it produced. `rpcId` marks a browser-minted prompt, so this
      // channel's own input — which has none — is never echoed back to the chat
      // that sent it, and the host's synthetic context stays out of the chat.
      if (event.data.source?.rpcId !== undefined) {
        const mirrored = userText(event.data)
        if (mirrored !== '') {
          void port.send(binding.chatId, { markdown: mirrored }).catch(reportSendFailure)
        }
      }
    } else if (isToolCallEvent(event)) {
      let calls = callSnapshots.get(session.id)
      if (calls === undefined) {
        calls = new Map()
        callSnapshots.set(session.id, calls)
      }
      calls.set(event.data.callId, { turn: event.data.turn, arguments: event.data.arguments })
    } else if (isTurnEndEvent(event)) {
      // The turn's writer is done, so a queued preset switch may take its own
      // turn at the log now.
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
    // One event's rendering must not take the rest of the turn with it: a
    // renderer that throws here — a presenter meeting a shape it did not
    // expect, say — would otherwise leave the chat with a thinking process
    // that opened and then went silent, and nothing anywhere saying why.
    try {
      binding.renderer.handle(event)
    } catch (error) {
      notify(`lark-channel: rendering ${event.type} of ${session.id} failed: ${failureDetail(error)}`)
      ctx.logger.warn('rendering %s failed: %s', event.type, error)
    }
    // AFTER the renderer: the turn's own closing output (the answer, a failure
    // line) still deserves its target; only what comes later must not.
    if (isTurnEndEvent(event)) {
      aimAt(session.id, binding, undefined)
      // A turn the host refused carries no request and no answer, so the chat
      // would otherwise just see its own message unanswered. `blocked` has other
      // producers — any pre-step rejection ends a turn that way — so the archive
      // set is what decides whether the archive is the account of this one.
      if (event.data.reason.kind === 'blocked' && archivedSessions().has(session.id)) {
        void port.send(binding.chatId, { text: ARCHIVED_SESSION_NOTICE.zh }).catch(reportSendFailure)
      }
    }
  })

  // Structured questions are offered on both surfaces at once, exactly as
  // approvals are: this chat gets a card and whatever answerer follows gets the
  // Web app's question panel, and the first answer decides.
  //
  // PREPEND for the same reason the approval listener prepends. The Web app's
  // answerer is registered during tree load and holds the question until a
  // browser answers it, so a listener behind it would never be reached and a
  // chat would wait forever on a question nobody in the browser is looking at.
  //
  // Only a conversation this channel already holds a binding for is claimed.
  // Everything else — a session the Web app is driving on its own — delegates,
  // and that delegation is what keeps the panel the only surface for it.
  ctx.on('user-questions/request', (request, next) => {
    const sessionId = request.agent?.session.id
    const binding = sessionId === undefined ? undefined : bySession.get(sessionId)
    if (binding === undefined || sessionId === undefined) return next()
    return askOnBothSurfaces(binding, sessionId, request, next)
  }, { prepend: true })

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
    bindingGenerations.clear()
    compositions.clear()
    callSnapshots.clear()
    runningBySession.clear()
    aimBySession.clear()
    return Promise.allSettled([
      // Before the sessions: a command still in flight is a writer on a
      // session log, and disposal that does not wait for it leaves this
      // channel touching an agent the host has already taken down. The
      // background set carries what surrounds those commands — opening an
      // agent, answering the chat, repainting a card.
      maintenance.close().then(() => drainBackground()),
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
