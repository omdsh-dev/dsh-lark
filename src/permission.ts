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
 * It carries the preset IN FORCE and nothing else: the host's own view is
 * `{ currentValue }`, and the list of presets a deployment offers lives on the
 * `permissionPresets` table instead. A card that read its rows from here would
 * therefore offer no button at all, which is why only the current value is read
 * off this projection.
 */
export interface PermissionsProjection {
  readonly currentValue?: unknown
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
    // The deployment's own list first, then the bundle. `resolve` alone is not
    // enough: it reads a name out of a record, so a name the table never listed
    // can still resolve through the prototype chain — and such a spec carries no
    // knobs, which reads as "does not loosen" and skips the approver this
    // function exists to require. The host's own command rejects those names, so
    // nothing is granted today; asking the list first is what keeps this gate
    // and that command answering the same question the same way.
    if (!presets.names.includes(preset)) return true
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
 * Every preset this deployment offers, read from its own table.
 *
 * The table is the same source every authorization decision here reads
 * (`resolve`), so what a card OFFERS and what a switch ENFORCES cannot drift,
 * and it is the only source that can list anything at all: the `permissions`
 * projection publishes the preset in force and no options. A name the table
 * lists but will not resolve is still offered, by name alone — the deployment
 * says it has that preset, and an unreadable bundle is not a reason to hide a
 * button; every consumer treats "unknown knobs" as its own caution.
 * @param presets - the deployment's preset table, when composed.
 * @returns the rows a picker may draw, in the table's declaration order.
 */
function presetRows(presets: HostPermissionPresets | undefined): PresetOption[] {
  if (presets === undefined) return []
  let names: readonly string[]
  try {
    names = presets.names
  } catch {
    // The table refuses to list itself (a default preset it cannot resolve, in
    // the host's own implementation): offering nothing is the honest read.
    return []
  }
  return names.map((value): PresetOption => {
    try {
      const spec = presets.resolve(value)
      const name = typeof spec.name === 'string' && spec.name !== '' ? spec.name : value
      const description = typeof spec.description === 'string' && spec.description !== ''
        ? spec.description
        : undefined
      return {
        value,
        name,
        ...description === undefined ? {} : { description },
        sandbox: spec.sandbox,
        approval: spec.approval,
      }
    } catch {
      return { value, name: value }
    }
  })
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
 *
 * Only the CURRENT value comes from the projection. The rows a picker offers
 * come from the deployment's own preset table, which is the one source that
 * lists them and the one every switch is judged against.
 * @param projections - the projection registry, when composed.
 * @param agent - the conversation's live agent.
 * @param presets - the deployment's preset table, when composed.
 * @returns the state, with no rows where no table is composed.
 */
export function readPresets(
  projections: HostSessionProjections | undefined,
  agent: HostAgent | undefined,
  presets?: HostPermissionPresets | undefined,
): PresetState {
  const current = currentPresetOf(projections, agent)
  return {
    ...current === undefined ? {} : { current },
    available: presetRows(presets),
  }
}

/**
 * The preset one conversation is running under, as the projection published it.
 * @param projections - the projection registry, when composed.
 * @param agent - the conversation's live agent.
 * @returns the preset in force, or undefined when nothing published one.
 */
function currentPresetOf(
  projections: HostSessionProjections | undefined,
  agent: HostAgent | undefined,
): string | undefined {
  if (projections === undefined || agent === undefined) return undefined
  let value: PermissionsProjection | undefined
  try {
    value = projections.snapshot(agent.session).values.permissions as PermissionsProjection | undefined
  } catch {
    // A projection that cannot be read leaves the card with nothing to claim,
    // which is the honest state — not a guess about someone's permissions.
    return undefined
  }
  const current = value?.currentValue
  return typeof current === 'string' && current !== '' ? current : undefined
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
    // The host's `execute` takes the attachments a submission carries between
    // the line and the signal. This channel only ever submits a plain
    // invocation, so the array is empty — but it has to be there: passed the
    // signal in that position, the host reads `signal.aborted` off an array.
    .execute(agent, `/${PERMISSION_COMMAND} ${preset}`, [], signal)
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
