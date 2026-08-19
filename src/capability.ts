/**
 * Cloud-document capability discovery and runtime correction.
 * @module dsh-lark-channel/capability
 */

import {
  LARK_DOC_SCOPE_REQUIREMENTS,
  larkDocsErrorDetails,
} from './larkdocs.ts'
import type {
  LarkDocCapability,
  LarkDocsProtocolPort,
  LarkDocScopeRequirements,
  LarkScopeGrant,
} from './larkdocs.ts'
import { documentAuthorizationCard, documentAuthorizationResultCard } from './cards.ts'
import { documentCapabilityCopy } from './status.ts'
import type { RegisterAppPort } from './onboarding.ts'

/** The platform value meaning a tenant has granted one declared scope. */
export const GRANTED_SCOPE_STATUS = 1

/** Scope discovery must never hold chat traffic or an authorization flow forever. */
export const DEFAULT_CAPABILITY_PROBE_DEADLINE_MS = 10_000

/** Stable order used by status cards and authorization requests. */
export const LARK_DOC_CAPABILITIES: readonly LarkDocCapability[] = ['write']

/** Agent tools gated by each capability; automatic link receipt has no tool name. */
export const LARK_DOC_TOOL_CAPABILITIES = {
  send_doc: 'write',
} as const satisfies Readonly<Record<string, LarkDocCapability>>

/** Configuration switches relevant to the model-visible document tools. */
export interface LarkDocToolSwitches {
  readonly sendDocs: boolean
}

/** Tool definitions later document tasks contribute, keyed by their fixed names. */
export type LarkDocToolDefinitions = Partial<Record<keyof typeof LARK_DOC_TOOL_CAPABILITIES, object>>

/** Minimal per-agent tool registry; kept structural to avoid a host package dependency here. */
export interface LarkDocToolRegistry {
  register?(definition: object): () => void
}

/**
 * Apply capability decisions to one agent's registration surface.
 *
 * Missing definitions are expected while Task #0 lands before the three
 * business tasks. An unavailable capability is still denied immediately; an
 * available one is registered as soon as its later task supplies a definition.
 */
export function registerLarkDocTools(input: {
  readonly tools: LarkDocToolRegistry | undefined
  readonly denied: Set<string>
  readonly snapshot: LarkDocCapabilitySnapshot
  readonly switches: LarkDocToolSwitches
  readonly definitions?: LarkDocToolDefinitions | undefined
  readonly report: (line: string) => void
}): readonly string[] {
  const registered: string[] = []
  for (const [name, capability] of Object.entries(LARK_DOC_TOOL_CAPABILITIES) as
    [keyof typeof LARK_DOC_TOOL_CAPABILITIES, LarkDocCapability][]) {
    const definition = input.definitions?.[name]
    // A deployment-level deny always wins over a feature switch or a granted
    // scope. Registering here would shadow the very tool denyTools removed.
    if (input.denied.has(name)) continue
    if (!input.switches.sendDocs || !input.snapshot[capability].enabled) {
      input.denied.add(name)
      continue
    }
    // Business task not installed yet: leave the name alone. Once a definition
    // exists, absence of per-agent registration is a real unavailable surface.
    if (definition === undefined) continue
    if (input.tools?.register === undefined) {
      input.denied.add(name)
      input.report(`lark-channel: ${name} could not be registered for this agent `
        + '(this host tool registry takes no per-agent tools)')
      continue
    }
    input.tools.register(definition)
    registered.push(name)
  }
  return registered
}

/** One feature's current decision. */
export interface LarkDocCapabilityState {
  readonly enabled: boolean
  /** Static or runtime-discovered scopes not currently granted. */
  readonly missingScopes: readonly string[]
  /** False while the current design §8 probe has not verified the complete static scope list. */
  readonly scopeMapVerified: boolean
  /** Why the current decision was made. */
  readonly source: 'scope-list' | 'optimistic' | 'runtime-correction'
}

/** Immutable view consumed by status and one agent's registration decision. */
export type LarkDocCapabilitySnapshot = Readonly<Record<LarkDocCapability, LarkDocCapabilityState>>

