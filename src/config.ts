/**
 * Serializable configuration, schema, and direct-call defaults.
 * @module dsh-lark-channel/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_BOT_HOPS } from './botchat.ts'
import type { SessionScope } from './session.ts'

/**
 * Tools whose answer cannot reach a chat.
 *
 * Empty now. Both tools that used to sit here — `ask_user_question` and
 * `exit_plan_mode` — ask through `ctx.userQuestions`, whose single provider
 * belongs to whichever UI registered it first, so their answers would surface
 * where nobody in this chat is watching. Each is shadowed per agent instead
 * and asks here, as a card. A deployment may still name either one, and that
 * denial wins; so does the fallback, which re-denies a tool whose shadow could
 * not be registered.
 */
const DEFAULT_DENY_TOOLS = [] as const

/**
 * Runtime plugin configuration supplied by the profile composition. Package
 * installation policy is owned by the provisioning CLI, not this schema.
 */
export interface Config {
  /**
   * Names this row when a deployment composes more than one, so two bots keep
   * separate settings sections, separate app-secret credentials, and separate
   * session ids — two bots in one group would otherwise share an agent.
   *
   * Absent is the original single-row deployment, whose identifiers are
   * unchanged: name the SECOND row, never the first, and nothing already
   * stored moves.
   */
  instance?: string
  /** Lark/Feishu app id (`cli_…`); absent (with no stored credential) starts first-boot QR registration. */
  appId?: string
  /**
   * Lark/Feishu app secret paired with {@link appId}. A deployment that
   * injects one here keeps owning it; onboarding stores what it scans behind
   * {@link Config.appSecretRef} instead, so nothing writes a secret into the
   * user settings document that a credentials provider could hold.
   */
  appSecret?: string
  /**
   * Name of the credential holding the app secret, resolved through
   * `ctx.credentials` on every boot: an environment variable, a dotenv entry,
   * or the provider's own store, whichever is configured.
   */
  appSecretRef?: string
  /**
   * Managed state, not hand-written configuration: open id of the user who
   * completed first-boot registration. On-demand document authorization sends
   * its app-changing link to this person instead of exposing it in a group.
   */
  registeredBy?: string
  /** Open-platform domain: `https://open.feishu.cn` (default) or `https://open.larksuite.com`. */
  domain?: string
  /** Absolute workspace directory for chat-driven agents; defaults to the host process cwd. */
  cwd?: string
  /**
   * Directory prefixes `/cd` may point a conversation at; empty allows any
   * existing directory. The platform already decides who can reach the bot at
   * all, so this only narrows where those people may aim it — set it when the
   * bot serves a room whose members should not roam the filesystem.
   */
  workspaceRoots?: string[]
  /**
   * Managed state, not configuration: the workspace each conversation was
   * `/cd`-ed to, keyed by conversation key, written back through the settings
   * service. An empty-string value marks "explicitly the default" — the
   * persistence layer deep-merges patches, so entries are overwritten rather
   * than deleted.
   */
  chatWorkspaces?: Record<string, string>
  /**
   * Managed state, not configuration: the `provider/model` route each
   * conversation asked for via `/model use`, keyed by conversation key, with
   * the same empty-string default marker as {@link chatWorkspaces}.
   */
  chatModels?: Record<string, string>
  /**
   * Managed state, not configuration: how many times each conversation has
   * started over with `/new`, keyed by the session id it derives at epoch
   * zero. Absent is the first session, whose id is unchanged.
   */
  chatEpochs?: Record<string, string>
  /**
   * Managed state, not configuration: how many times each canonical document
   * conversation has been reset with `/doc reset`, keyed by `doc:<fileToken>`.
   * Absent is the original durable session id.
   */
  documentGenerations?: Record<string, string>
  /** Provider route override for chat agents; defaults to the host `agentDefaultModel` selection. */
  provider?: string
  /** Model id override for chat agents; defaults to the host `agentDefaultModel` selection. */
  model?: string
  /**
   * Agent preset chat agents join, when the deployment composes a roster.
   * Absent joins the roster default. A deployment WITH a roster keeps every
   * model-facing row on the agent plane, so joining nothing would reach the
   * model with no tools at all.
   */
  preset?: string
  /**
   * Which conversation facet owns one agent session. The session id is derived
   * from that facet alone, so a restarted process reaches the conversation's
   * stored session instead of starting it over. `chat` gives a group one shared
   * agent; `chat-thread` gives each topic thread its own, so parallel topics
   * stop overwriting each other's context; `chat-sender` gives each person in a
   * shared chat their own.
   */
  sessionScope?: SessionScope
  /**
   * How assistant output reaches the chat. `cot` (default) shows the process as
   * a native thinking-process message — reasoning, tool calls with icons,
   * results as code — and sends the answer as an ordinary message, which is
   * where the platform says a final answer belongs. It needs a client new
   * enough to render one (PC 7.70, mobile 7.74); `stream` keeps the whole turn
   * in one typewriter card, for clients older than that surface.
   */
  output?: 'cot' | 'stream'
  /**
   * Show what the agent did on its way to an answer: its reasoning and the
   * tools it called. Off sends the answer alone.
   */
  showProcess?: boolean
  /**
   * Pass images a chat sends on to the model.
   *
   * Off by default, and deliberately: a route that cannot take images rejects
   * the whole request, the image is already in the session log by then, and
   * every later turn resends it — so one screenshot ends the conversation for
   * good, with no way back from the chat, because compaction sends that history
   * too. The host exposes no way to ask a route whether it accepts images, so
   * the deployment that knows its route is a vision one says so here.
   *
   * This is the division of labour with {@link receiveFiles}: this field says
   * whether an image's bytes reach the model's context, where token cost and
   * pixel-borne prompt injection are the things to weigh; {@link receiveFiles}
   * says whether the file behind any attachment — images included — lands on
   * disk so the agent has a path to it, with the content never entering
   * context either way. That split is also why there is no `attachFiles`:
   * attaching and landing are different operations with different risk
   * profiles, and one name should not paper over both.
   */
  attachImages?: boolean
  /**
   * Save files a chat sends into `.dsh-lark/inbox/` under the current
   * conversation's workspace, so the agent gets a path to work with instead
   * of a resource descriptor it has no way to read.
   *
   * On by default: a file's bytes never enter the model's context this way —
   * only its path does — so turning this on does not widen what the model can
   * see or do. It only fixes a worse status quo, where the transport already
   * tells the model a file's name and leaves it with no way to reach the
   * content behind it.
   */
  receiveFiles?: boolean
  /**
   * Ceiling, in bytes, on one inbound file; a file over it is discarded
   * rather than landed anyway.
   *
   * A whole message's total is capped too, at three times this number — a
   * message shipping twenty files each just under the per-file limit would
   * otherwise write twenty times as much to disk in one shot. That multiplier
   * is not its own setting: its only reason to exist is to track this one, so
   * letting it drift on its own would just reopen the same hole from a
   * different angle.
   */
  maxReceiveFileBytes?: number
  /**
   * Let chat agents send files out of their workspace back into the chat on
   * their own initiative.
   *
   * On by default: the risk this would otherwise carry is already handled
   * structurally rather than left for a deployment to opt into — a direct
   * message reaches only the person whose authorization is driving the agent,
   * so there is no exfiltration boundary to cross, while a group chat instead
   * gets an approval card on every send. A gate that only takes effect once a
   * deployment remembers to flip it is not a gate at all. There is
   * deliberately no setting here to turn the group approval off: that would
   * be an official back door for a prompt-injection exfiltration chain.
   */
  sendFiles?: boolean
  /**
   * Ceiling, in bytes, on one outbound file.
   *
   * An outbound file is read whole into a `Buffer` before the SDK ever sees
   * it, rather than handed over by path, so this number bounds how much of
   * the process's heap one send can claim — it is a memory safety limit
   * first, and only a courtesy to the recipient second.
   */
  maxSendFileBytes?: number
  /**
   * Let chat agents publish workspace artifacts as cloud documents. On by
   * default. New documents grant exactly the receiving direct user or group;
   * model-driven group creation waits for approval, while human `/put` does
   * not. The model tool creates only; human `/put --into` may append to its
   * explicit target. Agent-owned sends share the per-chat held-content ceiling
   * with `send_file`.
   */
  sendDocs?: boolean
  /**
   * Enable document-comment events as an agent conversation surface. One
   * durable session is derived per document; only explicit non-self mentions
   * open turns, and terminal replies return to the triggering comment thread.
   */
  commentDocs?: boolean
  /**
   * Start the QR re-authorization flow when a real document call reports
   * missing tenant scopes. The same additive request includes the document
   * comment event subscription. Off leaves the failure visible without sending
   * an app-configuration link.
   */
  docAuthorizeOnDemand?: boolean
  /**
   * Let the platform drop the process once its run finishes, leaving only the
   * answer in the conversation. `cot` output only.
   */
  hideProcessWhenDone?: boolean
  /**
   * Register this channel's commands on the bot so Feishu offers them when a
   * user types `/`. Reconciling: the panel ends up offering exactly what this
   * channel accepts, so an entry it no longer offers is removed rather than
   * left to answer "unknown command". Off means commands still work, typed
   * from memory, and a hand-curated panel is left untouched.
   */
  syncSlashCommands?: boolean
  /**
   * Tools chat agents may not call, denied per agent at execution with a
   * reason that redirects the model to the chat.
   *
   * The default names the two human-interaction tools whose answers cannot
   * reach this channel: `ctx.userQuestions` admits ONE provider per context,
   * so when any other UI registered it (the Web app's BFF claims every
   * agent-owned question) a chat agent's question would wait on a surface its
   * human is not watching. Asking in the chat is the native equivalent — a
   * reply is an ordinary message this bridge already turns into the next turn.
   */
  denyTools?: string[]
  /**
   * Bot open ids this channel answers, when a deployment wants only certain
   * ones. Empty — the default — narrows nothing, exactly like every other list
   * here: a bot someone added to a room this channel already serves is part of
   * that room's arrangement. {@link botHops} is what bounds the exchange.
   */
  botPeers?: string[]
  /**
   * Consecutive bot-sourced turns one conversation may run before this channel
   * stops answering. A human message refills it. Without a bound, two agents
   * answer each other until someone notices the bill.
   */
  botHops?: number
  /** In group chats, only respond when the bot is @-mentioned. */
  requireMention?: boolean
  /**
   * Open ids (`ou_…`) allowed to send direct messages, when a deployment wants
   * to narrow them further. Empty serves anyone who can reach the bot at all,
   * which the platform already decides: an app's visibility scope is what says
   * who in the tenant may open a conversation with it, and that decision
   * belongs in the developer console rather than duplicated here.
   */
  senderAllowlist?: string[]
  /**
   * When non-empty, only these group chat ids (`oc_…`) are served. Empty serves
   * any group the bot is added to. Group members are NOT gated individually:
   * a group is a room someone deliberately put the bot in, so the gate that
   * matters is which rooms, and {@link requireMention} decides what counts as
   * addressing it.
   */
  groupAllowlist?: string[]
  /**
   * Open ids (`ou_…`) allowed to answer approval questions. Empty lets whoever
   * may drive that chat answer it too, which in a group is the room; the
   * settled card names who decided either way. When the callback omits a name,
   * the channel may best-effort resolve it from the chat roster and safely
   * falls back to the open id. Set this when an escalation should need a named
   * human — it grants more power than the sandbox allows.
   */
  approvers?: string[]
}

