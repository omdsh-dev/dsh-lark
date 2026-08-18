import { describe, expect, it, vi } from 'vitest'
import {
  createDocumentAuthorizationCoordinator,
  LarkDocCapabilities,
  missingScopesFor,
  registerLarkDocTools,
  refreshLarkDocCapabilities,
  refreshLarkDocCapabilitiesWithDeadline,
} from '../src/capability.ts'
import type { RegisterAppRequest } from '../src/onboarding.ts'
import { cardTexts, fakeMessage, mountChannel } from './harness.ts'
import { presenceSection } from '../src/presence.ts'
import { resolveConfig } from '../src/config.ts'
import type { LarkDocScopeRequirements, LarkDocsProtocolPort, LarkScopeListResponse } from '../src/larkdocs.ts'
import {
  checkedLarkDocsResponse,
  LARK_DOC_SCOPE_REQUIREMENTS,
  LarkDocsProtocolError,
  larkDocsErrorDetails,
} from '../src/larkdocs.ts'

const REQUIREMENTS: LarkDocScopeRequirements = {
  read: { scopes: ['docs_ai:read', 'wiki:node:read'], verified: true },
  write: { scopes: ['docs_ai:write', 'drive:member:write'], verified: true },
  comment: { scopes: ['docs_ai:read', 'drive:comment:write'], verified: true },
}

function scope(name: string, granted: boolean, type: 'tenant' | 'user' = 'tenant') {
  return { scope_name: name, grant_status: granted ? 1 : 0, scope_type: type } as const
}

function port(list: () => Promise<LarkScopeListResponse>): LarkDocsProtocolPort {
  return {
    rawClient: {
      application: { v6: { scope: { list } } },
      wiki: { v2: { space: { getNode: async () => ({}) } } },
      request: async () => ({}),
    },
  }
}

function allGranted() {
  return [
    scope('docs_ai:read', true),
    scope('wiki:node:read', true),
    scope('docs_ai:write', true),
    scope('drive:member:write', true),
    scope('drive:comment:write', true),
  ]
}

describe('document capability probe', () => {
  it('resolves all five document settings to their designed defaults', () => {
    expect(resolveConfig({})).toMatchObject({
      receiveDocs: true,
      sendDocs: true,
      commentDocs: true,
      maxDocCommentsPerTurn: 20,
      docAuthorizeOnDemand: true,
    })
  })

  it('calls scope.list with no parameters and lights only fully granted capabilities', async () => {
    const list = vi.fn(async () => ({
      code: 0,
      data: {
        scopes: [
          scope('docs_ai:read', true),
          scope('wiki:node:read', true),
          scope('docs_ai:write', true),
          // A user grant cannot satisfy the app-identity feature.
          scope('drive:member:write', true, 'user'),
          scope('drive:comment:write', false),
        ],
      },
    }))
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)

    const result = await refreshLarkDocCapabilities(port(list), capabilities, vi.fn())

    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith({})
    expect(result.mode).toBe('scope-list')
    expect(result.snapshot.read.enabled).toBe(true)
    expect(result.snapshot.write).toMatchObject({
      enabled: false,
      missingScopes: ['drive:member:write'],
      source: 'scope-list',
    })
    expect(result.snapshot.comment).toMatchObject({
      enabled: false,
      missingScopes: ['drive:comment:write'],
    })
  })

  it('does not half-light a capability when only one of its scopes is granted', () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([scope('docs_ai:write', true)])

    expect(capabilities.state('write')).toMatchObject({
      enabled: false,
      missingScopes: ['drive:member:write'],
    })
  })

  it('keeps every capability optimistic when scope.list rejects the request', async () => {
    const report = vi.fn()
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)

    const result = await refreshLarkDocCapabilities(
      port(async () => ({ code: 99991663, msg: 'permission denied' })),
      capabilities,
      report,
    )

    expect(result.mode).toBe('optimistic')
    expect(Object.values(result.snapshot).every(state => state.enabled)).toBe(true)
    expect(report).toHaveBeenCalledWith(expect.stringContaining('permission denied'))
  })

  it('keeps every capability optimistic and reports a network failure', async () => {
    const report = vi.fn()
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)

    const result = await refreshLarkDocCapabilities(
      port(async () => { throw new Error('socket closed') }),
      capabilities,
      report,
    )

    expect(result.mode).toBe('optimistic')
    expect(Object.values(result.snapshot).every(state => state.enabled)).toBe(true)
    expect(report).toHaveBeenCalledWith(expect.stringContaining('socket closed'))
  })

  it('treats a successful envelope without data.scopes as a probe failure', async () => {
    const report = vi.fn()
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)

    const result = await refreshLarkDocCapabilities(
      port(async () => ({ code: 0, data: {} })),
      capabilities,
      report,
    )

    expect(result.mode).toBe('optimistic')
    expect(Object.values(result.snapshot).every(state => state.enabled)).toBe(true)
    expect(report).toHaveBeenCalledWith(expect.stringContaining('no data.scopes'))
  })

  it('locks the first-party minimum scope map while marking the live-probe boundary', () => {
    expect(LARK_DOC_SCOPE_REQUIREMENTS).toEqual({
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
    })

    const capabilities = new LarkDocCapabilities()
    capabilities.applyScopeList([])

    // The shipped map is unverified, so it reports what it believes is missing
    // and does NOT gate on it: names read off documentation must never be able
    // to turn off the call whose refusal is the only thing that could correct
    // them. Flipping `verified` is what makes this snapshot disable anything.
    expect(capabilities.snapshot().read).toEqual({
      enabled: true,
      missingScopes: ['docx:document:readonly', 'wiki:node:read'],
      scopeMapVerified: false,
      source: 'optimistic',
    })

    const verified = new LarkDocCapabilities({
      ...LARK_DOC_SCOPE_REQUIREMENTS,
      read: { ...LARK_DOC_SCOPE_REQUIREMENTS.read, verified: true },
    })
    verified.applyScopeList([])
    expect(verified.snapshot().read).toMatchObject({ enabled: false, source: 'scope-list' })
  })
})

