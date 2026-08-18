/**
 * Per-conversation workspaces. `/cd` points one conversation at a directory,
 * and the conversation's session id is derived from BOTH facts, so every
 * (conversation × directory) pair owns a durable session of its own. That turns
 * a host constraint into the feature: a session's cwd is fixed at creation, so
 * "switching" is really reaching a different session — and coming back to a
 * directory resumes the context that was built there instead of erasing it.
 *
 * The mapping persists through the host settings service, in the same section
 * that already holds onboarded credentials, so a restarted process routes every
 * conversation to the session it served before. Entries never need deletion —
 * the persistence layer deep-merges patches — so "back to the default" is an
 * explicit marker value rather than an absent key.
 * @module dsh-lark-channel/workspace
 */

import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { epochSessionId } from './epoch.ts'
import { sessionIdFor } from './session.ts'

/** Switch or show this conversation's workspace. Channel-owned: it needs no agent. */
export const CD_COMMAND = 'cd'

/** List the workspaces this channel knows. Channel-owned: it needs no agent. */
export const WS_COMMAND = 'ws'

/** Entry value marking "explicitly the default": a deep-merged patch cannot delete a key. */
const DEFAULT_MARKER = ''

/**
 * Verdict on one directory: its canonical path, or why it cannot be a workspace.
 * Injectable so command tests need no real filesystem.
 */
export type WorkspaceProbe = (path: string) => { readonly canonical: string } | { readonly error: string }

/** The real-filesystem probe: the directory must exist, and spellings collapse to one. */
export const probeDirectory: WorkspaceProbe = (path) => {
  try {
    if (!statSync(path).isDirectory()) return { error: '不是目录' }
    return { canonical: realpathSync(path) }
  } catch {
    return { error: '目录不存在' }
  }
}

/**
 * Expand a leading `~` against the operating-system home, the one path shorthand
 * a phone keyboard makes worth supporting.
 * @param input - the operator's path input.
 * @param home - substitutable home directory.
 * @returns the expanded path, or the input untouched.
 */
export function expandHome(input: string, home = homedir()): string {
  if (input === '~') return home
  if (input.startsWith('~/')) return resolve(home, input.slice(2))
  return input
}

/**
 * Why a directory can never be a workspace, however permissive the roots are.
 * These are the directories a `/cd` typo or a lazy shortcut lands on — and an
 * agent whose sandbox writes "the workspace" must not have that be the
 * filesystem root or someone's entire home.
 * @param canonical - the canonicalized candidate.
 * @param home - the home directory, canonicalized by the caller's probe.
 * @returns the refusal, or undefined when the directory is specific enough.
 */
export function forbiddenReason(canonical: string, home = homedir()): string | undefined {
  if (dirname(canonical) === canonical) return '不能把文件系统根目录设为工作区'
  if (canonical === home) return '不能把 Home 根目录设为工作区，请选更具体的子目录'
  if (canonical === dirname(home)) return '不能把用户目录的父级设为工作区'
  return undefined
}

/**
 * Whether a path falls under one of the configured roots. An empty list allows
 * anywhere: the platform already decides who can reach the bot, and this knob
 * only narrows what those people may point it at.
 * @param path - canonical candidate directory.
 * @param roots - allowed directory prefixes.
 * @returns true when allowed.
 */
export function withinRoots(path: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true
  return roots.some((root) => {
    const resolved = resolve(root)
    return path === resolved || path.startsWith(resolved.endsWith(sep) ? resolved : `${resolved}${sep}`)
  })
}

/**
 * The session id one conversation-and-workspace pair owns. The default
 * workspace keeps the historical plain id, so existing conversations keep their
 * sessions across this feature's arrival; an override appends a digest of the
 * canonical directory, so two spellings of one directory reach one session and
 * two directories never share.
 * @param key - conversation key.
 * @param overridePath - canonical override directory, absent for the default.
 * @returns the branded session id.
 */
export function workspaceSessionId(key: string, overridePath?: string, prefix?: string): string {
  const base = sessionIdFor(key, prefix)
  if (overridePath === undefined) return base
  return `${base}--${createHash('sha256').update(overridePath).digest('hex').slice(0, 10)}`
}

