import { describe, expect, it, vi } from 'vitest'
import {
  createDocumentAuthorizationCoordinator,
  LarkDocCapabilities,
  missingScopesFor,
  registerLarkDocTools,
  refreshLarkDocCapabilities,
  refreshLarkDocCapabilitiesWithDeadline,
} from '../src/capability.ts'
import { resolveConfig } from '../src/config.ts'
import type { LarkDocScopeRequirements, LarkDocsProtocolPort, LarkScopeListResponse } from '../src/larkdocs.ts'
import {
  checkedLarkDocsResponse,
  LarkDocsProtocolError,
  larkDocsErrorDetails,
} from '../src/larkdocs.ts'
import type { RegisterAppRequest } from '../src/onboarding.ts'
import { cardTexts, fakeMessage, mountChannel } from './harness.ts'

const REQUIREMENTS: LarkDocScopeRequirements = {
  write: { scopes: ['docs_ai:write', 'drive:member:write'], verified: true },
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

describe('single document capability', () => {
  it('resolves only the surviving document settings to their defaults', () => {
    const config = resolveConfig({})
    expect(config).toMatchObject({
      sendDocs: true,
      commentDocs: true,
      docAuthorizeOnDemand: true,
      documentGenerations: {},
    })
    expect(config).not.toHaveProperty('receiveDocs')
    expect(config).not.toHaveProperty('maxDocCommentsPerTurn')
  })

  it('lights write only when all verified tenant scopes are granted', async () => {
    const list = vi.fn(async () => ({
      code: 0,
      data: {
        scopes: [
          scope('docs_ai:write', true),
          scope('drive:member:write', true, 'user'),
        ],
      },
    }))
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)

    const result = await refreshLarkDocCapabilities(port(list), capabilities, vi.fn())

    expect(list).toHaveBeenCalledWith({})
    expect(result.snapshot).toEqual({
      write: {
        enabled: false,
        missingScopes: ['drive:member:write'],
        scopeMapVerified: true,
        source: 'scope-list',
      },
    })
  })

  it('keeps write optimistic when scope.list fails', async () => {
    const report = vi.fn()
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    const result = await refreshLarkDocCapabilities(
      port(async () => { throw new Error('socket closed') }),
      capabilities,
      report,
    )

    expect(result.mode).toBe('optimistic')
    expect(result.snapshot.write.enabled).toBe(true)
    expect(report).toHaveBeenCalledWith(expect.stringContaining('socket closed'))
  })

  it('preserves a runtime correction when a recheck times out', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([scope('docs_ai:write', true), scope('drive:member:write', true)])
    capabilities.correctRuntimeFailure('write', {
      error: { permission_violations: [{ subject: 'drive:member:write' }] },
    })

    const result = await refreshLarkDocCapabilitiesWithDeadline(
      port(() => new Promise(() => {})),
      capabilities,
      vi.fn(),
      'preserve',
      5,
    )

    expect(result.mode).toBe('failed')
    expect(result.snapshot.write).toMatchObject({ enabled: false, source: 'runtime-correction' })
  })

  it('keeps platform alternatives as one requirement and asks for the declared member scope', () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([scope('docs_ai:write', true), scope('drive:member:write', true)])

    const correction = capabilities.correctRuntimeFailure('write', {
      error: {
        permission_violations: [
          { subject: 'drive:member:write' },
          { subject: 'sheets:permission.member:create' },
        ],
      },
    })

    expect(correction).toEqual({
      disabled: ['write'],
      missingScopes: ['drive:member:write'],
      changed: true,
    })
    expect(missingScopesFor(capabilities.snapshot())).toContain('drive:member:write')
  })
})

describe('send_doc registration surface', () => {
  it('registers only send_doc when the switch and capability are on', () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([scope('docs_ai:write', true), scope('drive:member:write', true)])
    const denied = new Set<string>()
    const registered: { name: string }[] = []

    expect(registerLarkDocTools({
      tools: { register(definition) { registered.push(definition as { name: string }); return () => {} } },
      denied,
      snapshot: capabilities.snapshot(),
      switches: { sendDocs: true },
      definitions: { send_doc: { name: 'send_doc' } },
      report: vi.fn(),
    })).toEqual(['send_doc'])
    expect(registered).toEqual([{ name: 'send_doc' }])
    expect(denied).toEqual(new Set())
  })

  it('keeps denyTools authoritative and denies an unlit or disabled send_doc', () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([])
    const denied = new Set<string>()

    registerLarkDocTools({
      tools: { register: vi.fn(() => () => {}) },
      denied,
      snapshot: capabilities.snapshot(),
      switches: { sendDocs: true },
      definitions: { send_doc: { name: 'send_doc' } },
      report: vi.fn(),
    })
    expect([...denied]).toEqual(['send_doc'])

    const configuredDeny = new Set<string>(['send_doc'])
    const register = vi.fn(() => () => {})
    registerLarkDocTools({
      tools: { register },
      denied: configuredDeny,
      snapshot: capabilities.snapshot(),
      switches: { sendDocs: true },
      definitions: { send_doc: { name: 'send_doc' } },
      report: vi.fn(),
    })
    expect(register).not.toHaveBeenCalled()
  })
})