describe('runtime permission correction', () => {
  it('disables the attempted capability and any capability sharing the missing scope', () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList(allGranted())
    const agentCreationSnapshot = capabilities.snapshot()

    const correction = capabilities.correctRuntimeFailure('comment', {
      response: {
        data: {
          code: 99991672,
          msg: 'Access denied',
          error: { permission_violations: [{ subject: 'docs_ai:read' }] },
        },
      },
    })

    expect(correction).toEqual({
      disabled: ['comment', 'read'],
      missingScopes: ['docs_ai:read'],
      changed: true,
    })
    expect(capabilities.isEnabled('comment')).toBe(false)
    expect(capabilities.isEnabled('read')).toBe(false)
    expect(capabilities.isEnabled('write')).toBe(true)
    // Tools already installed from this snapshot stay unchanged; only the next
    // agent consults the mutable table again.
    expect(agentCreationSnapshot.comment.enabled).toBe(true)
  })

  it('learns an exact missing scope when the static map has not been verified', () => {
    const capabilities = new LarkDocCapabilities()
    const correction = capabilities.correctRuntimeFailure('write', {
      error: { permission_violations: [{ subject: 'server:return:value' }] },
    })

    expect(correction.missingScopes).toEqual(['server:return:value'])
    expect(capabilities.requiredScopes('write')).toContain('server:return:value')
    expect(missingScopesFor(capabilities.snapshot())).toContain('server:return:value')
  })

  it('does not change the table for a resource permission failure', () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList(allGranted())
    const before = capabilities.snapshot()

    expect(capabilities.correctRuntimeFailure('read', {
      code: 1061002,
      msg: 'document is not shared with this app',
    })).toEqual({ disabled: [], missingScopes: [], changed: false })
    expect(capabilities.snapshot()).toEqual(before)
  })

  it('re-enables a corrected capability only after a recheck sees its scope granted', () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList(allGranted())
    capabilities.correctRuntimeFailure('comment', {
      error: { permission_violations: [{ subject: 'drive:comment:write' }] },
    })

    capabilities.applyScopeList(allGranted().filter(item => item.scope_name !== 'drive:comment:write'))
    expect(capabilities.isEnabled('comment')).toBe(false)
    capabilities.applyScopeList(allGranted())
    expect(capabilities.isEnabled('comment')).toBe(true)
  })

  it('preserves runtime-disabled capabilities when an authorization recheck fails', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList(allGranted())
    capabilities.correctRuntimeFailure('comment', {
      error: { permission_violations: [{ subject: 'drive:comment:write' }] },
    })

    const result = await refreshLarkDocCapabilities(
      port(async () => { throw new Error('recheck network down') }),
      capabilities,
      vi.fn(),
      'preserve',
    )

    expect(result.mode).toBe('failed')
    expect(result.snapshot.comment).toMatchObject({ enabled: false, source: 'runtime-correction' })
  })

  it('preserves runtime-disabled capabilities when a recheck reaches its deadline', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList(allGranted())
    capabilities.correctRuntimeFailure('comment', {
      error: { permission_violations: [{ subject: 'drive:comment:write' }] },
    })

    const result = await refreshLarkDocCapabilitiesWithDeadline(
      port(() => new Promise(() => {})),
      capabilities,
      vi.fn(),
      'preserve',
      5,
    )

    expect(result.mode).toBe('failed')
    expect(result.snapshot.comment).toMatchObject({ enabled: false, source: 'runtime-correction' })
  })
})

