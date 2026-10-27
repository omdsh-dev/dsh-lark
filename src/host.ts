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

/**
 * The live session a host agent drives; only the identity is read here.
 *
 * The log is deliberately absent: a plugin that folds state out of raw events
 * duplicates a rule the owning service already publishes, and DSH deprecates
 * the synchronous event reads that made it possible.
 */
export interface HostSession {
  /** The session id shared by the agent registry and session log. */
  readonly id: string
}

/**
 * Why an active agent driver was cancelled, as the host records it.
 *
 * A structured cause, not a label: the host switches on `kind` when it writes
 * the turn's end reason and refuses an unrecognized value there, so a bare
 * string aborts the turn and then throws while the reason is being recorded.
 */
export type HostCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

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

/**
 * One session as the host's corpus lists it (subset of `SessionRecord`).
 * `header.cwd` is what decides whether a conversation may continue it, and
 * `live` is what tells a chat the web UI is already driving it.
 */
export interface HostSessionRecord {
  readonly header?: {
    readonly id?: string
    readonly cwd?: string
    readonly createdAt?: number
    /**
     * `subagent` for work an agent delegated to itself. Those are not
     * conversations anyone had: they open with an instruction the agent wrote,
     * run one turn, and end.
     */
    readonly origin?: string
    /** Depth below a driving session; anything above zero was delegated. */
    readonly delegationDepth?: number
    /** The session this one was forked from, when it was forked at all. */
    readonly parentSession?: string
    /**
     * The Session format generation this log was written in.
     *
     * A projection-cache record is bound to the generation that folded it, so a
     * header that cannot name one cannot witness a cache row either. Absent on a
     * listing older than the field, which reads as "no cache read" rather than as
     * a wrong one.
     */
    readonly version?: number
    /** Whether the log carries a fork-inherited prefix; the cache binds to it. */
    readonly isSeeded?: boolean
  }
  /** Whether an agent currently drives this id. */
  readonly live?: boolean
}

/** One event of a session, as the query engine's lightweight listing gives it. */
export interface HostEventRecord {
  readonly seq: number
  readonly type: string
  /** Unix epoch milliseconds. */
  readonly time: number
}

/**
 * One raw event as the log holds it. `source` is the field this channel is
 * after: a session's `user/message` stream carries injected context — system
 * prompt snapshots, skill catalogs, job notices — beside what a person typed,
 * and only the source tells them apart.
 */
export interface HostRawEvent {
  readonly seq: number
  readonly type: string
  readonly time?: number
  readonly data?: {
    readonly source?: { readonly kind?: string }
    readonly content?: readonly { readonly type?: string; readonly text?: string }[]
  }
}

/** One result of a batch title read; a rejected one carries no value. */
export type HostTitleResult =
  | { readonly sessionId: string; readonly status: 'fulfilled'; readonly value?: { readonly title?: { readonly title?: string } } }
  | { readonly sessionId: string; readonly status: 'rejected'; readonly reason?: unknown }

/**
 * The `sessionQuery` engine (subset). Read-only: this channel lists what a
 * conversation may continue and folds titles to label them, and leaves every
 * write to the session store.
 */
