import { describe, expect, it } from 'vitest'
import { instanceIdentity, refuseInstanceName } from '../src/instance.ts'
import { APP_SECRET_REF } from '../src/credentials.ts'
import { sessionIdFor } from '../src/session.ts'
import { workspaceSessionId } from '../src/workspace.ts'

describe('instance identity', () => {
  it('leaves an unnamed row on the identifiers it already has', () => {
    const identity = instanceIdentity()
    // Byte for byte: an existing deployment's settings section, credential,
    // and every stored session id have to keep resolving after this feature
    // exists. A change here orphans live conversations.
    expect(identity).toEqual({
      settingsNamespace: 'lark-channel',
      secretRef: APP_SECRET_REF,
      sessionPrefix: 'lark-',
    })
    expect(instanceIdentity('')).toEqual(identity)
    expect(sessionIdFor('oc_1', identity.sessionPrefix)).toBe('lark-oc_1')
    expect(sessionIdFor('oc_1')).toBe('lark-oc_1')
    expect(workspaceSessionId('oc_1', undefined, identity.sessionPrefix)).toBe('lark-oc_1')
  })

  it('keys a named row apart in all three places at once', () => {
    const second = instanceIdentity('support')
    expect(second.settingsNamespace).toBe('lark-channel-support')
    expect(second.secretRef).toBe('LARK_APP_SECRET_SUPPORT')
    expect(second.sessionPrefix).toBe('lark-support-')
    // The one that bites quietest: two bots in ONE group must not derive the
    // same session id and share an agent.
    expect(sessionIdFor('oc_shared', second.sessionPrefix))
      .not.toBe(sessionIdFor('oc_shared', instanceIdentity().sessionPrefix))
  })

  it('folds a dashed name into the shape a credential reference allows', () => {
    expect(instanceIdentity('cn-ops').secretRef).toBe('LARK_APP_SECRET_CN_OPS')
    expect(instanceIdentity('cn-ops').settingsNamespace).toBe('lark-channel-cn-ops')
  })

  it('refuses a name that would corrupt the identifiers it becomes part of', () => {
    for (const bad of ['Support', 'has space', 'has/slash', '-leading', 'a'.repeat(33), 'sup:port']) {
      expect(refuseInstanceName(bad)).toBeDefined()
      expect(() => instanceIdentity(bad)).toThrow('instance')
    }
    for (const good of ['support', 'cn-ops', 'b2', '2nd-bot']) {
      expect(refuseInstanceName(good)).toBeUndefined()
    }
  })

  it('gives every named row a distinct set, so two of them cannot collide', () => {
    const names = ['support', 'sales', 'cn-ops']
    const identities = names.map(name => instanceIdentity(name))
    for (const field of ['settingsNamespace', 'secretRef', 'sessionPrefix'] as const) {
      const values = identities.map(identity => identity[field])
      expect(new Set(values).size).toBe(names.length)
      expect(values).not.toContain(instanceIdentity()[field])
    }
  })
})