describe('agent registration surface', () => {
  it('keeps denyTools authoritative even when scopes and definitions are available', () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList(allGranted())
    const denied = new Set<string>(['send_doc'])
    const registered: { name: string }[] = []

    registerLarkDocTools({
      tools: { register(definition) { registered.push(definition as { name: string }); return () => {} } },
      denied,
      snapshot: capabilities.snapshot(),
      switches: { sendDocs: true, commentDocs: true },
      definitions: {
        send_doc: { name: 'send_doc' },
        read_doc_anchors: { name: 'read_doc_anchors' },
        comment_on_doc: { name: 'comment_on_doc' },
      },
      report: vi.fn(),
    })

    expect(registered.map(tool => tool.name)).not.toContain('send_doc')
    expect(denied.has('send_doc')).toBe(true)
  })

  it('does not register an unlit capability and explains the absent tools in presence', () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([
      scope('docs_ai:read', true),
      scope('wiki:node:read', true),
      // write is only partially granted; comment is absent.
      scope('docs_ai:write', true),
    ])
    const denied = new Set<string>()
    const registered: object[] = []

    registerLarkDocTools({
      tools: { register(definition) { registered.push(definition); return () => {} } },
      denied,
      snapshot: capabilities.snapshot(),
      switches: { sendDocs: true, commentDocs: true },
      definitions: {
        send_doc: { name: 'send_doc' },
        read_doc_anchors: { name: 'read_doc_anchors' },
        comment_on_doc: { name: 'comment_on_doc' },
      },
      report: vi.fn(),
    })

    expect(registered).toEqual([])
    expect([...denied]).toEqual(['send_doc', 'read_doc_anchors', 'comment_on_doc'])
    expect(presenceSection({}, [...denied])).toContain(
      'Unavailable here: send_doc, read_doc_anchors, comment_on_doc.',
    )
  })
})

describe('protocol error parsing', () => {
  it('preserves non-zero code, message, and exact permission violation subjects', () => {
    expect(() => checkedLarkDocsResponse({
      code: 99991672,
      msg: 'Access denied',
      error: {
        permission_violations: [
          { subject: 'scope:a' },
          { subject: 'scope:a' },
          { subject: 'scope:b' },
        ],
      },
    })).toThrow(LarkDocsProtocolError)

    try {
      checkedLarkDocsResponse({
        code: 99991672,
        msg: 'Access denied',
        error: { permission_violations: [{ subject: 'scope:a' }] },
      })
    } catch (error) {
      expect(larkDocsErrorDetails(error)).toMatchObject({
        code: 99991672,
        message: 'Access denied',
        permissionViolations: ['scope:a'],
      })
    }
  })

  it('prefers an Axios response platform envelope over outer transport prose', () => {
    const axiosError = Object.assign(new Error('Request failed with status code 403'), {
      code: 'ERR_BAD_RESPONSE',
      response: {
        status: 403,
        data: {
          code: 99991672,
          msg: 'Platform says document scope is missing',
          error: { permission_violations: [{ subject: 'docx:document:write_only' }] },
        },
      },
    })

    expect(larkDocsErrorDetails(axiosError)).toEqual({
      code: 99991672,
      message: 'Platform says document scope is missing',
      permissionViolations: ['docx:document:write_only'],
    })

    const resourceAcl = Object.assign(new Error('Request failed with status code 403'), {
      response: { data: { code: 1770001, msg: 'document is not shared with this app' } },
    })
    expect(larkDocsErrorDetails(resourceAcl)).toEqual({
      code: 1770001,
      message: 'document is not shared with this app',
      permissionViolations: [],
    })
  })
})

