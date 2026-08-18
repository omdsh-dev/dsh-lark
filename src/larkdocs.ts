/**
 * Temporary home for Lark cloud-document protocol facts that neither
 * `@larksuite/channel` nor the typed node SDK currently owns.
 *
 * ADR 0006 (`docs/adr/0006-lark-doc-protocol-lands-here-first.md`) requires
 * this boundary to move as one unit into a future `channel/docs.ts` once the
 * raw endpoints have been verified in real applications. Keep URLs, response
 * parsing, scope names, and platform error shapes here rather than leaking
 * them into the bridge.
 *
 * @module dsh-lark-channel/larkdocs
 */

/** The three independently gated cloud-document features. */
export type LarkDocCapability = 'read' | 'write' | 'comment'

/** One capability's tenant-scope contract. */
export interface LarkDocScopeRequirement {
  /** Every scope must be granted before a verified capability is available. */
  readonly scopes: readonly string[]
  /** False means the names still need the real permission-violation probe in design §3. */
  readonly verified: boolean
}

/** Scope requirements keyed by the feature they gate. */
export type LarkDocScopeRequirements = Readonly<Record<LarkDocCapability, LarkDocScopeRequirement>>

/**
 * Tenant scope names for cloud-document operations.
 *
 * The design deliberately refuses to infer these from similarly named public
 * APIs: `docs_ai` is not typed, and the server's
 * `error.permission_violations[].subject` is the source of truth. No safe
 * IM-only test application was available while Task #0 was implemented. The
 * names below are the minimum tenant scopes confirmed from first-party API
 * documentation and official CLI metadata, not from the §3 endpoint probes;
 * `verified` therefore remains false and the status surface says so. Runtime
 * violations are retained by `LarkDocCapabilities`, which lets on-demand
 * authorization use the exact names the platform returned. Flip `verified`
 * only after the §3 probes are run.
 */
export const LARK_DOC_SCOPE_REQUIREMENTS: LarkDocScopeRequirements = {
  read: {
    scopes: ['docx:document:readonly', 'wiki:node:read'],
    verified: false,
  },
  write: {
    scopes: [
      'docx:document:create',
      'docx:document:write_only',
      'docx:document:readonly',
      'docs:permission.member:create',
    ],
    verified: false,
  },
  comment: {
    scopes: ['docs:document.comment:create', 'docx:document:readonly'],
    verified: false,
  },
}

/** One item returned by `application.v6.scope.list`. */
export interface LarkScopeGrant {
  readonly scope_name: string
  readonly grant_status: number
  readonly scope_type?: 'user' | 'tenant' | undefined
}

/** The typed SDK response shape used by the capability probe. */
export interface LarkScopeListResponse {
  readonly code?: number | undefined
  readonly msg?: string | undefined
  readonly data?: { readonly scopes?: readonly LarkScopeGrant[] | undefined } | undefined
}

/** One wiki node as returned by the typed `wiki.v2.space.getNode` endpoint. */
export interface LarkWikiNodeResponse {
  readonly code?: number | undefined
  readonly msg?: string | undefined
  readonly data?: {
    readonly node?: {
      readonly obj_token?: string | undefined
      readonly obj_type?: string | undefined
      readonly title?: string | undefined
    } | undefined
  } | undefined
}

/** Minimum typed and raw client surface used by document capabilities and reads. */
export interface LarkDocsClient {
  readonly application: {
    readonly v6: {
      readonly scope: {
        list(payload?: {}): Promise<LarkScopeListResponse>
      }
    }
  }
  readonly wiki: {
    readonly v2: {
      readonly space: {
        getNode(payload: { readonly params: { readonly token: string } }): Promise<LarkWikiNodeResponse>
      }
    }
  }
  readonly drive?: {
    readonly v1: {
      readonly permissionMember: {
        create(payload: {
          readonly data: {
            readonly member_type: 'openid' | 'openchat'
            readonly member_id: string
            readonly perm: 'view'
          }
          readonly params: { readonly type: 'docx'; readonly need_notification?: boolean }
          readonly path: { readonly token: string }
        }): Promise<{ readonly code?: number | undefined; readonly msg?: string | undefined }>
      }
    }
  }
  /** Untyped docs_ai escape hatch kept inside this ADR 0006 boundary. */
  request(options: {
    readonly method: string
    readonly url: string
    readonly data?: unknown
    readonly params?: unknown
    readonly signal?: AbortSignal
  }): Promise<unknown>
}

