/**
 * The approval panel this channel's conversations render in the Web composer.
 *
 * It presents the same decision the shipped panel does, plus one state that one
 * cannot reach: a request the log shows was already settled by another surface
 * — the Feishu chat, in the deployment this was built for. That request's panel
 * has stopped deciding anything, so this one says so and settles it instead of
 * waiting for a press that would be discarded.
 *
 * The panel is the TEMPORARY half of a two-surface approval; see the plugin
 * entry for why the durable fix belongs in the gateway.
 * @module dsh-lark-channel/client/ApprovalPanel
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AnswerablePending, PanelFace, PanelTarget } from './panel-store.ts'
import { asPendingApproval, retirementFor, settledForTarget } from './panel-store.ts'
import type { SettledApproval } from './decisions.ts'
import type { UseSessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import { commandForCall } from './approval-command.ts'
import type { DisplayReason } from './panel-store.ts'
import css from './ApprovalPanel.module.css'

/** The framework seats this panel reads. */
export interface LarkApprovalPanelProps {
  /** Selector-matched request, from the chain entry's `select`. */
  readonly matched: PanelTarget
  /** Live settled-approval reads. */
  readonly panel: PanelFace
  /** The Client's pending-interaction status seat. */
  readonly useSessionStatus: UseSessionStatus
  /** The Chat store seat, which resolves the correlated Tool call's command. */
  readonly useChat: UseChat
  /** Panel copy. */
  readonly t: PropsLocale<'larkApproval'>['t']
}

/**
 * The live reads this registration hands its own component.
 *
 * `hooks` is the registrant-private compartment: the renderer binds each bare
 * observable to a `use<Name>` selector hook, so the component subscribes
 * through the framework instead of holding a subscription of its own.
 */
export interface LarkApprovalInjected {
  readonly panel: PanelFace
  /** Resolve the asker's localized reason into the active UI language. */
  readonly resolveReason: (reason: DisplayReason) => string
  readonly hooks: {
    readonly larkSettled: HostObservable<readonly SettledApproval[]>
  }
}

/**
 * Present one approval on a conversation this channel drives.
 *
 * The pending request, the settled fold, and the correlated command are all
 * read through framework seats rather than handed in: `select` must stay a pure
 * function of the owner props, so every live read reaches the component through
 * a hook the slot composes onto it.
 * @param props - matched request, live reads, and the locale seat.
 * @returns the approval composer takeover.
 */
export function ApprovalPanel(props: LarkApprovalPanelProps & InjectFace<LarkApprovalInjected>) {
  const settled = props.useLarkSettled((all: readonly SettledApproval[]) => all)
  const pending = props.useSessionStatus((snapshot: SessionStatusSnapshot) =>
    asPendingApproval(snapshot.get(props.matched.sessionId)?.pendingInteraction))
  const callId = props.matched.callId
  // The command comes from the Chat store, the same source the shipped detail
  // renders from. A person approving a shell call has to see what they are
  // approving — an escalation granted without the command is a press that
  // decides nothing knowable.
  const command = props.useChat((snapshot: ChatSnapshot) => commandForCall(snapshot, callId))
  // The asker's own explanation outranks this plugin's generic sentence, on the
  // same terms the shipped panel uses: it is the only text that says what this
  // particular request is for.
  const { displayReason, reason: plainReason } = props.matched
  const reason = displayReason === undefined ? plainReason : props.resolveReason(displayReason)
  const settledHere = settledForTarget(settled, props.matched)
  // Latched, never derived. Retiring the request records it in the very set the
  // fold subtracts, so a state derived from that fold holds "decided elsewhere"
  // for exactly one render and then reverts to a card that looks live again —
  // the leftover this panel exists to remove. The latch keeps the presentation
  // and the recorded decision for as long as this panel is mounted on the
  // request, whatever the fold reports afterwards.
  const [decidedElsewhere, setDecidedElsewhere] = useState<readonly SettledApproval[]>([])
  useEffect(() => {
    if (settledHere.length === 0) return
    setDecidedElsewhere(current => current.length === 0 ? settledHere : current)
  }, [settledHere.length])
  return (
    <PanelFlow
      key={callId ?? props.matched.toolName}
      matched={props.matched}
      panel={props.panel}
      pending={pending}
      decidedElsewhere={decidedElsewhere}
      command={command}
      reason={reason}
      t={props.t}
    />
  )
}