/** What one `/cd` attempt concluded. */
export type SwitchResult =
  | {
      readonly ok: true
      /** The conversation's workspace after the switch. */
      readonly path: string
      /** False when the conversation was already there. */
      readonly changed: boolean
      /** Whether the target is the deployment default. */
      readonly toDefault: boolean
      /** Whether the mapping survives a restart. */
      readonly durable: boolean
    }
  | { readonly ok: false; readonly reason: string }

/** Construction options for {@link ChatWorkspaces}. */
export interface ChatWorkspacesOptions {
  /** The deployment default directory (resolved, not necessarily canonical). */
  readonly defaultPath: string
  /** Persisted conversation-key → directory entries; {@link DEFAULT_MARKER} means default. */
  readonly entries?: Record<string, string> | undefined
  /** Directory prefixes `/cd` may enter; empty allows anywhere. */
  readonly roots?: readonly string[] | undefined
  /** Deep-merge one patch into the plugin's settings section; false = not composed. */
  readonly persist?: ((patch: { chatWorkspaces: Record<string, string> }) => Promise<boolean>) | undefined
  /** Operator console line. */
  readonly report?: ((line: string) => void) | undefined
  /** Directory verdicts; tests substitute one. */
  readonly probe?: WorkspaceProbe | undefined
  /** Home for `~` expansion and the forbidden-directory rules; tests substitute one. */
  readonly home?: string | undefined
  /** Prefix this row's session ids carry; absent keeps the original one. */
  readonly sessionPrefix?: string | undefined
  /**
   * How many times a conversation has started over, by the id it derives at
   * epoch zero. Absent keeps every conversation on its first.
   */
  readonly epochOf?: ((baseId: string) => number) | undefined
  /**
   * Directories known outside this channel — the host workspace registry's
   * listing, when the deployment composes one. What `/ws` shows and what a
   * bare-name `/cd` can reach, so a chat can discover every project its human
   * already uses with the host instead of memorizing paths.
   */
  readonly known?: (() => readonly string[]) | undefined
}

/**
 * The per-conversation workspace state: which directory each conversation is
 * pointed at, the session id that pair owns, and the `/cd` transition between
 * them. Pure state plus injected effects, so tests drive it without a
 * filesystem or a settings service.
 */
export class ChatWorkspaces {
  private readonly entries: Map<string, string>
  private readonly defaultPath: string
  /** The default's canonical form, for deciding that a `/cd` target IS the default. */
  private readonly defaultCanonical: string
  private readonly roots: readonly string[]
  private readonly persist: (patch: { chatWorkspaces: Record<string, string> }) => Promise<boolean>
  private readonly report: (line: string) => void
  private readonly probe: WorkspaceProbe
  private readonly home: string | undefined
  private readonly known: () => readonly string[]
  private readonly sessionPrefix: string | undefined
  private readonly epochOf: (baseId: string) => number
  /** The non-durable warning is orientation; once is enough. */
  private warnedNotDurable = false

  constructor(options: ChatWorkspacesOptions) {
    this.defaultPath = options.defaultPath
    this.roots = options.roots ?? []
    this.persist = options.persist ?? (async () => false)
    this.report = options.report ?? (() => {})
    this.probe = options.probe ?? probeDirectory
    this.home = options.home
    this.known = options.known ?? (() => [])
    this.sessionPrefix = options.sessionPrefix
    this.epochOf = options.epochOf ?? (() => 0)
    this.entries = new Map(Object.entries(options.entries ?? {}))
    const probed = this.probe(this.defaultPath)
    this.defaultCanonical = 'canonical' in probed ? probed.canonical : this.defaultPath
  }

  /** The directory one conversation's next session runs in. */
  pathFor(key: string): string {
    const entry = this.entries.get(key)
    return entry === undefined || entry === DEFAULT_MARKER ? this.defaultPath : entry
  }

  /**
   * The id this conversation derives before it ever started over. The epoch
   * map is keyed by it, so a `/new` in one directory leaves the thread in
   * another untouched.
   * @param key - conversation key.
   * @returns the session id at epoch zero.
   */
  baseSessionIdFor(key: string): string {
    const entry = this.entries.get(key)
    return entry === undefined || entry === DEFAULT_MARKER
      ? workspaceSessionId(key, undefined, this.sessionPrefix)
      : workspaceSessionId(key, entry, this.sessionPrefix)
  }

  /** The session id one conversation currently resolves to. */
  sessionIdFor(key: string): string {
    const base = this.baseSessionIdFor(key)
    return epochSessionId(base, this.epochOf(base))
  }