/** A channel port exposing the SDK client without importing a transitive dependency. */
export interface LarkDocsProtocolPort {
  readonly rawClient: LarkDocsClient
}

/** A platform error reduced to the fields this feature can act on. */
export interface LarkDocsErrorDetails {
  readonly code?: string | number | undefined
  readonly message: string
  /** Exact tenant scopes named by the platform; empty means this is not an app-scope failure. */
  readonly permissionViolations: readonly string[]
}

/** Safely treat an arbitrary value as a string-keyed object. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Read a non-empty platform code without inventing one. */
function errorCode(value: unknown): string | number | undefined {
  const candidate = record(value)?.code
  return typeof candidate === 'string' || typeof candidate === 'number' ? candidate : undefined
}

/** Read the most useful message carried by one error envelope. */
function errorMessage(value: unknown): string | undefined {
  if (value instanceof Error && value.message !== '') return value.message
  const candidate = record(value)
  for (const key of ['msg', 'message', 'description'] as const) {
    const text = candidate?.[key]
    if (typeof text === 'string' && text !== '') return text
  }
  return undefined
}

/** Extract exact violation subjects from one `{ error: { permission_violations } }` body. */
function violationSubjects(value: unknown): string[] {
  const violations = record(record(value)?.error)?.permission_violations
  if (!Array.isArray(violations)) return []
  return violations.flatMap((violation) => {
    const subject = record(violation)?.subject
    return typeof subject === 'string' && subject !== '' ? [subject] : []
  })
}

/**
 * Parse the several envelopes node-sdk/Axios may put around a platform error.
 *
 * Only `error.permission_violations[].subject` marks an application-scope
 * failure. Resource access errors therefore leave the list empty and cannot
 * accidentally disable a whole capability.
 * @param value - thrown error or non-zero raw response.
 * @returns stable details suitable for logging and runtime correction.
 */
export function larkDocsErrorDetails(value: unknown): LarkDocsErrorDetails {
  const root = record(value)
  const response = record(root?.response)
  const responseData = record(response?.data)
  const data = record(root?.data)
  // Axios puts the authoritative Lark envelope under response.data while the
  // outer Error carries transport prose such as "Request failed with status
  // code 403". Platform code/msg must win whenever both exist.
  const candidates = [response?.data, responseData?.error, root?.data, data?.error, root?.error, value]
  const carried = root?.permissionViolations
  const permissionViolations = [...new Set([
    ...candidates.flatMap(violationSubjects),
    ...Array.isArray(carried)
      ? carried.filter((scope): scope is string => typeof scope === 'string' && scope !== '')
      : [],
  ])]
  const code = candidates.map(errorCode).find(candidate => candidate !== undefined)
  const message = candidates.map(errorMessage).find(candidate => candidate !== undefined)
    ?? (typeof value === 'string' ? value : 'Unknown Lark API failure')
  return { code, message, permissionViolations }
}

/** Error thrown when a raw protocol response reports a non-zero platform code. */
export class LarkDocsProtocolError extends Error {
  readonly code?: string | number | undefined
  readonly permissionViolations: readonly string[]

  constructor(value: unknown) {
    const details = larkDocsErrorDetails(value)
    super(details.message)
    this.name = 'LarkDocsProtocolError'
    this.code = details.code
    this.permissionViolations = details.permissionViolations
  }
}

/**
 * Reject a raw protocol response that carries a non-zero platform code.
 * @param response - untyped `rawClient.request` result.
 * @returns the same response after validation.
 */
export function checkedLarkDocsResponse<T>(response: T): T {
  const code = errorCode(response)
  const platformError = record(record(response)?.error)
  if ((code !== undefined && code !== 0 && code !== '0')
    || (platformError !== undefined && Object.keys(platformError).length > 0)) {
    throw new LarkDocsProtocolError(response)
  }
  return response
}

