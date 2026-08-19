/**
 * Package-owned invariant companion for `dsh-lark-channel`.
 * @module dsh-lark-channel/invariant
 */

import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = 'dsh-lark-channel'

/** A package-attributed invariant failure reported by the host registry. */
type InvariantFailure = (message: string) => never

/** Installer callback accepted by the host's invariant registry. */
type InvariantInstaller = (ctx: Context, fail: InvariantFailure) => void | Promise<void>

/** Minimal runtime contract used by the companion without a source checkout. */
interface InvariantRegistry {
  register(packageName: string, installer: InvariantInstaller): () => void
}

/** Cordis companion plugin name. */
export const name = 'lark-channel-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bridge's chat→agent bindings and pending approval
 * cards are process-local ephemera keyed by host-owned ids; every durable
 * relation they touch (`user/message` events, the approval ask/outcome audit
 * pair) is owned and asserted by the host session and approval packages.
 */
const install: InvariantInstaller = () => {}

/**
 * Resolve the host registry through Cordis's named service lookup. Keeping this
 * narrow local contract lets this package build without host source files; a
 * composed DSH profile still supplies the real `invariants` service.
 * @param ctx - Cordis context carrying the host service.
 * @returns the host invariant registry.
 * @throws {Error} when the companion is loaded without its host service.
 */
function getInvariantRegistry(ctx: Context): InvariantRegistry {
  const registry = ctx.get('invariants') as InvariantRegistry | undefined
  if (registry === undefined) {
    throw new Error(`invariant companion requires the "invariants" service for ${PACKAGE_NAME}`)
  }
  return registry
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(getInvariantRegistry(ctx).register(PACKAGE_NAME, install))