  /**
   * Every directory this channel can name: the default first, then what this
   * channel switched to, then every workspace the host registry lists — the
   * projects its human already uses with the host, which is what makes `/ws`
   * a discovery surface rather than a diary.
   */
  knownPaths(): string[] {
    const paths = [this.defaultCanonical]
    for (const entry of this.entries.values()) {
      if (entry !== DEFAULT_MARKER && !paths.includes(entry)) paths.push(entry)
    }
    for (const path of this.known()) {
      if (!paths.includes(path)) paths.push(path)
    }
    return paths
  }

  /** Whether one conversation currently runs in the deployment default. */
  isDefault(key: string): boolean {
    const entry = this.entries.get(key)
    return entry === undefined || entry === DEFAULT_MARKER
  }

  /**
   * Point one conversation at a directory. Accepts an absolute path, a `~`
   * path, or the unique basename of a known workspace — the shorthand `/ws`
   * advertises, because a full path is miserable to type on a phone.
   * @param key - conversation key.
   * @param input - the operator's target exactly as typed.
   * @returns what happened, for the chat reply.
   */
  async switch(key: string, input: string): Promise<SwitchResult> {
    const expanded = expandHome(input, this.home)
    let candidate: string
    if (isAbsolute(expanded)) {
      candidate = expanded
    } else {
      const matches = this.knownPaths().filter(path => basename(path) === expanded)
      if (matches.length === 1 && matches[0] !== undefined) {
        candidate = matches[0]
      } else if (matches.length > 1) {
        return { ok: false, reason: `名字 \`${input}\` 对应多个目录：\n${matches.map(m => `- \`${m}\``).join('\n')}\n请用完整路径。` }
      } else {
        return { ok: false, reason: `请提供绝对路径（可以 \`~\` 开头），或 \`/${WS_COMMAND}\` 列表里的名字。` }
      }
    }

    const probed = this.probe(candidate)
    if ('error' in probed) return { ok: false, reason: `\`${candidate}\` ${probed.error}。` }
    const canonical = probed.canonical
    // The deployment default is always reachable: the operator chose it, and
    // the guards below narrow what CHATS may add, not what the deployment runs.
    const toDefault = canonical === this.defaultCanonical
    if (!toDefault) {
      const forbidden = forbiddenReason(canonical, this.home)
      if (forbidden !== undefined) return { ok: false, reason: `${forbidden}。` }
      if (!withinRoots(canonical, this.roots)) {
        return { ok: false, reason: `\`${canonical}\` 不在允许的 workspaceRoots 内。` }
      }
    }

    const before = this.pathFor(key)
    const value = toDefault ? DEFAULT_MARKER : canonical
    const changed = (this.entries.get(key) ?? DEFAULT_MARKER) !== value
    this.entries.set(key, value)
    let durable = true
    if (changed) {
      durable = await this.persist({ chatWorkspaces: { [key]: value } }).catch((error: unknown) => {
        this.report(`lark-channel: persisting the workspace switch failed: ${String(error)}`)
        return false
      })
      if (!durable && !this.warnedNotDurable) {
        this.warnedNotDurable = true
        this.report('lark-channel: workspace switches are in-memory only (no settings service); they reset on restart')
      }
    }
    return {
      ok: true,
      path: toDefault ? this.defaultCanonical : canonical,
      changed: changed && before !== (toDefault ? this.defaultCanonical : canonical),
      toDefault,
      durable,
    }
  }
}

/**
 * Run one workspace command line and produce the chat reply.
 * @param name - the parsed command name, {@link CD_COMMAND} or {@link WS_COMMAND}.
 * @param line - the complete line, slash included.
 * @param key - the conversation the command is about.
 * @param store - the workspace state.
 * @param onSwitched - awaited after a change of directory, before the reply;
 * the bridge releases the conversation's current agent here so the next message
 * walks the ladder under the new id.
 * @returns markdown for the chat.
 */
