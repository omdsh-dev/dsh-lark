import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import type {
  CardActionEvent,
  CardActionResponse,
  LarkChannelError,
  MarkdownStreamController,
  NormalizedMessage,
  RejectEvent,
  SendInput,
  SendOptions,
  SendResult,
} from '@larksuite/channel'
import * as plugin from '../src/index.ts'
import { commandName } from '../src/commands.ts'
import { internals } from '../src/runtime.ts'
import type { ChannelConfig } from '../src/runtime.ts'
import type { ChannelPort } from '../src/bridge.ts'
import type {
  HostAgentOptions,
  HostImageLimits,
  HostAttachments,
  HostCommands,
  HostAgentPresets,
  HostApprovalOutcome,
  HostDefaultModel,
  HostSettings,
  HostUserMessage,
} from '../src/host.ts'
import type { RegisterAppPort } from '../src/onboarding.ts'

/**
 * How many inbound subscriptions `installBridge` opens: `message`,
 * `cardAction`, `reject`, `error`, `reconnecting`, `reconnected`. Tests use the
 * count as the "bridge is installed" signal, so it lives here rather than being
 * pinned at each call site.
 */
export const INBOUND_SUBSCRIPTIONS = 6

/** One outbound message captured by the fake port. */
export interface SentMessage {
  to: string
  input: SendInput
  opts?: SendOptions | undefined
}

type MessageHandler = (msg: NormalizedMessage) => void | Promise<void>
type CardActionHandler = (evt: CardActionEvent) => void | CardActionResponse | Promise<void | CardActionResponse>
type RejectHandler = (evt: RejectEvent) => void
type ErrorHandler = (err: LarkChannelError) => void
type ConnectionStateHandler = () => void
/** Any inbound subscription the fake port accepts, whatever the event name. */
type PortHandler = MessageHandler | CardActionHandler | RejectHandler | ErrorHandler | ConnectionStateHandler

/** One streaming card opened by the renderer, with the content it received. */
export interface StreamedCard {
  to: string
  /** Ordered controller operations: appended chunks and whole-content replacements. */
  ops: ({ append: string } | { set: string })[]
  /** The card's content as the controller applied the operations. */
  content: string
  /** Whether the producer returned, so the stream settled. */
  closed: boolean
}

