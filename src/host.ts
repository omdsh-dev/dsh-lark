/**
 * Narrow local contracts for the DSH host services and events this plugin
 * consumes. Keeping these structural copies (instead of importing host source
 * packages) lets the package build self-contained; a composed DSH profile
 * supplies the real implementations at runtime. Field shapes mirror
 * `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, and
 * `@deepseek-ai/dsh-user-approval` as of dsh 0.0.1-rc.2.
 * @module dsh-lark-channel/host
 */

import type { Context } from '@deepseek-ai/cordis'

/** The live session a host agent drives; only the identity is read here. */
export interface HostSession {
  /** The session id shared by the agent registry and session log. */
  readonly id: string
  /**
   * The session log, which several host services fold their own state out of
   * rather than mirroring it. Read-only here: this plugin folds plan mode from
   * it to know whether a plan review is even meaningful.
   */
  readonly events?: readonly HostSessionEvent[]
}

/** Durable metadata for one stored image, from {@link HostAttachments.saveImage}. */
export interface HostImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** One model-facing content block this plugin produces. */
export type HostContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: HostImageRef }

/** A user-role message accepted by {@link HostAgent.followup}. */
export interface HostUserMessage {
  /** Stable message identity; a fresh UUID per message. */
  readonly id: string
  readonly role: 'user'
  /** Model-facing content blocks: the chat's text, plus any images it carried. */
  readonly content: readonly HostContentBlock[]
  /** Producer tag: chat input is a direct human prompt. */
  readonly source: { readonly kind: 'user' }
}

/** What one image must satisfy to be stored, from the attachment service. */
export interface HostImageLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly mediaTypes: readonly string[]
}

/**
 * The `attachments` store (subset of the host `AttachmentStore`). Images reach
 * a model as an opaque reference to bytes this service owns, never as a path
 * or a URL, so a chat image has to be committed here before it can be sent.
 */
export interface HostAttachments {
  readonly imageLimits: HostImageLimits
  /** Validate and durably commit one image; the media type is checked against the bytes. */
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<HostImageRef>
}

/**
 * The deployment's permission presets (subset of the host `permissionPresets`
 * service). Read-only here: this channel classifies a switch by what the
 * preset actually does, and leaves the writing to `/permission`.
 */
export interface HostPermissionPresets {
  /** Every switchable preset name, in the table's declaration order. */
  readonly names: readonly string[]
  /**
   * One preset's knob bundle.
   * @throws when the name is not in the deployment's table.
   */
  resolve(name: string): {
    readonly sandbox: string
    readonly approval: string
    readonly name?: string | undefined
    readonly description?: string | undefined
  }
}

/** Public live-agent handle (subset of the host `Agent` interface). */
export interface HostAgent {
  /** The single identity shared with {@link session}. */
  readonly id: string
  readonly session: HostSession
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: HostUserMessage): void
  /**
   * Clear queued work and abort the active turn. A no-op when nothing is
   * active, so a chat may offer it unconditionally.
   */
  cancel(cause: string): void
  /**
   * Resolve once the agent has no driver or maintenance task running.
   * Optional here because the contract reaches this plugin as an object rather
   * than as a dependency range: an older host simply has no such method.
   */
  whenIdle?(): Promise<void>
  /**
   * Run one non-turn task from the agent's true idle phase. The task starts
   * synchronously once that phase is claimed, later waking input waits in the
   * inbox until it settles, and the claim THROWS SYNCHRONOUSLY when a turn or
   * another maintenance task already owns the agent.
   *
   * This is what makes a channel-issued command safe: every command appends to
   * the session log, and the log takes one writer.
   */
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** An owned agent plus its teardown capability, from `agents.create()`. */
export interface HostAgentHandle {
  readonly agent: HostAgent
  dispose(): Promise<void>
}

