/**
 * Where the bytes of an inbound file land.
 *
 * The transport already turns a file message into a `<file key="…"
 * name="app.log"/>` marker inside the message text, so the model sees the NAME
 * and never the content. That is worse than seeing nothing: handed a file name
 * and no bytes, a model guesses what the log said and answers as though it had
 * read it. This module makes the name true — every file a message carried is
 * streamed into the conversation's workspace, and a note riding the same text
 * says where it now is.
 *
 * The split with `images.ts` is deliberate: this module owns "how bytes reach
 * the disk", `images.ts` owns "how an image becomes a content block the model
 * can see". An image passes through both.
 *
 * The per-file limit can only be judged AFTER the download. A
 * `ResourceDescriptor` carries no size and the transport offers no size probe,
 * so the verdict is `bytesWritten` and an over-limit file is unlinked the
 * moment it lands. The bytes really do touch the disk once; that is the
 * transport's surface, not a choice made here.
 *
 * Sanitization below buys filesystem safety and nothing else. A sanitized name
 * is still attacker-chosen text that rides into the model's prompt, and the
 * defense at that layer is the standing presence line, not this one.
 *
 * The outbound half is the same boundary walked the other way, and it exists in
 * this shape because of HOW the bytes leave. This plugin hands the transport a
 * `Buffer` rather than a local path (ADR 0004), and `MediaUploader.toBuffer`
 * returns on its first line for a buffer — `Buffer.isBuffer(source)` — so the
 * SDK's own `resolve → blacklist → realpath → re-check → allowlist` guard never
 * runs for anything this plugin sends. The `resolve → realpath → container
 * check` order in {@link resolveOutboundFile} IS that guard, put back by hand.
 * Its two middle steps are not interchangeable: canonicalize first, ask "inside
 * the workspace?" second, or `<workspace>/link → /etc/shadow` answers yes.
 * @module dsh-lark-channel/files
 */

import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type { NormalizedMessage, ResourceDescriptor } from '@larksuite/channel'
import { canonicalPathOf, isWithinContainer } from './containment.ts'

/** The channel's own directory inside a workspace. */
const CHANNEL_DIRECTORY = '.dsh-lark'

/** Where inbound files land under it, one directory per message. */
const INBOX_DIRECTORY = 'inbox'

/**
 * How many per-file budgets one message may spend. Deliberately not
 * configurable: its only job is to stop "twenty 20 MB files in one message",
 * and it moves with the per-file limit by construction — a knob of its own
 * would answer no question the per-file limit leaves open.
 */
export const MESSAGE_BYTES_FACTOR = 3

/**
 * The longest name a file may land under. Far below every filesystem's own
 * per-component limit, which leaves the duplicate counter room to append `-2`
 * without a second truncation pass.
 */
const MAX_NAME_LENGTH = 120

/** Stems Windows reserves, whatever extension follows them. */
const RESERVED_STEMS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** What a name sanitized down to nothing lands under. */
const FALLBACK_NAME = 'file'

/** The inbound half of the transport, as this module uses it. */
export interface InboundFilePort {
  downloadResourceToFile(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    destPath: string,
  ): Promise<{ contentType?: string; bytesWritten: number }>
}

/** One inbound file that reached the workspace. */
export interface LandedFile {
  readonly fileKey: string
  readonly type: 'file' | 'image' | 'audio' | 'video'
  /** Absolute path on disk. */
  readonly path: string
  readonly bytes: number
  readonly contentType?: string | undefined
  /** The sanitized name it landed under. */
  readonly fileName: string
}

/** What one message's files became. */
export interface CollectedFiles {
  readonly landed: readonly LandedFile[]
  /** One line per thing the model must know about, exactly as it rides the text. */
  readonly notes: readonly string[]
}

/** How {@link collectInboundFiles} is bounded and where it writes. */
export interface InboundOptions {
  /** The conversation's workspace, i.e. what `/cd` currently points at. */
  readonly workspace: string
  /** Whether this deployment accepts files at all. */
  readonly enabled: boolean
  readonly maxFileBytes: number
  /** Operator console line. */
  readonly report: (line: string) => void
  /**
   * Whether this workspace has yet to be told where inbound files land; the
   * `.gitignore` hint rides the first landing rather than every message.
   */
  readonly hintWorkspace?: boolean | undefined
}