/** Configuration after defaults have been resolved; credentials may still be pending onboarding. */
export interface ResolvedConfig {
  instance?: string | undefined
  appId?: string | undefined
  appSecret?: string | undefined
  appSecretRef?: string | undefined
  registeredBy?: string | undefined
  domain?: string | undefined
  cwd?: string | undefined
  workspaceRoots: string[]
  chatWorkspaces: Record<string, string>
  chatModels: Record<string, string>
  chatEpochs: Record<string, string>
  documentGenerations: Record<string, string>
  provider?: string | undefined
  model?: string | undefined
  preset?: string | undefined
  sessionScope: SessionScope
  output: 'cot' | 'stream'
  showProcess: boolean
  attachImages: boolean
  receiveFiles: boolean
  maxReceiveFileBytes: number
  sendFiles: boolean
  maxSendFileBytes: number
  sendDocs: boolean
  commentDocs: boolean
  docAuthorizeOnDemand: boolean
  hideProcessWhenDone: boolean
  syncSlashCommands: boolean
  denyTools: string[]
  botPeers: string[]
  botHops: number
  requireMention: boolean
  senderAllowlist: string[]
  groupAllowlist: string[]
  approvers: string[]
}

/** Loader-visible configuration schema and defaults. */
export const Config: z<Config> = z.object({
  instance: z.string(),
  appId: z.string(),
  appSecret: z.string().role('secret'),
  appSecretRef: z.string(),
  registeredBy: z.string(),
  domain: z.string(),
  cwd: z.string(),
  workspaceRoots: z.array(String),
  chatWorkspaces: z.dict(String).default({}),
  chatModels: z.dict(String).default({}),
  chatEpochs: z.dict(String).default({}),
  documentGenerations: z.dict(String).default({}),
  provider: z.string(),
  model: z.string(),
  preset: z.string(),
  sessionScope: z.union(['chat', 'chat-thread', 'chat-sender'] as const).default('chat'),
  output: z.union(['cot', 'stream'] as const).default('cot'),
  showProcess: z.boolean().default(true),
  attachImages: z.boolean().default(false),
  receiveFiles: z.boolean().default(true),
  maxReceiveFileBytes: z.number().default(20 * 1024 * 1024),
  sendFiles: z.boolean().default(true),
  maxSendFileBytes: z.number().default(20 * 1024 * 1024),
  sendDocs: z.boolean().default(true),
  commentDocs: z.boolean().default(true),
  docAuthorizeOnDemand: z.boolean().default(true),
  hideProcessWhenDone: z.boolean().default(false),
  syncSlashCommands: z.boolean().default(true),
  denyTools: z.array(String).default([...DEFAULT_DENY_TOOLS]),
  botPeers: z.array(String).default([]),
  botHops: z.number().default(DEFAULT_BOT_HOPS),
  requireMention: z.boolean().default(true),
  senderAllowlist: z.array(String),
  groupAllowlist: z.array(String),
  approvers: z.array(String),
})