export async function runWorkspaceCommand(
  name: string,
  line: string,
  key: string,
  store: ChatWorkspaces,
  onSwitched: () => Promise<void>,
): Promise<string> {
  if (name === WS_COMMAND) {
    const current = store.pathFor(key)
    const paths = store.knownPaths()
    const rows = paths.map((path, index) => {
      const marks = [
        ...index === 0 ? ['默认'] : [],
        ...path === current ? ['当前'] : [],
      ]
      return `- \`${basename(path)}\` ${path}${marks.length > 0 ? `（${marks.join('，')}）` : ''}`
    })
    return [
      '**工作区**',
      ...rows,
      `用 \`/${CD_COMMAND} <路径或名字>\` 切换；每个目录的会话上下文各自保留。`,
    ].join('\n')
  }

  const argument = line.trimStart().slice(1 + name.length).trim()
  if (argument === '') {
    return `📁 当前工作区：\`${store.pathFor(key)}\`${store.isDefault(key) ? '（默认）' : ''}`
  }
  const result = await store.switch(key, argument)
  if (!result.ok) return `⚠️ ${result.reason}`
  if (!result.changed) return `📁 当前就在 \`${result.path}\`。`
  await onSwitched()
  const where = result.toDefault ? `已切回默认工作区 \`${result.path}\`` : `已切换到 \`${result.path}\``
  const durability = result.durable ? '' : '\n（本部署未组合 settings，这次切换在重启后会丢失。）'
  return `📁 ${where}\n下一条消息在该目录继续；这个目录之前的会话上下文会被续用。${durability}`
}

// ── Session overrides (/session): symmetric to ChatWorkspaces ───────────────

/** Session override command name. */
export const SESSION_COMMAND = 'session'

/** Sentinel value for clearing an override. */
const SESSION_RESET_MARKER = '__reset__'

/** Construction options. */
export interface ChatSessionOverridesOptions {
  /** Persisted chatKey → sessionId override map. */
  readonly entries?: Record<string, string> | undefined
  /** Persist through the host settings service; false = no settings composed. */
  readonly persist?: ((patch: { chatSessions: Record<string, string> }) => Promise<boolean>) | undefined
  /** Single-line note for non-durable deployments. */
  readonly report?: ((line: string) => void) | undefined
}

/**
 * A conversation's explicit session override. By default each conversation's
 * session id is derived from workspace/epoch; this class lets /session <id>
 * bind the chat to any existing persisted session (including ones created in
 * the Web UI), and /session reset returns to automatic derivation.
 * Pure state plus injected effects, so tests drive it without a filesystem or
 * a settings service.
 */
export class ChatSessionOverrides {
  private readonly entries: Map<string, string>
  private readonly persist: (patch: { chatSessions: Record<string, string> }) => Promise<boolean>
  private readonly report: (line: string) => void
  private warnedNotDurable = false

  constructor(options: ChatSessionOverridesOptions) {
    this.persist = options.persist ?? (async () => false)
    this.report = options.report ?? (() => {})
    this.entries = new Map(Object.entries(options.entries ?? {}))
  }

  /** The override session id for one conversation; undefined when none. */
  overrideFor(key: string): string | undefined {
    const entry = this.entries.get(key)
    return entry === undefined || entry === SESSION_RESET_MARKER ? undefined : entry
  }

  /** Whether a conversation has an override. */
  has(key: string): boolean {
    return this.overrideFor(key) !== undefined
  }

  /** Bind a conversation to a session; undefined clears the override. */
  async set(key: string, sessionId: string | undefined): Promise<boolean> {
    const value = sessionId === undefined ? SESSION_RESET_MARKER : sessionId
    const changed = (this.entries.get(key) ?? SESSION_RESET_MARKER) !== value
    this.entries.set(key, value)
    let durable = true
    if (changed) {
      durable = await this.persist({ chatSessions: { [key]: value } }).catch((error: unknown) => {
        this.report(`lark-channel: persisting the session override failed: ${String(error)}`)
        return false
      })
      if (!durable && !this.warnedNotDurable) {
        this.warnedNotDurable = true
        this.report('lark-channel: session overrides are in-memory only (no settings service); they reset on restart')
      }
    }
    return durable
  }
}

/** Result of one session-command execution. */
export interface SessionCommandResult {
  /** Text to show in chat (bind/reset/invalid-id feedback). */
  readonly markdown: string
  /** Card content (/session with no args); preferred over markdown when present. */
  readonly card?: {
    readonly rows: readonly { id: string; title?: string | undefined; current: boolean; override: boolean }[]
    readonly workspace: string
    readonly canList: boolean
  } | undefined
}

/**
 * Handle the /session command, symmetric to runWorkspaceCommand:
 * - no argument: list sessions in the current workspace (card)
 * - /session <id>: bind this conversation to an existing session
 * - /session reset: clear the override, back to automatic derivation
 * @param line - the full command line, leading slash included.
 * @param key - conversation key.
 * @param overrides - the override store.
 * @param currentId - the session id this conversation resolves to today.
 * @param listSessions - optional listing of sessions in the current workspace.
 * @param currentPath - the conversation's current workspace path.
 */