/** An in-memory {@link ChannelPort} recording traffic and replaying inbound events. */
export function createFakePort() {
  const messageHandlers: MessageHandler[] = []
  const cardHandlers: CardActionHandler[] = []
  /** Every other subscription, by event name, so a test can replay any inbound event. */
  const byName = new Map<string, PortHandler[]>()
  const sent: SentMessage[] = []
  const updated: { messageId: string; card: object }[] = []
  const streams: StreamedCard[] = []
  /** Commands already on the app's panel, and the ones this run registered. */
  const panelCommands: string[] = []
  const panelCreated: string[] = []
  const panelDeleted: string[] = []
  /** Thinking processes opened by the renderer, with the events written to each. */
  const cots: {
    cotId: string
    messageId: string
    chatId: string
    replyTo?: string
    hidden: boolean
    events: { type: string; content: Record<string, unknown> }[]
    /** Stamps exactly as written, so ordering can be asserted. */
    timestamps: string[]
  }[] = []
  /** Downloadable resources, by file key, as the transport would serve them. */
  const resourceBytes = new Map<string, { buffer: Uint8Array; contentType?: string }>()
  /** Members returned by the optional cached roster lookup. */
  const chatMembers = new Map<string, readonly { id: string; name?: string }[]>()
  /** Roster lookups, retained to assert untrusted clicks have no side effects. */
  const memberLookups: string[] = []
  /**
   * Every download the transport was asked for, and which half served it. An
   * image that landed is read off the disk instead of fetched again, and only
   * the call count can tell a spared round trip from a repeated one.
   */
  const downloads: { fileKey: string; via: 'memory' | 'disk' }[] = []
  /** Optional holds a test injects into port operations to stage races. */
  const gates: { beforeSend?: () => Promise<void> } = {}
  const state = {
    connects: 0,
    disconnects: 0,
    subscriptions: 0,
    failNextSend: false,
    /** Reject every `stream()` call, as a deployment without card permissions would. */
    failStreams: false,
    /** Reject panel reads, as an app without the scope would. */
    failPanelList: false,
    /** Reject panel writes, as a duplicate name does. */
    failPanelCreate: false,
    /** Reject panel removals. */
    failPanelDelete: false,
    /** Reject opening a thinking process, as an old deployment would. */
    failCotCreate: false,
    /** Reject writing events to one. */
    failCotWrite: false,
    /** Reject roster reads, as an app without member-list permission would. */
    failChatMembers: false,
    /** Reject repaints, as a message too old to edit does. */
    failCardUpdate: false,
  }
  let counter = 0

  /**
   * The subscription list for one event name. Declared outside the port literal
   * because the port's `on` is an overload set, which a single implementation
   * signature satisfies only through an assertion.
   */
  const listFor = (name: string): PortHandler[] => {
    if (name === 'message') return messageHandlers as PortHandler[]
    if (name === 'cardAction') return cardHandlers as PortHandler[]
    const existing = byName.get(name)
    if (existing !== undefined) return existing
    const fresh: PortHandler[] = []
    byName.set(name, fresh)
    return fresh
  }

  const subscribe = (name: string, handler: PortHandler): (() => void) => {
    const list = listFor(name)
    list.push(handler)
    state.subscriptions += 1
    return () => {
      const index = list.indexOf(handler)
      if (index >= 0) {
        list.splice(index, 1)
        state.subscriptions -= 1
      }
    }
  }

  const port: ChannelPort = {
    async connect() { state.connects += 1 },
    async disconnect() { state.disconnects += 1 },
    async getChatMembers(chatId) {
      memberLookups.push(chatId)
      if (state.failChatMembers) throw new Error('cannot list chat members (fake)')
      return chatMembers.get(chatId) ?? []
    },
    on: subscribe as ChannelPort['on'],
    async send(to, input, opts): Promise<SendResult> {
      // A test may hold the send in flight to exercise what races it.
      if (gates.beforeSend !== undefined) await gates.beforeSend()
      if (state.failNextSend) {
        state.failNextSend = false
        throw new Error('send failed (fake)')
      }
      sent.push({ to, input, opts })
      counter += 1
      return { messageId: `om_sent_${counter}` }
    },
    async updateCard(messageId, card) {
      if (state.failCardUpdate) throw new Error('card update rejected (fake)')
      updated.push({ messageId, card })
    },
    async createCot(chatId, options) {
      if (state.failCotCreate) throw new Error('cot unavailable (fake)')
      counter += 1
      const handle = { cotId: `cot_${counter}`, messageId: `om_cot_${counter}` }
      cots.push({
        ...handle,
        chatId,
        ...options.replyTo === undefined ? {} : { replyTo: options.replyTo },
        hidden: options.hidden,
        events: [],
        timestamps: [],
      })
      return handle
    },
    async writeCotEvents(handle, events) {
      if (state.failCotWrite) throw new Error('cot write rejected (fake)')
      const cot = cots.find((c) => c.cotId === handle.cotId)
      if (cot === undefined) throw new Error(`no such cot ${handle.cotId} (fake)`)
      // The API bounds one write; a fake that ignored it would hide a real limit.
      if (events.length > 50) throw new Error('too many events in one write (fake)')
      cot.events.push(...events.map((e) => ({
        type: e.event_type,
        content: JSON.parse(e.content) as Record<string, unknown>,
      })))
      cot.timestamps.push(...events.map((e) => e.timestamp))
    },
    async downloadResourceWithMeta(messageId, fileKey, _type) {
      downloads.push({ fileKey, via: 'memory' })
      const stored = resourceBytes.get(fileKey)
      if (stored === undefined) throw new Error(`no such resource ${fileKey} on ${messageId} (fake)`)
      return stored
    },
    async downloadResourceToFile(messageId, fileKey, _type, destPath) {
      downloads.push({ fileKey, via: 'disk' })
      const stored = resourceBytes.get(fileKey)
      if (stored === undefined) throw new Error(`no such resource ${fileKey} on ${messageId} (fake)`)
      // Real bytes on a real path: the caller's quota and note assertions are
      // about what a later read finds, not about what this fake returned.
      await writeFile(destPath, stored.buffer)
      return {
        ...stored.contentType === undefined ? {} : { contentType: stored.contentType },
        bytesWritten: stored.buffer.byteLength,
      }
    },
    async listSlashCommands() {
      if (state.failPanelList) throw new Error('no permission to list commands (fake)')
      return panelCommands.map((c, index) => ({ command: c, commandId: `cmd_${index}` }))
    },
    async deleteSlashCommand(commandId) {
      if (state.failPanelDelete) throw new Error('cannot remove command (fake)')
      const index = panelCommands.findIndex((_, i) => `cmd_${i}` === commandId)
      if (index >= 0) panelDeleted.push(panelCommands[index]!)
    },
    async createSlashCommand(command) {
      if (state.failPanelCreate) throw new Error('command already exists (fake)')
      panelCommands.push(command)
      panelCreated.push(command)
    },
    async stream(to, input): Promise<SendResult> {
      if (state.failStreams) throw new Error('stream rejected (fake)')
      counter += 1
      const card: StreamedCard = { to, ops: [], content: '', closed: false }
      streams.push(card)
      const controller: MarkdownStreamController = {
        messageId: `om_stream_${counter}`,
        async append(chunk: string) {
          card.ops.push({ append: chunk })
          card.content += chunk
        },
        async setContent(full: string) {
          card.ops.push({ set: full })
          card.content = full
        },
      }
      // The real SDK drives the producer to completion before resolving.
      await input.markdown(controller)
      card.closed = true
      return { messageId: controller.messageId }
    },
  }

  return {
    port,
    sent,
    updated,
    streams,
    panelCommands,
    panelCreated,
    panelDeleted,
    resourceBytes,
    chatMembers,
    memberLookups,
    downloads,
    cots,
    state,
    gates,
    /** Deliver one inbound chat message to every subscribed handler. */
    async emitMessage(msg: NormalizedMessage): Promise<void> {
      for (const handler of [...messageHandlers]) await handler(msg)
    },
    /** Deliver one policy rejection to every subscribed handler. */
    emitReject(evt: RejectEvent): void {
      for (const handler of [...(byName.get('reject') ?? [])]) (handler as RejectHandler)(evt)
    },
    /** Deliver one transport failure to every subscribed handler. */
    emitError(err: LarkChannelError): void {
      for (const handler of [...(byName.get('error') ?? [])]) (handler as ErrorHandler)(err)
    },
    /** Deliver one connection-state change to every subscribed handler. */
    emitConnectionState(name: 'reconnecting' | 'reconnected'): void {
      for (const handler of [...(byName.get(name) ?? [])]) (handler as ConnectionStateHandler)()
    },
    /** Deliver one card action; returns the last handler's response. */
    async emitCardAction(evt: CardActionEvent): Promise<CardActionResponse | undefined> {
      let response: CardActionResponse | undefined
      for (const handler of [...cardHandlers]) {
        const result = await handler(evt)
        if (result !== undefined) response = result
      }
      return response
    },
  }
}