describe('protocol error parsing', () => {
  it('preserves platform code, message, and exact permission subjects', () => {
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
      expect(larkDocsErrorDetails(error)).toEqual({
        code: 99991672,
        message: 'Access denied',
        permissionViolations: ['scope:a'],
      })
    }
  })

  it('prefers an Axios platform envelope over transport prose', () => {
    const error = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        data: {
          code: 99991672,
          msg: 'tenant scope missing',
          error: { permission_violations: [{ subject: 'docs_ai:write' }] },
        },
      },
    })
    expect(larkDocsErrorDetails(error)).toEqual({
      code: 99991672,
      message: 'tenant scope missing',
      permissionViolations: ['docs_ai:write'],
    })
  })
})

describe('document authorization coordinator', () => {
  it('sends the exact missing write scope to the owner and rechecks afterward', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([scope('docs_ai:write', true)])
    capabilities.correctRuntimeFailure('write', {
      error: { permission_violations: [{ subject: 'drive:member:write' }] },
    })
    const sends: { to: string; input: object }[] = []
    const register = vi.fn(async (request: {
      addons?: { scopes: { tenant: string[] } }
      onQRCodeReady(info: { url: string; expireIn: number }): void
    }) => {
      request.onQRCodeReady({ url: 'https://accounts.example/authorize', expireIn: 600 })
      capabilities.applyScopeList([
        scope('docs_ai:write', true),
        scope('drive:member:write', true),
      ])
      return { client_id: 'cli_test', client_secret: 'secret' }
    })
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_test',
      registeredBy: 'ou_owner',
      register,
      chat: { send: async (to, input) => { sends.push({ to, input }); return {} } },
      capabilities,
      refresh: async () => ({ mode: 'scope-list', snapshot: capabilities.snapshot() }),
      report: vi.fn(),
      signal: new AbortController().signal,
    })

    await coordinator.request({ originChatId: 'oc_group', scopes: ['drive:member:write'] })

    expect(register).toHaveBeenCalledOnce()
    expect(register.mock.calls[0]![0].addons?.scopes.tenant).toEqual(['drive:member:write'])
    expect(sends.some(send => send.to === 'ou_owner')).toBe(true)
    expect(sends.some(send => send.to === 'oc_group')).toBe(true)
  })

  it('falls back to the origin with an explicit warning when no registrant is recorded', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([scope('docs_ai:write', true)])
    const sent: { to: string; input: { text: string } | { card: object } }[] = []
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_test',
      register: async (request) => {
        request.onQRCodeReady({ url: 'https://accounts.example/fallback', expireIn: 600 })
        return { client_id: 'cli_test', client_secret: 'secret' }
      },
      chat: { async send(to, input) { sent.push({ to, input }); return {} } },
      capabilities,
      refresh: async () => ({ mode: 'scope-list', snapshot: capabilities.snapshot() }),
      report: vi.fn(),
      signal: new AbortController().signal,
    })

    await coordinator.request({ originChatId: 'oc_group', scopes: ['drive:member:write'] })

    expect(sent.every(item => item.to === 'oc_group')).toBe(true)
    expect(cardTexts((sent[0]!.input as { card: object }).card).map(item => item.content))
      .toContain('这个链接可以修改应用配置。当前没有已记录的注册者，只能发到原聊天；请勿转发。扫码后渠道会重新检查权限。')
  })

  it('reports a failed recheck without restoring a runtime-corrected write capability', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([scope('docs_ai:write', true), scope('drive:member:write', true)])
    capabilities.correctRuntimeFailure('write', {
      error: { permission_violations: [{ subject: 'drive:member:write' }] },
    })
    const sent: { to: string; input: { text: string } | { card: object } }[] = []
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_test',
      registeredBy: 'ou_owner',
      register: async (request) => {
        request.onQRCodeReady({ url: 'https://accounts.example/recheck', expireIn: 600 })
        return { client_id: 'cli_test', client_secret: 'secret' }
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

    await coordinator.request({ originChatId: 'oc_group', scopes: ['drive:member:write'] })

    expect(capabilities.isEnabled('write')).toBe(false)
    const result = sent.filter(item => item.to === 'ou_owner' && 'card' in item.input)[1]!
    const text = cardTexts((result.input as { card: object }).card).map(item => item.content)
    expect(text).toContain('复核失败，状态未确认；权限按上次确认结果保持不变')
    expect(text.join(' ')).not.toContain('✓')
  })

  it('reports a newly granted comment-only scope even when the write capability fingerprint is unchanged', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([scope('docs_ai:write', true), scope('drive:member:write', true)])
    const sent: { to: string; input: { text: string } | { card: object } }[] = []
    const commentScope = 'docs:document.comment:create'
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_test',
      registeredBy: 'ou_owner',
      register: async (request) => {
        request.onQRCodeReady({ url: 'https://accounts.example/comment-scope', expireIn: 600 })
        capabilities.applyScopeList([
          scope('docs_ai:write', true),
          scope('drive:member:write', true),
          scope(commentScope, true),
        ])
        return { client_id: 'cli_test', client_secret: 'secret' }
      },
      chat: { async send(to, input) { sent.push({ to, input }); return {} } },
      capabilities,
      refresh: async () => ({ mode: 'scope-list', snapshot: capabilities.snapshot() }),
      report: vi.fn(),
      signal: new AbortController().signal,
    })

    await coordinator.request({ originChatId: 'ou_owner', scopes: [commentScope] })

    const result = sent.filter(item => item.to === 'ou_owner' && 'card' in item.input)[1]!
    const text = cardTexts((result.input as { card: object }).card).map(item => item.content).join('\n')
    expect(text).toContain('权限状态有变化')
    expect(text).toContain(commentScope)
    expect(text).not.toContain('权限未变化')
    expect(text).toContain('事件订阅没有查询接口')
  })

  it('queues concurrent scopes into a later batch and notifies every origin', async () => {
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    capabilities.applyScopeList([])
    const requests: RegisterAppRequest[] = []
    const releases: (() => void)[] = []
    const sent: { to: string; input: { text: string } | { card: object } }[] = []
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_test',
      registeredBy: 'ou_owner',
      register: request => new Promise((resolve) => {
        requests.push(request)
        request.onQRCodeReady({ url: `https://accounts.example/${String(requests.length)}`, expireIn: 600 })
        releases.push(() => { resolve({ client_id: 'cli_test', client_secret: 'secret' }) })
      }),
      chat: { async send(to, input) { sent.push({ to, input }); return {} } },
      capabilities,
      refresh: async () => ({ mode: 'scope-list', snapshot: capabilities.snapshot() }),
      report: vi.fn(),
      signal: new AbortController().signal,
    })

    const first = coordinator.request({ originChatId: 'oc_a', scopes: ['scope:a'] })
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    const second = coordinator.request({ originChatId: 'oc_b', scopes: ['scope:b'] })
    const third = coordinator.request({ originChatId: 'oc_c', scopes: ['scope:c'] })
    releases[0]!()
    await vi.waitFor(() => { expect(requests).toHaveLength(2) })
    expect(new Set(requests[1]!.addons!.scopes.tenant)).toEqual(new Set(['scope:b', 'scope:c']))
    expect(requests[1]!.addons!.events?.items.tenant).toEqual(['drive.notice.comment_add_v1'])
    releases[1]!()
    await Promise.all([first, second, third])
    expect(sent.filter(item => 'text' in item.input).map(item => item.to))
      .toEqual(expect.arrayContaining(['oc_a', 'oc_b', 'oc_c']))
  })

  it('settles active and queued requests when the coordinator is aborted', async () => {
    const controller = new AbortController()
    const capabilities = new LarkDocCapabilities(REQUIREMENTS)
    const coordinator = createDocumentAuthorizationCoordinator({
      appId: 'cli_test',
      registeredBy: 'ou_owner',
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

describe('bridge capability readiness', () => {
  it('holds an early message until the startup scope snapshot settles', async () => {
    let resolveScopes!: (response: LarkScopeListResponse) => void
    const deferred = new Promise<LarkScopeListResponse>((resolve) => { resolveScopes = resolve })
    const harness = await mountChannel({}, { scopeList: () => deferred })
    const handling = harness.fake.emitMessage(fakeMessage({ content: 'early' }))
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(harness.agents.created).toHaveLength(0)

    resolveScopes({ code: 0, data: { scopes: harness.fake.scopeGrants } })
    await handling
    expect(harness.agents.created).toHaveLength(1)
    await harness.dispose()
  })

  it('unblocks readiness after probe failure and on disposal', async () => {
    const failed = await mountChannel({}, {
      scopeList: async () => { throw new Error('startup probe failed') },
    })
    await failed.fake.emitMessage(fakeMessage({ content: 'continue' }))
    expect(failed.agents.created).toHaveLength(1)
    await failed.dispose()

    const never = new Promise<LarkScopeListResponse>(() => {})
    const disposed = await mountChannel({}, { scopeList: () => never })
    const handling = disposed.fake.emitMessage(fakeMessage({ content: 'waiting' }))
    await disposed.dispose()
    await handling
    expect(disposed.agents.created).toHaveLength(0)
  })
})
