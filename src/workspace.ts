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
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { canonicalPathOf, isSamePath, isWithinContainer } from './containment.ts'
import { epochSessionId } from './epoch.ts'
import { paginate, type Page } from './pager.ts'
import type { ConversationSubject } from './session.ts'
import { sessionIdFor } from './session.ts'

/** Switch or show this conversation's workspace. Channel-owned: it needs no agent. */
export const CD_COMMAND = 'cd'

/** List the workspaces this channel knows. Channel-owned: it needs no agent. */
export const WS_COMMAND = 'ws'

/** Marks this plugin's workspace rows apart from other card actions. */
export const WORKSPACE_ACTION = 'dsh-lark-channel/workspaces'

/** How many workspace rows one page of the picker draws. */
export const WS_PAGE_ROWS = 10

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
 *
 * Every comparison here goes through the filesystem's own rules rather than
 * `===`, because these guards only work if they fire: on a case-folding host,
 * `c:\users\me` IS the home that `C:\Users\me` names, and a string comparison
 * would answer "a directory somewhere else" and let a chat point its agent at
 * the whole thing.
 * @param canonical - the canonicalized candidate.
 * @param home - the home directory, as `homedir()` spells it.
 * @returns the refusal, or undefined when the directory is specific enough.
 */
export function forbiddenReason(canonical: string, home = homedir()): string | undefined {
  // The candidate arrives canonical, so the home it is compared against has to
  // be canonical too. `isSamePath` compares with `relative`, which folds case
  // where the host folds it but follows no link: a `$HOME` reached through one
  // (`/home/x -> /mnt/data/x` is a common server layout, and 8.3 short names
  // are the Windows version) would compare unequal to its own canonical form,
  // and the guards below would not fire at all.
  const base = canonicalPathOf(home) ?? home
  if (isSamePath(dirname(canonical), canonical)) return '不能把文件系统根目录设为工作区'
  if (isSamePath(canonical, base)) return '不能把 Home 根目录设为工作区，请选更具体的子目录'
  if (isSamePath(canonical, dirname(base))) return '不能把用户目录的父级设为工作区'
  return undefined
}

/**
 * Whether a path falls under one of the configured roots. An empty list allows
 * anywhere: the platform already decides who can reach the bot, and this knob
 * only narrows what those people may point it at.
 *
 * Both sides are compared the way the filesystem compares them, so a root
 * spelled in another case is the same allow-list entry wherever the host folds
 * case — an operator who wrote `c:\work` has not thereby forbidden their own
 * `C:\work`.
 *
 * The root is resolved first, so a root spelled relative keeps the meaning it
 * always had. The candidate is deliberately NOT resolved for it: it is already
 * canonical by contract, and a spelling that never named a place must be
 * refused here rather than quietly given the process working directory's
 * meaning.
 * @param path - canonical candidate directory.
 * @param roots - allowed directory prefixes.
 * @returns true when allowed.
 */
export function withinRoots(path: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true
  return roots.some((root) => isWithinContainer(path, resolve(root)))
}

/**
 * The directory override a stored or configured value actually names.
 *
 * The value arrives from configuration and from the settings document, which
 * are hand-editable: anything that is not a non-empty string names no
 * directory. Guards the id derivation, because the alternative is worse than
 * ignoring a bad entry — the derivation HASHES this value, and a non-string
 * there threw out of the bridge's own installation, leaving a connected
 * transport with no handlers and a chat that answered nothing.
 * @param value - whatever the entry held.
 * @returns the usable directory, or undefined for "the deployment default".
 */