/** The sender `fakeMessage()` speaks as, and the default clicker in tests. */
export const SENDER_ID = 'ou_sender_1'

/** A complete inbound message with overridable fields. */
export function fakeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_in_1',
    chatId: 'oc_chat_1',
    chatType: 'p2p',
    senderId: 'ou_sender_1',
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1,
    ...overrides,
  }
}

/**
 * Keywords the host's schema validator accepts, quoted from the diagnostic it
 * raises for anything else: "subset: type/oneOf/properties/required/
 * additionalProperties/items/enum/const + annotations".
 */
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])

/**
 * Walk one schema the way the host's `assertSupportedJsonSchema` does, and
 * throw what it would throw. The rule that actually bit: `required` is an
 * ARRAY on the object, never a flag on a property — the per-property form
 * belongs to the spec that `defineTool` compiles, not to a registrable
 * definition.
 * @param schema - the schema to check.
 * @param path - diagnostic path, as the host builds it.
 */
export function assertSupportedSchema(schema: unknown, path = 'schema'): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`${path} must be a schema object`)
  }
  const node = schema as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      throw new Error(`unsupported JSON schema: ${path}.${key} is not a supported keyword`)
    }
  }
  if ('required' in node) {
    if (!Array.isArray(node.required)) {
      throw new Error(
        `unsupported JSON schema: ${path}.required must be an array of property names, `
        + `not ${JSON.stringify(node.required)} — the per-property form is the uncompiled spec`,
      )
    }
    if (node.type !== 'object') throw new Error(`unsupported JSON schema: ${path}.required needs type "object"`)
  }
  if (node.properties !== undefined) {
    for (const [key, child] of Object.entries(node.properties as Record<string, unknown>)) {
      assertSupportedSchema(child, `${path}.properties.${key}`)
    }
  }
  if (node.items !== undefined) assertSupportedSchema(node.items, `${path}.items`)
  for (const variant of (node.oneOf ?? []) as unknown[]) assertSupportedSchema(variant, `${path}.oneOf`)
}

/**
 * Reject a tool definition the real registry would reject: it demands an
 * output schema with a `render`, validates that schema, and reserves one name.
 * @param definition - the definition being registered.
 */
export function assertRegistrableTool(definition: { name: string; parameters?: unknown; output?: unknown }): void {
  if (definition.name === 'run_code') throw new Error('tool name "run_code" is reserved and cannot be shadowed')
  const output = definition.output as { schema?: unknown; render?: unknown } | undefined
  if (output === undefined || typeof output.render !== 'function') {
    throw new Error(`tool "${definition.name}" must declare output { schema, render }`)
  }
  assertSupportedSchema(output.schema)
  // Not validated by the registry, but the model reads it: a spec-form
  // parameter schema reaches the model as nonsense.
  if (definition.parameters !== undefined) assertSupportedSchema(definition.parameters, 'parameters')
}

