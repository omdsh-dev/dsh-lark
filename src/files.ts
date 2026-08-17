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
 * @module dsh-lark-channel/files
 */

import { createHash } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { NormalizedMessage, ResourceDescriptor } from '@larksuite/channel'

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
 * @returns the Chinese-facing short form.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
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
 * @param msg - the inbound message.
 * @param workspace - the conversation's workspace directory.
 * @returns the absolute directory path.
 */
function inboxDirectoryFor(msg: NormalizedMessage, workspace: string): string {
  const sentAt = Number.isFinite(msg.createTime) && msg.createTime > 0 ? msg.createTime : Date.now()
  const stamp = new Date(sentAt).toISOString().slice(0, 19).replace(/:/g, '')
  const digest = createHash('sha256').update(msg.messageId).digest('hex').slice(0, 8)
  return join(workspace, CHANNEL_DIRECTORY, INBOX_DIRECTORY, `${stamp}-${digest}`)
}

/**
 * Remove a file that must not stay. A failure here is swallowed on purpose:
 * the note explaining the skip is already written, and a second complaint
 * about a file nobody was promised is noise.
 * @param path - the file to unlink.
 */
async function discardFile(path: string): Promise<void> {
  await unlink(path).catch(() => {})
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
  } catch (error) {
    const detail = failureDetail(error)
    options.report(`lark-channel: could not create the inbox directory ${directory}: ${detail}`)
    return {
      landed: [],
      notes: [`（收到 ${resources.length} 个文件，但无法在工作区创建 ${CHANNEL_DIRECTORY}/${INBOX_DIRECTORY}/：${detail}）`],
    }
  }

  const landed: LandedFile[] = []
  const skipped: string[] = []
  const claimed = new Set<string>()
  let budget = options.maxFileBytes * MESSAGE_BYTES_FACTOR
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
        await discardFile(destination)
        skipped.push(
          `（文件 ${fileName} 有 ${formatBytes(bytesWritten)}，`
          + `超过单个文件上限 ${formatBytes(options.maxFileBytes)}，未保存）`,
        )
        continue
      }
      if (bytesWritten > budget) {
        // The message total is a ceiling, not a hint: the file that would break
        // it goes back off the disk, and everything behind it stays undownloaded.
        await discardFile(destination)
        skipped.push(
          `（单条消息总量上限 ${formatBytes(options.maxFileBytes * MESSAGE_BYTES_FACTOR)} 已用尽，`
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
      await discardFile(destination)
      options.report(`lark-channel: downloading ${fileName} of message ${msg.messageId} failed: ${detail}`)
      skipped.push(`（文件 ${fileName} 下载失败：${detail}）`)
    }
  }

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
