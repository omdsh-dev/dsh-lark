/**
 * Publishing workspace artifacts as Lark documents: path safety, the agent
 * tool and the human `/put` command.
 *
 * Platform URLs, bodies, tokens, scope errors and raw SDK calls stay in
 * `larkdocs.ts` under ADR 0006. This module owns only channel business policy.
 * @module dsh-lark-channel/larkdoc-publish
 */

import { basename, extname } from 'node:path'
import {
  describeReadFailure,
  describeRefusalForChat,
  describeRefusalForModel,
  readOutboundFile,
  resolveOutboundFile,
} from './outbound-file.ts'
import type { OutboundFile } from './outbound-file.ts'
import { describeLarkDocumentFailure } from './larkdocs.ts'
import type { LarkDocumentTarget, WrittenLarkDocument } from './larkdocs.ts'

/** The model-facing tool that publishes a workspace artifact as a document. */
export const SEND_DOC_TOOL = 'send_doc'

/** The human-owned equivalent of {@link SEND_DOC_TOOL}. */
export const PUT_COMMAND = 'put'

/** One workspace artifact after the shared outbound check and stable-handle read. */
export interface LarkDocumentArtifact {
  readonly file: OutboundFile
  readonly title: string
  readonly content: string
}

/** Result after the platform side effect exists, even if its chat receipt did not arrive. */
export interface PublishedLarkDocument extends WrittenLarkDocument {
  /** Any partial-success fact the model should preserve. */
  readonly warning?: string | undefined
  /** Specifically means the final chat receipt failed and may be retried without rewriting the document. */
  readonly receiptWarning?: string | undefined
}

/** Boundaries the agent-scoped document tool needs from the bridge. */
export interface SendDocPorts {
  readonly maxBytes: number
  readonly report: (line: string) => void
  workspaceOf(sessionId: string): string | undefined
  /** Share the per-chat outbound-content quota with `send_file`; direct chats run without a held slot. */
  withOutboundSlot<T>(sessionId: string, operation: () => Promise<T>): Promise<T>
  publish(
    sessionId: string,
    artifact: LarkDocumentArtifact,
    signal?: AbortSignal,
  ): Promise<PublishedLarkDocument>
}

/** Throw the cancellation reason at boundaries where another side effect would otherwise begin. */
function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

/** Title shown by Feishu: the file's final extension is transport detail. */
export function larkDocumentTitle(fileName: string): string {
  const suffix = extname(fileName)
  return basename(fileName, suffix)
}

/** Turn one stable file-handle read into a markdown document artifact. */
function documentArtifact(file: OutboundFile, bytes: Buffer): LarkDocumentArtifact {
  return { file, title: larkDocumentTitle(file.fileName), content: bytes.toString('utf8') }
}

/** Read through the shared stable-identity guard, with no host path in failures. */
async function readDocumentArtifact(file: OutboundFile): Promise<LarkDocumentArtifact> {
  try {
    return documentArtifact(file, await readOutboundFile(file))
  } catch (error) {
    throw new Error(`That file could not be read: ${describeReadFailure(error, file)}`)
  }
}