/** One agent creation recorded by the fake registry. */
export interface CreatedAgent {
  sessionId: string
  meta: { cwd?: string; agentPreset?: string } | undefined
  agentOptions: HostAgentOptions | undefined
  /** Whether creation ran a composition `setup` callback, and with a scoped context. */
  setupRan: boolean
  /** Deny reason this agent's composed guards give one tool name, if any. */
  denyReason: (name: string) => string | undefined
  /** Prompt sections setup registered on this agent's scope. */
  promptSections: { name: string; order: number; text: string }[]
  /** Tool definitions the composition registered in this agent's own layer. */
  registeredTools: { name: string }[]
  agent: {
    id: string
    session: { id: string; events: { type: string; data: unknown }[] }
    ctx: Context
    followup: ReturnType<typeof vi.fn<(m: HostUserMessage) => void>>
    cancel: ReturnType<typeof vi.fn<(cause: string) => void>>
    whenIdle: () => Promise<void>
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => Promise<T>
    /** Test hook: hold the agent as if a turn were driving it. */
    drive: (driving: boolean) => void
  }
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

/**
 * The deployment's preset table, as the host's `permissionPresets` service
 * publishes it: names plus each one's knob bundle. Defaults to the pair the
 * host ships, and takes extra entries so a test can define the preset a name
 * check would wave through — a custom one that is unconfined under a harmless
 * name.
 */
export function createFakePermissionPresets(
  extra: Record<string, { sandbox: string; approval: string }> = {},
) {
  const table: Record<string, { sandbox: string; approval: string }> = {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    ...extra,
  }
  return {
    get names() { return Object.keys(table) },
    resolve: (name: string) => {
      const spec = table[name]
      if (spec === undefined) throw new Error(`dsh: unknown preset ${name}`)
      return spec
    },
  }
}

/** An in-memory `agents` registry capturing every agent it produced. */
export function createFakeAgents(options: { readonly canRegister?: boolean } = {}) {
  const created: CreatedAgent[] = []
  /** Session ids a test declared stored, so `resume` loads them instead of rejecting. */
  const resumable = new Set<string>()
  /** Agents a test declared already live under another owner, so `get` adopts one. */
  const live = new Map<string, CreatedAgent['agent']>()
  const resumed: string[] = []
  const looked: string[] = []

  const makeAgent = (sessionId: string): CreatedAgent['agent'] => {
    // The idle phase, modelled the way the host documents it: one owner at a
    // time, a REFUSAL THROWN SYNCHRONOUSLY when something already owns it, and
    // `whenIdle` following whatever is running. A looser double would let the
    // channel's own serialization go untested — which is exactly how the last
    // two writer bugs reached a chat.
    let owner: Promise<unknown> | undefined
    let driving = false
    return {
      id: sessionId,
      // A live session carries its log; several host services fold their state
      // out of it rather than mirroring it, and this channel reads two that way.
      session: { id: sessionId, events: [] },
      // A live-reuse composes the chat-only parts on the agent's scope; the fake
      // scope carries no tools, which is the safe-degradation path.
      ctx: new Context(),
      followup: vi.fn<(m: HostUserMessage) => void>(),
      cancel: vi.fn<(cause: string) => void>(),
      whenIdle: async () => {
        while (driving || owner !== undefined) {
          if (owner !== undefined) await owner.catch(() => undefined)
          if (driving) await new Promise((done) => { setTimeout(done, 1) })
        }
      },
      runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        if (driving || owner !== undefined) {
          throw new Error('dsh: an agent activity already owns this agent')
        }
        const controller = new AbortController()
        const running = task(controller.signal)
        owner = running.catch(() => undefined).then(() => { owner = undefined })
        return running
      },
      drive: (next: boolean) => { driving = next },
    }
  }

  /**
   * Run one composition the way the real factory does: on a scoped context
   * carrying the per-agent tools and prompt services, awaited BEFORE the agent
   * is published, so a rejection surfaces to the caller and yields no agent.
   */
  const compose = async (setup?: (agentCtx: Context) => Promise<void>, agent?: CreatedAgent['agent']) => {
    const guards: ((execution: { name: string }) => string | undefined)[] = []
    const sections: { name: string; order: number; text: string }[] = []
    /** Tool definitions this agent's composition registered in its own layer. */
    const registered: { name: string }[] = []
    if (setup !== undefined) {
      // The real factory hands setup the agent's own scope, extended with the
      // agent so `agentCtx.agent` names it; the fake mirrors that shape.
      const agentCtx = agent === undefined ? new Context() : new Context().extend({ agent })
      agentCtx.provide('tools', {
        guard: (g: (e: { name: string }) => string | undefined) => {
          guards.push(g)
          return () => { guards.splice(guards.indexOf(g), 1) }
        },
        // A registry too old for per-agent registrations, which is what the
        // deny fallbacks exist for.
        ...options.canRegister === false ? {} : {
        // The real registry shadows an outer name in an agent's own layer,
        // and validates the definition before accepting it — a definition it
        // rejects fails agent creation, which is how a malformed schema first
        // reached production. The fake enforces the same contract so that
        // class of defect fails here instead.
        register: (definition: { name: string; parameters?: unknown; output?: unknown }) => {
          assertRegistrableTool(definition)
          registered.push(definition)
          return () => { registered.splice(registered.indexOf(definition), 1) }
        },
        },
      })
      agentCtx.provide('systemPrompt', { section: (s: { name: string; order: number; text: string }) => {
        sections.push(s)
        return () => undefined
      } })
      await setup(agentCtx)
    }
    return {
      setupRan: setup !== undefined,
      /** Deny reason the composed guards give a tool, or undefined when allowed. */
      denyReason: (name: string) => guards.map(g => g({ name })).find(r => r !== undefined),
      promptSections: sections,
      registeredTools: registered,
    }
  }