/** Per-agent provider/model routing accepted by {@link HostAgentRegistry.create}. */
export interface HostAgentOptions {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/** One persisted session's header, as this plugin's lookup reads it. */
export interface HostSessionHeader {
  readonly id: string
  /** Unix epoch milliseconds; the newest header for a chat is the one to resume. */
  readonly createdAt: number
}

/**
 * The `sessionPersistence` store (subset of the host provider). Only headers
 * are read: enough to find a chat's previous session without loading any log.
 */
export interface HostSessionPersistence {
  list(signal?: AbortSignal): Promise<readonly HostSessionHeader[]>
}

/** The `agents` registry service (subset of the host `AgentRegistry`). */
export interface HostAgentRegistry {
  /** Reopen a persisted session as a live agent, replaying its history. */
  resume(options: {
    readonly resumeSessionId: string
    readonly agentOptions?: HostAgentOptions
    readonly setup?: (agentCtx: Context) => Promise<void>
  }): Promise<HostAgentHandle>
  create(options: {
    readonly sessionId: string
    readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
    readonly agentOptions?: HostAgentOptions
    /**
     * Creation-time composition of the agent's scoped world, awaited before
     * the session and agent are published. A rejection rolls the whole
     * creation back, so a broken composition never yields a half-built session.
     */
    readonly setup?: (agentCtx: Context) => Promise<void>
  }): Promise<HostAgentHandle>
}

/**
 * The `tools` registry, as this plugin's per-agent composition uses it
 * (subset of the host `ToolRegistry`).
 */
export interface HostTools {
  /**
   * Register a monotonic execution guard. Registered through an agent's scoped
   * context it applies to that agent alone; returning a string denies the call
   * with that reason, and no other guard can force-allow what one denied.
   */
  guard(guard: (execution: { readonly name: string }) => string | undefined): () => void
  /**
   * Register a tool definition, returning its disposer. Through an agent's
   * scoped context the registration is that agent's alone, and a name already
   * present in an outer layer is SHADOWED rather than rejected — the registry
   * reserves exactly one name from shadowing (`run_code`), which makes
   * overriding any other an intended capability rather than a trick.
   *
   * Optional in this narrow contract so a deployment composing a registry
   * without it still boots; questions then fall back to being denied.
   */
  register?(definition: object): () => void
  /**
   * One visible tool definition in a viewing scope. The scope is an opaque
   * `ScopeKey`; omitted views the global layer, which a deployment with a
   * preset roster leaves empty ({@link HostAgentPresets.standingKeyFor} supplies
   * the roster's).
   */
  get(name: string, scope?: unknown): HostToolDefinition | undefined
}

/** The presentation half of a tool definition (subset of the host `ToolDefinition`). */
export interface HostToolDefinition {
  /**
   * Pure projection of one pending call for a UI. Every view variant carries a
   * `title`: a short, always-visible label describing what THIS call does,
   * which is what a log line or card header shows. Absent on tools that accept
   * the generic fallback (title = tool name).
   */
  presentCall?(args: unknown): { readonly title?: string; readonly kind?: string } | undefined
}

/** One command this deployment offers, from {@link HostCommands.list}. */
export interface HostCommandDescriptor {
  /** Lowercase name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery surfaces. */
  readonly description: string
}

/** One settled command execution (subset of the host `CommandExecution`). */
export interface HostCommandExecution {
  readonly result:
    | { readonly kind: 'success'; readonly text?: string }
    | { readonly kind: 'error'; readonly text: string }
}

/**
 * The `commands` runtime: slash commands dispatched WITHOUT a model turn, which
 * is why a chat must route them here instead of letting the model read a literal
 * `/clear` as prose.
 */
export interface HostCommands {
  /** Commands available to one agent, for discovery. */
  list(agent: HostAgent): readonly HostCommandDescriptor[]
  /**
   * Run one complete slash-command line. Resolves `undefined` when the syntax
   * or the name does not resolve, which is what distinguishes an unknown
   * command from one that ran and failed.
   */
  execute(agent: HostAgent, line: string, signal: AbortSignal): Promise<HostCommandExecution | undefined>
}

/** The `systemPrompt` assembler, as this plugin's per-agent composition uses it. */
export interface HostSystemPrompt {
  /**
   * Register one ordered prompt section in the calling context's scope layer.
   * Tool guidance uses orders 100–199; a duplicate name throws.
   */
  section(section: { name: string; order: number; text: string }): () => void
}

/**
 * The `agentPresets` roster (subset of the host `AgentPresets`). A deployment
 * that composes one keeps every model-facing row — tools, prompt sections — on
 * the agent plane, so the tool registry's global layer is EMPTY and an agent
 * that joins no preset reaches the model with no tools at all.
 */
export interface HostAgentPresets {
  /**
   * Resolve a preset id, or the roster default when absent.
   * @throws when the roster supplies no such preset.
   */
  resolve(id?: string): Promise<{ readonly id: string }>
  /**
   * Join one agent's scope to a preset's standing composition. Call from the
   * agent factory's `setup(agentCtx)`.
   */
  mount(agentCtx: Context, id?: string): Promise<unknown>
  /**
   * The standing scope key a reader with no agent resolves this preset's
   * registrations in — the view that holds its tools, since a roster keeps
   * every model-facing row off the global layer.
   */
  standingKeyFor(id?: string): Promise<unknown>
}

/** One workspace record (subset of the host `Workspace` entity). */
export interface HostWorkspace {
  readonly id: string
  /** The record's canonical (realpath) directory. */
  readonly path: string
  /**
   * Account one session under this workspace. Validates the session header's
   * cwd against {@link path}, so a session created with that exact value
   * attaches and one created with an uncanonicalized variant is rejected.
   */
  attachSession(id: string): Promise<unknown>
}

/**
 * The `workspaceRegistry` service (subset of the host registry). Grouping is
 * accounted, not derived: a session whose cwd merely matches a workspace stays
 * Ungrouped until something attaches it.
 */
export interface HostWorkspaceRegistry {
  /** The record for a canonical path, or undefined when none is registered. */
  resolveByPath(path: string): Promise<HostWorkspace | undefined>
  /** Register a workspace for a directory; at most one record exists per canonical path. */
  create(path: string, title?: string): Promise<HostWorkspace>
  /**
   * Every registered workspace. Optional in this narrow contract so a
   * deployment composing an older registry still boots; `/ws` then lists only
   * what this channel itself has seen.
   */
  list?(): readonly HostWorkspace[]
}

/** One provider route, as the `llm` registry advertises it. */
export interface HostLlmProvider {
  readonly id: string
  readonly name: string
}

/** One advertised model on a provider route. */
export interface HostLlmModel {
  readonly provider: string
  readonly id: string
  readonly name: string
}

/**
 * The `llm` adapter registry (subset of the host `LlmRuntime`). Listing is
 * advisory by the host's own contract — adapters may accept model ids they do
 * not advertise — so a consumer must never turn absence into rejection.
 */
export interface HostLlm {
  listProviders(): HostLlmProvider[]
  listModels(provider: string): Promise<readonly HostLlmModel[]>
}

/** The `agentDefaultModel` service (subset of `AgentDefaultModelConfig`). */
export interface HostDefaultModel {
  /** The deployment's current default provider/model selection. */
  currentSelection(): HostAgentOptions
}

/** The Cordis loader service; awaited so agents never see a half-composed tree. */
export interface HostLoader {
  await(): Promise<unknown>
}

/** One registered namespace's owner scope (subset of the host `SettingsScope`). */
export interface HostSettingsScope {
  /** The resolved value: schema defaults, then composition base, then the user document. */
  get(): unknown
  /** Deep-merge a patch into the user section and persist it through the provider. */
  update(patch: object): Promise<unknown>
}

/** The `settings` user-settings service (subset of `SettingsProvider`). */
export interface HostSettings {
  /**
   * Register a namespace schema; the registration is an effect on the calling
   * fiber. Duplicate namespaces and stored sections the schema rejects fail loud.
   */
  register(ns: string, schema: unknown, options?: { base?: unknown }): HostSettingsScope
}

/**
 * The `sessionProjections` registry, narrowed to reading one session's cut.
 *
 * Every projection the deployment composed folds the same session log: token
 * usage, context occupancy, step counts. Reading is synchronous and consistent
 * — one snapshot answers for one log position — so a status report never
 * mixes two.
 */
export interface HostSessionProjections {
  /**
   * Read every registered projection for one session.
   * @param session - the session to read.
   * @returns the cut, keyed by projection, and the log position it answers for.
   */
  snapshot(session: HostSession): { readonly asOfSeq: number; readonly values: Record<string, unknown> }
}

/** Whole-session token totals, as the host's `tokenUsage` projection reports them. */
export interface HostTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/**
 * How full the model's context is, as the host's `contextPressure` projection
 * reports it. Every field is optional: a session that has not yet made a
 * request has no sample, and a provider that reports no window has no
 * denominator.
 */
export interface HostContextPressure {
  /** Prompt-side tokens the last request actually carried. */
  readonly pressureTokens?: number
  /** What the NEXT request would carry, moved by everything logged since. */
  readonly projectedTokens?: number
  readonly contextWindow?: number
}

/** One immutable entry in the host session log; narrowed via the guards below. */
export interface HostSessionEvent {
  readonly type: string
  readonly data: unknown
}

/** The `assistant/message` payload fields this plugin renders. */
export interface AssistantMessageData {
  readonly turn: number
  readonly message: {
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }
}

/** The `turn/end` payload fields this plugin reports. */
export interface TurnEndData {
  readonly turn: number
  readonly reason: {
    readonly kind: string
    readonly error?: { readonly code?: string; readonly message?: string }
  }
}

/** The `step/start` payload fields this plugin uses to warm a card up. */
export interface StepStartData {
  readonly turn: number
  readonly step: number
}

/** The `turn/start` payload fields this plugin uses. */
export interface TurnStartData {
  readonly turn: number
}

/**
 * The `user/message` payload: the message object a turn consumed, carrying the
 * id its producer stamped on it. One turn may consume SEVERAL queued messages,
 * so this event — not turn order — is what correlates a turn with the inbound
 * message(s) it answers.
 */
export interface UserMessageEventData {
  readonly id?: string
}

/** The `assistant/chunk` payload fields this plugin streams. */
export interface AssistantChunkData {
  readonly turn: number
  /**
   * One raw stream chunk. Only `text-delta` reaches the chat: `reasoning-delta`
   * is the model's private thinking and stays off the wire, and tool-call
   * deltas are raw JSON fragments reported through `tool/call` instead.
   */
  readonly chunk: { readonly type: string; readonly text?: string }
}

/** The `tool/result` payload fields a thinking process reports. */
export interface ToolResultData {
  readonly turn: number
  readonly message: {
    /** The producing call, so a result pairs with the call that asked. */
    readonly source?: { readonly callId?: string }
    readonly content: readonly {
      readonly type: string
      readonly toolCallId?: string
      /** Nested model-facing blocks; a tool's text output lives here. */
      readonly content?: readonly { readonly type: string; readonly text?: string }[]
    }[]
  }
  readonly error?: { readonly name: string; readonly code: string }
}

/** The `tool/call` payload fields this plugin surfaces as activity. */
export interface ToolCallData {
  readonly turn: number
  /** Pairs the call with the approval question that decides it. */
  readonly callId: string
  readonly name: string
  /** Raw arguments JSON exactly as the model produced it (unparsed, untrusted). */
  readonly arguments: string
}

/**
 * The `compaction/start` payload: the opening bracket of one compaction. The
 * event is itself the host's durable lock, so at most one bracket is open per
 * session and a bare id is enough to pair the three of them.
 */
export interface CompactionStartData {
  /** Ties this bracket's `summary` and `end` back to the `start` that opened it. */
  readonly compactionId: string
  /**
   * Who owns the transaction, and the only thing that separates the two kinds
   * of compaction. A number means the bracket is strictly enclosed by that open
   * turn — the automatic kind, which nobody asked for and which therefore has no
   * other trace in the chat. `null` means a standalone `compactNow()`
   * transaction, i.e. a manual `/compact`, whose command reply has already said
   * what it did.
   */
  readonly turn: number | null
}

/**
 * The `compaction/summary` payload, written only when the transaction actually
 * summarized. A bracket that pruned its way back under safe pressure closes
 * without one, and a failed bracket never reaches one — so the absence of this
 * event is not an error, it is the difference between history having been
 * folded and nothing having been.
 */
export interface CompactionSummaryData {
  readonly compactionId: string
  /**
   * How many tokens the summary replaced. The folded amount is reported here
   * and nowhere else — `end` carries the verdict but never the size — so a
   * reader that wants both has to hold this until the bracket closes. Read it
   * through {@link foldedTokenCount} rather than directly.
   */
  readonly shadowedTokenCount?: number
}

/**
 * The `compaction/end` payload: the closing bracket, and the only place the
 * transaction's verdict appears.
 *
 * A `summary` that already landed does NOT mean the session was changed: when
 * `error` is set the host deliberately leaves the conversation surface
 * untouched and only the log remembers the attempt. Anything counting real
 * compactions therefore has to pair a `summary` with a clean `end`, never count
 * summaries on their own. The close can also fail outright and leave a blocking
 * orphan on purpose, so this event may simply never arrive.
 */
export interface CompactionEndData {
  readonly compactionId: string
  /** The same ownership contract as {@link CompactionStartData.turn}. */
  readonly turn: number | null
  /** The failure, when the transaction failed; absent on success. */
  readonly error?: string
}

/**
 * Narrow a session event to the assembled assistant message for one step.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link AssistantMessageData}.
 */
export function isAssistantMessageEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantMessageData } {
  return event.type === 'assistant/message'
}