describe('on-demand document authorization', () => {
  it('sends one app-changing link privately to registeredBy and rechecks after scanning', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList(allGranted().filter(item => item.scope_name !== 'drive:comment:write'))
    capabilities.correctRuntimeFailure('comment', {
      error: { permission_violations: [{ subject: 'drive:comment:write' }] },
    })
    const sent: { to: string; input: { text: string } | { card: object } }[] = []
    const requests: RegisterAppRequest[] = []
    const controller = new AbortController()
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_existing',
      registeredBy: 'ou_registrar',
      register: async (request) => {
        requests.push(request)
        request.onQRCodeReady({ url: 'https://accounts.example/authorize', expireIn: 600 })
        return { client_id: 'cli_existing', client_secret: 'unchanged' }
      },
      chat: {
        async send(to, input) {
          sent.push({ to, input })
          return {}
        },
      },
      capabilities,
      refresh: async () => {
        capabilities.applyScopeList(allGranted())
        return { mode: 'scope-list', snapshot: capabilities.snapshot() }
      },
      report: vi.fn(),
      signal: controller.signal,
    })

    await coordinator.request({ originChatId: 'oc_group', scopes: ['drive:comment:write'] })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      source: 'dsh-lark-channel',
      appId: 'cli_existing',
      addons: { scopes: { tenant: ['drive:comment:write'] } },
      signal: controller.signal,
    })
    // ADR 0007: no grant-status branch or alternate card exists in this path.
    expect(sent[0]!.to).toBe('ou_registrar')
    expect(JSON.stringify(sent[0]!.input)).toContain('https://accounts.example/authorize')
    expect(sent).toContainEqual({
      to: 'oc_group',
      input: { text: '文档能力需要补充授权，授权链接已私聊发给应用注册者。' },
    })
    const result = sent.filter(message => message.to === 'ou_registrar' && 'card' in message.input)[1]!
    expect(cardTexts((result.input as { card: object }).card).map(text => text.content))
      .toContain('权限状态有变化，以当前能力表为准')
    expect(capabilities.isEnabled('comment')).toBe(true)
  })

  it('falls back to the origin chat with an explicit app-configuration warning', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList(allGranted().filter(item => item.scope_name !== 'drive:comment:write'))
    const sent: { to: string; input: { text: string } | { card: object } }[] = []
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_existing',
      register: async (request) => {
        request.onQRCodeReady({ url: 'https://accounts.example/authorize', expireIn: 600 })
        return { client_id: 'cli_existing', client_secret: 'unchanged' }
      },
      chat: { async send(to, input) { sent.push({ to, input }); return {} } },
      capabilities,
      refresh: async () => ({ mode: 'scope-list', snapshot: capabilities.snapshot() }),
      report: vi.fn(),
      signal: new AbortController().signal,
    })

    await coordinator.request({ originChatId: 'oc_group', scopes: ['drive:comment:write'] })

    expect(sent.every(message => message.to === 'oc_group')).toBe(true)
    const firstCard = (sent[0]!.input as { card: object }).card
    expect(cardTexts(firstCard).map(text => text.content))
      .toContain('这个链接可以修改应用配置。当前没有已记录的注册者，只能发到原聊天；请勿转发。扫码后渠道会重新检查权限。')
    const resultCard = (sent[1]!.input as { card: object }).card
    expect(cardTexts(resultCard).map(text => text.content))
      .toContain('权限未变化；可能仍在审批，或 addons 灰度尚未生效')
  })

  it('reports a failed recheck without optimistically restoring the corrected capability', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList(allGranted())
    capabilities.correctRuntimeFailure('comment', {
      error: { permission_violations: [{ subject: 'drive:comment:write' }] },
    })
    const sent: { to: string; input: { text: string } | { card: object } }[] = []
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_existing',
      registeredBy: 'ou_registrar',
      register: async (request) => {
        request.onQRCodeReady({ url: 'https://accounts.example/authorize', expireIn: 600 })
        return { client_id: 'cli_existing', client_secret: 'unchanged' }
      },
      chat: { async send(to, input) { sent.push({ to, input }); return {} } },
      capabilities,
      refresh: () => refreshLarkDocCapabilities(
        port(async () => { throw new Error('network down after scan') }),
        capabilities,
        vi.fn(),
        'preserve',
      ),
      report: vi.fn(),
      signal: new AbortController().signal,
    })

    await coordinator.request({ originChatId: 'oc_group', scopes: ['drive:comment:write'] })

    expect(capabilities.isEnabled('comment')).toBe(false)
    const result = sent.filter(message => 'card' in message.input)[1]!
    const resultText = cardTexts((result.input as { card: object }).card).map(text => text.content)
    expect(resultText).toContain('复核失败，状态未确认；权限按上次确认结果保持不变')
    expect(resultText.join(' ')).not.toContain('✓')
  })

  it('queues concurrent new scopes and preserves every origin notification', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([])
    const requests: RegisterAppRequest[] = []
    const releases: (() => void)[] = []
    const sent: { to: string; input: { text: string } | { card: object } }[] = []
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_existing',
      registeredBy: 'ou_registrar',
      register: request => new Promise((resolve) => {
        requests.push(request)
        request.onQRCodeReady({ url: `https://accounts.example/${requests.length}`, expireIn: 600 })
        releases.push(() => { resolve({ client_id: 'cli_existing', client_secret: 'unchanged' }) })
      }),
      chat: { async send(to, input) { sent.push({ to, input }); return {} } },
      capabilities,
      refresh: async () => ({ mode: 'scope-list', snapshot: capabilities.snapshot() }),
      report: vi.fn(),
      signal: new AbortController().signal,
    })

    const first = coordinator.request({ originChatId: 'oc_read', scopes: ['scope:read'] })
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    const second = coordinator.request({ originChatId: 'oc_write', scopes: ['scope:write'] })
    const third = coordinator.request({ originChatId: 'oc_comment', scopes: ['scope:comment'] })
    expect(requests).toHaveLength(1)

    releases[0]!()
    await vi.waitFor(() => { expect(requests).toHaveLength(2) })
    expect(new Set(requests[1]!.addons!.scopes.tenant)).toEqual(new Set(['scope:write', 'scope:comment']))
    releases[1]!()
    await Promise.all([first, second, third])

    const notices = sent.filter(message => 'text' in message.input)
    expect(notices.map(message => message.to)).toEqual(expect.arrayContaining(['oc_read', 'oc_write', 'oc_comment']))
  })

  it('filters scopes granted by the successful first refresh before the next batch', async () => {
    const requirements: LarkDocScopeRequirements = {
      read: { scopes: ['scope:same'], verified: true },
      write: { scopes: [], verified: true },
      comment: { scopes: [], verified: true },
    }
    const capabilities = new LarkDocCapabilities(requirements)
    capabilities.applyScopeList([])
    const requests: RegisterAppRequest[] = []
    const releases: (() => void)[] = []
    const sent: { to: string; input: { text: string } | { card: object } }[] = []
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_existing',
      registeredBy: 'ou_registrar',
      register: request => new Promise((resolve) => {
        requests.push(request)
        request.onQRCodeReady({ url: 'https://accounts.example/same', expireIn: 600 })
        releases.push(() => { resolve({ client_id: 'cli_existing', client_secret: 'unchanged' }) })
      }),
      chat: { async send(to, input) { sent.push({ to, input }); return {} } },
      capabilities,
      refresh: async () => {
        capabilities.applyScopeList([scope('scope:same', true)])
        return { mode: 'scope-list', snapshot: capabilities.snapshot() }
      },
      report: vi.fn(),
      signal: new AbortController().signal,
    })

    const first = coordinator.request({ originChatId: 'oc_group_a', scopes: ['scope:same'] })
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    const duplicate = coordinator.request({ originChatId: 'oc_group_b', scopes: ['scope:same'] })
    await vi.waitFor(() => {
      expect(sent.filter(message => 'text' in message.input).map(message => message.to))
        .toEqual(expect.arrayContaining(['oc_group_a', 'oc_group_b']))
    })
    releases[0]!()
    await Promise.all([first, duplicate])

    expect(requests).toHaveLength(1)
    expect(sent.filter(message => message.to === 'ou_registrar'
      && 'card' in message.input
      && JSON.stringify(message.input).includes('https://accounts.example/same'))).toHaveLength(1)
  })

  it('shares one active URL card with every origin when registeredBy is absent', async () => {
    const requirements: LarkDocScopeRequirements = {
      read: { scopes: ['scope:same'], verified: true },
      write: { scopes: [], verified: true },
      comment: { scopes: [], verified: true },
    }
    const capabilities = new LarkDocCapabilities(requirements)
    capabilities.applyScopeList([])
    const requests: RegisterAppRequest[] = []
    let release!: () => void
    const sent: { to: string; input: { text: string } | { card: object } }[] = []
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_existing',
      register: request => new Promise((resolve) => {
        requests.push(request)
        request.onQRCodeReady({ url: 'https://accounts.example/shared-url', expireIn: 600 })
        release = () => { resolve({ client_id: 'cli_existing', client_secret: 'unchanged' }) }
      }),
      chat: { async send(to, input) { sent.push({ to, input }); return {} } },
      capabilities,
      refresh: async () => {
        capabilities.applyScopeList([scope('scope:same', true)])
        return { mode: 'scope-list', snapshot: capabilities.snapshot() }
      },
      report: vi.fn(),
      signal: new AbortController().signal,
    })

    const first = coordinator.request({ originChatId: 'oc_group_a', scopes: ['scope:same'] })
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    const second = coordinator.request({ originChatId: 'oc_group_b', scopes: ['scope:same'] })
    await vi.waitFor(() => {
      expect(sent.filter(message => 'card' in message.input && JSON.stringify(message.input).includes('shared-url'))
        .map(message => message.to)).toEqual(expect.arrayContaining(['oc_group_a', 'oc_group_b']))
    })
    release()
    await Promise.all([first, second])

    expect(requests).toHaveLength(1)
  })

  it('settles active and queued request promises when authorization is aborted', async () => {
    const controller = new AbortController()
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_existing',
      registeredBy: 'ou_registrar',
      register: () => new Promise(() => {}),
      chat: { async send() { return {} } },
      capabilities,
      refresh: async () => ({ mode: 'scope-list', snapshot: capabilities.snapshot() }),
      report: vi.fn(),
      signal: controller.signal,
    })

    const active = coordinator.request({ originChatId: 'oc_a', scopes: ['scope:a'] })
    const queued = coordinator.request({ originChatId: 'oc_b', scopes: ['scope:b'] })
    controller.abort()

    await expect(Promise.all([active, queued])).resolves.toEqual([undefined, undefined])
  })
})