  const service = {
    /** The live agent already published on this id, as the real registry reports it. */
    get(sessionId: string) {
      looked.push(sessionId)
      return live.get(sessionId)
    },
    /**
     * The real registry rejects when nothing is stored under the id — that
     * rejection is this channel's only existence probe. A resumed agent carries
     * no `meta`: the stored session header already holds its cwd and preset.
     */
    async resume(options: {
      readonly resumeSessionId: string
      readonly agentOptions?: HostAgentOptions
      readonly setup?: (agentCtx: Context) => Promise<void>
    }) {
      resumed.push(options.resumeSessionId)
      if (!resumable.has(options.resumeSessionId)) {
        throw new Error(`no stored session for ${options.resumeSessionId} (fake)`)
      }
      const agent = makeAgent(options.resumeSessionId)
      const record: CreatedAgent = {
        sessionId: options.resumeSessionId,
        meta: undefined,
        agentOptions: options.agentOptions,
        ...await compose(options.setup, agent),
        agent,
        dispose: vi.fn<() => Promise<void>>(async () => {}),
      }
      created.push(record)
      return { agent, dispose: record.dispose }
    },
    async create(options: {
      readonly sessionId: string
      readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
      readonly agentOptions?: HostAgentOptions
      readonly setup?: (agentCtx: Context) => Promise<void>
    }) {
      const agent = makeAgent(options.sessionId)
      const record: CreatedAgent = {
        sessionId: options.sessionId,
        meta: options.meta === undefined ? undefined : { ...options.meta },
        agentOptions: options.agentOptions,
        ...await compose(options.setup, agent),
        agent,
        dispose: vi.fn<() => Promise<void>>(async () => {}),
      }
      created.push(record)
      return { agent, dispose: record.dispose }
    },
  }
  return {
    created,
    service,
    /** Ids `resume` loads, and agents `get` adopts. */
    resumable,
    live,
    /** Ids handed to `resume` and to `get`, in call order. */
    resumed,
    looked,
    /** Declare one id already live under another owner. */
    declareLive(sessionId: string): CreatedAgent['agent'] {
      const agent = makeAgent(sessionId)
      live.set(sessionId, agent)
      return agent
    },
    /**
     * Declare one id already live under another owner, with a tools-capable
     * scope that records what a live-reuse composition registers — the shape
     * tests of the reuse fallback need. The bare {@link declareLive} agent
     * carries no tools, which exercises the safe-degradation path; this one
     * exercises the registration path.
     * @param sessionId - the session id to declare live.
     * @param failRegister - make the scope's tool registry reject every
     * registration, to exercise the reuse-failure fallback.
     */
    declareLiveWithScope(
      sessionId: string,
      options: { failRegister?: boolean } = {},
    ): {
      agent: CreatedAgent['agent']
      registeredTools: { name: string }[]
      promptSections: { name: string; order: number; text: string }[]
      denyReason: (name: string) => string | undefined
    } {
      const agent = makeAgent(sessionId)
      const guards: ((execution: { name: string }) => string | undefined)[] = []
      const sections: { name: string; order: number; text: string }[] = []
      const registered: { name: string }[] = []
      const ctx = new Context()
      ctx.provide('tools', {
        guard: (g: (e: { name: string }) => string | undefined) => {
          guards.push(g)
          return () => { guards.splice(guards.indexOf(g), 1) }
        },
        register: (definition: { name: string }) => {
          if (options.failRegister === true) throw new Error('registry rejects (fake)')
          registered.push(definition)
          return () => { registered.splice(registered.indexOf(definition), 1) }
        },
      })
      ctx.provide('systemPrompt', { section: (s: { name: string; order: number; text: string }) => {
        sections.push(s)
        return () => undefined
      } })
      agent.ctx = ctx
      live.set(sessionId, agent)
      return {
        agent,
        registeredTools: registered,
        promptSections: sections,
        denyReason: (name: string) => guards.map(g => g({ name })).find(r => r !== undefined),
      }
    },
  }
}

/** One line the plugin logged, at the level it chose. */
export interface LoggedLine {
  type: 'error' | 'info' | 'warn' | 'debug'
  /** The format string and its parameters, joined; assert with `toContain`. */
  text: string
}

/** Plugin config overrides; an explicit `undefined` removes a harness default. */
type ConfigOverrides = { [K in keyof plugin.Config]?: plugin.Config[K] | undefined }