/**
 * Narrow a session event to a closed turn boundary.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link TurnEndData}.
 */
export function isTurnEndEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: TurnEndData } {
  return event.type === 'turn/end'
}

/**
 * Narrow a session event to the opening of one step.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link StepStartData}.
 */
export function isStepStartEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: StepStartData } {
  return event.type === 'step/start'
}

/**
 * Narrow a session event to the opening of one turn.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link TurnStartData}.
 */
export function isTurnStartEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: TurnStartData } {
  return event.type === 'turn/start'
}

/**
 * Narrow a session event to a user message a turn consumed.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link UserMessageEventData}.
 */
export function isUserMessageEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: UserMessageEventData } {
  return event.type === 'user/message'
}

/**
 * Narrow a session event to one raw assistant stream chunk.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link AssistantChunkData}.
 */
export function isAssistantChunkEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantChunkData } {
  return event.type === 'assistant/chunk'
}

/**
 * Narrow a session event to one completed tool call's result.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link ToolResultData}.
 */
export function isToolResultEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: ToolResultData } {
  return event.type === 'tool/result'
}

/**
 * The call one result answers, and the text it produced.
 * @param data - the completed result payload.
 * @returns the call id and its joined text output.
 */
export function toolResultText(data: ToolResultData): { callId: string | undefined; text: string } {
  const block = data.message.content[0]
  const text = (block?.content ?? [])
    .filter(inner => inner.type === 'text' && inner.text !== undefined)
    .map(inner => inner.text)
    .join('')
  return { callId: block?.toolCallId ?? data.message.source?.callId, text }
}

