/**
 * Agent-facing document-comment workflow: session constraints, turn quotas,
 * anchored snapshot placement, and the two tool definitions.
 *
 * Raw Lark URLs, request bodies, and response parsing remain in `larkdocs.ts`
 * under ADR 0006; this module is intentionally protocol-free.
 * @module dsh-lark-channel/larkdoc-comments
 */

import { constants } from 'node:fs'
import { open, readdir, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { claimFileName, sanitizeFileName } from './files.ts'
import { failureDetail } from './format.ts'
import { resolveOutboundFile } from './outbound-file.ts'
import { canonicalPathOf, isWithinContainer } from './containment.ts'
import {
  assertLarkCommentTextLimit,
  createAnchoredLarkDocumentComment,
  describeLarkDocumentFailure,
  fetchLarkDocumentAnchors,
  larkDocsErrorDetails,
  resolveLarkDocumentTarget,
} from './larkdocs.ts'
import type {
  FetchedLarkDocument,
  LarkCommentReplyElement,
  LarkDocsProtocolPort,
  LarkDocumentTarget,
} from './larkdocs.ts'
import type {
  LarkDocumentFileIdentity,
  ReadLarkDocumentReference,
  ReadLarkDocumentSessions,
} from './larkdoc-session.ts'

/** The model-facing tool that fetches comment-aware XML block anchors. */
export const READ_DOC_ANCHORS_TOOL = 'read_doc_anchors'

/** The model-facing tool that creates one anchored comment. */
export const COMMENT_ON_DOC_TOOL = 'comment_on_doc'

/** Per-session counters keyed to the host's explicit agent turn lifecycle. */
export class LarkDocumentCommentQuotas {
  readonly #limit: number
  readonly #bySession = new Map<string, { turn: number; used: number }>()

  constructor(limit: number) {
    this.#limit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  }

  /** Open a turn once; duplicate lifecycle events cannot reset its counter. */
  beginTurn(sessionId: string, turn: number): void {
    if (this.#bySession.get(sessionId)?.turn === turn) return
    this.#bySession.set(sessionId, { turn, used: 0 })
  }

  /** Close only the turn named by the event, preserving a newer turn. */
  finishTurn(sessionId: string, turn: number): void {
    if (this.#bySession.get(sessionId)?.turn === turn) this.#bySession.delete(sessionId)
  }

  /** Spend one comment immediately before its network request. */
  consume(sessionId: string): void {
    const state = this.#bySession.get(sessionId)
    if (state === undefined) {
      throw new Error(`${COMMENT_ON_DOC_TOOL} is outside an active agent turn, so no comment was created.`)
    }
    if (state.used >= this.#limit) {
      throw new Error(`This turn's document-comment quota is exhausted (${state.used}/${this.#limit}); `
        + 'no more comments can be created until the next agent turn.')
    }
    state.used += 1
  }

  /** Forget one reset conversation without touching concurrent sessions. */
  clear(sessionId: string): void {
    this.#bySession.delete(sessionId)
  }

  /** Release bridge-owned state on disposal. */
  clearAll(): void {
    this.#bySession.clear()
  }
}

/** Boundaries shared by the two agent-scoped comment primitives. */
export interface CommentDocPorts {
  readonly protocol: LarkDocsProtocolPort
  readonly readDocuments: ReadLarkDocumentSessions
  readonly quotas: LarkDocumentCommentQuotas
  /** Reuses the inbound snapshot ceiling for the XML sibling. */
  readonly maxFileBytes: number
  readonly report: (line: string) => void
  workspaceOf(sessionId: string): string | undefined
  chatIdOf(sessionId: string): string | undefined
  correctFailure(sessionId: string, error: unknown): void | Promise<void>
  /** Internal deterministic race probe; production leaves it absent. */
  afterAnchorsIdentityValidation?: ((input: {
    readonly phase: 'create' | 'refresh'
    readonly path: string
  }) => void | Promise<void>) | undefined
  /** Internal deterministic probe between snapshot containment and open. */
  beforeAnchorsOpen?: ((input: {
    readonly phase: 'create' | 'refresh'
    readonly path: string
  }) => void | Promise<void>) | undefined
}

/** Resolve one tool's target and feed only real scope violations into Task #0. */
async function resolveCommentToolTarget(
  ports: CommentDocPorts,
  sessionId: string,
  supplied: string,
  signal?: AbortSignal,
): Promise<LarkDocumentTarget> {
  try {
    signal?.throwIfAborted()
    const target = await resolveLarkDocumentTarget(ports.protocol, supplied, signal)
    // The typed wiki call cannot receive an AbortSignal; this boundary is what
    // prevents a resolved-but-cancelled target from reaching the raw endpoint.
    signal?.throwIfAborted()
    return target
  } catch (error) {
    await Promise.resolve(ports.correctFailure(sessionId, error)).catch((correctionError: unknown) => {
      ports.report(`lark-channel: correcting document comment capability failed: ${failureDetail(correctionError)}`)
    })
    throw new Error(describeLarkDocumentFailure(error))
  }
}

/** O_NOFOLLOW where the host exposes it; identity checks remain authoritative without it. */
const NO_FOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

/** Filesystem identity from one bigint stat result. */
function anchorsIdentity(stats: { readonly dev: bigint; readonly ino: bigint }): LarkDocumentFileIdentity {
  return { device: stats.dev, inode: stats.ino }
}

/** Whether two observations name the same inode. */
function isSameAnchorsIdentity(left: LarkDocumentFileIdentity, right: LarkDocumentFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

/**
 * Validate one already-open handle before any content write.
 *
 * The handle identity, canonical containment, and current path identity must
 * all agree. Repeating this after the race probe catches a parent-directory
 * swap deterministically; writing through the handle is what keeps a swap in
 * the remaining syscall window from redirecting bytes to the new path.
 */
async function validateAnchorsHandle(
  handle: FileHandle,
  path: string,
  workspace: string,
  expected?: LarkDocumentFileIdentity,
): Promise<LarkDocumentFileIdentity> {
  const handleStats = await handle.stat({ bigint: true })
  if (!handleStats.isFile()) throw new Error('The anchored XML path is not a regular file.')
  const identity = anchorsIdentity(handleStats)
  if (expected !== undefined && !isSameAnchorsIdentity(identity, expected)) {
    throw new Error('The anchored XML file was replaced since this conversation first created it; refusing to write.')
  }

  const container = canonicalPathOf(workspace) ?? resolve(workspace)
  const canonical = canonicalPathOf(path)
  if (canonical === undefined || !isWithinContainer(canonical, container)) {
    throw new Error('The anchored XML path no longer resolves inside this conversation workspace; refusing to write.')
  }
  const pathStats = await stat(path, { bigint: true })
  if (!pathStats.isFile() || !isSameAnchorsIdentity(identity, anchorsIdentity(pathStats))) {
    throw new Error('The anchored XML path changed after it was opened; refusing to write.')
  }
  return identity
}

/** Unlink an exclusive-created entry only while the path still names that exact inode. */
async function unlinkCreatedAnchorsIfOwned(
  path: string,
  identity: LarkDocumentFileIdentity,
): Promise<void> {
  try {
    const current = await stat(path, { bigint: true })
    if (!isSameAnchorsIdentity(identity, anchorsIdentity(current))) return
    await unlink(path)
  } catch {
    // Missing/replaced paths are not ours to delete.
  }
}

/** Write every byte at offset zero through the identity-validated handle, then resize. */
async function writeAnchorsHandle(handle: FileHandle, content: string): Promise<void> {
  const bytes = Buffer.from(content, 'utf8')
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    if (result.bytesWritten === 0) throw new Error('Writing the anchored XML snapshot made no progress.')
    offset += result.bytesWritten
  }
  await handle.truncate(bytes.byteLength)
}

/** First claim: create without following/overwriting, validate, then write through that handle. */
async function createAnchorsFile(
  ports: CommentDocPorts,
  path: string,
  workspace: string,
  content: string,
  signal?: AbortSignal,
): Promise<LarkDocumentFileIdentity> {
  signal?.throwIfAborted()
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
    0o600,
  )
  let identity: LarkDocumentFileIdentity | undefined
  try {
    // Capture ownership immediately after O_EXCL succeeds. Validation may fail
    // because the parent was swapped before open; cleanup still has to know
    // which empty directory entry this call itself created.
    const created = await handle.stat({ bigint: true })
    identity = anchorsIdentity(created)
    await validateAnchorsHandle(handle, path, workspace, identity)
    await ports.afterAnchorsIdentityValidation?.({ phase: 'create', path })
    signal?.throwIfAborted()
    await validateAnchorsHandle(handle, path, workspace, identity)
    await writeAnchorsHandle(handle, content)
    signal?.throwIfAborted()
    await validateAnchorsHandle(handle, path, workspace, identity)
    return identity
  } catch (error) {
    if (identity !== undefined) await unlinkCreatedAnchorsIfOwned(path, identity)
    throw error
  } finally {
    await handle.close()
  }
}

/**
 * Refresh in place through the validated handle.
 *
 * This intentionally gives up atomic replacement: preserving the first file's
 * identity is the stronger safety property. A mid-write failure may leave that
 * same file partially refreshed, but no failure path dereferences an unverified
 * replacement and no parent swap can redirect bytes to an external victim.
 */
async function refreshAnchorsFile(
  ports: CommentDocPorts,
  path: string,
  workspace: string,
  expected: LarkDocumentFileIdentity,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const handle = await open(path, constants.O_RDWR | NO_FOLLOW)
  try {
    const identity = await validateAnchorsHandle(handle, path, workspace, expected)
    await ports.afterAnchorsIdentityValidation?.({ phase: 'refresh', path })
    signal?.throwIfAborted()
    await validateAnchorsHandle(handle, path, workspace, identity)
    await writeAnchorsHandle(handle, content)
    signal?.throwIfAborted()
    await validateAnchorsHandle(handle, path, workspace, identity)
  } finally {
    await handle.close()
  }
}

/** Require the final docx token to belong to this exact conversation session. */
function requireReadCommentTarget(
  ports: CommentDocPorts,
  sessionId: string,
  target: LarkDocumentTarget,
): void {
  if (!ports.readDocuments.has(sessionId, target.fileToken)) {
    throw new Error('That document was not read in this conversation. Document comments are allowed only on a '
      + 'document this session has already read; ask the person to send its link here first.')
  }
}

/** Stable comment failure text; 1069302 commonly means a stale/invalid anchor. */
export function describeLarkDocumentCommentFailure(error: unknown): string {
  const details = larkDocsErrorDetails(error)
  const failure = `${details.code === undefined ? '' : `[${String(details.code)}] `}${details.message}`
  return String(details.code) === '1069302'
    ? `${failure}. The document or anchor may have changed; run ${READ_DOC_ANCHORS_TOOL} again and use a current block_id.`
    : failure
}

/** Land comment-aware XML beside the trusted markdown snapshot. */
async function landLarkDocumentAnchors(
  ports: CommentDocPorts,
  sessionId: string,
  target: LarkDocumentTarget,
  reference: ReadLarkDocumentReference,
  content: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > ports.maxFileBytes) {
    throw new Error(`The anchored XML snapshot is ${bytes} bytes; the limit is ${ports.maxFileBytes} bytes, so it was not saved.`)
  }
  const workspace = ports.workspaceOf(sessionId)
  if (workspace === undefined) throw new Error(`${READ_DOC_ANCHORS_TOOL} found no workspace for this session`)

  // Reuse the existing canonicalize-then-contain check instead of trusting a
  // remembered string after a person or process may have replaced it.
  const snapshot = resolveOutboundFile(reference.path, workspace, Number.MAX_SAFE_INTEGER)
  if (!snapshot.ok) {
    throw new Error('The original document snapshot is no longer a regular file inside this workspace. '
      + 'Ask the person to send the document link again before reading anchors.')
  }
  const directory = dirname(snapshot.file.path)
  signal?.throwIfAborted()
  const claimed = new Set(await readdir(directory))
  const candidate = join(
    directory,
    claimFileName(claimed, sanitizeFileName(`${reference.title || target.fileToken}.blocks.xml`)),
  )
  const reservation = ports.readDocuments.reserveAnchorsPath(sessionId, target.fileToken, candidate)
  if (reservation === undefined || dirname(reservation.path) !== directory) {
    throw new Error('The document snapshot reference changed before its anchors path could be reserved. '
      + 'Ask the person to send the document link again.')
  }
  try {
    if (reservation.identity === undefined) {
      await ports.beforeAnchorsOpen?.({ phase: 'create', path: reservation.path })
      signal?.throwIfAborted()
      const identity = await createAnchorsFile(
        ports,
        reservation.path,
        workspace,
        content,
        signal,
      )
      if (!ports.readDocuments.commitAnchorsIdentity(
        sessionId,
        target.fileToken,
        reservation.path,
        identity,
      )) {
        await unlinkCreatedAnchorsIfOwned(reservation.path, identity)
        throw new Error('The conversation reset before the anchored XML identity could be recorded.')
      }
    } else {
      await ports.beforeAnchorsOpen?.({ phase: 'refresh', path: reservation.path })
      signal?.throwIfAborted()
      await refreshAnchorsFile(
        ports,
        reservation.path,
        workspace,
        reservation.identity,
        content,
        signal,
      )
    }
  } catch (error) {
    // EEXIST means the no-overwrite first claim lost a race, so a later call
    // must choose another name. Other failures retain the stable reservation:
    // a cancelled first write, for example, should refresh this same path next
    // time rather than manufacture `-2` merely because no file was committed.
    if (reservation.identity === undefined && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      ports.readDocuments.releaseAnchorsPath(sessionId, target.fileToken, reservation.path)
    }
    throw error
  }
  signal?.throwIfAborted()
  return reservation.path
}

/** Tool definition for the uncommon second, block-id-bearing document read. */
export function readDocAnchorsTool(ports: CommentDocPorts): object {
  /** Serialize only sibling-file commits for one session/document pair. */
  const landingTails = new Map<string, Promise<void>>()
  const serializeLanding = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = landingTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => { release = resolve })
    landingTails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (landingTails.get(key) === tail) landingTails.delete(key)
    }
  }

  return {
    name: READ_DOC_ANCHORS_TOOL,
    description: 'Fetch a comment-aware XML snapshot with block ids for a Feishu document this conversation has '
      + 'already read. Use the returned file to choose block_id values before comment_on_doc.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['doc'],
      properties: {
        doc: { type: 'string', description: 'Complete docx or Wiki link already read in this conversation.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: `The anchored document snapshot was saved at ${String((value as { path?: unknown })?.path ?? '')}.`,
      }],
    },
    async execute(args: unknown, exec: unknown): Promise<{ path: string }> {
      const supplied = String((args as { doc?: unknown } | null | undefined)?.doc ?? '')
      const context = exec as { agent?: { session?: { id?: string } }; signal?: AbortSignal }
      const sessionId = context.agent?.session?.id
      if (sessionId === undefined) throw new Error(`${READ_DOC_ANCHORS_TOOL} requires a calling agent`)
      context.signal?.throwIfAborted()
      if (ports.chatIdOf(sessionId) === undefined) {
        throw new Error(`${READ_DOC_ANCHORS_TOOL} found no chat for this session`)
      }
      const target = await resolveCommentToolTarget(ports, sessionId, supplied, context.signal)
      context.signal?.throwIfAborted()
      requireReadCommentTarget(ports, sessionId, target)
      const reference = ports.readDocuments.reference(sessionId, target.fileToken)
      if (reference === undefined) {
        throw new Error('The document is in this conversation\'s read set, but its landed snapshot location is unavailable. '
          + 'Ask the person to send its link here again before reading anchors.')
      }
      let fetched: FetchedLarkDocument
      try {
        fetched = await fetchLarkDocumentAnchors(ports.protocol, target.fileToken, context.signal)
      } catch (error) {
        await Promise.resolve(ports.correctFailure(sessionId, error)).catch((correctionError: unknown) => {
          ports.report(`lark-channel: correcting document comment capability failed: ${failureDetail(correctionError)}`)
        })
        ports.report(`lark-channel: reading document anchors for ${target.fileToken} failed: `
          + describeLarkDocumentFailure(error))
        throw new Error(describeLarkDocumentFailure(error))
      }
      context.signal?.throwIfAborted()
      const path = await serializeLanding(
        `${sessionId}\0${target.fileToken}`,
        () => landLarkDocumentAnchors(
          ports,
          sessionId,
          target,
          reference,
          fetched.content,
          context.signal,
        ),
      )
      context.signal?.throwIfAborted()
      return { path }
    },
  }
}