/** Result of applying one runtime API failure. */
export interface CapabilityCorrection {
  /** Capabilities disabled by the exact violation subjects. */
  readonly disabled: readonly LarkDocCapability[]
  /** Exact scopes suitable for `registerApp({ addons })`. */
  readonly missingScopes: readonly string[]
  /** False for resource permission and all other non-scope failures. */
  readonly changed: boolean
}

/** Scope-list failures include non-zero API responses as well as thrown transport errors. */
class ScopeProbeFailure extends Error {
  readonly code?: string | number | undefined

  constructor(response: unknown) {
    const details = larkDocsErrorDetails(response)
    super(details.message)
    this.code = details.code
  }
}

/** Select granted tenant scopes; user scopes cannot light an app-identity capability. */
function grantedTenantScopes(scopes: readonly LarkScopeGrant[]): Set<string> {
  return new Set(scopes.flatMap(scope =>
    (scope.scope_type === undefined || scope.scope_type === 'tenant')
      && scope.grant_status === GRANTED_SCOPE_STATUS
      ? [scope.scope_name]
      : [],
  ))
}

/** Mutable bridge-wide table; agents consume snapshots at creation time. */
export class LarkDocCapabilities {
  readonly #requirements: LarkDocScopeRequirements
  /**
   * Alternatives groups the platform itself named, per capability.
   *
   * One refusal is ONE requirement offering several scopes, not several
   * requirements: a live tenant answered a collaborator grant with eight of
   * them and said "任一即可". Keeping each refusal as a group is what lets a
   * later grant of any single member satisfy it.
   */
  readonly #discovered: Record<LarkDocCapability, string[][]> = {
    write: [],
  }
  #granted = new Set<string>()
  #mode: 'scope-list' | 'optimistic' = 'optimistic'
  readonly #runtimeDisabled = new Set<LarkDocCapability>()

  constructor(requirements: LarkDocScopeRequirements = LARK_DOC_SCOPE_REQUIREMENTS) {
    this.#requirements = requirements
  }

  /** Every scope that could bear on one capability, alternatives flattened. */
  requiredScopes(capability: LarkDocCapability): readonly string[] {
    return [...new Set([
      ...this.#requirements[capability].scopes,
      ...this.#discovered[capability].flat(),
    ])]
  }

  /**
   * The one scope an authorization request should name out of an alternatives
   * group.
   *
   * A refusal lists every scope that would satisfy the endpoint — measured, up
   * to eight for a collaborator grant, reaching across spreadsheets and
   * multi-dimensional tables. Asking for all of them would have a tenant
   * approve whole products to add one reader, so ask for the one this
   * capability already declares. When the map names none of them the group
   * goes out whole: picking a "narrowest" by shape would be inventing.
   */
  #preferred(capability: LarkDocCapability, group: readonly string[]): readonly string[] {
    const declared = new Set(this.#requirements[capability].scopes)
    const named = group.find(scope => declared.has(scope))
    return named === undefined ? [...group] : [named]
  }

  /** What still stands between this capability and the platform. */
  #missing(capability: LarkDocCapability): readonly string[] {
    const declared = this.#requirements[capability].scopes.filter(scope => !this.#granted.has(scope))
    const discovered = this.#discovered[capability]
      .filter(group => !group.some(scope => this.#granted.has(scope)))
      .flatMap(group => this.#preferred(capability, group))
    return [...new Set([...declared, ...discovered])]
  }

  /** Whether a newly created agent may receive this feature. */
  isEnabled(capability: LarkDocCapability): boolean {
    return this.state(capability).enabled
  }

  /** Whether the last successful scope.list explicitly granted one tenant scope. */
  isScopeGranted(scope: string): boolean {
    return this.#granted.has(scope)
  }

  /** One capability's current state. */
  state(capability: LarkDocCapability): LarkDocCapabilityState {
    const requirement = this.#requirements[capability]
    const missingScopes = this.#missing(capability)
    if (this.#runtimeDisabled.has(capability)) {
      return {
        enabled: false,
        missingScopes,
        scopeMapVerified: requirement.verified,
        source: 'runtime-correction',
      }
    }
    // An unverified map informs but does not gate. Its names were read off
    // documentation rather than out of refusals, and a wrong or incomplete
    // guess that turned a capability OFF would stop the very call whose
    // violation is the only thing that could correct it — a state no scan can
    // leave, because the authorization card would keep asking for a scope the
    // platform may not even have. Only a verified map, or a real runtime
    // violation, may take a capability away.
    const enabled = this.#mode === 'optimistic' || !requirement.verified || missingScopes.length === 0
    return {
      enabled,
      missingScopes,
      scopeMapVerified: requirement.verified,
      source: this.#mode === 'optimistic' || !requirement.verified ? 'optimistic' : 'scope-list',
    }
  }

  /** Immutable view for cards and creation-time tool registration. */
  snapshot(): LarkDocCapabilitySnapshot {
    return {
      write: this.state('write'),
    }
  }

  /** Replace the tenant grant snapshot after a successful `scope.list`. */
  applyScopeList(scopes: readonly LarkScopeGrant[]): void {
    this.#granted = grantedTenantScopes(scopes)
    this.#mode = 'scope-list'
    for (const capability of LARK_DOC_CAPABILITIES) {
      if (this.#missing(capability).length === 0) this.#runtimeDisabled.delete(capability)
    }
  }

  /** Startup-only fallback: no runtime correction can exist before readiness. */
  enableOptimistically(): void {
    this.#mode = 'optimistic'
    this.#runtimeDisabled.clear()
  }

  /**
   * Correct the table from a real document endpoint failure.
   *
   * The attempted capability is always disabled: an unverified scope may not
   * appear in the static map yet. Other capabilities sharing a known scope are
   * disabled too. A resource permission error carries no violation subjects and
   * therefore changes nothing.
   */
  correctRuntimeFailure(capability: LarkDocCapability, error: unknown): CapabilityCorrection {
    const violations = larkDocsErrorDetails(error).permissionViolations
    if (violations.length === 0) return { disabled: [], missingScopes: [], changed: false }

    const group = [...violations]
    const known = this.#discovered[capability]
    if (!known.some(seen => seen.length === group.length && seen.every((scope, index) => scope === group[index]))) {
      known.push(group)
    }
    for (const scope of group) {
      // A real endpoint is stronger evidence than an older scope snapshot.
      // Treat its violation as missing until a later successful scope.list
      // explicitly grants it again.
      this.#granted.delete(scope)
    }
    const affected = new Set<LarkDocCapability>([capability])
    for (const candidate of LARK_DOC_CAPABILITIES) {
      if (this.requiredScopes(candidate).some(scope => group.includes(scope))) affected.add(candidate)
    }
    for (const candidate of affected) this.#runtimeDisabled.add(candidate)
    return { disabled: [...affected], missingScopes: this.#preferred(capability, group), changed: true }
  }
}

/** What a startup/recheck probe concluded. */
export interface CapabilityProbeResult {
  readonly mode: 'scope-list' | 'optimistic' | 'failed'
  readonly snapshot: LarkDocCapabilitySnapshot
  readonly error?: unknown
}

/**
 * Probe the app's tenant grants with the SDK's zero-parameter typed endpoint.
 * Startup failures may opt into optimistic availability. Authorization
 * rechecks preserve the last confirmed/runtime-corrected state instead.
 */
export async function refreshLarkDocCapabilities(
  port: LarkDocsProtocolPort,
  capabilities: LarkDocCapabilities,
  report: (line: string) => void,
  failureMode: 'optimistic' | 'preserve' = 'optimistic',
  signal?: AbortSignal,
): Promise<CapabilityProbeResult> {
  try {
    const response = await port.rawClient.application.v6.scope.list({})
    if (signal?.aborted === true) {
      return { mode: 'failed', snapshot: capabilities.snapshot(), error: signal.reason }
    }
    if (response.code !== undefined && response.code !== 0) throw new ScopeProbeFailure(response)
    if (response.data?.scopes === undefined) {
      throw new ScopeProbeFailure({ code: response.code, msg: 'scope.list returned no data.scopes' })
    }
    capabilities.applyScopeList(response.data.scopes)
    return { mode: 'scope-list', snapshot: capabilities.snapshot() }
  } catch (error) {
    if (signal?.aborted === true) {
      return { mode: 'failed', snapshot: capabilities.snapshot(), error: signal.reason ?? error }
    }
    const details = larkDocsErrorDetails(error)
    if (failureMode === 'optimistic') {
      capabilities.enableOptimistically()
      report(`lark-channel: document capability probe failed; keeping all capabilities optimistic`
        + `${details.code === undefined ? '' : ` [${String(details.code)}]`}: ${details.message}`)
      return { mode: 'optimistic', snapshot: capabilities.snapshot(), error }
    }
    report(`lark-channel: document capability recheck failed; preserving the last confirmed state`
      + `${details.code === undefined ? '' : ` [${String(details.code)}]`}: ${details.message}`)
    return { mode: 'failed', snapshot: capabilities.snapshot(), error }
  }
}

/**
 * Bound one scope probe and make its timeout semantics explicit.
 *
 * The inner probe receives an abort signal and checks it before every mutation.
 * A late SDK result can therefore settle its own abandoned promise, but cannot
 * overwrite the state the timeout path already exposed.
 */
export async function refreshLarkDocCapabilitiesWithDeadline(
  port: LarkDocsProtocolPort,
  capabilities: LarkDocCapabilities,
  report: (line: string) => void,
  failureMode: 'optimistic' | 'preserve',
  deadlineMs = DEFAULT_CAPABILITY_PROBE_DEADLINE_MS,
  parentSignal?: AbortSignal,
): Promise<CapabilityProbeResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeParentAbort = (): void => {}
  const terminal = new Promise<CapabilityProbeResult>((resolve) => {
    const finish = (reason: 'timeout' | 'aborted'): void => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      if (reason === 'timeout') {
        if (failureMode === 'optimistic') capabilities.enableOptimistically()
        report(`lark-channel: document capability ${failureMode === 'optimistic' ? 'startup probe' : 'recheck'} `
          + `timed out after ${String(deadlineMs)}ms; `
          + `${failureMode === 'optimistic' ? 'keeping all capabilities optimistic' : 'preserving the last confirmed state'}`)
      }
      resolve({
        mode: reason === 'timeout' && failureMode === 'optimistic' ? 'optimistic' : 'failed',
        snapshot: capabilities.snapshot(),
        error: reason,
      })
    }
    timer = setTimeout(() => { finish('timeout') }, Math.max(0, deadlineMs))
    if (parentSignal !== undefined) {
      const onAbort = (): void => { finish('aborted') }
      if (parentSignal.aborted) onAbort()
      else {
        parentSignal.addEventListener('abort', onAbort, { once: true })
        removeParentAbort = () => { parentSignal.removeEventListener('abort', onAbort) }
      }
    }
  })
  try {
    return await Promise.race([
      refreshLarkDocCapabilities(port, capabilities, report, failureMode, controller.signal),
      terminal,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeParentAbort()
    // Winning normally also invalidates any terminal callback already queued.
    if (!controller.signal.aborted) controller.abort('completed')
  }
}

/** Missing scopes across selected capabilities, de-duplicated for `addons`. */
export function missingScopesFor(
  snapshot: LarkDocCapabilitySnapshot,
  capabilities: readonly LarkDocCapability[] = LARK_DOC_CAPABILITIES,
): readonly string[] {
  return [...new Set(capabilities.flatMap(capability => snapshot[capability].missingScopes))]
}

/** Minimal chat sink used by the authorization coordinator. */
export interface DocumentAuthorizationChat {
  send(to: string, input: { readonly text: string } | { readonly card: object }): Promise<unknown>
}

/** One authorization request raised by a real document endpoint failure. */
export interface DocumentAuthorizationRequest {
  /** Chat where the failure occurred; used only for the safe fallback and group notice. */
  readonly originChatId: string
  /** Exact platform-returned subjects, never inferred names. */
  readonly scopes: readonly string[]
}

/** Boundaries for on-demand app re-authorization. */
export interface DocumentAuthorizationOptions {
  readonly appId: string
  readonly registeredBy?: string | undefined
  readonly register: RegisterAppPort
  readonly chat: DocumentAuthorizationChat
  readonly capabilities: LarkDocCapabilities
  readonly refresh: () => Promise<CapabilityProbeResult>
  readonly report: (line: string) => void
  readonly signal: AbortSignal
}

/** Public handle later document operations call after runtime correction. */
export interface DocumentAuthorizationCoordinator {
  request(request: DocumentAuthorizationRequest): Promise<void>
}

/** One snapshot's material decisions, excluding explanatory source labels. */
function capabilityFingerprint(snapshot: LarkDocCapabilitySnapshot): string {
  return JSON.stringify(LARK_DOC_CAPABILITIES.map(capability => ({
    capability,
    enabled: snapshot[capability].enabled,
    missingScopes: snapshot[capability].missingScopes,
  })))
}

/**
 * Coordinate the one QR path of ADR 0007 and verify its result with scope.list.
 *
 * Concurrent requests are drained in batches. Requests arriving while one QR
 * flow is active wait for the next flow, whose scopes and origin chats are
 * unioned so no newly discovered requirement or notification is lost.
 */
export function createDocumentAuthorizationCoordinator(
  options: DocumentAuthorizationOptions,
): DocumentAuthorizationCoordinator {
  const commentEvent = 'drive.notice.comment_add_v1'
  interface QueuedAuthorization {
    readonly originChatId: string
    readonly scopes: readonly string[]
    readonly resolve: () => void
  }
  interface ActiveAuthorization {
    readonly scopes: Set<string>
    readonly origins: Set<string>
    readonly items: QueuedAuthorization[]
    readonly originFeedback: Set<string>
    readonly sends: Promise<unknown>[]
    url?: string
    registrarCardSent: boolean
  }
  const queue: QueuedAuthorization[] = []
  const waiters = new Set<() => void>()
  let draining = false
  let active: ActiveAuthorization | undefined

  const sendActiveFeedback = (flow: ActiveAuthorization, origin: string): void => {
    if (flow.url === undefined || flow.originFeedback.has(origin)) return
    flow.originFeedback.add(origin)
    if (options.registeredBy !== undefined && options.registeredBy !== '') {
      if (origin === options.registeredBy) return
      flow.sends.push(options.chat.send(origin, {
        text: '文档能力需要补充授权，授权链接已私聊发给应用注册者。',
      }).catch((error: unknown) => {
        options.report(`lark-channel: sending the document authorization notice failed: ${String(error)}`)
      }))
      return
    }
    flow.sends.push(options.chat.send(origin, {
        card: documentAuthorizationCard({
          scopes: [...flow.scopes],
          events: [commentEvent],
          url: flow.url,
          exposed: true,
        }),
    }).catch((error: unknown) => {
      options.report(`lark-channel: sending the document authorization card failed: ${String(error)}`)
    }))
  }

  const publishActiveUrl = (flow: ActiveAuthorization, url: string): void => {
    flow.url = url
    if (options.registeredBy !== undefined && options.registeredBy !== '' && !flow.registrarCardSent) {
      flow.registrarCardSent = true
      flow.sends.push(options.chat.send(options.registeredBy, {
        card: documentAuthorizationCard({
          scopes: [...flow.scopes],
          events: [commentEvent],
          url,
          exposed: false,
        }),
      }).catch((error: unknown) => {
        options.report(`lark-channel: sending the document authorization card failed: ${String(error)}`)
      }))
    }
    for (const origin of flow.origins) sendActiveFeedback(flow, origin)
  }

  const runBatch = async (batch: readonly QueuedAuthorization[]): Promise<void> => {
    const scopes = [...new Set(batch.flatMap(item => item.scopes))]
      .filter(scope => !options.capabilities.isScopeGranted(scope))
    if (scopes.length === 0) {
      for (const item of batch) item.resolve()
      return
    }
    const flow: ActiveAuthorization = {
      scopes: new Set(scopes),
      origins: new Set(batch.map(item => item.originChatId)),
      items: [...batch],
      originFeedback: new Set(),
      sends: [],
      registrarCardSent: false,
    }
    active = flow
    const before = capabilityFingerprint(options.capabilities.snapshot())
    const grantedBefore = new Set(scopes.filter(scope => options.capabilities.isScopeGranted(scope)))
    try {
      await options.register({
        source: 'dsh-lark-channel',
        appId: options.appId,
        addons: {
          scopes: { tenant: scopes },
          events: { items: { tenant: [commentEvent] } },
        },
        signal: options.signal,
        onQRCodeReady({ url }) { publishActiveUrl(flow, url) },
      })
      await Promise.all(flow.sends)
      if (options.signal.aborted) return
      const rechecked = await options.refresh()
      if (options.signal.aborted) return
      const after = capabilityFingerprint(rechecked.snapshot)
      const newlyGrantedScopes = scopes.filter(scope =>
        !grantedBefore.has(scope) && options.capabilities.isScopeGranted(scope),
      )
      const outcome = rechecked.mode === 'failed'
        ? 'failed'
        : before === after && newlyGrantedScopes.length === 0 ? 'unchanged' : 'changed'
      const targets = options.registeredBy === undefined || options.registeredBy === ''
        ? [...flow.origins]
        : [options.registeredBy]
      await Promise.all(targets.map(target => options.chat.send(target, {
        card: documentAuthorizationResultCard({
          outcome,
          capabilities: documentCapabilityCopy(rechecked.snapshot),
          grantedScopes: newlyGrantedScopes,
        }),
      })))
    } finally {
      if (active === flow) active = undefined
      for (const item of flow.items) item.resolve()
    }
  }

  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (!options.signal.aborted && queue.length > 0) {
        const batch = queue.splice(0)
        try {
          await runBatch(batch)
        } catch (error: unknown) {
          if (!options.signal.aborted) {
            const detail = larkDocsErrorDetails(error).message
            options.report(`lark-channel: document authorization failed: ${detail}`)
            const origins = [...new Set(batch.map(item => item.originChatId))]
            const targets = options.registeredBy === undefined || options.registeredBy === ''
              ? origins
              : [options.registeredBy]
            await Promise.all(targets.map(target => options.chat.send(target, {
              text: `⚠️ 文档权限授权未完成：${detail}`,
            }).catch(() => {})))
          }
        }
      }
    } finally {
      draining = false
      // A request can arrive after the loop sees an empty queue but before the
      // flag clears; hand it a fresh drain instead of leaving it stranded.
      if (!options.signal.aborted && queue.length > 0) void drain()
    }
  }

  const request = (authorization: DocumentAuthorizationRequest): Promise<void> => {
    const scopes = [...new Set(authorization.scopes.filter(scope => scope !== ''))]
    if (scopes.length === 0 || options.signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        waiters.delete(settle)
        resolve()
      }
      waiters.add(settle)
      const item = { originChatId: authorization.originChatId, scopes, resolve: settle }
      if (active !== undefined && scopes.every(scope => active!.scopes.has(scope))) {
        active.items.push(item)
        const isNewOrigin = !active.origins.has(authorization.originChatId)
        active.origins.add(authorization.originChatId)
        if (isNewOrigin && active.url !== undefined) sendActiveFeedback(active, authorization.originChatId)
        return
      }
      queue.push(item)
      void drain()
    })
  }

  const settleOnAbort = (): void => {
    queue.splice(0)
    for (const settle of [...waiters]) settle()
  }
  if (options.signal.aborted) settleOnAbort()
  else options.signal.addEventListener('abort', settleOnAbort, { once: true })

  return { request }
}