/** Everything a message can carry except a sticker: a sticker is not a file. */
type LandableResource = ResourceDescriptor & { type: LandedFile['type'] }

/**
 * Whether one resource is bytes worth keeping.
 * @param resource - the descriptor the transport normalized.
 * @returns true for everything but a sticker.
 */
function isLandableResource(resource: ResourceDescriptor): resource is LandableResource {
  return resource.type !== 'sticker'
}

/**
 * The type the transport wants for one resource. Its own `ResourceType` knows
 * only images and files; audio and video are files that happen to play.
 * @param type - the resource's normalized kind.
 * @returns the download type to pass.
 */
function downloadTypeOf(type: LandedFile['type']): 'image' | 'file' {
  return type === 'image' ? 'image' : 'file'
}

/**
 * Render a handled failure as one readable detail.
 * @param error - the rejection value, which need not be an `Error`.
 * @returns the message, or the stringified value for a non-error rejection.
 */
function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A size the way a note should carry it: exact below a kilobyte, one decimal
 * above it, so "25.4 MiB over a 20.0 MiB limit" reads as a comparison instead
 * of two long numbers to line up digit by digit.
 * @param bytes - the count.
 * @param byteUnit - what a raw count is called; KiB and MiB need no translation.
 * @returns the short form.
 */
