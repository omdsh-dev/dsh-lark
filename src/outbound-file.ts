/**
 * How bytes leave a workspace for the chat: the model's own `send_file`, the
 * human's `/get`, and the one check both go through.
 *
 * This module exists in this shape because of HOW the bytes leave. The plugin
 * hands the transport a `Buffer` rather than a local path (ADR 0004), and
 * `MediaUploader.toBuffer` returns on its first line for a buffer —
 * `Buffer.isBuffer(source)` — so the SDK's own
 * `resolve → blacklist → realpath → re-check → allowlist` guard never runs for
 * anything this plugin sends. The `resolve → realpath → container check` order
 * in {@link resolveOutboundFile} IS that guard, put back by hand. Its two middle
 * steps are not interchangeable: canonicalize first, ask "inside the workspace?"
 * second, or `<workspace>/link → /etc/shadow` answers yes.
 *
 * What the check clears is a file, not a permission. Whether a cleared file may
 * actually go out is the bridge's gate — direct message straight through, group
 * behind an approval card (ADR 0002) — and the bridge reads the bytes before it
 * asks, so what a room approves is the artifact that leaves. Nothing here knows
 * about that, on purpose: this module answers "may these bytes be sent at all",
 * once, for both callers.
 * @module dsh-lark-channel/outbound-file
 */

import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { canonicalPathOf, isWithinContainer } from './containment.ts'
import { failureDetail, formatBytesForChat, formatBytesForModel } from './format.ts'

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
      return `That file is ${formatBytesForModel(refusal.bytes)}, over this chat's `
        + `${formatBytesForModel(refusal.limit)} single-file limit; send a smaller file, or an excerpt in your reply.`
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
      return `文件有 ${formatBytesForChat(refusal.bytes)}，超过单个文件上限 ${formatBytesForChat(refusal.limit)}。`
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
        // The ESCAPE is reported, and only the escape. A model reaching outside
        // its workspace is the shape an injected instruction takes, it never
        // reaches the delivery port, so this is the only place it can leave a
        // trace — while "not found", "not a file" and "too large" are the model
        // mistyping a path or misjudging a size, and putting those on the
        // console lets a model that keeps guessing write to it at will.
        // Collapsed to one bounded line first, because the path is model-authored
        // text and a console line it could break in two is one it could forge.
        if (verdict.refusal.code === 'outside_workspace') {
          const attempted = requested.replace(/\s+/g, ' ').slice(0, 200)
          ports.report(`lark-channel: ${SEND_FILE_TOOL} refused ${attempted} `
            + `in session ${sessionId}: ${verdict.refusal.code}`)
        }
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