/** Mount the production plugin over the fake port and fake `agents` registry. */
export async function mountChannel(
  config: ConfigOverrides = {},
  services: {
    defaultModel?: HostDefaultModel
    settings?: HostSettings
    registerApp?: RegisterAppPort
    presets?: HostAgentPresets
    /**
     * An answerer registered BEFORE the plugin, as a host row that mounts
     * during tree load is (the Web app's BFF claims every audited approval and
     * never delegates). Records whether it was ever consulted.
     */
    competingAnswerer?: { claims: { toolName: string }[] }
    /** The `tools` registry the bridge describes calls through. */
    tools?: object
    /** The `workspaceRegistry` chat sessions are accounted under. */
    workspaces?: object
    /** The `sessionQuery` /session lists and verifies sessions through. */
    sessionQuery?: object
    /** The `commands` runtime slash lines dispatch through. */
    commands?: object
    /** The `attachments` store chat images are committed to. */
    attachments?: object
    /** The `llm` registry `/model` lists routes from. */
    llm?: object
    /** The `planMode` service a shadowed plan review switches through. */
    planMode?: object
    /** The `sessionProjections` registry the preset and meter reads go through. */
    sessionProjections?: object
    /** The `permissionPresets` table a preset switch is classified against. */
    permissionPresets?: object
    /** False models a tool registry too old to take per-agent registrations. */
    agentsCanRegisterTools?: boolean
    /** The `credentials` seam the app secret is stored behind. */
    credentials?: object
  } = {},
) {
  const ctx = new Context()
  const logs: LoggedLine[] = []
  // Cordis buffers log messages and prints nothing without an exporter, and its
  // default exporter level drops `debug`; this one keeps every level so a test
  // can tell an operator-console line from one deliberately kept off it.
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      logs.push({ type: message.type, text: (message.args as unknown[]).map(part => String(part)).join(' ') })
    },
  })
  const agents = createFakeAgents(services.agentsCanRegisterTools === false ? { canRegister: false } : {})
  const competing = services.competingAnswerer
  if (competing !== undefined) {
    ctx.on('approval/request', (request) => {
      competing.claims.push({ toolName: request.toolName })
      // Claims the question without delegating, exactly like the BFF.
      return new Promise<HostApprovalOutcome>(() => {})
    })
  }
  ctx.provide('agents', agents.service)
  if (services.defaultModel !== undefined) ctx.provide('agentDefaultModel', services.defaultModel)
  if (services.settings !== undefined) ctx.provide('settings', services.settings)
  if (services.presets !== undefined) ctx.provide('agentPresets', services.presets)
  if (services.tools !== undefined) ctx.provide('tools', services.tools)
  if (services.workspaces !== undefined) ctx.provide('workspaceRegistry', services.workspaces)
  if (services.sessionQuery !== undefined) ctx.provide('sessionQuery', services.sessionQuery)
  if (services.llm !== undefined) ctx.provide('llm', services.llm)
  if (services.planMode !== undefined) ctx.provide('planMode', services.planMode)
  if (services.sessionProjections !== undefined) ctx.provide('sessionProjections', services.sessionProjections)
  if (services.permissionPresets !== undefined) ctx.provide('permissionPresets', services.permissionPresets)
  if (services.credentials !== undefined) ctx.provide('credentials', services.credentials)
  if (services.commands !== undefined) ctx.provide('commands', services.commands)
  if (services.attachments !== undefined) ctx.provide('attachments', services.attachments)
  const fake = createFakePort()
  const portConfigs: ChannelConfig[] = []
  const notices: string[] = []
  const originalCreatePort = internals.createPort
  const originalRegisterApp = internals.registerApp
  const originalNotify = internals.notify
  const portAuthorizations: {
    directSenders: string[]
    groups: string[]
    approvers: string[]
  }[] = []
  internals.createPort = (portConfig, authorization) => {
    portConfigs.push(portConfig)
    portAuthorizations.push({
      directSenders: [...authorization.directSenders],
      groups: [...authorization.groups],
      approvers: [...authorization.approvers],
    })
    return fake.port
  }
  internals.registerApp = services.registerApp
    ?? (() => Promise.reject(new Error('registerApp not faked for this test')))
  internals.notify = (line) => { notices.push(line) }
  // A re-issued QR code waits out the production floor, which a test must not.
  internals.reissueFloorMs = 0
  const merged = {
    appId: 'cli_test',
    appSecret: 'test-secret',
    provider: 'test-provider',
    model: 'test-model',
    ...config,
  } as plugin.Config
  const fiber = await ctx.plugin(plugin, merged)
  // Activation bootstraps asynchronously; hold until the bridge subscribed when
  // the mount alone is expected to reach a connected channel.
  if (merged.appId !== undefined && merged.appSecret !== undefined && services.settings === undefined) {
    await vi.waitFor(() => {
      if (fake.state.subscriptions !== INBOUND_SUBSCRIPTIONS) throw new Error('bridge not subscribed yet')
    })
  }
  return {
    ctx,
    fiber,
    fake,
    agents,
    portConfigs,
    portAuthorizations,
    notices,
    logs,
    async dispose(): Promise<void> {
      try {
        await fiber.dispose()
      } finally {
        internals.createPort = originalCreatePort
        internals.registerApp = originalRegisterApp
        internals.notify = originalNotify
        delete internals.reissueFloorMs
      }
    },
  }
}