/**
 * Narrow a session event to one model-requested tool invocation.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link ToolCallData}.
 */
export function isToolCallEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: ToolCallData } {
  return event.type === 'tool/call'
}

/**
 * Narrow a session event to the opening of one compaction.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link CompactionStartData}.
 */
export function isCompactionStartEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: CompactionStartData } {
  return event.type === 'compaction/start'
}

/**
 * Narrow a session event to the summary one compaction wrote.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link CompactionSummaryData}.
 */
export function isCompactionSummaryEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: CompactionSummaryData } {
  return event.type === 'compaction/summary'
}

/**
 * Narrow a session event to the close of one compaction.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link CompactionEndData}.
 */
export function isCompactionEndEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: CompactionEndData } {
  return event.type === 'compaction/end'
}

/**
 * The folded amount of one compaction, when there is an amount worth showing.
 *
 * Every surface reading this number has to keep "no value" and "zero" apart, so
 * the test lives here once instead of in each of them. A bracket whose count is
 * missing, negative or non-finite folded an amount nobody can act on, and a row
 * reading `0 folded` is the kind of lie an operator acts on anyway — the same
 * reason the status card drops a row rather than printing a zero into it.
 * @param data - the summary payload of one compaction bracket.
 * @returns the folded token count, or `undefined` when there is none to show.
 */