function formatSize(bytes: number, byteUnit: string): string {
  if (bytes < 1024) return `${bytes} ${byteUnit}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * One size for a human reading the chat.
 * @param bytes - the count.
 * @returns the Chinese-facing short form.
 */
function formatBytes(bytes: number): string {
  return formatSize(bytes, '字节')
}

/**
 * One size for the model reading a tool error.
 * @param bytes - the count.
 * @returns the English short form.
 */
function formatBytesInEnglish(bytes: number): string {
  return formatSize(bytes, bytes === 1 ? 'byte' : 'bytes')
}

/**
 * Suffix a name Windows reserves. The reservation covers the stem, so `CON.txt`
 * is as unusable as `CON` — and a Linux host still receives files that a
 * Windows colleague will later unzip.
 * @param name - a sanitized single path component.
 * @returns the name, with the stem suffixed when it is reserved.
 */
function escapeReservedName(name: string): string {
  const [stem = '', ...rest] = name.split('.')
  return RESERVED_STEMS.test(stem) ? [`${stem}_`, ...rest].join('.') : name
}

/**
 * Shorten an over-long name without losing what tells a human — and a
 * `file` command — what kind of file it is.
 * @param name - a sanitized single path component.
 * @returns the name within {@link MAX_NAME_LENGTH}.
 */
function truncateKeepingExtension(name: string): string {
  if (name.length <= MAX_NAME_LENGTH) return name
  const extension = extname(name)
  // An "extension" that eats the whole budget is not one worth keeping.
  if (extension.length === 0 || extension.length >= MAX_NAME_LENGTH) return name.slice(0, MAX_NAME_LENGTH)
  return `${name.slice(0, MAX_NAME_LENGTH - extension.length)}${extension}`
}

/**
 * Turn the sender's file name into one component safe to join onto a directory.
 *
 * The order is the substance. `basename` runs first because the input may be a
 * whole path; the separator pass cannot then be dropped, because POSIX
 * `basename` does not split on `\` and a Windows-shaped name reaches a Linux
 * host unchanged. Stripping leading dots is what turns `..` — a name that
 * escapes the directory — into nothing at all.
 *
 * Filesystem safety is all this buys. The name still rides into the note the
 * model reads; that layer's defense is the standing presence line.
 * @param name - the sender's file name, absent when the message carried none.
 * @returns a single path component, never empty.
 */
export function sanitizeFileName(name: string | undefined): string {
  const stripped = basename(name ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
  const safe = truncateKeepingExtension(escapeReservedName(stripped))
  return safe === '' ? FALLBACK_NAME : safe
}

/**
 * The name one file lands under, given what already landed beside it.
 * Collisions are scoped to a single message's directory, so the counter only
 * ever separates the same name sent twice in one breath.
 * @param taken - names already claimed in this directory; the chosen one joins them.
 * @param name - the sanitized name.
 * @returns the name to write: `app.log`, then `app-2.log`.
 */
function claimFileName(taken: Set<string>, name: string): string {
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  let candidate = name
  for (let ordinal = 2; taken.has(candidate); ordinal += 1) candidate = `${stem}-${ordinal}${extension}`
  taken.add(candidate)
  return candidate
}

/**
 * The directory one message's files land in. A component per message scopes
 * name collisions to that message and keeps the listing in send order.
 *
 * The stamp is UTC: the name only has to be stable and sortable, and the local
 * zone of whichever host ran the channel is not something a later reader can
 * recover anyway. The digest is what ties a directory back to its message.
 *
 * `resolve`, not `join`: every path this module hands out is absolute, because a
 * relative one rides into the note the model reads and points at whichever
 * directory that model's own tools happen to run in.
 * @param msg - the inbound message.
 * @param workspace - the conversation's workspace directory.
 * @returns the absolute directory path.
 */
function inboxDirectoryFor(msg: NormalizedMessage, workspace: string): string {
  const sentAt = Number.isFinite(msg.createTime) && msg.createTime > 0 ? msg.createTime : Date.now()
  const stamp = new Date(sentAt).toISOString().slice(0, 19).replace(/:/g, '')
  const digest = createHash('sha256').update(msg.messageId).digest('hex').slice(0, 8)
  return resolve(workspace, CHANNEL_DIRECTORY, INBOX_DIRECTORY, `${stamp}-${digest}`)
}

/**
 * Remove a file that must not stay. No second note on failure — the one
 * explaining the skip is already written, and complaining twice about a file
 * nobody was promised is noise. The operator does hear about a real failure:
 * the note then says "not saved" while the file sits in the workspace, and
 * nobody else is in a position to notice that they disagree.
 * @param path - the file to unlink.
 * @param report - operator console line.
 */
async function discardFile(path: string, report: (line: string) => void): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    // Nothing there is the outcome asked for, not a failure: a download that
    // died before it created the file leaves nothing to remove.
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return
    report(`lark-channel: removing ${path} failed, so it stays in the workspace: ${failureDetail(error)}`)
  })
}

/**
 * Remove one message's directory once nothing landed in it. `rmdir` and not a
 * recursive remove: it refuses a directory with anything in it, so a mistake
 * here can never take bytes with it. A failure is swallowed and not reported —
 * unlike a file that would not go away, a leftover empty directory contradicts
 * nothing anyone was told.
 * @param path - the message directory.
 */
async function discardDirectory(path: string): Promise<void> {
  await rmdir(path).catch(() => {})
}

/**
 * The note naming what landed and where. Absolute paths, because nothing here
 * knows which directory the model's own tools run in.
 * @param landed - the files on disk.
 * @returns the note as it rides the message text.
 */
function landedNote(landed: readonly LandedFile[]): string {
  return `（收到 ${landed.length} 个文件，已存到工作区：\n${landed.map(file => `- ${file.path}`).join('\n')}）`
}

/**
 * Land every file one message carried in the conversation's workspace.
 *
 * Nothing is dropped silently: a file that is refused, too big, or fails to
 * download leaves a note the model reads, because a model that received a file
 * and believes it did not is worse off than one that knows what it is missing.
 * @param msg - the inbound message.
 * @param port - transport used to stream the bytes to disk.
 * @param options - workspace, switch, and the per-file budget.
 * @returns the files on disk and the notes to append to the text.
 */
export async function collectInboundFiles(
  msg: NormalizedMessage,
  port: InboundFilePort,
  options: InboundOptions,
): Promise<CollectedFiles> {
  const resources = msg.resources.filter(isLandableResource)
  if (resources.length === 0) return { landed: [], notes: [] }
  if (!options.enabled) {
    // Told, not hidden: someone who attaches a log is talking about the log.
    return { landed: [], notes: [`（用户发送了 ${resources.length} 个文件，本渠道未接收它们：receiveFiles 未开启）`] }
  }

  const directory = inboxDirectoryFor(msg, options.workspace)
  try {
    // The transport streams into an existing directory; it does not make one.
    await mkdir(directory, { recursive: true })
    // And the directory it just made has to be PROVEN inside the workspace
    // rather than merely spelled that way. The sanitizer cannot see a symlink —
    // it judges one name, while `resolve` and `join` fold `..` and then answer
    // "inside the workspace" for a path whose own components lead anywhere at
    // all: a `.dsh-lark/inbox` pointing elsewhere takes `mkdir` with it, and
    // the sender's next file lands in the link's target under a name the sender
    // chose. So containment is asked of the filesystem and not of the string,
    // the same way outbound refuses to trust a path it has not canonicalized
    // (ADR 0004) — and a write earns that question at least as much as a read.
    const landing = realpathSync(directory)
    const container = canonicalPathOf(options.workspace) ?? resolve(options.workspace)
    if (!isWithinContainer(landing, container)) {
      throw new Error('the inbox directory does not resolve inside the workspace')
    }
  } catch (error) {
    const detail = failureDetail(error)
    // Nothing was downloaded, so whatever this attempt did create is an empty
    // directory nobody was promised — including one made through a link.
    await discardDirectory(directory)
    options.report(`lark-channel: could not create the inbox directory ${directory}: ${detail}`)
    return {
      landed: [],
      notes: [`（收到 ${resources.length} 个文件，但无法在工作区创建 ${CHANNEL_DIRECTORY}/${INBOX_DIRECTORY}/：${detail}）`],
    }
  }

  const landed: LandedFile[] = []
  const skipped: string[] = []
  const claimed = new Set<string>()
  // One name for the ceiling, so what the note quotes and what the loop
  // enforces cannot drift apart.
  const messageCeiling = options.maxFileBytes * MESSAGE_BYTES_FACTOR
  let budget = messageCeiling
  for (const [index, resource] of resources.entries()) {
    const fileName = claimFileName(claimed, sanitizeFileName(resource.fileName))
    const destination = join(directory, fileName)
    try {
      const { contentType, bytesWritten } = await port.downloadResourceToFile(
        msg.messageId,
        resource.fileKey,
        downloadTypeOf(resource.type),
        destination,
      )
      if (bytesWritten > options.maxFileBytes) {
        await discardFile(destination, options.report)
        skipped.push(
          `（文件 ${fileName} 有 ${formatBytes(bytesWritten)}，`
          + `超过单个文件上限 ${formatBytes(options.maxFileBytes)}，未保存）`,
        )
        continue
      }
      if (bytesWritten > budget) {
        // The message total is a ceiling, not a hint: the file that would break
        // it goes back off the disk, and everything behind it stays undownloaded.
        await discardFile(destination, options.report)
        skipped.push(
          `（单条消息总量上限 ${formatBytes(messageCeiling)} 已用尽，`
          + `还有 ${resources.length - index} 个文件未保存）`,
        )
        break
      }
      budget -= bytesWritten
      landed.push({
        fileKey: resource.fileKey,
        type: resource.type,
        path: destination,
        bytes: bytesWritten,
        ...contentType === undefined ? {} : { contentType },
        fileName,
      })
    } catch (error) {
      const detail = failureDetail(error)
      // A half-streamed file is indistinguishable from a complete one once it
      // sits in the workspace, so the remains of a failed download go away.
      await discardFile(destination, options.report)
      options.report(`lark-channel: downloading ${fileName} of message ${msg.messageId} failed: ${detail}`)
      skipped.push(`（文件 ${fileName} 下载失败：${detail}）`)
    }
  }

  // A message whose every file was refused would otherwise leave its directory
  // behind, one empty `<stamp>-<digest>/` per rejected message, accumulating in
  // exactly the directory the `.gitignore` hint sends people to look at.
  if (landed.length === 0) await discardDirectory(directory)

  return {
    landed,
    notes: [
      ...landed.length === 0 ? [] : [landedNote(landed)],
      ...skipped,
      // Only worth saying once something is actually sitting in the repository.
      ...options.hintWorkspace === true && landed.length > 0
        ? [`（提示：${CHANNEL_DIRECTORY}/ 未被 git 忽略，可加入 .gitignore）`]
        : [],
    ],
  }
}

/** Why one outbound path cannot be sent. */
export type OutboundRefusal =
  | { readonly code: 'outside_workspace' }
  | { readonly code: 'not_found' }
  | { readonly code: 'not_a_file' }
  | { readonly code: 'too_large'; readonly bytes: number; readonly limit: number }

/** One file cleared for sending. */
export interface OutboundFile {
  /** The canonical path the bytes come from. */
  readonly path: string
  /** The name the chat will show, i.e. the canonical path's basename. */
  readonly fileName: string
  readonly bytes: number
}

/** What one path turned out to be: a file cleared to leave, or a refusal. */
export type OutboundVerdict =
  | { readonly ok: true; readonly file: OutboundFile }
  | { readonly ok: false; readonly refusal: OutboundRefusal }

/**
 * What the filesystem says about one canonical path.
 * @param path - a canonical path.
 * @returns whether it is a regular file and how big, or undefined when it cannot be examined.
 */
function inspectFile(path: string): { readonly isFile: boolean; readonly bytes: number } | undefined {
  try {
    const stats = statSync(path)
    return { isFile: stats.isFile(), bytes: stats.size }
  } catch {
    return undefined
  }
}

/**
 * Whether one path may leave this workspace, and what it weighs.
 *
 * The order of the steps IS the check, and it is the order the SDK itself walks
 * for a local path — the one this plugin steps around by handing over a
 * `Buffer` (see the module note). Resolve, canonicalize, and only THEN ask
 * whether the result is inside the workspace: swap the last two and
 * `<workspace>/link → /etc/shadow` clears the container check, because the
 * question would be about the link's own path and not about the bytes it points
 * at. **Do not reorder those two.**
 *
 * The workspace is canonicalized too, or macOS — where `/tmp` is a link into
 * `/private/var` — would judge every file in it an escape.
 * @param input - the path as its caller typed it; a relative one resolves against the workspace.
 * @param workspace - the conversation's workspace, the only directory bytes may come from.
 * @param maxBytes - the single-file ceiling.
 * @returns the cleared file, or why it is refused.
 */
export function resolveOutboundFile(input: string, workspace: string, maxBytes: number): OutboundVerdict {
  const requested = input.trim()
  // Naming no file at all is not "the workspace is not a file" — which is what
  // resolving an empty path against it would conclude — it is a missing path.
  if (requested === '') return { ok: false, refusal: { code: 'not_found' } }
  // A workspace that cannot be canonicalized still bounds the check: its
  // resolved form is what every path under it will be compared against.
  const container = canonicalPathOf(workspace) ?? resolve(workspace)
  const canonical = canonicalPathOf(resolve(container, requested))
  if (canonical === undefined) return { ok: false, refusal: { code: 'not_found' } }
  if (!isWithinContainer(canonical, container)) return { ok: false, refusal: { code: 'outside_workspace' } }
  const found = inspectFile(canonical)
  if (found === undefined) return { ok: false, refusal: { code: 'not_found' } }
  if (!found.isFile) return { ok: false, refusal: { code: 'not_a_file' } }
  if (found.bytes > maxBytes) {
    return { ok: false, refusal: { code: 'too_large', bytes: found.bytes, limit: maxBytes } }
  }
  return { ok: true, file: { path: canonical, fileName: basename(canonical), bytes: found.bytes } }
}

/**
 * Read the cleared file's bytes for `send({ file })`.
 *
 * The bytes come from the verdict's canonical path and never from the caller's
 * own input, so a link the check already followed cannot be followed a second
 * time to somewhere else.
 *
 * The size is checked again against the verdict, because `readFile` treats the
 * size it stats as a hint and reads to EOF regardless. A file still being
 * appended to when it was cleared — an agent's own background process writing
 * on — would otherwise come back BIGGER than the ceiling that just let it
 * through, and the ceiling is the whole reason this function exists.
 *
 * That check enforces the CEILING and closes no race: a rewrite to the same
 * length passes it unnoticed, and this function re-examines neither the
 * canonical path nor what it now points at. So it is not what makes a group's
 * approval mean anything — the caller's ORDER is. `deliverFile` reads the bytes
 * before it asks the room and sends the buffer it already holds, so the file the
 * card certified is the object that leaves.
 * @param file - a file {@link resolveOutboundFile} cleared.
 * @returns its contents.
 * @throws {Error} when the file vanished after it was cleared, or is no longer the size it cleared at.
 */
export async function readOutboundFile(file: OutboundFile): Promise<Buffer> {
  const bytes = await readFile(file.path)
  if (bytes.byteLength !== file.bytes) throw new Error(`${file.fileName} changed size after it was cleared`)
  return bytes
}

/**
 * The refusal as the model reads it — English, actionable, and naming no path
 * the model did not supply itself. A canonical path here would hand whoever
 * wrote the files this model is reading a map of the host's filesystem.
 * @param refusal - the verdict's reason.
 * @returns the sentence to throw as the tool's error.
 */
export function describeRefusalForModel(refusal: OutboundRefusal): string {
  switch (refusal.code) {
    case 'outside_workspace':
      return 'That path leaves the workspace; only files inside the current workspace can be sent.'
    case 'not_found':
      return 'There is no file at that path; check where you wrote it before sending.'
    case 'not_a_file':
      return 'That path is not a regular file, so it has no bytes to send; a directory cannot be sent as one file.'
    case 'too_large':
      return `That file is ${formatBytesInEnglish(refusal.bytes)}, over this chat's `
        + `${formatBytesInEnglish(refusal.limit)} single-file limit; send a smaller file, or an excerpt in your reply.`
  }
}