/** An in-memory `agentPresets` roster recording every resolve and mount. */
export function createFakePresets(ids: string[] = ['default'], defaultId = ids[0]!) {
  const mounted: { id: string | undefined; scoped: boolean }[] = []
  const resolved: (string | undefined)[] = []
  const presets: HostAgentPresets = {
    async resolve(id) {
      resolved.push(id)
      const wanted = id ?? defaultId
      if (!ids.includes(wanted)) throw new Error(`agent-presets: unknown preset "${wanted}"`)
      return { id: wanted }
    },
    async mount(agentCtx, id) {
      mounted.push({ id, scoped: agentCtx !== undefined })
      return undefined
    },
    async standingKeyFor(id) {
      return `standing:${id ?? defaultId}`
    },
  }
  return { presets, mounted, resolved }
}

/** An in-memory `workspaceRegistry` recording lookups, creations, and attachments. */
export function createFakeWorkspaces(registered: Record<string, string> = {}) {
  const created: string[] = []
  const attached: { workspaceId: string; sessionId: string }[] = []
  const state = { failAttach: false }
  const entity = (path: string, id: string) => ({
    id,
    path,
    async attachSession(sessionId: string) {
      if (state.failAttach) throw new Error('cwd does not match the workspace path (fake)')
      attached.push({ workspaceId: id, sessionId })
    },
  })
  const service = {
    async resolveByPath(path: string) {
      const id = registered[path]
      return id === undefined ? undefined : entity(path, id)
    },
    async create(path: string) {
      created.push(path)
      const id = `ws_created_${created.length}`
      registered[path] = id
      return entity(path, id)
    },
    /** Every registered workspace, as the real registry's listing reports them. */
    list() {
      return Object.entries(registered).map(([path, id]) => entity(path, id))
    },
  }
  return { service, created, attached, state }
}

/** An in-memory `sessionQuery` listing a fixed set of persisted sessions. */
export function createFakeSessionQuery(sessions: Array<{ id: string; cwd?: string; createdAt?: number }> = []) {
  const service: {
    listSessions(): Promise<Array<{ header?: { id?: string; cwd?: string; createdAt?: number } }>>
    readTitleSnapshots(ids: readonly string[]): Promise<Array<{
      sessionId: string
      status: string
      value: { session: { id: string }; title: { title?: string | undefined } }
    }>>
  } = {
    async listSessions() {
      return sessions.map(session => ({
        header: {
          id: session.id,
          ...session.cwd === undefined ? {} : { cwd: session.cwd },
          ...session.createdAt === undefined ? {} : { createdAt: session.createdAt },
        },
      }))
    },
    async readTitleSnapshots(ids) {
      return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { session: { id: sessionId }, title: { title: undefined } } }))
    },
  }
  return { service, sessions }
}