/** Stable model/chat-facing error preserving the platform code and message. */
export function describeLarkDocumentFailure(error: unknown): string {
  const details = larkDocsErrorDetails(error)
  return `${details.code === undefined ? '' : `[${String(details.code)}] `}${details.message}`
}

/** A document created or appended through docs_ai. */
export interface WrittenLarkDocument {
  readonly fileToken: string
  readonly url: string
  readonly title: string
  readonly appended: boolean
}

/** A docx target resolved from either a direct document or wiki link. */
export interface LarkDocumentTarget {
  readonly fileToken: string
  readonly sourceUrl: string
}

/** Which standard user-facing host fills a missing create response URL. */
export type LarkDocumentBrand = 'feishu' | 'lark'

/** Escape a title inserted into docs_ai's XML-like markdown content. */
export function escapeLarkDocumentTitle(title: string): string {
  return title.replace(/[&<>"']/gu, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&#34;',
    "'": '&#39;',
  })[character]!)
}

/** Reverse {@link escapeLarkDocumentTitle} for a title read back out of content. */
function unescapeLarkDocumentTitle(value: string): string {
  return value.replace(/&(?:amp|lt|gt|#34|#39);/gu, entity => ({
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&#34;': '"',
    '&#39;': "'",
  })[entity] ?? entity)
}

/**
 * The title a docs_ai export carries inside its own content.
 *
 * Measured 2026-08-18 against a live tenant: the fetch response has no `title`
 * field at all — `data.document` is `{ content, document_id, revision_id }` in
 * both formats. A real document's export instead opens with the DocxXML title
 * element, because a document title is one of the things markdown cannot
 * express (design §7.3). Without reading it here, every plain docx link lands
 * under a name that is only its token, and design §7.4's token fallback stops
 * being the exception it was written as.
 * @param content - exported document body, markdown or XML.
 * @returns the title, or undefined when the export opens with ordinary content.
 */
export function larkDocumentTitleFromContent(content: string): string | undefined {
  const opening = /^\s*<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(content)
  if (opening === null) return undefined
  const title = unescapeLarkDocumentTitle(opening[1] ?? '').trim()
  return title === '' ? undefined : title
}

/** Exact create body required by docs_ai. Title is content, not a top-level field. */
export function larkDocumentCreateData(title: string, content: string): object {
  const normalizedTitle = title.trim()
  const body = normalizedTitle === ''
    ? content
    : content === ''
      ? `<title>${escapeLarkDocumentTitle(normalizedTitle)}</title>`
      : `<title>${escapeLarkDocumentTitle(normalizedTitle)}</title>\n${content}`
  return {
    content: body,
    format: 'markdown',
    parent_position: 'my_library',
  }
}

/** Exact append body. `-1` is the protocol's end-of-document sentinel. */
export function larkDocumentAppendData(content: string): object {
  return { format: 'markdown', command: 'block_insert_after', block_id: '-1', content }
}

/** Document-link forms this channel deliberately understands. */
export type LarkDocumentLink =
  | { readonly kind: 'docx'; readonly token: string; readonly url: string }
  | { readonly kind: 'wiki'; readonly token: string; readonly url: string }
  | {
      readonly kind: 'unsupported'
      readonly type: 'docs' | 'sheets' | 'base' | 'minutes' | 'file'
      readonly token?: string | undefined
      readonly url: string
    }
  | { readonly kind: 'other-lark'; readonly url: string }
  | { readonly kind: 'external'; readonly url: string }

/** A document fetched from the API before it is committed to the workspace. */
export interface FetchedLarkDocument {
  readonly fileToken: string
  readonly title?: string | undefined
  readonly content: string
}

/** The exact body of the untyped docs_ai markdown fetch endpoint. */
export const LARK_DOC_MARKDOWN_FETCH_DATA = {
  format: 'markdown',
  extra_param: JSON.stringify({
    enable_user_cite_reference_map: true,
    return_html5_block_data: true,
  }),
  export_option: {
    export_block_id: false,
    export_style_attrs: false,
    export_cite_extra_data: false,
  },
} as const