/** Tool definition for one bounded, always-anchored create_v2 comment. */
export function commentOnDocTool(ports: CommentDocPorts): object {
  return {
    name: COMMENT_ON_DOC_TOOL,
    description: 'Write one anchored comment on a Feishu document this conversation has already read. Call '
      + 'read_doc_anchors first and pass one current block_id. This never creates a whole-document comment.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['doc', 'block_id', 'text'],
      properties: {
        doc: { type: 'string', description: 'Complete docx or Wiki link already read in this conversation.' },
        block_id: { type: 'string', description: 'Current block id from read_doc_anchors.' },
        text: { type: 'string', description: 'Comment text, up to 10000 Unicode code points.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['commented', 'comment_id'],
        properties: {
          commented: { type: 'boolean' },
          comment_id: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: `Anchored document comment created (${String((value as { comment_id?: unknown })?.comment_id ?? '')}).`,
      }],
    },
    async execute(args: unknown, exec: unknown): Promise<{ commented: true; comment_id: string }> {
      const input = args as { doc?: unknown; block_id?: unknown; text?: unknown } | null | undefined
      const supplied = String(input?.doc ?? '')
      const blockId = String(input?.block_id ?? '').trim()
      const text = String(input?.text ?? '')
      const context = exec as { agent?: { session?: { id?: string } }; signal?: AbortSignal }
      const sessionId = context.agent?.session?.id
      if (sessionId === undefined) throw new Error(`${COMMENT_ON_DOC_TOOL} requires a calling agent`)
      context.signal?.throwIfAborted()
      if (ports.chatIdOf(sessionId) === undefined) throw new Error(`${COMMENT_ON_DOC_TOOL} found no chat for this session`)
      if (blockId === '') throw new Error(`${COMMENT_ON_DOC_TOOL} requires a non-empty block_id from ${READ_DOC_ANCHORS_TOOL}`)
      if (text === '') throw new Error(`${COMMENT_ON_DOC_TOOL} requires non-empty comment text`)
      const replyElements: readonly LarkCommentReplyElement[] = [{ type: 'text', text }]
      assertLarkCommentTextLimit(replyElements)

      const target = await resolveCommentToolTarget(ports, sessionId, supplied, context.signal)
      context.signal?.throwIfAborted()
      requireReadCommentTarget(ports, sessionId, target)
      // Consumed immediately before the request: validation failures do not
      // spend quota, while failed write attempts still cannot be used to spam.
      context.signal?.throwIfAborted()
      ports.quotas.consume(sessionId)
      try {
        const commentId = await createAnchoredLarkDocumentComment(
          ports.protocol,
          target.fileToken,
          blockId,
          replyElements,
          context.signal,
        )
        context.signal?.throwIfAborted()
        return { commented: true, comment_id: commentId }
      } catch (error) {
        await Promise.resolve(ports.correctFailure(sessionId, error)).catch((correctionError: unknown) => {
          ports.report(`lark-channel: correcting document comment capability failed: ${failureDetail(correctionError)}`)
        })
        const failure = describeLarkDocumentCommentFailure(error)
        ports.report(`lark-channel: commenting on document ${target.fileToken} failed: ${failure}`)
        throw new Error(failure)
      }
    },
  }
}