/**
 * The refusal as the chat reads it — 中文, and short: the human typed the path
 * one line ago and does not need it read back.
 * @param refusal - the verdict's reason.
 * @returns the reason for the chat reply.
 */
export function describeRefusalForChat(refusal: OutboundRefusal): string {
  switch (refusal.code) {
    case 'outside_workspace':
      return '只能发送工作区内的文件。'
    case 'not_found':
      return '这个路径下没有文件。'
    case 'not_a_file':
      return '这不是一个普通文件（目录不能作为一个文件发送）。'
    case 'too_large':
      return `文件有 ${formatBytes(refusal.bytes)}，超过单个文件上限 ${formatBytes(refusal.limit)}。`
  }
}

/** The tool that lets a model hand its own artifacts to the person who asked. */
export const SEND_FILE_TOOL = 'send_file'

/**
 * What the model is told the tool does.
 *
 * Two omissions in the parameters are deliberate and both belong to this text.
 * There is no `caption`: the model's own reply is the explanation, and a Feishu
 * file message carries no body to put one in. There is no target chat: a file
 * can only go to the chat the agent already belongs to, which is a security
 * premise and not a capability to be parameterized. And "Short content belongs
 * in your reply instead" is how this channel refuses to degrade a long answer
 * into an attachment — the rule lives in the description because that is where
 * the model reads it.
 */
