/**
 * Where this channel's managed state persists, across the two host settings
 * generations.
 *
 * The state is the per-conversation facts a chat builds up: the directory it was
 * `/cd`-ed to, the model route it asked for, the session it continues, and how
 * many times it started over. The host owns the durable home for them, and that
 * home moved. An older host registered a namespace against a schema and handed
 * back a scope — `register(ns, schema, { base }) -> { get, update(patch) }` —
 * while the host this package declares projects each Loader row's volatile
 * Config fields and writes them by the row's own id: `update(ns, patch,
 * revision?)`, where `ns` is the row's `id:` in the configuration tree.
 *
 * Both are supported here, because a deployment may run either generation: the
 * modern seam is preferred, the older one is used when it is the only one
 * present, and a deployment with neither gets an in-memory channel plus one line
 * saying exactly that — which is the state this channel was in silently when the
 * host changed and the hand-copied contract in `host.ts` did not.
 *
 * A modern write lands only where the row's own Config marks the field volatile;
 * the host validates that and refuses the patch otherwise. A refusal is reported
 * once, with the host's own words, rather than being mistaken for durability.
 * @module dsh-lark-channel/settings-store
 */

import type { Context } from '@deepseek-ai/cordis'
import { failureDetail } from './format.ts'

/** One row's live volatile config, as the host's `describe()` publishes it. */
export interface SettingsDescriptorLike {
  readonly ns?: unknown
  readonly value?: unknown
  /**
   * The part of that config the USER document supplies, when the host
   * publishes it. What a deployment injected through its own composition shows
   * up in `value` but not here, which is the distinction migration needs.
   */
  readonly user?: unknown
}