export async function runSessionCommand(
  line: string,
  key: string,
  overrides: ChatSessionOverrides,
  currentId: string,
  listSessions?: () => Promise<readonly { id: string; title?: string | undefined; cwd?: string | undefined; createdAt?: number | undefined }[]>,
  currentPath?: string | undefined,
  verifySession?: (id: string) => Promise<boolean>,
): Promise<SessionCommandResult> {
  const argument = line.trimStart().slice(1 + SESSION_COMMAND.length).trim()
  const lower = argument.toLowerCase()
  if (lower === 'reset' || lower === 'clear') {
    const durable = await overrides.set(key, undefined)
    const durability = durable ? '' : '\n（本部署未组合 settings，重启后会回到自动派生。）'
    return { markdown: `🔁 已解除会话切换，恢复自动路由。\n下一条消息按聊天/话题/工作区自动路由。${durability}` }
  }
  if (argument === '') {
    const override = overrides.overrideFor(key)
    // No argument = list switchable sessions in the current workspace (like /ws
    // lists workspaces), not a duplicate of /status's "current session".
    let listing = ''
    if (listSessions !== undefined) {
      try {
        const sessions = await listSessions()
        if (sessions.length === 0) {
          listing = '\n\n_（当前工作区暂无其他会话，发条消息即可创建。）_'
        } else {
          const rows = sessions.map(s => {
            const label = s.title !== undefined && s.title !== '' ? s.title : s.id
            const mark = s.id === (override ?? currentId) ? '（当前）' : ''
            return `- \`${label}\` ${s.id}${mark}`
          })
          const where = currentPath === undefined || currentPath === '' ? '当前工作区' : `当前工作区：\`${currentPath}\``
          listing = `\n\n💬 **可切换会话**（${where}）\n${rows.join('\n')}`
        }
      } catch (error) {
        listing = `\n\n_（会话列表不可用：${error instanceof Error ? error.message : String(error)}）_`
      }
    }
    const status = override === undefined
      ? `当前会话：\`${currentId}\``
      : `当前会话：\`${override}\`（已切换）\n自动派生：\`${currentId}\``
    // Card mode: return structured session data; the bridge renders sessionCard
    // (label = title, value = id, copyable on mobile).
    const canList = listSessions !== undefined
    let rows: { id: string; title?: string | undefined; current: boolean; override: boolean }[] = []
    if (canList) {
      try {
        const sessions = await listSessions!()
        rows = sessions.map(s => ({
          id: s.id,
          title: s.title,
          current: s.id === (override ?? currentId),
          override: s.id === override && override !== undefined,
        }))
      } catch {
        /* canList stays true; empty rows make the card show unavailable */
      }
    }
    return {
      markdown: `${status}${listing}\n\n用法：\n\`/session <id>\` — 切换到列表中的某个会话\n\`/session reset\` — 解除切换，恢复自动路由\n\`/new\` — 原地开新会话`,
      card: {
        rows,
        workspace: currentPath ?? '',
        canList: listSessions !== undefined,
      },
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(argument)) {
    return { markdown: `⚠️ 会话 ID 格式不合法：\`${argument}\`。\n合法字符：字母、数字、\`\.\`、\`_\`、\`-\`。` }
  }
  // /session <id> means switch to an EXISTING session. Binding an id nobody
  // has would bind fine and then silently CREATE an empty session on the next
  // message (the ladder's resume-then-create fallback), so a non-existent id
  // is refused up front instead of leaving the operator in a surprise shell.
  if (verifySession !== undefined) {
    const exists = await verifySession(argument)
    if (!exists) {
      return {
        markdown: `⚠️ 会话 \`${argument}\` 不存在，无法切换。\n\`/session\` 可查看当前工作区的可切换会话；已归档或其他工作区的会话只要有 ID 也可切换。`,
      }
    }
  }
  const durable = await overrides.set(key, argument)
  const durability = durable ? '' : '\n（本部署未组合 settings，这次绑定在重启后会丢失。）'
  return { markdown: `🔗 已切换到会话 \`${argument}\`。\n下一条消息继续该会话的上下文。${durability}\n\`/session reset\` 可解除切换。` }
}
