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

/** The sole model-visible cloud-document capability. */
export type LarkDocCapability = 'write'

/** One capability's tenant-scope contract. */
export interface LarkDocScopeRequirement {
  /** Every scope must be granted before a verified capability is available. */
  readonly scopes: readonly string[]
  /** False means the names still need the real permission-violation probe in the current design §8. */
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
 * documentation and official CLI metadata, not from the current design §8 probes;
 * `verified` therefore remains false and the status surface says so. Runtime
 * violations are retained by `LarkDocCapabilities`, which lets on-demand
 * authorization use the exact names the platform returned. Flip `verified`
 * only after the current design §8 probes are run.
 */
export const LARK_DOC_SCOPE_REQUIREMENTS: LarkDocScopeRequirements = {
  write: {
    scopes: [
      'docx:document:create',
      'docx:document:write_only',
      'docx:document:readonly',
      'docs:permission.member:create',
    ],
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

/** Minimum typed and raw client surface used by document capabilities and writes. */
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
      readonly meta?: {
        batchQuery(payload: {
          readonly data: {
            readonly request_docs: {
              readonly doc_token: string
              readonly doc_type: 'doc' | 'docx' | 'sheet' | 'file' | 'wiki'
            }[]
            readonly with_url?: boolean
          }
          readonly params?: { readonly user_id_type?: 'open_id' }
        }): Promise<{
          readonly data?: {
            readonly metas?: readonly {
              readonly doc_token: string
              readonly title: string
              readonly url: string
            }[]
          } | undefined
        }>
      }
    }
    readonly v2?: {
      readonly permissionPublic: {
        get(payload: {
          readonly params: { readonly type: 'doc' | 'docx' | 'sheet' | 'file' }
          readonly path: { readonly token: string }
        }): Promise<{
          readonly data?: {
            readonly permission_public?: {
              readonly external_access_entity?: 'open' | 'closed' | 'allow_share_partner_tenant' | undefined
              readonly external_access?: boolean | undefined
              readonly link_share_entity?: string | undefined
            } | undefined
          } | undefined
        }>
      }
    }
  }
  readonly contact?: {
    readonly v3: {
      readonly user: {
        get(payload: {
          readonly params: { readonly user_id_type: 'open_id' }
          readonly path: { readonly user_id: string }
        }): Promise<{
          readonly data?: { readonly user?: { readonly name?: string | undefined } | undefined } | undefined
        }>
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

/*
 * Every write below honours cancellation BEFORE its request and never after it.
 * Once the platform has answered, the write HAS landed, and throwing a
 * cancellation there turns a landed write into "failed" for every caller above:
 * the operator console read `writing document … failed: turn stopped` for an
 * append that really appended, and a person told "failed" sends it again, so the
 * same content lands twice. A stopped turn is closed by naming what already
 * exists (design §12), not by denying it. The pre-request check is where a
 * cancellation is still free.
 */

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
