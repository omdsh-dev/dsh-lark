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
 * The `permissions` projection the host publishes for every session: which
 * preset is in force and which ones exist.
 */
export interface PermissionsProjection {
  readonly currentValue?: unknown
  readonly options?: readonly {
    readonly value?: unknown
    readonly name?: unknown
    readonly description?: unknown
  }[]
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
 * @param projections - the projection registry, when composed.
 * @param agent - the conversation's live agent.
 * @returns the state, empty where nothing published one.
 */
export function readPresets(
  projections: HostSessionProjections | undefined,
  agent: HostAgent | undefined,
  presets?: HostPermissionPresets | undefined,
): PresetState {
  if (projections === undefined || agent === undefined) return { available: [] }
  let value: PermissionsProjection | undefined
  try {
    value = projections.snapshot(agent.session).values.permissions as PermissionsProjection | undefined
  } catch {
    // A projection that cannot be read leaves the card with nothing to claim,
    // which is the honest state — not a guess about someone's permissions.
    return { available: [] }
  }
  if (value === undefined) return { available: [] }
  const current = typeof value.currentValue === 'string' ? value.currentValue : undefined
  const available = (value.options ?? [])
    .map(option => readOption(option))
    .filter((option): option is PresetOption => option !== undefined)
    .map(option => withSpec(option, presets))
  return { ...current === undefined || current === '' ? {} : { current }, available }
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