function PanelFlow({ matched, panel, pending, decidedElsewhere, command, reason, t }: {
  readonly matched: PanelTarget
  readonly panel: PanelFace
  readonly pending: AnswerablePending | undefined
  readonly decidedElsewhere: readonly SettledApproval[]
  readonly command: string | undefined
  readonly reason: string | undefined
  readonly t: PropsLocale<'larkApproval'>['t']
}) {
  const [answered, setAnswered] = useState(false)
  const waiting = useRef(false)
  const active = useRef(true)
  const composing = useRef(false)
  const compositionEnded = useRef(false)
  /** Whether this mount already recorded the elsewhere decision. */
  const retired = useRef(false)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  const settledElsewhere = decidedElsewhere.length > 0
  // What the log recorded, when it is one of the two outcomes this panel has a
  // control for; the fail-closed rest close the copy without submitting.
  const recordedOutcome = decidedElsewhere[0]?.outcome
  const inert = answered || settledElsewhere

  /**
   * Retire the request the log shows was already decided, so the panel the chat
   * left behind does not stand waiting for a press that can no longer change
   * anything.
   *
   * Each settled request is recorded against its own log identity, which is what
   * removes it from the fold. The outcome submitted here is the one the log
   * recorded, not a value of this panel's choosing: the channel's listener
   * already returned the real decision to the Host, so what this closes is this
   * page's copy — and a copy closed with the decision that was actually taken
   * cannot misreport it. The ref keeps that submission to one per mount.
   */
  useEffect(() => {
    if (retired.current) return
    const retire = retirementFor(decidedElsewhere, pending)
    if (retire.length === 0) return
    retired.current = true
    for (const requestId of retire) panel.markAnsweredHere(matched.sessionId, requestId)
    if (recordedOutcome === undefined) return
    void pending?.answer(recordedOutcome).catch(() => {})
  }, [decidedElsewhere, recordedOutcome, pending, panel, matched.sessionId])

  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    if (inert || waiting.current || pending === undefined || !pending.answerable) return
    waiting.current = true
    setAnswered(true)
    for (const approval of decidedElsewhere) panel.markAnsweredHere(matched.sessionId, approval.id)
    void pending.answer(outcome).catch(() => {
      if (!active.current) return
      waiting.current = false
      setAnswered(false)
    })
  }

  const keydown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // A settled panel takes no keyboard decision either: the buttons are
    // disabled, and Enter on a panel that says "decided elsewhere" would
    // otherwise submit one.
    if (inert) return
    const element = event.target as Element
    if (event.defaultPrevented || !event.currentTarget.contains(document.activeElement)
      || element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null) return
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    if (event.key === 'Enter' && element.closest('button, a[href], [role="button"]') !== null) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
    if (event.repeat || composing.current || compositionEnded.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    answer(event.key === 'Enter' ? 'allowed-once' : 'rejected')
  }

  return (
    <div className={css.root} data-approval-key={matched.key} aria-busy={inert}
      onKeyDown={keydown}
      onKeyUpCapture={() => { compositionEnded.current = false }}
      onCompositionStartCapture={() => { composing.current = true }}
      onCompositionEndCapture={() => { composing.current = false; compositionEnded.current = true }}>
      <div className={css.card}>
        <div className={`${css.strip}${settledElsewhere ? ` ${css.stripSettled}` : ''}`}>
          <StateDot state={settledElsewhere ? 'done' : answered ? 'ongoing' : 'warning'} />
          {settledElsewhere ? t('decidedElsewhere') : t('waiting')}
        </div>
        <div className={css.body} data-approval-scroll tabIndex={0} role="group" aria-label={t('detail.aria')}>
          <div className={css.headline}>
            {reason ?? t('escalation', { toolName: matched.toolName })}
          </div>
          {command !== undefined && <div className={css.command}>{command}</div>}
        </div>
        <div className={css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={inert} onClick={() => { answer('rejected') }}>
            {t('reject')}
          </Button>
          <Button variant="primary" disabled={inert} onClick={() => { answer('allowed-once') }}>
            {t('allowOnce')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Full props of this panel's registration, for tests and the register site. */
export type LarkApprovalPanelFullProps =
  PropsRuntime<'conversation.composer'>
  & { readonly matched: PanelTarget }
  & PropsLocale<'larkApproval'>
