/**
 * The permission preset, as a thing a chat can see and change.
 *
 * The host owns both knobs — how far the sandbox lets a command reach, and
 * whether an action that needs approval gets to ask — and pairs them into
 * named presets switched by `/permission <name>`. The command already takes
 * that argument; a chat could always switch, it just had to know the name and
 * type it. So this module is not new capability, it is the same capability
 * with a surface: read the current preset, offer the others, and switch by
 * running the host's own command.
 *
 * One property of the shipped table has to reach the person pressing the
 * button. `danger-full-access` is not only "stop confining" — it also sets the
 * approval policy to `never`, and `never` means an action that still needs
 * approval is REFUSED rather than waved through. Someone who reads the name as
 * "allow everything" would be half right and half wrong, which is the worst
 * way to be wrong about a permission.
 * @module dsh-lark-channel/permission
 */

import type { HostAgent, HostCommands, HostPermissionPresets, HostSessionProjections } from './host.ts'
import type { ConversationSubject } from './session.ts'

/**
 * The `permissions` projection the host publishes for every session.
 *
 * Two shapes reach this module, and a version that only knew one of them read
 * "unknown" on the other: hosts publish either the folded session state
 * (`preset`/`sandbox`/`approval`, what the log committed) or its wire view
 * (`currentValue`, the derived answer a remote client renders). Both are read.
 * `options` is the older third shape, kept because a deployment that still
 * publishes it is a deployment whose list is authoritative.
 */
export interface PermissionsProjection {
  /** Wire view: the preset the session derives right now. */
  readonly currentValue?: unknown
  /** Folded state: the last `permission/preset` the log committed, before derivation. */
  readonly preset?: unknown
  /** Folded state: last committed sandbox mode, before the composition default. */
  readonly sandbox?: unknown
  /** Folded state: last committed approval policy, before the composition default. */
  readonly approval?: unknown
  readonly options?: readonly {
    readonly value?: unknown
    readonly name?: unknown
    readonly description?: unknown
  }[]
}

/**
 * This channel's own names for the presets the product ships, in both
 * languages a card can carry.
 *
 * The host's table carries a display label, but the shipped entries label
 * themselves with their own key (`workspace-write`), and a chat reading
 * `read-only · read-only` has been told nothing. A deployment that sets an
 * explicit label keeps it: this map only fills in where the host offered none.
 */
export const PRESET_LABELS: Readonly<Record<string, { readonly zh: string; readonly en: string }>> = {
  'read-only': { zh: '仅可查看', en: 'Read Only' },
  'workspace-write': { zh: '工作区内修改', en: 'Workspace Write' },
  'danger-full-access': { zh: '完全权限', en: 'Full Access' },
  auto: { zh: '自动审查', en: 'Auto Review' },
  custom: { zh: '自定义', en: 'Custom' },
}

/** The derived state of knobs that match no available preset; never switchable. */
export const CUSTOM_PRESET = 'custom'

/**
 * How one preset is called in a chat, as one string: the deployment's own
 * label when it set one, this channel's Chinese name for a shipped preset, and
 * the raw key otherwise.
 * @param value - the preset key `/permission` takes.
 * @param name - the label the host published, when it published one.
 * @returns the human name to put in a plain-text message.
 */
export function presetLabel(value: string, name?: string | undefined): string {
  if (typeof name === 'string' && name !== '' && name !== value) return name
  return PRESET_LABELS[value]?.zh ?? value
}

/**
 * The same name for a card, where a translated string must carry its English
 * form rather than borrow the Chinese one.
 * @param value - the preset key.
 * @param name - the label the host published, when it published one.
 * @returns this channel's bilingual label, or the deployment's own string.
 */
export function presetLabelCopy(
  value: string,
  name?: string | undefined,
): { readonly zh: string; readonly en: string } | string {
  if (typeof name === 'string' && name !== '' && name !== value) return name
  return PRESET_LABELS[value] ?? value
}

/**
 * One preset a deployment offers, as the host describes it.
 *
 * The host names and explains its own presets, including ones a deployment
 * added. Keeping only the value would leave a card able to explain exactly the
 * two names this plugin happens to hardcode.
 */