export interface HostSessionQuery {
  /** The complete logical corpus, newest first. */
  listSessions(signal?: AbortSignal): Promise<readonly HostSessionRecord[]>
  /**
   * Lightweight records for one session's events — no text, so counting what a
   * conversation contains and asking when it last moved costs no payload.
   */
  listEvents?(sessionId: string): Promise<readonly HostEventRecord[]>
  /**
   * One full event plus a bounded window around it — the only read here that
   * carries an event's `source`, which is what tells a person's message apart
   * from the ones a plugin injected into the same stream.
   */
  readEvent?(request: {
    readonly sessionId: string
    readonly seq: number
    readonly before?: number
    readonly after?: number
  }): Promise<{ readonly events?: readonly HostRawEvent[] }>
  /**
   * Fold the latest title for several sessions at once. Optional because a
   * deployment may compose a query engine without it; the picker then labels
   * rows by time alone.
   */
  readTitleSnapshots?(sessionIds: readonly string[], signal?: AbortSignal): Promise<readonly HostTitleResult[]>
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
   * @param cause - the structured reason the host records on the turn's end.
   */
  cancel(cause: HostCancelCause): void
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
   * @param agent - the agent whose session the command runs against.
   * @param line - the complete line, slash included.
   * @param submittedAttachments - images and staged file receipts the
   * submission carried, in order; empty for a plain invocation, which is the
   * only kind this channel submits.
   * @param signal - cancellation for the execution.
   */
  execute(
    agent: HostAgent,
    line: string,
    submittedAttachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<HostCommandExecution | undefined>
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
   * every model-facing row off the global layer. Handed over outright, with no
   * lease to return; a host that publishes this alone predates
   * {@link acquireScope}. Read only through {@link standingScopeFor}.
   */
  standingKeyFor?(id?: string): Promise<unknown>
  /**
   * The same standing scope key, lent as a revision lease the caller disposes
   * once its scoped read is over. A host publishing this returns the key on the
   * lease rather than on its own promise, and publishes no `standingKeyFor`.
   */
  acquireScope?(id?: string): Promise<StandingScopeLease>
}

/** One preset's standing view, lent for as long as a reader needs it. */
export interface StandingScopeLease {
  /** The scope key every scoped read passes to the tool registry. */
  readonly key: unknown
  /** Returns the lease; absent when the host handed the key over outright. */
  [Symbol.asyncDispose]?(): Promise<void>
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
  /**
   * Sessions the operator archived: the host's own "hide this from every
   * grouping surface". Optional for the same reason as {@link list}. A chat
   * whose session is in this set is refused rather than restored: lifting an
   * archive is the operator's decision, and the host's admission gate is what
   * enforces it.
   */
  readonly archivedSessionIds?: readonly string[]
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

/**
 * One Loader row's live settings, as the host's `describe()` publishes it.
 *
 * The namespace is the row's own `id:` in the profile's configuration tree, and
 * `value` is that row's effective config projected onto the fields its schema
 * marks volatile. A row with no volatile field is absent from the list.
 */
export interface HostSettingsDescriptor {
  /** The row's configuration-tree id, which is the namespace every write names. */
  readonly ns: string
  /** The row's effective config, volatile fields only. */
  readonly value?: unknown
  /**
   * The part of that config the USER document itself supplies, when published.
   *
   * The difference between this and {@link HostSettingsDescriptor.value} is what
   * tells a secret a deployment injected from one this plugin's onboarding
   * wrote: migration must move the second and leave the first with its owner.
   * Optional because an older seam publishes the effective value alone.
   */
  readonly user?: unknown
  /** Monotonic revision, for a caller that wants to fence its write. */
  readonly revision?: number
}

/**
 * The `settings` service (subset of the host `SettingsForms`).
 *
 * Writes go to the PROFILE's patch document and only touch fields the row's own
 * schema marks volatile; the host refuses anything else. This channel therefore
 * keeps its managed state on those fields, and a deployment whose row declares
 * none gets an in-memory channel with one line saying so (see
 * `settings-store.ts`).
 */
export interface HostSettings {
  /** Every configurable row's live volatile config, in tree order. */
  describe(options?: unknown): readonly HostSettingsDescriptor[]
  /** Deep-merge one patch into a row's section and persist it. */
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  /** Replace a row's section outright, keeping the inherited base underneath. */
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
}

/** One projection block, as either cache face serves it. */
export interface HostProjectionBlock {
  /** The log position the served values have folded through at least. */
  readonly asOfSeq: number
  /** Whole values per projection key; a key with no usable row is absent. */
  readonly values: Record<string, unknown>
}

/**
 * The `sessionProjectionCache` service (subset).
 *
 * The host folds every registered projection over each session log anyway, and
 * checkpoints the result durably. Reading those rows back is the one way to
 * label a session without opening its log at all: the values are as stale as
 * the last checkpoint and never wrong, which is the same bargain the host's own
 * session list makes.
 */
export interface HostSessionProjectionCache {
  /**
   * The stored rows bound to one listed header's lifecycle.
   * @param meta - the listed header; its format generation and lineage are the identity witness.
   * @param keys - the projection keys the caller needs.
   * @returns the block, or undefined when no usable row exists for this lifecycle.
   */
  cachedSnapshot(
    meta: {
      readonly id: string
      readonly createdAt: number
      readonly cwd?: string | undefined
      readonly version?: number | undefined
      readonly isSeeded?: boolean | undefined
    },
    keys?: readonly string[],
  ): HostProjectionBlock | undefined
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
  /**
   * Read only the cells this registry already materialized for one session,
   * without folding history: the live face of the same rows the persisted cache
   * serves to a listing. Optional because a deployment may compose a registry
   * older than this read; a row then falls back to the stored rows or to the log.
   * @param session - the attached session whose cached cells are inspected.
   * @param keys - the projection keys the caller needs.
   * @returns the lowest common cached cut, or undefined when no cell exists.
   */
  cachedSnapshot?(session: HostSession, keys?: readonly string[]): HostProjectionBlock | undefined
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
  /**
   * Where the message came from. A prompt minted by a browser client carries
   * `rpcId`; this channel's own chat input and the host's synthetic context
   * (skill catalogs, job notices, goal rounds) do not. That field is what lets
   * the bridge mirror a browser prompt into a chat without echoing the chat's
   * own input back to the person who typed it.
   */
  readonly source?: { readonly kind?: string; readonly rpcId?: string } | undefined
  /** The model-facing blocks the prompt was recorded with. */
  readonly content?: readonly { readonly type?: string; readonly text?: string }[] | undefined
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

/**
 * One ordered publication of an agent's live model output.
 *
 * Live output left the session log when `assistant/chunk` was retired: the loop
 * now publishes it per agent, as a `start`, a series of `chunk`s, and one `end`.
 * This channel translates each `chunk` frame back into {@link AssistantChunkData}
 * so its renderers keep consuming one shape regardless of which host carried the
 * text.
 */
export type AssistantStreamFrame =
  | { readonly type: 'start'; readonly attemptId: string; readonly turn: number }
  | { readonly type: 'chunk'; readonly attemptId: string; readonly chunk: AssistantChunkData['chunk'] }
  | { readonly type: 'end'; readonly attemptId: string }

/**
 * The `agent/assistant-stream` payload fields this channel reads.
 *
 * Structural only: the agent's live session id names the conversation whose
 * renderer receives the frame, and a frame that names no session is not ours.
 */
export interface AssistantStreamPayload {
  readonly agent?: { readonly session?: { readonly id?: string } } | undefined
  readonly frame?: AssistantStreamFrame | undefined
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
 * Read the standing scope one preset's registrations live in.
 *
 * Two host shapes publish this: `standingKeyFor` hands the key over outright,
 * and its successor `acquireScope` lends the same key as a revision lease. One
 * composition reads through here so the same deployment works on either, and
 * the lease a newer host lends comes back to the caller, which owns releasing
 * it for as long as it reads through the key.
 * @param presets - the host preset roster.
 * @param presetId - the resolved preset whose standing view is wanted.
 * @returns the key and any lease the caller must dispose, or undefined when the
 * host publishes neither reader.
 */
export async function standingScopeFor(
  presets: HostAgentPresets,
  presetId: string,
): Promise<StandingScopeLease | undefined> {
  if (presets.acquireScope !== undefined) return await presets.acquireScope(presetId)
  if (presets.standingKeyFor !== undefined) return { key: await presets.standingKeyFor(presetId) }
  return undefined
}

/**
 * Render one recorded user prompt as the plain text a chat can read back.
 * @param data - the `user/message` payload.
 * @returns the prompt's text blocks joined in order, empty when it carries none.
 */
export function userText(data: UserMessageEventData): string {
  return (data.content ?? [])
    .filter(block => block.type === 'text' && block.text !== undefined && block.text !== '')
    .map(block => block.text as string)
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

/** One choice a structured question offers, as the model wrote it. */
export interface HostUserQuestionOption {
  /** User-facing label the answer echoes back. */
  readonly label: string
  /** Optional extra context a capable UI renders beside the label. */
  readonly description?: string | undefined
}

/** One question of a host structured-question request. */
export interface HostUserQuestionItem {
  /** Stable caller-provided identity, echoed in the answer. */
  readonly id: string
  /** The question to display. */
  readonly question: string
  /** Optional short heading the asker grouped it under. */
  readonly header?: string | undefined
  /** Optional supporting detail kept out of the option labels. */
  readonly detail?: string | undefined
  /** Choices offered, when the asker named any. */
  readonly options?: readonly HostUserQuestionOption[] | undefined
  /** Whether more than one option may be selected. Defaults to single-select. */
  readonly multiSelect?: boolean | undefined
}

/**
 * One structured question the host asks through its own answerer waterfall.
 *
 * The host's `ask_user_question` tool raises this whatever presentation answers
 * it, so the channel's card and the Web app's panel are two offers of the SAME
 * question rather than two tools with one name.
 */
export interface HostUserQuestionRequest {
  /** The questions to display, in ask order. */
  readonly questions: readonly HostUserQuestionItem[]
  /** The agent the question is asked on behalf of; absent when the asker named none. */
  readonly agent?: { readonly session: { readonly id: string } } | undefined
  /** Cancellation lifetime of the pending question. */
  readonly signal?: AbortSignal | undefined
  /** Foreground-wait facts; present only for the opt-in timed tool. */
  readonly wait?: { readonly callId: string; readonly timed?: boolean } | undefined
}

/** One answered question, in the shape the host's tool returns. */
export interface HostUserQuestionAnswerItem {
  /** The answered question's own id. */
  readonly id: string
  /** Labels chosen; empty when the human typed instead or skipped it. */
  readonly selected: readonly string[]
  /** Free text the human typed, when they did. */
  readonly custom?: string | undefined
}

/** The answer to one structured-question request, as the waterfall returns it. */
export interface HostUserQuestionAnswer {
  /** One item per question asked. */
  readonly answers: readonly HostUserQuestionAnswerItem[]
}

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
    /**
     * Ask composed answerers for structured user input. Return an answer to
     * claim the request or call `next()` to delegate. Scope-filtered dispatch:
     * an agent-scoped listener receives only that agent.
     *
     * Unlike `approval/request`, a chain nobody claims REJECTS: the innermost
     * answerer throws rather than resolving a fail-closed outcome, so a listener
     * that delegates and waits must treat rejection as "another surface will
     * decide, or none will" rather than as an answer.
     * @mode waterfall
     */
    'user-questions/request'(
      request: HostUserQuestionRequest,
      next: () => Promise<HostUserQuestionAnswer>,
    ): Promise<HostUserQuestionAnswer>
    /**
     * One ordered publication of an agent's live model output. Agent-scoped:
     * a listener receives only the agents whose frames reach its scope, and the
     * payload's agent names the session whose renderer should read the frame.
     */
    'agent/assistant-stream'(payload: AssistantStreamPayload): void
  }
}