/** An in-memory `attachments` store recording every committed image. */
export function createFakeAttachments(limits: Partial<HostImageLimits> = {}) {
  const saved: { mediaType: string; bytes: number; name?: string }[] = []
  const state = { failSave: false }
  const service: HostAttachments = {
    imageLimits: {
      maxImageBytes: 1_000_000,
      maxImagesPerMessage: 3,
      maxMessageImageBytes: 2_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      ...limits,
    },
    async saveImage(input) {
      if (state.failSave) throw new Error('store rejected the image (fake)')
      saved.push({
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        ...input.name === undefined ? {} : { name: input.name },
      })
      return {
        attachmentId: `att_${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 100,
        height: 50,
        ...input.name === undefined ? {} : { name: input.name },
      }
    },
  }
  return { service, saved, state }
}

/** An in-memory `commands` runtime recording every dispatched line. */
export function createFakeCommands(
  available: { name: string; description: string }[] = [{ name: 'clear', description: '开始新的对话' }],
  outcomes: Record<string, { kind: 'success'; text?: string } | { kind: 'error'; text: string }> = {},
) {
  const executed: string[] = []
  const service: HostCommands = {
    list: () => available,
    async execute(_agent, line, _signal) {
      executed.push(line)
      const name = commandName(line) ?? ''
      if (!available.some(c => c.name === name)) return undefined
      return { result: outcomes[name] ?? { kind: 'success', text: `ran ${name}` } }
    },
  }
  return { service, executed }
}

/** An in-memory `tools` registry that can describe calls and record guards. */
export function createFakeTools(
  presenters: Record<string, (args: unknown) => { title?: string } | undefined> = {},
) {
  const views: { name: string; scope: unknown }[] = []
  const service = {
    guard: () => () => undefined,
    get(name: string, scope?: unknown) {
      views.push({ name, scope })
      const presentCall = presenters[name]
      return presentCall === undefined ? undefined : { presentCall }
    },
  }
  return { service, views }
}

/** An in-memory `settings` service: one namespace layering base under `stored`. */
export function createFakeSettings(stored: Record<string, unknown> = {}) {
  const updates: object[] = []
  const registered: { ns: string; base: unknown }[] = []
  const settings: HostSettings = {
    register(ns, _schema, options) {
      registered.push({ ns, base: options?.base })
      return {
        get: () => ({ ...(options?.base as Record<string, unknown>), ...stored }),
        update: async (patch) => {
          updates.push(patch)
          Object.assign(stored, patch)
        },
      }
    },
  }
  return { settings, updates, registered }
}

/** One node of a card, as the tests need to see it. */
interface CardNode {
  readonly tag?: string
  readonly content?: string
  readonly i18n?: Record<string, string>
  readonly text?: { readonly tag?: string; readonly content?: string; readonly i18n?: Record<string, string> }
  readonly behaviors?: { readonly type?: string; readonly value?: unknown }[]
  readonly elements?: CardNode[]
  readonly columns?: CardNode[]
  readonly options?: CardNode[]
  readonly body?: CardNode
}

/**
 * Every node of a card, at any depth.
 *
 * The tests walk rather than index because layout is the card module's
 * business: nesting a control inside a column or a container must not be able
 * to quietly drop it from a safety assertion.
 * @param card - a built card object.
 * @returns every node, parents before children.
 */
export function cardNodes(card: object): CardNode[] {
  const found: CardNode[] = []
  const walk = (node: CardNode | undefined): void => {
    if (node === undefined || node === null || typeof node !== 'object') return
    found.push(node)
    for (const child of [...node.elements ?? [], ...node.columns ?? [], ...node.options ?? []]) walk(child)
    walk(node.body)
  }
  walk(card as CardNode)
  return found
}

/**
 * Every string a card renders, paired with the tag that renders it and the
 * translations it carries. A tag of `markdown` or `lark_md` means the string
 * is interpreted as markup; an `i18n` map means the card authored the string
 * itself rather than borrowing it.
 * @param card - a built card object.
 * @returns one entry per rendered string.
 */
export function cardTexts(card: object): { tag: string; content: string; i18n?: Record<string, string> }[] {
  return cardNodes(card).flatMap((node) => {
    if (node.text?.content !== undefined) {
      return [{
        tag: node.text.tag ?? 'plain_text',
        content: node.text.content,
        ...node.text.i18n === undefined ? {} : { i18n: node.text.i18n },
      }]
    }
    if (node.tag === 'markdown' && node.content !== undefined) return [{ tag: 'markdown', content: node.content }]
    if (node.tag === 'plain_text' && node.content !== undefined) {
      return [{ tag: 'plain_text', content: node.content, ...node.i18n === undefined ? {} : { i18n: node.i18n } }]
    }
    return []
  })
}

/**
 * Every clickable thing a card carries, whatever shape it takes: a button, or
 * a whole container row that answers when pressed.
 * @param card - a built card object.
 * @returns each control's visible label and its callback payload.
 */
export function cardControls(card: object): { label: string; value: unknown }[] {
  return cardNodes(card).flatMap((node) => {
    const callback = (node.behaviors ?? []).find((behavior) => behavior.type === 'callback')
    if (callback === undefined) return []
    const label = node.text?.content
      ?? cardTexts(node as object).find((text) => text.content !== '')?.content
      ?? ''
    return [{ label, value: callback.value }]
  })
}

/**
 * An in-memory credentials provider, as the host seam behaves: `resolve`
 * answers with a value and its source, `set` stores one.
 * @param seeded - references already configured before the plugin starts.
 * @returns the service and the store behind it.
 */
export function createFakeCredentials(seeded: Record<string, string> = {}) {
  const values = new Map(Object.entries(seeded))
  const stored: { ref: string; value: string }[] = []
  return {
    values,
    stored,
    credentials: {
      resolve: async (ref: string) => {
        const value = values.get(ref)
        return value === undefined ? undefined : { value, source: 'file' }
      },
      set: async (ref: string, value: string) => {
        if (value === '') throw new Error('an empty value cannot be stored (fake)')
        values.set(ref, value)
        stored.push({ ref, value })
      },
    },
  }
}

/** Extract the approval correlation payload from a sent card's buttons. */
export function approvalValueFromCard(card: object): { kind: string; id: string; decision: string }[] {
  return cardControls(card).map((control) => control.value as { kind: string; id: string; decision: string })
}