/** Exact body of the separate, comment-aware XML anchor fetch. */
export const LARK_DOC_ANCHOR_FETCH_DATA = {
  format: 'xml',
  extra_param: JSON.stringify({
    enable_user_cite_reference_map: true,
    include_comments: true,
    return_html5_block_data: true,
  }),
  export_option: { export_block_id: true },
} as const

/** Server-enforced aggregate text budget for one create_v2 comment. */
export const MAX_LARK_DOC_COMMENT_RUNES = 10_000

/** Hosts which carry tenant Feishu/Lark document paths. */
const LARK_DOCUMENT_HOSTS = ['feishu.cn', 'larksuite.com', 'larkoffice.com'] as const

/** Recognized but deliberately unsupported document surfaces. */
const UNSUPPORTED_DOCUMENT_TYPES = new Set(['docs', 'sheets', 'base', 'minutes', 'file'])

/** Decide whether a host belongs to a supported tenant-domain suffix. */
function isLarkDocumentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return LARK_DOCUMENT_HOSTS.some(suffix => normalized === suffix || normalized.endsWith(`.${suffix}`))
}

/**
 * Classify one URL without making a network request.
 * @param value - complete URL candidate.
 * @returns a stable link kind and, where applicable, its path token.
 */
export function classifyLarkDocumentUrl(value: string): LarkDocumentLink {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { kind: 'external', url: value }
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !isLarkDocumentHost(parsed.hostname)) {
    return { kind: 'external', url: value }
  }
  const [type = '', token = ''] = parsed.pathname.split('/').filter(Boolean)
  if ((type === 'docx' || type === 'wiki') && token !== '') {
    return { kind: type, token, url: value }
  }
  if (UNSUPPORTED_DOCUMENT_TYPES.has(type)) {
    return {
      kind: 'unsupported',
      type: type as Extract<LarkDocumentLink, { kind: 'unsupported' }>['type'],
      ...token === '' ? {} : { token },
      url: value,
    }
  }
  return { kind: 'other-lark', url: value }
}

/** Raw docs_ai fetch response fields consumed by this plugin. */
interface FetchDocumentResponse {
  readonly code?: number | string | undefined
  readonly msg?: string | undefined
  readonly data?: {
    readonly document?: {
      readonly title?: string | undefined
      readonly content?: string | undefined
    } | undefined
  } | undefined
}

/** Raw create_v2 comment response fields consumed by this plugin. */
interface CreateCommentResponse {
  readonly code?: number | string | undefined
  readonly msg?: string | undefined
  readonly data?: { readonly comment_id?: string | undefined } | undefined
}

/** A create_v2 text element. This is deliberately not the old `text_run` shape. */
export interface LarkCommentTextElement {
  readonly type: 'text'
  readonly text: string
}

/** Future V2 elements may carry no text and therefore spend no text budget. */
export type LarkCommentReplyElement = LarkCommentTextElement | {
  readonly type: string
  readonly text?: string | undefined
}

/** Exact anchored create_v2 request body. Anchor omission is not representable. */
export function larkDocumentCommentData(
  blockId: string,
  replyElements: readonly LarkCommentReplyElement[],
): object {
  return {
    file_type: 'docx',
    reply_elements: replyElements,
    anchor: { block_id: blockId },
  }
}

/** Count Unicode code points across every V2 text element, matching Go runes. */
export function countLarkCommentTextRunes(replyElements: readonly LarkCommentReplyElement[]): number {
  return replyElements.reduce((total, element) =>
    total + (element.type === 'text' && typeof element.text === 'string' ? [...element.text].length : 0), 0)
}

/** Reject the aggregate server limit before any comment request is sent. */
export function assertLarkCommentTextLimit(replyElements: readonly LarkCommentReplyElement[]): void {
  const actual = countLarkCommentTextRunes(replyElements)
  if (actual > MAX_LARK_DOC_COMMENT_RUNES) {
    throw new Error(`Comment text has ${actual} Unicode code points; the limit is ${MAX_LARK_DOC_COMMENT_RUNES}. `
      + 'Splitting text across more reply_elements does not increase the limit.')
  }
}