const SEND_FILE_DESCRIPTION = 'Send one file from the current workspace to this chat, so the person who asked '
  + 'can download it. Use it for artifacts: reports, diffs, generated images, exported data. Short content '
  + 'belongs in your reply instead — never send a file just to say a few sentences. One call sends one file; '
  + 'call it again for more.'

/** What the tool needs from the bridge to send one file. */
export interface SendFilePorts {
  /**
   * Deliver one cleared file to the agent's own chat, gate included.
   * @param sessionId - the agent's session, which names the chat.
   * @param file - the file the check cleared.
   * @param signal - the execution's cancellation. Passed on because a gate can
   * outlive the call that opened it: a group approval waits for a human, and
   * without this the card left behind by a cancelled turn stays live for the
   * whole approval timeout — someone pressing "allow" twenty minutes after the
   * turn was stopped would put the file in the group anyway, which is the leak
   * the gate exists to prevent (ADR 0002).
   * @returns undefined on success, or the reason the send did not happen.
   */
  deliver(sessionId: string, file: OutboundFile, signal?: AbortSignal): Promise<string | undefined>
  /**
   * The conversation workspace one session runs in, or undefined when it has no chat.
   * @param sessionId - the agent's session.
   * @returns the workspace directory, or undefined.
   */
  workspaceOf(sessionId: string): string | undefined
  /** The single-file ceiling. */
  readonly maxBytes: number
  /**
   * Operator console line. A path this check refuses never reaches
   * {@link SendFilePorts.deliver}, so this is the only place an attempt to leave
   * the workspace can be reported — and an escape attempt is an operator's
   * event, not just the model's error.
   */
  readonly report: (line: string) => void
}

