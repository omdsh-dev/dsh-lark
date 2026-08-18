/**
 * Automatic Feishu/Lark document receipt into the conversation inbox.
 *
 * `larkdocs.ts` owns platform protocol facts. This module owns channel policy:
 * finding links in message text, applying the per-message budget, landing
 * snapshots beside ordinary inbound files, and leaving model-visible notes.
 * @module dsh-lark-channel/larkdoc-inbound
 */

import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NormalizedMessage } from '@larksuite/channel'
import {
  claimFileName,
  discardEmptyInboundMessageDirectory,
  prepareInboundMessageDirectory,
  sanitizeFileName,
} from './files.ts'
import { failureDetail, formatBytesForChat } from './format.ts'
import type { ReadLarkDocumentSessions } from './larkdoc-session.ts'
import {
  classifyLarkDocumentUrl,
  fetchLarkDocumentMarkdown,
  larkDocsErrorDetails,
  resolveLarkWikiDocument,
  larkDocumentTitleFromContent,
} from './larkdocs.ts'
import type {
  FetchedLarkDocument,
  LarkDocsProtocolPort,
  LarkDocumentLink,
} from './larkdocs.ts'

/** One immutable document snapshot that reached the conversation inbox. */
export interface LandedLarkDocument extends FetchedLarkDocument {
  readonly sourceUrl: string
  /** Absolute path to the snapshot. */
  readonly path: string
  readonly bytes: number
  readonly fileName: string
}

/** The result appended to one model-bound chat message. */
export interface CollectedLarkDocuments {
  readonly landed: readonly LandedLarkDocument[]
  /** One note per outcome the model must not mistake for silence. */
  readonly notes: readonly string[]
}

/** Maximum readable document links one message may spend. */
export const MAX_LARK_DOCS_PER_MESSAGE = 3

/** URL punctuation commonly attached by prose and markdown rather than the URL. */
const TRAILING_URL_PUNCTUATION = /[),.，。；;！？!?\]}]+$/u

/**
 * Extract only recognized tenant document URLs from normalized message text.
 * Non-Lark URLs remain ordinary message content and produce no channel note.
 */