/** Raw docs_ai create response fields consumed by this plugin. */
interface CreateDocumentResponse {
  readonly code?: number | string | undefined
  readonly msg?: string | undefined
  readonly data?: {
    readonly document?: {
      readonly document_id?: string | undefined
      readonly url?: string | undefined
    } | undefined
  } | undefined
}

/**
 * Fetch one docx file as fidelity-preserving markdown/DocxXML.
 * All docs_ai protocol facts stay in this module per ADR 0006.
 */
export async function fetchLarkDocumentMarkdown(
  port: LarkDocsProtocolPort,
  fileToken: string,
): Promise<FetchedLarkDocument> {
  const response = checkedLarkDocsResponse(await port.rawClient.request({
    method: 'POST',
    url: `/open-apis/docs_ai/v1/documents/${encodeURIComponent(fileToken)}/fetch`,
    data: LARK_DOC_MARKDOWN_FETCH_DATA,
  })) as FetchDocumentResponse
  const document = response.data?.document
  if (typeof document?.content !== 'string') {
    throw new Error(`docs_ai fetch returned no document content for ${fileToken}`)
  }
  return {
    fileToken,
    ...typeof document.title === 'string' && document.title !== '' ? { title: document.title } : {},
    content: document.content,
  }
}

/** Fetch one docx file as comment-aware XML with exported block ids. */
export async function fetchLarkDocumentAnchors(
  port: LarkDocsProtocolPort,
  fileToken: string,
  signal?: AbortSignal,
): Promise<FetchedLarkDocument> {
  signal?.throwIfAborted()
  const raw = await port.rawClient.request({
    method: 'POST',
    url: `/open-apis/docs_ai/v1/documents/${encodeURIComponent(fileToken)}/fetch`,
    data: LARK_DOC_ANCHOR_FETCH_DATA,
    ...signal === undefined ? {} : { signal },
  })
  signal?.throwIfAborted()
  const response = checkedLarkDocsResponse(raw) as FetchDocumentResponse
  const document = response.data?.document
  if (typeof document?.content !== 'string') {
    throw new Error(`docs_ai anchor fetch returned no document content for ${fileToken}`)
  }
  return {
    fileToken,
    ...typeof document.title === 'string' && document.title !== '' ? { title: document.title } : {},
    content: document.content,
  }
}