export interface PresetOption {
  /** The name `/permission` takes, and what a button carries. */
  readonly value: string
  /** What to show a reader; the value itself when the host offered no other. */
  readonly name: string
  /** The host's own explanation, when it published one. */
  readonly description?: string | undefined
  /**
   * What the preset actually does, from the deployment's own table.
   *
   * Carried so that what a card SAYS and what this channel ENFORCES read the
   * same source. A deployment defines its own table: a preset called
   * `workspace-write` can be unconfined underneath, and a card that described
   * it from the name would be asking someone to authorize one thing while
   * granting another — in the one place where that is least acceptable, a
   * consent screen. Absent when the table cannot be read.
   */
  readonly sandbox?: string | undefined
  readonly approval?: string | undefined
}

/** The host command that switches presets. Channel-driven, host-owned. */
export const PERMISSION_COMMAND = 'permission'

/** Marks this plugin's preset buttons apart from other card actions. */
export const PERMISSION_ACTION = 'dsh-lark-channel/permission'

/** The preset this channel treats as the loud one, whatever else a deployment defines. */
export const UNCONFINED_PRESET = 'danger-full-access'

/** What one conversation's presets look like right now. */
export interface PresetState {
  /** The preset in force, when the host reported one. */
  readonly current?: string | undefined
  /** Every preset this deployment offers, in the host's own order. */
  readonly available: readonly PresetOption[]
}

/**
 * Whether switching to one preset loosens what the conversation may reach.
 *
 * The one asymmetry this channel's authorization rests on: taking the sandbox
 * off is a grant, and putting it back on is not. A rule that gated both the
 * same way would stop an ordinary member from making their own conversation
 * SAFER, which is the wrong thing to make hard.
 *
 * Judged by what the preset DOES, not by what it is called. A deployment
 * defines its own table — `unrestricted-prod: { sandbox: danger-full-access,
 * approval: never }` is a preset a name check would wave straight through — so
 * the knobs decide: removing the confinement or removing the asking is a
 * grant. Where the table cannot be read the answer is yes, because "I could
 * not tell" is not a reason to skip an approver.
 * @param preset - the preset being switched to.
 * @param presets - the deployment's preset table, when composed.
 * @returns true when the switch removes confinement or stops the asking.
 */
export function loosensSandbox(preset: string, presets: HostPermissionPresets | undefined): boolean {
  if (presets === undefined) return true
  try {
    const spec = presets.resolve(preset)
    return spec.sandbox === UNCONFINED_SANDBOX || spec.approval === NEVER_ASK
  } catch {
    // An unknown name is not a safe name.
    return true
  }
}

/** The sandbox mode that confines nothing; the host's own `SandboxMode` value. */
const UNCONFINED_SANDBOX = 'danger-full-access'

/** The approval policy that stops asking; the host's own `ApprovalPolicy` value. */
const NEVER_ASK = 'never'

/**
 * Read one preset option out of the projection's untyped payload.
 * @param option - one entry of the projection's option list.
 * @returns the option, or undefined for a shape this does not recognize.
 */
function readOption(option: {
  readonly value?: unknown
  readonly name?: unknown
  readonly description?: unknown
}): PresetOption | undefined {
  const value = [option.value, option.name].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate !== '',
  )
  if (value === undefined) return undefined
  const name = typeof option.name === 'string' && option.name !== '' ? option.name : value
  const description = typeof option.description === 'string' && option.description !== ''
    ? option.description
    : undefined
  return { value, name, ...description === undefined ? {} : { description } }
}

/**
 * Attach what one preset actually does, when the deployment's table can be
 * read. A table that cannot be read leaves the option as the projection
 * described it, and every consumer treats "unknown" as its own caution.
 * @param option - the option as published.
 * @param presets - the deployment's preset table, when composed.
 * @returns the option, with its knobs when they are knowable.
 */
function withSpec(option: PresetOption, presets: HostPermissionPresets | undefined): PresetOption {
  if (presets === undefined) return option
  try {
    const spec = presets.resolve(option.value)
    return { ...option, sandbox: spec.sandbox, approval: spec.approval }
  } catch {
    return option
  }
}

/**
 * Whether one preset both removes the sandbox and stops the asking — the two
 * things this channel's loudest copy promises, and the pair a button that
 * offers to "stop asking" must actually deliver.
 * @param option - the option to judge, as read.
 * @returns true only when the deployment's table says both.
 */
export function isUnconfined(option: PresetOption | undefined): boolean {
  return option?.sandbox === UNCONFINED_SANDBOX && option.approval === NEVER_ASK
}