/**
 * Resolve the same defaults for direct callers that bypass Cordis Loader.
 * @param config - Serialized configuration with the required credentials.
 * @returns Configuration with all schema defaults applied.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...config,
    workspaceRoots: config.workspaceRoots ?? [],
    chatWorkspaces: config.chatWorkspaces ?? {},
    chatModels: config.chatModels ?? {},
    chatEpochs: config.chatEpochs ?? {},
    documentGenerations: config.documentGenerations ?? {},
    sessionScope: config.sessionScope ?? 'chat',
    output: config.output ?? 'cot',
    showProcess: config.showProcess ?? true,
    attachImages: config.attachImages ?? false,
    receiveFiles: config.receiveFiles ?? true,
    maxReceiveFileBytes: config.maxReceiveFileBytes ?? 20 * 1024 * 1024,
    sendFiles: config.sendFiles ?? true,
    maxSendFileBytes: config.maxSendFileBytes ?? 20 * 1024 * 1024,
    sendDocs: config.sendDocs ?? true,
    commentDocs: config.commentDocs ?? true,
    docAuthorizeOnDemand: config.docAuthorizeOnDemand ?? true,
    hideProcessWhenDone: config.hideProcessWhenDone ?? false,
    syncSlashCommands: config.syncSlashCommands ?? true,
    denyTools: config.denyTools ?? [...DEFAULT_DENY_TOOLS],
    botPeers: config.botPeers ?? [],
    botHops: config.botHops ?? DEFAULT_BOT_HOPS,
    requireMention: config.requireMention ?? true,
    senderAllowlist: config.senderAllowlist ?? [],
    groupAllowlist: config.groupAllowlist ?? [],
    approvers: config.approvers ?? [],
  }
}