/** Create exactly one anchored docx comment through the V2 endpoint. */
export async function createAnchoredLarkDocumentComment(
  port: LarkDocsProtocolPort,
  fileToken: string,
  blockId: string,
  replyElements: readonly LarkCommentReplyElement[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  assertLarkCommentTextLimit(replyElements)
  const raw = await port.rawClient.request({
    method: 'POST',
    url: `/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/new_comments`,
    data: larkDocumentCommentData(blockId, replyElements),
    ...signal === undefined ? {} : { signal },
  })
  signal?.throwIfAborted()
  const response = checkedLarkDocsResponse(raw) as CreateCommentResponse
  const commentId = response.data?.comment_id
  if (typeof commentId !== 'string' || commentId === '') {
    throw new Error('create_v2 returned no comment_id')
  }
  return commentId
}

/** Create one markdown document in the application's own library. */
export async function createLarkDocument(
  port: LarkDocsProtocolPort,
  title: string,
  content: string,
  options: { readonly brand?: LarkDocumentBrand; readonly signal?: AbortSignal } = {},
): Promise<WrittenLarkDocument> {
  options.signal?.throwIfAborted()
  const response = checkedLarkDocsResponse(await port.rawClient.request({
    method: 'POST',
    url: '/open-apis/docs_ai/v1/documents',
    data: larkDocumentCreateData(title, content),
    ...options.signal === undefined ? {} : { signal: options.signal },
  })) as CreateDocumentResponse
  options.signal?.throwIfAborted()
  const document = response.data?.document
  if (typeof document?.document_id !== 'string' || document.document_id === '') {
    throw new Error('docs_ai create returned no document_id')
  }
  return {
    fileToken: document.document_id,
    url: typeof document.url === 'string' && document.url !== ''
      ? document.url
      : `${options.brand === 'lark' ? 'https://www.larksuite.com' : 'https://www.feishu.cn'}`
        + `/docx/${encodeURIComponent(document.document_id)}`,
    title,
    appended: false,
  }
}

/** Append markdown to the end of an existing docx document. */
export async function appendLarkDocument(
  port: LarkDocsProtocolPort,
  target: LarkDocumentTarget,
  title: string,
  content: string,
  signal?: AbortSignal,
): Promise<WrittenLarkDocument> {
  signal?.throwIfAborted()
  checkedLarkDocsResponse(await port.rawClient.request({
    // First-party docs_ai evidence fixes this as PUT. Keep the method locked by tests.
    method: 'PUT',
    url: `/open-apis/docs_ai/v1/documents/${encodeURIComponent(target.fileToken)}`,
    data: larkDocumentAppendData(content),
    ...signal === undefined ? {} : { signal },
  }))
  signal?.throwIfAborted()
  return { fileToken: target.fileToken, url: target.sourceUrl, title, appended: true }
}

/** Add exactly one reader to a newly created document using the typed SDK. */
export async function grantLarkDocumentReader(
  port: LarkDocsProtocolPort,
  fileToken: string,
  member: { readonly type: 'openid' | 'openchat'; readonly id: string },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const create = port.rawClient.drive?.v1.permissionMember.create
  if (create === undefined) throw new Error('typed drive.v1.permissionMember.create is unavailable')
  checkedLarkDocsResponse(await create({
    data: { member_type: member.type, member_id: member.id, perm: 'view' },
    params: { type: 'docx', need_notification: false },
    path: { token: fileToken },
  }))
  signal?.throwIfAborted()
}

/** Read and validate one typed wiki node without leaking its SDK shape. */
export async function resolveLarkWikiDocument(
  port: LarkDocsProtocolPort,
  token: string,
  signal?: AbortSignal,
): Promise<{ readonly fileToken: string; readonly objType: string; readonly title?: string | undefined }> {
  signal?.throwIfAborted()
  const response = checkedLarkDocsResponse(await port.rawClient.wiki.v2.space.getNode({
    params: { token },
  }))
  signal?.throwIfAborted()
  const node = response.data?.node
  if (typeof node?.obj_type !== 'string' || node.obj_type === '') {
    throw new Error(`wiki node ${token} returned no obj_type`)
  }
  if (typeof node.obj_token !== 'string' || node.obj_token === '') {
    throw new Error(`wiki node ${token} returned no obj_token`)
  }
  return {
    fileToken: node.obj_token,
    objType: node.obj_type,
    ...typeof node.title === 'string' && node.title !== '' ? { title: node.title } : {},
  }
}

/** Resolve one human/model supplied target link to its underlying docx token. */
export async function resolveLarkDocumentTarget(
  port: LarkDocsProtocolPort,
  value: string,
  signal?: AbortSignal,
): Promise<LarkDocumentTarget> {
  signal?.throwIfAborted()
  const supplied = value.trim()
  const link = classifyLarkDocumentUrl(supplied)
  if (link.kind === 'docx') return { fileToken: link.token, sourceUrl: link.url }
  if (link.kind === 'wiki') {
    const node = await resolveLarkWikiDocument(port, link.token, signal)
    if (node.objType !== 'docx') {
      throw new Error(`That wiki link points to ${node.objType}, not a docx document.`)
    }
    return { fileToken: node.fileToken, sourceUrl: link.url }
  }
  if (link.kind === 'unsupported') {
    throw new Error(`That link points to ${link.type}, not a supported docx document.`)
  }
  if (link.kind === 'other-lark') throw new Error('That Feishu/Lark link is not a supported docx or wiki document link.')
  throw new Error('The target must be a complete Feishu/Lark docx or wiki document link.')
}