/**
 * Card payload carried by one preset button.
 *
 * It names the CONVERSATION, not just the chat. A chat outlives its sessions —
 * `/new` and `/cd` each move it onto a different session id, and the ones it
 * left behind stay in the bridge's tables — so a click that carries only a
 * chat id has to guess which of them it meant. The conversation key is the
 * thing that survives all of it: the live session is derived from it, the same
 * way every message does.
 */
export interface PermissionActionValue extends ConversationSubject {
  readonly kind: typeof PERMISSION_ACTION
  /** The preset to switch to. */
  readonly preset: string
}

/**
 * Narrow an arbitrary card-action value to this module's payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function permissionActionValue(value: unknown): PermissionActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== PERMISSION_ACTION) return undefined
  if (typeof record.preset !== 'string' || record.preset === '') return undefined
  if (typeof record.key !== 'string' || record.key === '') return undefined
  if (typeof record.chatId !== 'string' || typeof record.chatType !== 'string') return undefined
  if (record.owner !== undefined && typeof record.owner !== 'string') return undefined
  return {
    kind: PERMISSION_ACTION,
    preset: record.preset,
    key: record.key,
    chatId: record.chatId,
    chatType: record.chatType,
    ...record.owner === undefined ? {} : { owner: record.owner },
  }
}

/**
 * One preset the deployment's table offers, read without trusting the
 * projection to have published it.
 * @param name - the preset key.
 * @param presets - the deployment's table.
 * @returns the option, labelled as the host labelled it.
 */
function optionFromTable(name: string, presets: HostPermissionPresets): PresetOption {
  let spec: ReturnType<HostPermissionPresets['resolve']>
  try {
    spec = presets.resolve(name)
  } catch {
    return { value: name, name }
  }
  return {
    value: name,
    name: spec.name ?? name,
    ...spec.description === undefined || spec.description === '' ? {} : { description: spec.description },
    sandbox: spec.sandbox,
    approval: spec.approval,
  }
}

/**
 * Every preset the deployment can switch to, in the table's own order.
 *
 * The projection publishes what is IN FORCE, not what is OFFERED: in the
 * current host the folded state carries no list at all, so a reader that only
 * looks there shows an empty picker beside a working command. The table is the
 * authority for the offer, and it is the same source `/permission` validates
 * against.
 * @param presets - the deployment's table, when composed.
 * @returns the offered presets, empty when no table is readable.
 */
function tableOptions(presets: HostPermissionPresets | undefined): PresetOption[] {
  if (presets === undefined) return []
  try {
    return presets.names.map(name => optionFromTable(name, presets))
  } catch {
    return []
  }
}

/**
 * Read which preset one conversation runs under.
 *
 * Through the host's own `permissions` projection, for three reasons that the
 * first two attempts each missed. It is a READ: running `/permission` to find
 * out appends `command/run` and `command/done` to the session log, which made
 * a status card a second writer beside the agent's. It is CHEAP: a projection
 * is folded incrementally and cached, while folding the log per read costs the
 * whole log every time a card is drawn. And it is PUBLISHED: the projection
 * carries a registered schema, unlike a service method or a sentence meant for
 * a human to read.
 *
 * What is IN FORCE and what is OFFERED come from different places, and a
 * reader that confused them showed an empty picker beside a working command:
 * the projection publishes the value only, while the deployment's table is what
 * `/permission` accepts. Both are read here, and either shape of the value is
 * understood.
 * @param projections - the projection registry, when composed.
 * @param agent - the conversation's live agent.
 * @param presets - the deployment's preset table, when composed.
 * @returns the state, empty where nothing published one and no table exists.
 */
export function readPresets(
  projections: HostSessionProjections | undefined,
  agent: HostAgent | undefined,
  presets?: HostPermissionPresets | undefined,
): PresetState {
  const offered = tableOptions(presets)
  if (projections === undefined || agent === undefined) return { available: offered }
  let value: PermissionsProjection | undefined
  try {
    value = projections.snapshot(agent.session).values.permissions as PermissionsProjection | undefined
  } catch {
    // A projection that cannot be read leaves the card with nothing to claim
    // about the CURRENT preset, while the offer still stands: the table is not
    // behind this failure.
    return { available: offered }
  }
  if (value === undefined) return { available: offered }
  const published = (value.options ?? [])
    .map(option => readOption(option))
    .filter((option): option is PresetOption => option !== undefined)
    .map(option => withSpec(option, presets))
  // The table decides what can be switched, so it decides what is offered: a
  // projection that lists a subset describes the sessions it looked at, not the
  // presets this deployment accepts.
  const available = offered.length > 0 ? offered : published
  const current = currentOf(value, agent, presets, available)
  return { ...current === undefined ? {} : { current }, available }
}