/** The modern seam: per-row volatile config, written by the row's own id. */
export interface ModernSettings {
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** The older seam's namespace scope. */
export interface LegacySettingsScope {
  /** The resolved value: schema defaults, then composition base, then the document. */
  get(): unknown
  /** Deep-merge a patch into the namespace's stored section. */
  update(patch: object): Promise<unknown>
}

/** The older seam: a namespace registered against a schema. */
export interface LegacySettings {
  register(ns: string, schema: unknown, options?: { base?: unknown }): LegacySettingsScope
}

/** What one deployment's settings seam gives this plugin. */
export interface SettingsBinding {
  /**
   * The configuration as the seam resolved it, when the seam can hand one back.
   *
   * Absent on the modern seam: there the resolved config is already the value
   * the Loader passed this plugin, so there is nothing to re-read.
   */
  readonly resolved?: unknown
  /**
   * Whether a seam exists that can store managed state at all.
   *
   * Distinct from what any single write does: a composed seam may still refuse
   * one patch (and says so when it does). This is the answer to "will `/cd`,
   * `/model` and the session pointers survive a restart?", which the operator
   * asks when something was just fixed and cannot read off the chat.
   */
  readonly durable: boolean
  /**
   * Write one managed-state patch.
   * @param patch - the section to merge, keyed as this channel's config names it.
   * @returns whether it reached durable storage.
   */
  persist(patch: object): Promise<boolean>
}

/**
 * The Loader row id this plugin is mounted as, when the tree names one.
 *
 * Read structurally: the id lives on the Loader's entry, which is an extension
 * of the Cordis fiber this package's `@deepseek-ai/cordis` does not type.
 * @param ctx - the plugin's scoped context.
 * @returns the row's id, or undefined when this deployment names none.
 */
export function entryIdOf(ctx: Context): string | undefined {
  const fiber = (ctx as { fiber?: { entry?: { options?: { id?: unknown } } } }).fiber
  const id = fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * The part of one row's config the USER document supplies, when the host says.
 *
 * The modern seam publishes both the effective value and the document's own
 * contribution, which is the only way to tell a secret a deployment injected
 * from one this plugin's onboarding wrote: migration must move the second and
 * leave the first where its owner put it.
 * @param settings - the composed `settings` service, in whichever generation it is.
 * @param ns - the row id to read.
 * @returns the document's contribution, or undefined when the host publishes
 * none (an older seam) or cannot answer.
 */
export function userSectionOf(settings: unknown, ns: string): unknown {
  const describe = (settings as { describe?: unknown } | null | undefined)?.describe
  if (typeof describe !== 'function') return undefined
  try {
    const rows = describe.call(settings) as readonly SettingsDescriptorLike[] | undefined
    return rows?.find(row => row.ns === ns)?.user
  } catch {
    // A host that will not list its rows leaves migration to its own judgement
    // rather than guessing which secret is whose.
    return undefined
  }
}

/** Construction options for {@link createSettingsBinding}. */
export interface SettingsBindingOptions {
  /** The composed `settings` service, in whichever generation it is. */
  readonly settings: unknown
  /** The Loader row id a modern write names, when the tree names one. */
  readonly entryId: string | undefined
  /** The namespace an older host registers, and the fallback a modern one names. */
  readonly namespace: string
  /** This plugin's Config schema, for the older seam's registration. */
  readonly schema: unknown
  /** The composed config the older seam registers as its base. */
  readonly base: unknown
  /** Operator console line. */
  readonly report: (line: string) => void
}

/**
 * The top-level fields this plugin's own schema lets the host write.
 *
 * Read from the schema the Loader resolved, which is the same object the host
 * asks for volatility, so the two can never disagree about what this row owns.
 * @param schema - this plugin's Config schema, of any generation.
 * @returns the field names, or undefined when the schema cannot be read.
 */
function volatileFields(schema: unknown): ReadonlySet<string> | undefined {
  const dict = (schema as { dict?: Record<string, { meta?: { volatile?: boolean } }> } | null | undefined)?.dict
  if (dict === undefined || dict === null) return undefined
  return new Set(Object.entries(dict)
    .filter(([, field]) => field.meta?.volatile === true)
    .map(([name]) => name))
}

/**
 * Bind this channel's managed state to the settings seam a deployment composed.
 * @param options - the service, the row identity, and the schema to register.
 * @returns the binding, whose `persist` is a no-op when nothing can store.
 */
export function createSettingsBinding(options: SettingsBindingOptions): SettingsBinding {
  const { settings, entryId, namespace, schema, base, report } = options
  const noStore = (reason: string): SettingsBinding => {
    report(`lark-channel: ${reason} — /cd workspaces, /model routes and session pointers live in memory only`)
    return { durable: false, persist: async () => false }
  }
  if (settings === undefined || settings === null) {
    return noStore('no settings service is composed')
  }

  const owned = volatileFields(schema)
  let reportedStray = false
  /**
   * Narrow one patch to the fields this row declares.
   *
   * A host that validates refuses the WHOLE patch over a single undeclared key
   * — which is how a registration once lost the credentials it had just
   * created, because it also reported who scanned the code. Dropping the stray
   * key keeps the state that matters, and saying so keeps the mistake visible
   * instead of silently costing a write.
   */
  const ownFields = (patch: object): object => {
    if (owned === undefined) return patch
    const stray = Object.keys(patch).filter(key => !owned.has(key))
    if (stray.length === 0) return patch
    if (!reportedStray) {
      reportedStray = true
      report(`lark-channel: not persisting undeclared field(s) ${stray.join(', ')}; `
        + `this row writes ${[...owned].join(', ')}`)
    }
    return Object.fromEntries(Object.entries(patch).filter(([key]) => owned.has(key)))
  }

  const modern = settings as Partial<ModernSettings>
  if (typeof modern.update === 'function' && entryId !== undefined) {
    const update = modern.update.bind(settings)
    let refused = false
    return {
      durable: true,
      async persist(patch) {
        const fields = ownFields(patch)
        // Everything was stray: there is nothing this row may write.
        if (Object.keys(fields).length === 0) return false
        try {
          await update(entryId, fields)
          return true
        } catch (error: unknown) {
          // Said once, with the host's own words: "not volatile" and "overridden
          // by a home patch" are fixes the operator can make, while a channel
          // that quietly kept the state in memory is the failure this whole
          // module exists to end.
          if (!refused) {
            refused = true
            report(`lark-channel: persisting managed state as "${entryId}" failed: ${failureDetail(error)}`)
          }
          return false
        }
      },
    }
  }

  const legacy = settings as Partial<LegacySettings>
  if (typeof legacy.register === 'function') {
    try {
      const scope = legacy.register.call(settings, namespace, schema, { base })
      let refused = false
      return {
        resolved: scope.get(),
        durable: true,
        async persist(patch) {
          const fields = ownFields(patch)
          // Everything was stray: there is nothing this row may write.
          if (Object.keys(fields).length === 0) return false
          try {
            await scope.update(fields)
            return true
          } catch (error: unknown) {
            if (!refused) {
              refused = true
              report(`lark-channel: persisting managed state as "${namespace}" failed: ${failureDetail(error)}`)
            }
            return false
          }
        },
      }
    } catch (error: unknown) {
      return noStore(`registering the settings namespace "${namespace}" failed: ${failureDetail(error)}`)
    }
  }

  // A modern service with no row id to name: the write path exists but this
  // deployment gives the plugin row no `id:`, so no patch can be addressed.
  // Said in those words rather than "offers neither seam", because the operator
  // fix is to name the row, not to change hosts.
  if (typeof modern.update === 'function') {
    return noStore('the settings service writes by Loader row id, and this deployment names none for this plugin')
  }

  return noStore("this host's settings service offers neither update() nor register()")
}