/**
 * Build the agent-scoped `send_file`.
 *
 * Every refusal is thrown rather than returned, as in `plan.ts`: a tool result
 * is what steers the model's next move, and "that file is too big" has to reach
 * it as a failure it must act on rather than a field it may ignore.
 * @param ports - how to look up the workspace and deliver the bytes.
 * @returns the definition, for `tools.register` on an agent's context.
 */
export function sendFileTool(ports: SendFilePorts): object {
  return {
    name: SEND_FILE_TOOL,
    description: SEND_FILE_DESCRIPTION,
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to the file, inside the workspace.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sent'],
        properties: { sent: { type: 'boolean' } },
      },
      render: () => [{ type: 'text', text: 'The file was sent to the chat.' }],
    },
    async execute(args: unknown, exec: unknown): Promise<{ sent: true }> {
      // Total by construction: without `defineTool`'s validating wrapper this
      // body IS the validation, and a path-shaped argument that is not a string
      // must reach the ordinary refusal rather than throw a type error.
      const requested = String((args as { path?: unknown } | null | undefined)?.path ?? '')
      const context = exec as { agent?: { session?: { id?: string } }; signal?: AbortSignal }
      const sessionId = context.agent?.session?.id
      if (sessionId === undefined) {
        throw new Error(`${SEND_FILE_TOOL} requires a calling agent (no chat to send a file to)`)
      }
      const workspace = ports.workspaceOf(sessionId)
      if (workspace === undefined) {
        throw new Error(`${SEND_FILE_TOOL} found no chat for this session, so there is nowhere to send a file`)
      }
      const verdict = resolveOutboundFile(requested, workspace, ports.maxBytes)
      if (!verdict.ok) {
        // Reported here and nowhere else: a refused path never reaches the
        // delivery port, and a model reaching outside its workspace — the shape
        // an injected instruction takes — is something an operator must be able
        // to see. Collapsed to one bounded line first, because the path is
        // model-authored text and a console line it could break in two is a
        // console line it could forge.
        const attempted = requested.replace(/\s+/g, ' ').slice(0, 200)
        ports.report(`lark-channel: ${SEND_FILE_TOOL} refused ${attempted} `
          + `in session ${sessionId}: ${verdict.refusal.code}`)
        throw new Error(describeRefusalForModel(verdict.refusal))
      }
      // Refused by its human, timed out, upload failed: one string, because to
      // the model they are one thing — the file did not arrive, and why. Those
      // are reported by the deliverer itself, which is the half that knows the
      // transport's own code for them.
      const failure = await ports.deliver(sessionId, verdict.file, context.signal)
      if (failure !== undefined) throw new Error(failure)
      return { sent: true }
    },
  }
}

