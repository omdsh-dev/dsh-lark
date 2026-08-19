/**
 * Where this channel's app secret lives.
 *
 * The host owns a seam for exactly this: `ctx.credentials` resolves a
 * REFERENCE — a shell-identifier name like `LARK_APP_SECRET` — through
 * whichever provider a deployment composed, reading an environment variable,
 * a dotenv file, or its own store, and reporting changes so the next
 * operation picks them up. Configuration surfaces then describe a secret
 * without ever holding one.
 *
 * This plugin used to persist the scanned secret straight into the user
 * settings document, which is the wrong home for it twice over: that document
 * is meant to be read and hand-edited, and it is the same file a deployment
 * copies around to move its preferences. The secret now goes to the
 * credentials seam and the settings keep only the reference.
 *
 * A deployment without a credentials provider keeps working exactly as it
 * did, secret and all — degrading to a worse hiding place beats refusing to
 * onboard a bot.
 * @module dsh-lark-channel/credentials
 */

/** Where a resolved credential came from, as the provider reports it. */
export interface ResolvedCredential {
  readonly value: string
  /** `env`, `file`, or a dotenv path — an operator's answer to "which one is live?". */
  readonly source?: string
}

/** The `credentials` seam, narrowed to what this plugin does with it. */
export interface HostCredentials {
  /**
   * Read one reference's current value.
   * @param ref - the reference name.
   * @returns the value and its source, or undefined when nothing is stored.
   */
  resolve(ref: string): Promise<ResolvedCredential | undefined>
  /**
   * Store one reference's value.
   * @param ref - the reference name.
   * @param value - the secret; providers reject an empty one.
   */
  set(ref: string, value: string): Promise<void>
}

/**
 * The reference this channel stores its app secret under.
 *
 * Deliberately the same name as the environment variable the provisioning CLI
 * writes: a deployment that exports `LARK_APP_SECRET` is already configured,
 * because the local provider resolves an inherited environment variable before
 * anything it stores itself.
 */
export const APP_SECRET_REF = 'LARK_APP_SECRET'

/** A reference must be a shell identifier; the seam brands them that way. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Whether a configured reference is one the seam will accept.
 * @param ref - the candidate reference.
 * @returns whether it is a shell identifier.
 */
export function isCredentialRef(ref: string): boolean {
  return REF_PATTERN.test(ref)
}

/**
 * Resolve the app secret for one configuration.
 *
 * A secret written into the entry config wins: a deployment that injected it
 * (from its own environment, its own vault) has said where the value comes
 * from, and reaching past that to a stored reference would silently serve a
 * different bot than the composition asked for.
 * @param credentials - the seam, when a provider is composed.
 * @param config - the app id, the inline secret, and the reference.
 * @param report - operator console line for a reference that cannot resolve.
 * @returns the secret, or undefined when neither source has one.
 */
export async function resolveAppSecret(
  credentials: HostCredentials | undefined,
  config: { readonly appSecret?: string | undefined; readonly appSecretRef?: string | undefined },
  report: (line: string) => void,
): Promise<string | undefined> {
  if (config.appSecret !== undefined && config.appSecret !== '') return config.appSecret
  const ref = config.appSecretRef
  if (ref === undefined || ref === '') return undefined
  if (!isCredentialRef(ref)) {
    report(`lark-channel: appSecretRef "${ref}" is not a valid credential reference; ignoring it`)
    return undefined
  }
  if (credentials === undefined) {
    report(`lark-channel: no credentials provider is composed, so appSecretRef "${ref}" cannot be resolved`)
    return undefined
  }
  const resolved = await credentials.resolve(ref).catch((error: unknown) => {
    report(`lark-channel: resolving credential "${ref}" failed: ${String(error)}`)
    return undefined
  })
  if (resolved === undefined || resolved.value === '') {
    report(`lark-channel: credential "${ref}" is not configured`)
    return undefined
  }
  return resolved.value
}

/** What became of an attempt to put a secret behind a reference. */
export interface SecretStored {
  /** The reference to record in settings, when the secret was stored behind one. */
  readonly ref?: string
  /** Whether the secret itself still has to be written to settings. */
  readonly inSettings: boolean
}

/**
 * Store one app secret in the best home this deployment offers.
 * @param credentials - the seam, when a provider is composed.
 * @param secret - the secret to store.
 * @param report - operator console line.
 * @returns the reference to record, or the instruction to keep the secret in settings.
 */
export async function storeAppSecret(
  credentials: HostCredentials | undefined,
  secret: string,
  report: (line: string) => void,
  ref: string = APP_SECRET_REF,
): Promise<SecretStored> {
  if (credentials === undefined) return { inSettings: true }
  try {
    await credentials.set(ref, secret)
    return { ref, inSettings: false }
  } catch (error) {
    // Worth a line rather than a throw: a bot that onboarded is more use than
    // one that refused to, and the operator can move the secret later.
    report(`lark-channel: storing the app secret as "${ref}" failed (${String(error)}); keeping it in settings`)
    return { inSettings: true }
  }
}

/**
 * Move a secret already sitting in the settings document behind a reference.
 *
 * Runs on every boot that finds one there, so a deployment onboarded before
 * this existed is repaired by restarting rather than by re-scanning. The
 * settings value is blanked rather than deleted, because a deep-merge patch
 * cannot remove a key — and an empty secret is an absent one everywhere here.
 * @param credentials - the seam, when a provider is composed.
 * @param config - the configuration as the settings document resolved it.
 * @param persist - the settings patch writer.
 * @param report - operator console line.
 * @returns the reference the secret now lives behind, when it moved.
 */
export async function migrateAppSecret(
  credentials: HostCredentials | undefined,
  config: { readonly appSecret?: string | undefined; readonly appSecretRef?: string | undefined },
  persist: (patch: object) => Promise<boolean>,
  report: (line: string) => void,
  ref: string = APP_SECRET_REF,
): Promise<string | undefined> {
  const secret = config.appSecret
  if (secret === undefined || secret === '') return undefined
  if (credentials === undefined) return undefined
  const stored = await storeAppSecret(credentials, secret, report, ref)
  if (stored.ref === undefined) return undefined
  const persisted = await persist({ appSecret: '', appSecretRef: stored.ref }).catch((error: unknown) => {
    report(`lark-channel: moving the app secret out of settings failed: ${String(error)}`)
    return false
  })
  if (!persisted) return undefined
  report(`lark-channel: moved the app secret out of user settings; it is now the credential "${stored.ref}"`)
  return stored.ref
}