export function foldedTokenCount(data: CompactionSummaryData): number | undefined {
  const folded = data.shadowedTokenCount
  return typeof folded === 'number' && Number.isFinite(folded) && folded >= 0 ? folded : undefined
}

/**
 * Join the text blocks of a committed assistant message.
 * @param data - the committed message payload.
 * @returns the concatenated text, empty when the step produced none.
 */
export function assistantText(data: AssistantMessageData): string {
  return data.message.content
    .filter(block => block.type === 'text' && block.text !== undefined && block.text !== '')
    .map(block => block.text)
    .join('')
}

/**
 * Render a failed turn's reason as one operator-readable line.
 * @param data - the closed turn payload.
 * @returns the error detail, empty when the turn did not fail.
 */
export function turnErrorDetail(data: TurnEndData): string {
  if (data.reason.kind !== 'error') return ''
  const error = data.reason.error
  return error === undefined ? '' : `${error.code ?? 'error'}: ${error.message ?? ''}`.trimEnd()
}

/** Closed outcome of a host approval question; `'allowed-once'` is the only grant. */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Readonly same-process permission question (subset of `ApprovalRequest`). */
export interface HostApprovalRequest {
  /** The agent on whose behalf the question is asked; routes the question. */
  readonly agent: HostAgent
  /** The tool the question is about (presentation and audit). */
  readonly toolName: string
  /** The exact tool call being decided, when the asker has one. */
  readonly callId?: string
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /** Aborting withdraws the question; a late answer is discarded. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host agent registry; required via `inject`. */
    agents: HostAgentRegistry
  }
  interface Events {
    /** Durable session facts broadcast by the host session store. */
    'session/event'(session: HostSession, event: HostSessionEvent): void
    /**
     * One message left an agent's inbox inside its open turn. This is where a
     * turn decides what it is answering, and it precedes the turn's first
     * step — which is why a reply is aimed here rather than at the later
     * `user/message` record.
     */
    'agent/inbox/claimed'(payload: {
      readonly agent: HostAgent
      readonly message: { readonly id?: string }
      readonly turn?: number
    }): void
    /** Waterfall permission question; answer only for owned agents, else delegate via `next()`. */
    'approval/request'(
      request: HostApprovalRequest,
      next: () => Promise<HostApprovalOutcome>,
    ): Promise<HostApprovalOutcome>
  }
}