/** Send one workspace file to the chat. Channel-owned: it needs no agent. */
export const GET_COMMAND = 'get'

/**
 * Run one `/get` line: parse the path, clear it, hand it to the caller's send.
 *
 * The same {@link resolveOutboundFile} the tool goes through, on purpose. A
 * human typing the command is not a reason to trust a path more — `/get` skips
 * the group approval card because the intent is explicit, not because the
 * boundary moved.
 * @param line - the complete line, slash included.
 * @param workspace - the conversation's workspace.
 * @param maxBytes - the single-file ceiling.
 * @param send - delivers the cleared file's bytes to the chat.
 * @returns the chat reply, or undefined when the file was sent and speaks for itself.
 */
export async function runGetCommand(
  line: string,
  workspace: string,
  maxBytes: number,
  send: (file: OutboundFile, bytes: Buffer) => Promise<void>,
): Promise<string | undefined> {
  const argument = line.trimStart().slice(1 + GET_COMMAND.length).trim()
  if (argument === '') return `用法：\`/${GET_COMMAND} <路径>\`，把工作区里的一个文件发到这个聊天（相对路径按工作区解析）。`
  const verdict = resolveOutboundFile(argument, workspace, maxBytes)
  if (!verdict.ok) return `⚠️ ${describeRefusalForChat(verdict.refusal)}`
  let bytes: Buffer
  try {
    bytes = await readOutboundFile(verdict.file)
  } catch (error) {
    return `⚠️ 读取 \`${verdict.file.path}\` 失败：${failureDetail(error)}`
  }
  try {
    await send(verdict.file, bytes)
  } catch (error) {
    return `⚠️ 发送 \`${verdict.file.fileName}\` 失败：${failureDetail(error)}`
  }
  return undefined
}