export function extractLarkDocumentLinks(content: string): readonly Exclude<LarkDocumentLink, { kind: 'external' }>[] {
  const candidates = content.match(/https?:\/\/[^\s<>"']+/giu) ?? []
  return candidates.flatMap((candidate) => {
    const link = classifyLarkDocumentUrl(candidate.replace(TRAILING_URL_PUNCTUATION, ''))
    return link.kind === 'external' ? [] : [link]
  })
}

/** Chinese surface name used by unsupported-link notes. */
function unsupportedDocumentName(type: Extract<LarkDocumentLink, { kind: 'unsupported' }>['type']): string {
  switch (type) {
    case 'docs': return '旧版飞书文档'
    case 'sheets': return '飞书表格'
    case 'base': return '飞书多维表格'
    case 'minutes': return '飞书妙记'
    case 'file': return '飞书云盘文件'
  }
}

/** Preserve platform code and message while making resource ACL failures actionable. */
function documentReadFailureNote(fileToken: string, error: unknown): string {
  const details = larkDocsErrorDetails(error)
  const code = details.code === undefined ? '' : `[${String(details.code)}] `
  const resourceDenied = details.permissionViolations.length === 0
    && /permission|forbidden|access denied|not shared|share.*app|权限|无权|未共享/iu.test(details.message)
  if (resourceDenied) {
    return `（文档 ${fileToken} 读取失败：${code}${details.message}；机器人没有这篇文档的权限，请把它加进文档协作者。）`
  }
  return `（文档 ${fileToken} 读取失败：${code}${details.message}）`
}

/** Note making the snapshot's absolute-path and point-in-time semantics explicit. */
function landedDocumentNote(landed: readonly LandedLarkDocument[]): string {
  return `（读到 ${landed.length} 篇飞书文档，已存为快照到工作区：\n`
    + `${landed.map(document => `- ${document.path}`).join('\n')}\n`
    + '快照是读取那一刻的内容，文档之后可能已被修改。）'
}

/** Options binding automatic reads to one conversation session. */
export interface CollectLarkDocumentOptions {
  readonly workspace: string
  readonly sessionId: string
  readonly enabled: boolean
  /** False when the startup/runtime capability table has denied reads. */
  readonly capabilityEnabled?: boolean | undefined
  /** Reuses `maxReceiveFileBytes`; a snapshot is an inbound file. */
  readonly maxFileBytes: number
  readonly readDocuments: ReadLarkDocumentSessions
  readonly report: (line: string) => void
  /** Runtime capability correction supplied by the bridge seam. */
  readonly correctFailure?: ((error: unknown) => void | Promise<void>) | undefined
}

/** Resolve a direct or wiki link to a fetchable docx token. */
async function resolveReadableDocument(
  link: Extract<LarkDocumentLink, { kind: 'docx' | 'wiki' }>,
  port: LarkDocsProtocolPort,
): Promise<{ readonly fileToken: string; readonly title?: string | undefined } | { readonly objType: string }> {
  if (link.kind === 'docx') return { fileToken: link.token }
  const node = await resolveLarkWikiDocument(port, link.token)
  if (node.objType !== 'docx') return { objType: node.objType }
  return { fileToken: node.fileToken, ...node.title === undefined ? {} : { title: node.title } }
}

/**
 * Read every supported link in one message into the shared inbound inbox.
 * A failure spends only that document; it never rejects the conversation turn.
 */
export async function collectLarkDocumentSnapshots(
  msg: NormalizedMessage,
  port: LarkDocsProtocolPort,
  options: CollectLarkDocumentOptions,
): Promise<CollectedLarkDocuments> {
  const links = extractLarkDocumentLinks(msg.content)
  if (links.length === 0) return { landed: [], notes: [] }

  const unsupported = links.filter((link): link is Extract<LarkDocumentLink, { kind: 'unsupported' }> =>
    link.kind === 'unsupported')
  const notes = [...new Set(unsupported.map(link => link.type))].map((type) => {
    const count = unsupported.filter(link => link.type === type).length
    return `（消息里有 ${count} 个${unsupportedDocumentName(type)}链接，本渠道只读 docx 文档，读不了这类内容。）`
  })
  const readable = links.filter((link): link is Extract<LarkDocumentLink, { kind: 'docx' | 'wiki' }> =>
    link.kind === 'docx' || link.kind === 'wiki')
  if (readable.length === 0) return { landed: [], notes }
  if (!options.enabled) {
    return {
      landed: [],
      notes: [
        ...notes,
        `（消息里有 ${readable.length} 个飞书文档链接，但 receiveDocs 未开启，本渠道未读取，也没有落盘快照。）`,
      ],
    }
  }
  if (options.capabilityEnabled === false) {
    return {
      landed: [],
      notes: [
        ...notes,
        `（消息里有 ${readable.length} 个飞书文档链接，但文档读取能力未点亮，本渠道未读取，也没有落盘快照。）`,
      ],
    }
  }

  const attempted = readable.slice(0, MAX_LARK_DOCS_PER_MESSAGE)
  if (readable.length > attempted.length) {
    notes.push(`（消息里有 ${readable.length} 个文档链接，超过单条消息 ${MAX_LARK_DOCS_PER_MESSAGE} 篇的上限，`
      + `后 ${readable.length - attempted.length} 篇未读取。）`)
  }

  const landed: LandedLarkDocument[] = []
  let directory: string | undefined
  let claimed: Set<string> | undefined
  for (const link of attempted) {
    let fileToken = link.token
    try {
      const resolved = await resolveReadableDocument(link, port)
      if ('objType' in resolved) {
        notes.push(`（Wiki 节点 ${link.token} 指向 ${resolved.objType}，本渠道只读 docx 文档，未读取。）`)
        continue
      }
      fileToken = resolved.fileToken
      const fetched = await fetchLarkDocumentMarkdown(port, fileToken)
      const bytes = Buffer.byteLength(fetched.content, 'utf8')
      if (bytes > options.maxFileBytes) {
        notes.push(`（文档 ${fileToken} 有 ${formatBytesForChat(bytes)}，`
          + `超过单篇快照上限 ${formatBytesForChat(options.maxFileBytes)}，未保存。）`)
        continue
      }

      if (directory === undefined) {
        directory = await prepareInboundMessageDirectory(msg, options.workspace)
        claimed = new Set(await readdir(directory))
      }
      // The response body carries no title, so the export's own leading title
      // element is the last place a docx link can get a readable name from.
      const documentTitle = resolved.title ?? fetched.title ?? larkDocumentTitleFromContent(fetched.content)
      const title = documentTitle ?? fileToken
      const fileName = claimFileName(claimed!, sanitizeFileName(`${title}.md`))
      const path = join(directory, fileName)
      await writeFile(path, fetched.content, { flag: 'wx' })
      const snapshot: LandedLarkDocument = {
        ...fetched,
        // One title for the file name and for the record: they described the
        // same document by different rules before.
        ...documentTitle === undefined ? {} : { title: documentTitle },
        sourceUrl: link.url,
        path,
        bytes,
        fileName,
      }
      landed.push(snapshot)
      options.readDocuments.remember(options.sessionId, fileToken, { path, title })
    } catch (error) {
      await Promise.resolve(options.correctFailure?.(error)).catch((correctionError: unknown) => {
        options.report(`lark-channel: correcting document read capability failed: ${failureDetail(correctionError)}`)
      })
      options.report(`lark-channel: reading document ${fileToken} of message ${msg.messageId} failed: ${failureDetail(error)}`)
      notes.push(documentReadFailureNote(fileToken, error))
    }
  }

  if (landed.length === 0 && directory !== undefined) {
    await discardEmptyInboundMessageDirectory(directory)
  }
  return {
    landed,
    notes: [
      ...landed.length === 0 ? [] : [landedDocumentNote(landed)],
      ...notes,
    ],
  }
}