/**
 * Which preset the session is actually on, from whichever shape the host
 * published and, failing both, from the knobs it committed.
 * @param value - the projection value.
 * @param agent - the conversation's agent.
 * @param presets - the deployment's table.
 * @param available - the presets this deployment offers.
 * @returns the preset in force, or undefined when nothing can be said.
 */
function currentOf(
  value: PermissionsProjection,
  agent: HostAgent,
  presets: HostPermissionPresets | undefined,
  available: readonly PresetOption[],
): string | undefined {
  // The wire view is already derived, so it wins where it exists.
  if (typeof value.currentValue === 'string' && value.currentValue !== '') return value.currentValue
  // The folded state records the last selection; a session that never made one
  // has null here and is derived below.
  if (typeof value.preset === 'string' && value.preset !== '') return value.preset
  // The host derives it itself, ties between two names on one bundle included.
  if (presets?.current !== undefined) {
    try {
      const derived = presets.current(agent.session)
      if (typeof derived === 'string' && derived !== '') return derived
    } catch {
      // A reader that is not ready is a reader that cannot answer yet.
    }
  }
  const sandbox = typeof value.sandbox === 'string' ? value.sandbox : undefined
  const approval = typeof value.approval === 'string' ? value.approval : undefined
  if (sandbox === undefined && approval === undefined) return undefined
  // Least authoritative, still better than silence: match the committed knobs
  // against the table, which is how the host derives it too. Committed knobs
  // that match no preset are the host's own `custom`, not "unknown": the
  // session IS on something, just not on a name this table offers.
  const matched = available.find(option =>
    (sandbox === undefined || option.sandbox === sandbox)
    && (approval === undefined || option.approval === approval)
    && option.sandbox !== undefined
    && option.approval !== undefined)
  return matched?.value ?? CUSTOM_PRESET
}

/**
 * Switch one conversation to a preset, through the host's own command.
 * @param agent - the conversation's live agent.
 * @param commands - the host command runtime, when composed.
 * @param preset - the preset name to switch to.
 * @param signal - cancellation for the host execution.
 * @returns whether the switch landed, and what the host said about it.
 */
export async function switchPreset(
  agent: HostAgent,
  commands: HostCommands | undefined,
  preset: string,
  signal: AbortSignal,
): Promise<{ readonly ok: boolean; readonly detail?: string }> {
  if (commands === undefined) return { ok: false, detail: 'no command runtime is composed' }
  const execution = await commands
    .execute(agent, `/${PERMISSION_COMMAND} ${preset}`, signal)
    .catch((error: unknown) => {
      // A cancelled command is not a failed one, and flattening the two here
      // is invisible from the outside: the caller would see an ordinary
      // failure and tell the chat the switch failed, naming whatever the
      // abort happened to throw — for a conversation that simply moved on.
      // Whoever aborted said why in the signal's reason; that survives.
      if (signal.aborted) throw signal.reason
      return { result: { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) } }
    })
  if (execution === undefined) return { ok: false, detail: 'the host does not offer /permission' }
  const result = execution.result
  return result.kind === 'error'
    ? { ok: false, ...result.text === undefined ? {} : { detail: result.text } }
    : { ok: true, ...result.text === undefined ? {} : { detail: result.text } }
}

/**
 * The sandbox mode one tool call asked to be raised to, read from the exact
 * arguments the call carried.
 *
 * The host's approval request names the tool and the reason but not the
 * escalation — that travels in the call's own `sandbox_permissions` argument,
 * which this channel already snapshots at ask time. Reading it there is how
 * the card can say what is actually being granted.
 * @param callArguments - the snapshotted arguments, as the model produced them.
 * @returns the requested mode, or undefined when the call asked for none.
 */
export function requestedEscalation(callArguments: string | undefined): string | undefined {
  if (callArguments === undefined || callArguments === '') return undefined
  try {
    const parsed = JSON.parse(callArguments) as { sandbox_permissions?: unknown }
    const mode = parsed.sandbox_permissions
    return typeof mode === 'string' && mode !== '' ? mode : undefined
  } catch {
    return undefined
  }
}