export function workspaceOverride(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The session id one conversation-and-workspace pair owns. The default
 * workspace keeps the historical plain id, so existing conversations keep their
 * sessions across this feature's arrival; an override appends a digest of the
 * canonical directory, so two spellings of one directory reach one session and
 * two directories never share.
 * @param key - conversation key.
 * @param overridePath - canonical override directory, absent for the default.
 * @param prefix - this row's session prefix, absent for the original one.
 * @returns the branded session id.
 */
export function workspaceSessionId(key: string, overridePath?: unknown, prefix?: string): string {
  const base = sessionIdFor(key, prefix)
  const override = workspaceOverride(overridePath)
  if (override === undefined) return base
  return `${base}--${createHash('sha256').update(override).digest('hex').slice(0, 10)}`
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
   * The legacy epoch a stored conversation still runs on, by the id it derives
   * at epoch zero. Absent keeps every conversation on its first. Nothing
   * advances this any more — `/new` mints an id instead — but conversations
   * that were moved by the old counter are still on their `--e<N>` session, and
   * the id is the only pointer to that thread.
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
    // Only entries that name a directory are kept: the document is
    // hand-editable, and one junk value used to reach the id derivation's hash
    // and take the whole bridge install down with it.
    this.entries = new Map(Object.entries(options.entries ?? {})
      .map(([key, value]) => [key, workspaceOverride(value)] as const)
      .filter((pair): pair is readonly [string, string] => pair[1] !== undefined))
    const probed = this.probe(this.defaultPath)
    this.defaultCanonical = 'canonical' in probed ? probed.canonical : this.defaultPath
  }

  /** The directory one conversation's next session runs in. */
  pathFor(key: string): string {
    const entry = this.entries.get(key)
    return entry === undefined || entry === DEFAULT_MARKER ? this.defaultPath : entry
  }

  /**
   * The id this conversation derives at the directory it is in, before any
   * suffix. A session minted for the conversation is minted under it, and the
   * conversation's pointer is keyed by it — so starting over in one directory
   * leaves the thread in another untouched.
   * @param key - conversation key.
   * @returns the anchor id.
   */
  baseSessionIdFor(key: string): string {
    const entry = workspaceOverride(this.entries.get(key))
    return entry === undefined || entry === DEFAULT_MARKER
      ? workspaceSessionId(key, undefined, this.sessionPrefix)
      : workspaceSessionId(key, entry, this.sessionPrefix)
  }

  /**
   * The session id one conversation derives on its own.
   *
   * A pointer normally decides which session a conversation runs, so this is
   * what that pointer falls back to — and what a conversation that never
   * pointed anywhere has always run. The legacy epoch only appears for a
   * conversation an older release moved, which is still on that session.
   * @param key - conversation key.
   * @returns the derived session id.
   */
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
    // Compared with `isSamePath` rather than `===`: these paths are canonical,
    // and on a case-folding host (macOS, Windows) two spellings of one directory
    // are one directory — `includes` would list it twice, once as the default
    // and once as a switch target, and `/ws` would offer a duplicate row.
    for (const entry of this.entries.values()) {
      if (entry !== DEFAULT_MARKER && !paths.some(path => isSamePath(path, entry))) paths.push(entry)
    }
    for (const path of this.known()) {
      if (!paths.some(known => isSamePath(known, path))) paths.push(path)
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
    const toDefault = isSamePath(canonical, this.defaultCanonical)
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
 * One directory the picker offers as a row.
 *
 * The name leads and the path follows, the way a workspace is named anywhere
 * else: a person reaches for `deepseek`, and the full path is what tells two
 * directories of the same name apart.
 */
export interface WorkspaceChoice {
  /** The canonical directory this row would switch to. */
  readonly path: string
  /** Its last segment, which is what a reader recognizes. */
  readonly name: string
  /** Whether this is the deployment default. */
  readonly isDefault: boolean
  /** Whether the conversation runs here now. */
  readonly current: boolean
}

/**
 * Every directory this conversation may switch to, current one first.
 *
 * The current directory leads rather than sitting in place, because it is the
 * one fact a reader checks before anything else — and a page that could hide it
 * would make the card unable to say where the conversation is.
 * @param store - the workspace state.
 * @param key - the conversation key.
 * @returns the rows to offer, current first then the rest in listing order.
 */
export function workspaceChoices(store: ChatWorkspaces, key: string): WorkspaceChoice[] {
  const current = store.pathFor(key)
  const paths = store.knownPaths()
  const rows = paths.map((path, index): WorkspaceChoice => ({
    path,
    name: basename(path),
    // The list is built with the default first, so the index IS the answer here;
    // comparing paths would ask the same question a second time.
    isDefault: index === 0,
    current: isSamePath(path, current),
  }))
  // Stable within each group: the current row is moved, never re-sorted, so the
  // rest keep the registry's order and a reader finds a directory where the
  // previous page left it.
  return [...rows.filter(row => row.current), ...rows.filter(row => !row.current)]
}

/**
 * One page of workspace rows, and where it sits in the whole list.
 *
 * The rows, the page index, and the page count are {@link Page}'s; this name
 * says which list they came from.
 */
export type WorkspacePage = Page<WorkspaceChoice>

/**
 * The slice of rows one page shows.
 *
 * The current directory is pinned to the first page's first row whatever page
 * was asked for, so every page can say where the conversation is. It is drawn
 * there and nowhere else: a row that appeared on two pages would be two buttons
 * for one directory.
 * @param choices - the rows to paginate, current first.
 * @param page - the requested zero-based page; out-of-range values clamp.
 * @returns the rows to draw and the page's position.
 */
export function workspacePage(choices: readonly WorkspaceChoice[], page: number): WorkspacePage {
  return paginate(choices, page, WS_PAGE_ROWS)
}

/** Card payload carried by one workspace row, or by a page control. */
export interface WorkspaceActionValue extends ConversationSubject {
  readonly kind: typeof WORKSPACE_ACTION
  /**
   * The directory to switch to, absent on a page control.
   *
   * The path travels with the button rather than being re-derived at press
   * time, because the row a person pressed IS the authorization: the picker
   * drew it from {@link ChatWorkspaces.knownPaths}, and the switch re-probes it
   * against the same guards a typed `/cd` faces. Nothing here is trusted.
   */
  readonly path?: string | undefined
  /** The page to draw; absent when the row itself is the subject. */
  readonly page?: number | undefined
}

/**
 * Narrow an arbitrary card-action value to this module's payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function workspaceActionValue(value: unknown): WorkspaceActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== WORKSPACE_ACTION) return undefined
  if (typeof record.key !== 'string' || record.key === '') return undefined
  if (typeof record.chatId !== 'string' || typeof record.chatType !== 'string') return undefined
  if (record.owner !== undefined && typeof record.owner !== 'string') return undefined
  if (record.path !== undefined && (typeof record.path !== 'string' || record.path === '')) return undefined
  if (record.page !== undefined
    && (typeof record.page !== 'number' || !Number.isSafeInteger(record.page) || record.page < 0)) return undefined
  // A button that names neither is inert, and accepting it would authorize a
  // press that can do nothing.
  if (record.path === undefined && record.page === undefined) return undefined
  return {
    kind: WORKSPACE_ACTION,
    key: record.key,
    chatId: record.chatId,
    chatType: record.chatType,
    ...record.owner === undefined ? {} : { owner: record.owner },
    ...record.path === undefined ? {} : { path: record.path },
    ...record.page === undefined ? {} : { page: record.page },
  }
}

/**
 * Run one workspace command line and produce the chat reply.
 *
 * `/ws` no longer comes here: it answers with a card whose rows are pressed,
 * which is the whole point of the picker. What remains is `/cd`, kept complete
 * because the picker can only offer directories the channel already knows —
 * a directory nobody has used with the host yet has no row, and typing its path
 * is the only way to reach it.
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