describe('bridge capability readiness and self-bootstrap', () => {
  it('keeps a configured send_doc denial through real agent composition', async () => {
    const harness = await mountChannel({ denyTools: ['send_doc'] })
    await harness.fake.emitMessage(fakeMessage({ content: 'hello' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const created = harness.agents.created[0]!

    expect(created.registeredTools.map(tool => tool.name)).not.toContain('send_doc')
    expect(created.denyReason('send_doc')).toContain('unavailable')
    expect(created.promptSections.find(section => section.name === 'lark-channel:presence')?.text)
      .toContain('send_doc')
    await harness.dispose()
  })

  it('holds an early message until the startup scope snapshot is settled', async () => {
    let resolveScopes!: (response: LarkScopeListResponse) => void
    const deferred = new Promise<LarkScopeListResponse>((resolve) => { resolveScopes = resolve })
    const harness = await mountChannel({}, { scopeList: () => deferred })

    const handling = harness.fake.emitMessage(fakeMessage({ content: 'early message' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.agents.created).toHaveLength(0)

    resolveScopes({ code: 0, data: { scopes: harness.fake.scopeGrants } })
    await handling
    expect(harness.agents.created).toHaveLength(1)
    await harness.dispose()
  })

  it('times out a hung startup probe and ignores its late empty result', async () => {
    let resolveScopes!: (response: LarkScopeListResponse) => void
    const deferred = new Promise<LarkScopeListResponse>((resolve) => { resolveScopes = resolve })
    const harness = await mountChannel({}, { scopeList: () => deferred, capabilityDeadlineMs: 10 })

    await harness.fake.emitMessage(fakeMessage({ content: 'deadline should release me' }))
    expect(harness.agents.created).toHaveLength(1)
    expect(harness.notices.some(line => line.includes('startup probe timed out'))).toBe(true)

    resolveScopes({ code: 0, data: { scopes: [] } })
    await new Promise(resolve => setTimeout(resolve, 0))
    await harness.fake.emitMessage(fakeMessage({ chatId: 'oc_after_late', content: 'new chat' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(2) })
    expect(harness.agents.created[1]!.registeredTools.map(tool => tool.name)).toContain('send_doc')
    await harness.dispose()
  })

  it('unblocks a waiting early message on disposal without creating an agent', async () => {
    let resolveScopes!: (response: LarkScopeListResponse) => void
    const deferred = new Promise<LarkScopeListResponse>((resolve) => { resolveScopes = resolve })
    const harness = await mountChannel({}, { scopeList: () => deferred })
    const handling = harness.fake.emitMessage(fakeMessage({ content: 'early message' }))

    await harness.dispose()
    await handling
    expect(harness.agents.created).toHaveLength(0)
    resolveScopes({ code: 0, data: { scopes: [] } })
  })

  it('settles readiness after a startup probe failure and composes optimistically', async () => {
    const harness = await mountChannel({}, {
      scopeList: async () => { throw new Error('startup scope network down') },
    })

    await harness.fake.emitMessage(fakeMessage({ content: 'continue despite probe failure' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    expect(harness.notices.some(line => line.includes('keeping all capabilities optimistic'))).toBe(true)
    await harness.dispose()
  })

  it('uses a document link to bootstrap an IM-only app and still leaves a not-read note', async () => {
    const requests: RegisterAppRequest[] = []
    const harness = await mountChannel(
      { registeredBy: 'ou_registrar' },
      {
        scopeGrants: [],
        registerApp: async (request) => {
          requests.push(request)
          request.onQRCodeReady({ url: 'https://accounts.example/authorize-docs', expireIn: 600 })
          return { client_id: 'cli_test', client_secret: 'test-secret' }
        },
      },
    )

    // An unverified map cannot dark a capability, so the first link is really
    // attempted; the platform's own refusal is what starts the bootstrap. The
    // alternatives it offers are recorded, but only the declared one is asked
    // for — the tenant should not approve a whole product family to read a doc.
    harness.fake.documentResponses.set('doc_bootstrap', {
      code: 99991672,
      msg: 'Access denied. One of the following scopes is required: [docx:document, docx:document:readonly]',
      error: {
        permission_violations: [{ subject: 'docx:document' }, { subject: 'docx:document:readonly' }],
      },
    })
    await harness.fake.emitMessage(fakeMessage({ content: '请看 https://example.feishu.cn/docx/doc_bootstrap' }))
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    expect(requests[0]!.addons!.scopes.tenant).toEqual(['docx:document:readonly'])
    expect(harness.fake.sent.some(message => message.to === 'ou_registrar' && 'card' in message.input)).toBe(true)

    // Read is off now, so the NEXT link is the one that is refused up front.
    await vi.waitFor(() => { expect(harness.fake.state.scopeLists).toBe(2) })
    await harness.fake.emitMessage(fakeMessage({
      messageId: 'om_retry',
      content: '再看 https://example.feishu.cn/docx/doc_retry',
    }))
    await vi.waitFor(() => { expect(requests).toHaveLength(2) })
    const followups = harness.agents.created[0]!.agent.followup.mock.calls
    expect(JSON.stringify(followups)).toContain('文档读取能力未点亮')
    await harness.dispose()
  })

  it('asks only for the capabilities a real refusal actually turned off', async () => {
    const withheld = 'docs:permission.member:create'
    const grants = [...new Set(Object.values(LARK_DOC_SCOPE_REQUIREMENTS).flatMap(item => item.scopes))]
      .filter(scopeName => scopeName !== withheld)
      .map(scopeName => scope(scopeName, true))
    const requests: RegisterAppRequest[] = []
    const harness = await mountChannel(
      { registeredBy: 'ou_registrar' },
      {
        scopeGrants: grants,
        registerApp: async (request) => {
          requests.push(request)
          request.onQRCodeReady({ url: 'https://accounts.example/write-comment', expireIn: 600 })
          return { client_id: 'cli_test', client_secret: 'test-secret' }
        },
      },
    )
    // A violation naming a scope only `write` declares takes read (the caller)
    // and write down together, and leaves comment alone.
    harness.fake.documentResponses.set('doc_readable', {
      code: 99991672,
      msg: 'Access denied',
      error: { permission_violations: [{ subject: withheld }] },
    })

    await harness.fake.emitMessage(fakeMessage({ content: '请读 https://example.feishu.cn/docx/doc_readable' }))
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })

    // Exactly the withheld scope reaches the administrator: not the whole map,
    // and nothing belonging to a capability that was never refused.
    expect(requests[0]!.addons!.scopes.tenant).toEqual([withheld])
    // The recheck confirms it is still withheld, so the two stay off — and the
    // untouched one stays on.
    await vi.waitFor(() => { expect(harness.fake.state.scopeLists).toBe(2) })
    // A different chat, because tools are decided once at agent creation and
    // the agent that made the failing call keeps the table it was born with.
    await harness.fake.emitMessage(fakeMessage({ chatId: 'oc_after', messageId: 'om_after', content: 'hello' }))
    await vi.waitFor(() => { expect(harness.agents.created.length).toBe(2) })
    const tools = harness.agents.created[1]!.registeredTools.map(tool => tool.name)
    expect(tools).not.toContain('send_doc')
    expect(tools).toContain('comment_on_doc')
    await harness.dispose()
  })

  it('allows a new document link to retry after the previous authorization recheck failed', async () => {
    let scopeCalls = 0
    const requests: RegisterAppRequest[] = []
    const harness = await mountChannel(
      { registeredBy: 'ou_registrar' },
      {
        scopeList: async () => {
          scopeCalls += 1
          if (scopeCalls === 1) return { code: 0, data: { scopes: [] } }
          throw new Error('recheck unavailable')
        },
        registerApp: async (request) => {
          requests.push(request)
          request.onQRCodeReady({ url: `https://accounts.example/retry-${requests.length}`, expireIn: 600 })
          return { client_id: 'cli_test', client_secret: 'test-secret' }
        },
      },
    )

    harness.fake.documentResponses.set('doc_failed_1', {
      code: 99991672,
      msg: 'Access denied',
      error: { permission_violations: [{ subject: 'docx:document:readonly' }] },
    })
    await harness.fake.emitMessage(fakeMessage({ content: '看 https://example.feishu.cn/docx/doc_failed_1' }))
    await vi.waitFor(() => {
      expect(requests).toHaveLength(1)
      expect(harness.fake.sent.filter(message => message.to === 'ou_registrar' && 'card' in message.input))
        .toHaveLength(2)
    })
    await harness.fake.emitMessage(fakeMessage({
      messageId: 'om_failed_2',
      content: '再看 https://example.feishu.cn/docx/doc_failed_2',
    }))
    await vi.waitFor(() => { expect(requests).toHaveLength(2) })
    await harness.dispose()
  })
})