/** Model tool definition. It can only publish back to the calling agent's chat. */
export function sendDocTool(ports: SendDocPorts): object {
  return {
    name: SEND_DOC_TOOL,
    description: 'Turn one markdown file from the current workspace into a Feishu document and return its link '
      + 'to this chat. Use it for long artifacts a chat message reads badly: reports, reviews, design notes. '
      + 'Short content belongs in your reply instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to the markdown file, inside the workspace.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sent', 'link', 'appended'],
        properties: {
          sent: { type: 'boolean' },
          link: { type: 'string' },
          appended: { type: 'boolean' },
          warning: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const result = value as { link?: unknown; warning?: unknown }
        const warning = typeof result.warning === 'string' ? ` Warning: ${result.warning}` : ''
        return [{ type: 'text', text: `The document exists at ${String(result.link ?? '')}.${warning}` }]
      },
    },
    async execute(args: unknown, exec: unknown): Promise<{
      sent: true
      link: string
      appended: boolean
      warning?: string | undefined
    }> {
      const input = args as { path?: unknown } | null | undefined
      const requested = String(input?.path ?? '')
      const context = exec as { agent?: { session?: { id?: string } }; signal?: AbortSignal }
      const sessionId = context.agent?.session?.id
      if (sessionId === undefined) throw new Error(`${SEND_DOC_TOOL} requires a calling agent (no chat to send to)`)
      const workspace = ports.workspaceOf(sessionId)
      if (workspace === undefined) throw new Error(`${SEND_DOC_TOOL} found no chat for this session`)

      const verdict = resolveOutboundFile(requested, workspace, ports.maxBytes)
      if (!verdict.ok) {
        if (verdict.refusal.code === 'outside_workspace') {
          ports.report(`lark-channel: ${SEND_DOC_TOOL} refused ${requested.replace(/\s+/g, ' ').slice(0, 200)} `
            + `in session ${sessionId}: ${verdict.refusal.code}`)
        }
        throw new Error(describeRefusalForModel(verdict.refusal))
      }

      return ports.withOutboundSlot(sessionId, async () => {
        throwIfAborted(context.signal)
        // The shared slot was claimed before this read, so three pending group
        // document approvals cannot be followed by a fourth pinned buffer.
        const artifact = await readDocumentArtifact(verdict.file)
        throwIfAborted(context.signal)
        const published = await ports.publish(sessionId, artifact, context.signal)
        return {
          sent: true as const,
          link: published.url,
          appended: published.appended,
          ...published.warning === undefined ? {} : { warning: published.warning },
        }
      })
    },
  }
}

/** Parsed `/put` arguments; path keeps spaces, the target must be one complete URL. */
export type PutCommandArguments =
  | { readonly ok: true; readonly path: string; readonly into?: string | undefined }
  | { readonly ok: false; readonly reason: string }

/** Parse `/put <path> [--into <link>]` without inventing shell quoting rules. */
export function parsePutCommand(line: string): PutCommandArguments {
  const tail = line.trimStart().slice(1 + PUT_COMMAND.length).trim()
  if (tail === '') return { ok: false, reason: `用法：\`/${PUT_COMMAND} <路径> [--into <文档链接>]\`` }
  const markers = [...tail.matchAll(/(?:^|\s+)--into(?:\s+|$)/gu)]
  if (markers.length === 0) return { ok: true, path: tail }
  if (markers.length > 1) return { ok: false, reason: '`--into` 只能出现一次。' }
  const marker = markers[0]!
  const path = tail.slice(0, marker.index).trim()
  const into = tail.slice(marker.index + marker[0].length).trim()
  if (path === '') return { ok: false, reason: '缺少要发布的工作区文件路径。' }
  if (into === '') return { ok: false, reason: '`--into` 后需要一个 docx 或 wiki 文档链接。' }
  if (/\s/u.test(into)) return { ok: false, reason: '`--into` 只接受一个完整的 docx 或 wiki 文档链接。' }
  return { ok: true, path, into }
}

/** Run the human-owned publish command; it intentionally uses no long-lived group slot. */
export async function runPutCommand(
  line: string,
  workspace: string,
  maxBytes: number,
  resolveTarget: (value: string, signal?: AbortSignal) => Promise<LarkDocumentTarget>,
  publish: (
    artifact: LarkDocumentArtifact,
    target: LarkDocumentTarget | undefined,
    signal?: AbortSignal,
  ) => Promise<PublishedLarkDocument>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const parsed = parsePutCommand(line)
  if (!parsed.ok) return `⚠️ ${parsed.reason}`
  const verdict = resolveOutboundFile(parsed.path, workspace, maxBytes)
  if (!verdict.ok) return `⚠️ ${describeRefusalForChat(verdict.refusal)}`
  try {
    throwIfAborted(signal)
    const artifact = await readDocumentArtifact(verdict.file)
    throwIfAborted(signal)
    // Human-owned /put may append because the person explicitly selected the target.
    const target = parsed.into === undefined ? undefined : await resolveTarget(parsed.into, signal)
    throwIfAborted(signal)
    const published = await publish(artifact, target, signal)
    if (published.receiptWarning !== undefined) {
      return `✅ 文档已写入，内容不会重试：${published.url}\n⚠️ ${published.receiptWarning}`
    }
    return undefined
  } catch (error) {
    return `⚠️ 写入飞书文档失败：${describeLarkDocumentFailure(error)}`
  }
}
