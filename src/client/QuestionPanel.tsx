/**
 * The question panel this channel's conversations render in the Web composer.
 *
 * The interaction flow mirrors the shipped question composer: one question per
 * page with a pager, an explicit skip, a dismissal that withdraws a
 * tool-call-keyed panel, a cancel that ends a request nothing could bring back,
 * validation that no question goes unanswered by accident, a countdown the user
 * can freeze, an answer surface that holds the deadline while it has focus,
 * drafts that survive a strict Session entry remount, and the read-only review
 * card a settled call is read back through.
 *
 * On top of that it keeps the one state the shipped panel cannot reach: a
 * request the log shows was already answered by another surface — the Feishu
 * chat, in the deployment this was built for. That request's panel has stopped
 * deciding anything, so this one says so and withdraws itself instead of waiting
 * for a press that would be discarded. The settlement is recognised by the
 * questions it asked, never by recency: a blocking request carries no call id,
 * so the batch's own questions are the only identity the log and the presented
 * request share, and matching on anything looser answers one question with
 * another's answers.
 *
 * The card state (countdown, wait presentation, channel, closed) comes from the
 * request object's own public observable face. The shipped composer reads the
 * same state through its registration's `keyedHooks` seat, which belongs to the
 * package this channel does not depend on; the request object publishes it for
 * exactly this purpose, so the panel reads the source directly rather than
 * taking a second presentation package as a dependency.
 *
 * That direct read is a RECORDED DEVIATION from the client stack's rule that a
 * business component carries no subscription machinery (business data reaches a
 * render through a framework hook or a declared store): `useQuestionCard` is the
 * one `useSyncExternalStore` in this package, it exists because the seat that
 * would replace it lives in a package this one must not value-import, and the
 * alternative — a second presentation package in the dependency list — trades a
 * contained deviation for a wider one. Every other live read here (the settled
 * fold, the drafts) arrives through the registration's `inject` face as the rule
 * requires.
 *
 * Plan reviews stay with the shipped panel: this channel answers plans through
 * its own shadowed tool in the chat, so this entry claims only `question`
 * interactions.
 *
 * The panel is the TEMPORARY half of a two-surface question; see the plugin
 * entry for why the durable fix belongs in the gateway.
 * @module dsh-lark-channel/client/QuestionPanel
 */

import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ChangeEvent, type FocusEvent, type KeyboardEvent,
} from 'react'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular,
  IconEditOutlineRegular, MarkdownText, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AnswerableQuestion, QuestionAnswerItem, QuestionCardState, QuestionFace, QuestionSpec, QuestionTarget, SubmissionGuard } from './question-store.ts'
import { answerBatchOf, asPendingQuestion, createSubmissionGuard, parseRecommendedLabel, recommendedFirstOption, retirementForQuestion } from './question-store.ts'
import type { QuestionDraftAnswer, QuestionDraftProgress, QuestionDraftsFace } from './question-drafts.ts'
import type { SettledQuestion } from './question-decisions.ts'
import type { SessionStatusSnapshot, UseSessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import css from './QuestionPanel.module.css'

/** The framework seats this panel reads. */
export interface LarkQuestionPanelProps {
  /** Selector-matched request, from the chain entry's `select`. */
  readonly matched: QuestionTarget
  /** Live settled-question reads. */
  readonly panel: QuestionFace
  /** Remount-surviving answer drafts. */
  readonly drafts: QuestionDraftsFace
  /** The Client's pending-interaction status seat. */
  readonly useSessionStatus: UseSessionStatus
  /** Panel copy. */
  readonly t: PropsLocale<'larkQuestion'>['t']
}

/**
 * The live reads this registration hands its own component.
 *
 * `hooks` is the registrant-private compartment: the renderer binds each bare
 * observable to a `use<Name>` selector hook, so the component subscribes
 * through the framework instead of holding a subscription of its own.
 */
export interface LarkQuestionInjected {
  readonly panel: QuestionFace
  readonly drafts: QuestionDraftsFace
  readonly hooks: {
    readonly larkQuestionSettled: HostObservable<readonly SettledQuestion[]>
  }
}

/**
 * Displayed feedback: validation feedback is stored as a dictionary KEY and
 * translated at render, so already-shown feedback follows a locale switch;
 * runtime failure messages (finished strings from the wire) pass through
 * verbatim.
 */
type Feedback =
  | { key: 'error.incomplete' | 'error.unanswered' | 'error.unavailable' | 'error.resubmit' | 'status.sent' }
  | { text: string }

/** A card that already left the registry, for a panel still mounted on it. */
const REMOVED_CARD: QuestionCardState = {
  state: 'open', waitState: 'counting', countdown: undefined, channel: 'none', closed: true,
}

/**
 * The question a projection carrying none at all presents.
 *
 * The Host refuses an empty batch (its schema is `.min(1)`), so this is a
 * malformed-projection fallback: rendering one inert card with no text is the
 * honest read of a request that names nothing, and it keeps an index lookup
 * from throwing out of a mounted panel. The card it draws is inert, so nothing
 * can be submitted from it.
 */
const EMPTY_QUESTION: QuestionSpec = { id: '', question: '' }

/** The draft an index that outlived a shrunken batch falls back to. */
const EMPTY_DRAFT: QuestionDraftAnswer = { selected: [], custom: '', skipped: false }

/**
 * Follow the live card state of one request.
 *
 * A request without the observable face (a projection carrying fewer members)
 * reads as a card with no channel, which withdraws the submission affordances
 * instead of inventing a state.
 * @param pending - the request whose card to follow, when one is presented.
 * @returns the current card state.
 */
function useQuestionCard(pending: AnswerableQuestion | undefined): QuestionCardState {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => pending?.subscribe?.(listener) ?? (() => {}),
    [pending],
  )
  const read = useCallback((): QuestionCardState => pending?.getSnapshot?.() ?? REMOVED_CARD, [pending])
  return useSyncExternalStore(subscribe, read, read)
}

/** Return whether a text-field key event belongs to an active IME composition. */
function isComposing(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
  // oxlint-disable-next-line typescript/no-deprecated
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
}

/** The free-text answer field shared by both question variants. */
interface AnswerFieldProps {
  /** Visual variant: the custom row's inline column or the optionless question's framed block. */
  variant: 'inline' | 'block'
  /** Current draft text. */
  value: string
  /** Empty-field prompt. */
  placeholder: string
  /** Whether a submission in flight has frozen the field. */
  disabled: boolean
  /** Whether this field takes focus on mount. */
  autoFocus?: boolean
  /** Called when the field takes focus. */
  onFocus?: () => void
  /** Called with each edit of the draft. */
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  /** Called with each key press, before the browser's own handling. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

/**
 * Auto-growing free-text answer: a textarea, so a long answer soft-wraps and
 * Shift+Enter breaks a line, over a hidden mirror that owns the height.
 *
 * The mirror renders the draft plus a trailing newline in normal flow and so
 * sizes the grid row (counting rows by '\n' cannot see soft wraps); the
 * textarea shares that one cell and stretches to it, and `rows={1}` keeps the
 * control's own intrinsic height out of the row sizing so the mirror alone
 * decides. Past the mirror's cap the textarea scrolls itself — it is the only
 * scrollport in the stack, there being no second glyph layer to keep aligned.
 * Mirror and textarea MUST share font, line-height, padding and wrapping rules
 * or the two heights diverge.
 *
 * @param props - visual variant, draft text, and the field's event handlers.
 * @returns The mirrored auto-growing field.
 */
function AnswerField(props: AnswerFieldProps) {
  const classes = `${css.field} ${props.variant === 'inline' ? css.customInline : css.customBlock}`
  return (
    <div className={classes}>
      <div aria-hidden className={css.fieldMirror}>{`${props.value}\n`}</div>
      <textarea
        autoFocus={props.autoFocus}
        className={css.fieldInput}
        value={props.value}
        disabled={props.disabled}
        rows={1}
        placeholder={props.placeholder}
        onFocus={props.onFocus}
        onChange={props.onChange}
        onKeyDown={props.onKeyDown}
      />
    </div>
  )
}

/**
 * Present one question batch on a conversation this channel drives.
 *
 * The pending request and the settled fold are read through framework seats
 * rather than handed in: `select` must stay a pure function of the owner
 * props, so every live read reaches the component through a hook the slot
 * composes onto it.
 * @param props - matched request, live reads, and the locale seat.
 * @returns the question composer takeover.
 */
export function QuestionPanel(props: LarkQuestionPanelProps & InjectFace<LarkQuestionInjected>) {
  const settled = props.useLarkQuestionSettled((all: readonly SettledQuestion[]) => all)
  const pending = props.useSessionStatus((snapshot: SessionStatusSnapshot) =>
    asPendingQuestion(snapshot.get(props.matched.sessionId)?.pendingInteraction))
  return (
    <PanelFlow
      key={props.matched.key}
      matched={props.matched}
      panel={props.panel}
      drafts={props.drafts}
      pending={pending}
      settled={settled}
      t={props.t}
    />
  )
}

function PanelFlow({ matched, panel, drafts, pending, settled, t }: {
  readonly matched: QuestionTarget
  readonly panel: QuestionFace
  readonly drafts: QuestionDraftsFace
  readonly pending: AnswerableQuestion | undefined
  readonly settled: readonly SettledQuestion[]
  readonly t: PropsLocale<'larkQuestion'>['t']
}) {
  const questions = matched.questions
  // A read-only card built from a settled call's transcript: the same panel
  // over the recorded answers, with nothing left to submit.
  const review = pending?.review
  // Latched, never derived: the retirement further down records the answered
  // request in the same fold this reads from, so a state derived from that fold
  // would show the record for exactly one render and then drop it — leaving a
  // panel that invites a press on a request somebody already answered, and
  // losing the "what was actually answered" the record exists to show. Only the
  // settlement this panel retires is ever latched here: the record it shows is
  // the one the log wrote for THIS request.
  const [answeredElsewhere, setAnsweredElsewhere] = useState<readonly QuestionAnswerItem[] | undefined>(undefined)
  const settledElsewhere = answeredElsewhere !== undefined
  // The log's own record doubles as the display once another surface answered:
  // the card closes showing what was actually answered, never this browser's
  // drafts.
  const record = review ?? answeredElsewhere
  const card = useQuestionCard(pending)
  const canSubmit = card.channel !== 'none'
  const markdownLabels = useMemo(() => ({
    code: {
      copyLabel: t('copy'),
      copiedLabel: t('copied'),
      toolbarLabels: {
        codeLabel: t('codeBlock.title'),
        wrapLabel: t('codeBlock.wrap'),
        unwrapLabel: t('codeBlock.unwrap'),
      },
    },
    footnotes: t('markdown.footnotes'),
  }), [t])
  // Recorded answers echo the question ids rather than their order; a recorded
  // answer with no selection and no custom text was skipped.
  const recordDrafts = useMemo<QuestionDraftAnswer[]>(() => {
    if (record === undefined) return []
    const recorded = new Map(record.map(answer => [answer.id, answer]))
    return questions.map((item) => {
      const answer = recorded.get(item.id)
      const custom = answer?.custom ?? ''
      return {
        selected: [...answer?.selected ?? []],
        custom,
        skipped: answer !== undefined && answer.selected.length === 0 && custom === '',
      }
    })
  }, [questions, record])
  // A marked first choice is an implicit draft on a live card, and nothing at
  // all on a card showing a record, whose answer is already known.
  const initialDrafts = useMemo<QuestionDraftAnswer[]>(() => questions.map((item) => {
    const recommended = record === undefined ? recommendedFirstOption(item) : undefined
    return { selected: recommended === undefined ? [] : [recommended], custom: '', skipped: false }
  }), [questions, record])
  const stored = drafts.read(matched.sessionId, matched.key, questions.length)
  // A card holding a record renders the record itself, so a draft its live
  // incarnation left behind can never surface as an answer; only the page
  // position is restored.
  const storedProgress = record === undefined ? stored : undefined
  const restoredWait = storedProgress?.wait
    ?? (storedProgress?.drafts.some((item, itemIndex) =>
      item.selected.length !== initialDrafts[itemIndex]?.selected.length
      || item.selected.some((label, labelIndex) => label !== initialDrafts[itemIndex]?.selected[labelIndex])
      || item.custom !== '' || item.skipped) === true
      ? 'editing' : undefined)
  const [progress, setProgress] = useState<QuestionDraftProgress>(() => ({
    index: stored?.index ?? 0,
    drafts: storedProgress?.drafts ?? initialDrafts,
    ...(restoredWait === undefined ? {} : { wait: restoredWait }),
  }))
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState<Feedback | null>(null)
  // Collapsed to the header strip so the conversation above stays readable
  // while the user decides; answer drafts live in the per-apply registry.
  const [minimized, setMinimized] = useState(false)
  // The free-form textarea autofocuses on first presentation; re-expanding a
  // collapsed question must not steal focus from the expand toggle back into
  // the input, so focus is granted once per question index.
  const focusedQuestions = useRef(new Set<number>())
  const answerSurface = useRef<HTMLDivElement>(null)
  const active = useRef(true)
  // A waterfall submission is only "sent": the gateway drops an outcome that
  // arrives after another Client settled the event, without telling anyone. The
  // draft therefore survives until the projection closes the card, and a card
  // that flips to continued while a submission is in flight re-arms the
  // controls so the same draft can go through the Remote path.
  const sentVia = useRef<'waterfall' | null>(null)
  // The user's own wait decision, re-applied to the request on mount: the card
  // owns the countdown, so a remounted panel must tell it what the user chose.
  const waitDisposition = useRef<'editing' | 'waiting' | undefined>(restoredWait)
  /** Whether this mount already recorded the elsewhere answer. */
  const retired = useRef(false)
  /**
   * This mount's in-flight submission, created once.
   *
   * The guard holds both halves of the panel's submit discipline: one submission
   * at a time, and the re-arm that releases it when a dropped waterfall answer
   * leaves the draft to be sent again. See {@link SubmissionGuard}.
   */
  const submission = useRef<SubmissionGuard | undefined>(undefined)
  const guard = (submission.current ??= createSubmissionGuard())
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  /**
   * Retire the request the log shows was already answered, so the panel the
   * chat left behind does not stand waiting for a press that can no longer
   * change anything.
   *
   * The settlement is correlated with the questions THIS panel presents, never
   * with recency: the fold reports every settled call, and only the one that
   * asked this same batch can answer it. A settlement for another batch is
   * therefore left alone — it is not this request's answer, and retiring it
   * would both close this panel over somebody else's question and submit that
   * question's answers here. That is also why this mount is retired only once
   * the withdrawal below has actually gone through: an unmatched fold, and a
   * card that could not be settled yet, must not consume it.
   *
   * The batch submitted here is the one the log recorded, so the panel's own
   * copy closes showing what was actually answered — and submitting it is what
   * withdraws that copy, because the request it settles is the one the Host
   * already finished and the outcome is dropped there. A card whose channel is
   * gone cannot be settled, so the withdrawal falls back to the dismissal the
   * card offers, and a card that refuses both says so rather than standing
   * there as if it were still waiting for a press.
   */
  useEffect(() => {
    if (retired.current) return
    const retire = retirementForQuestion(settled, questions, pending)
    if (retire === undefined) return
    // The record shows while the withdrawal is in flight, so the panel stops
    // inviting a press the moment the log says somebody else answered.
    setAnsweredElsewhere(retire.answers)
    // Only a withdrawal that went through retires this mount, and the log entry
    // stays in the fold until then: a card that could not be settled yet is
    // retried the next time the fold moves instead of standing there forever.
    const withdrawn = (): void => {
      retired.current = true
      panel.markAnsweredHere(matched.sessionId, retire.callId)
    }
    void pending?.answer({ answers: retire.answers }).then(withdrawn, () =>
      pending?.dismiss?.().then(withdrawn, () => { setError({ key: 'error.unavailable' }) }))
  }, [settled, questions, pending, panel, matched.sessionId])

  useEffect(() => {
    if (waitDisposition.current === 'waiting') pending?.takeTime?.()
    if (waitDisposition.current === 'editing') pending?.engage?.()
  }, [pending])

  // A closed card has nothing left to answer: its draft must not surface as an
  // answer for the next request that reuses the seat.
  useEffect(() => {
    if (card.closed) drafts.clear(matched.sessionId, matched.key)
  }, [card.closed, drafts, matched.sessionId, matched.key])

  // Drafts of requests this Session no longer presents are stale by definition;
  // the request object knows which sibling cards are still live. Only THIS
  // Session's drafts are reconciled: the registry is shared by every
  // conversation the Client renders, and a keep-set from one Session would
  // otherwise delete another's typed answers.
  useEffect(() => {
    const live = pending?.liveKeys?.()
    if (live !== undefined) drafts.prune(matched.sessionId, live)
  }, [drafts, pending, matched.sessionId])

  useEffect(() => {
    if (sentVia.current !== 'waterfall' || card.state !== 'continued') return
    sentVia.current = null
    // The guard is released with the controls it guards: a waterfall submission
    // that resolved was still dropped, and this re-arm is the panel asking for
    // the same draft again — a guard left set would make the button it just
    // enabled do nothing at all, silently. Releasing it retires the token of the
    // dropped submission, so whatever that one reports later cannot clear or
    // block the retry this re-arm admits.
    guard.rearm()
    setBusy(null)
    setError({ key: 'error.resubmit' })
  }, [card.state, guard])

  // The countdown belongs to the carrier, not to this component: the user can
  // hide the panel and reopen it from the tool call row, and a timer that died
  // with the mount would leave the tool call waiting past its deadline.
  const countdown = card.countdown
  // A card holding a record renders the record, not this browser's drafts.
  const shownDrafts = record === undefined ? progress.drafts : recordDrafts
  // Both lookups are total. A projection that carries no question, or a stored
  // index that outlived a shrunken batch, must render rather than throw out of
  // a mounted panel; the empty-question case renders inert below, so nothing
  // can be submitted from it either.
  const question = questions[progress.index] ?? questions[0] ?? EMPTY_QUESTION
  const draft = shownDrafts[progress.index] ?? shownDrafts[0] ?? EMPTY_DRAFT
  const hasOptions = (question.options?.length ?? 0) > 0
  // A card holding a record has nothing left to answer, and a submission in
  // flight freezes the surface; the request itself may also be absent on a
  // projection that lost it, and a batch with no questions has nothing to send.
  const readOnly = record !== undefined
  const inert = questions.length === 0 || readOnly || busy !== null || settledElsewhere || pending === undefined

  const replaceProgress = (nextIndex: number, nextDrafts: QuestionDraftAnswer[]): void => {
    const next: QuestionDraftProgress = {
      index: nextIndex,
      drafts: nextDrafts,
      ...(waitDisposition.current === undefined ? {} : { wait: waitDisposition.current }),
    }
    setProgress(next)
    drafts.replace(matched.sessionId, matched.key, next)
    setError(null)
  }

  /** Freeze the request's countdown for as long as the user needs. */
  const takeTime = (): void => {
    waitDisposition.current = 'waiting'
    pending?.takeTime?.()
    replaceProgress(progress.index, progress.drafts)
  }

  /** Keep the first edited draft answerable without a foreground deadline. */
  const engage = (): void => {
    if (waitDisposition.current !== undefined) return
    waitDisposition.current = 'editing'
    pending?.engage?.()
  }

  const focusAnswerSurface = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) pending?.holdFocus?.()
  }

  const blurAnswerSurface = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) pending?.releaseFocus?.()
  }

  // Focus, a hidden window and a switched-away tab all change what "the user is
  // deciding right now" means; the card is told, so its deadline follows the
  // person rather than the panel's mount.
  useEffect(() => {
    const release = (): void => { pending?.releaseFocus?.() }
    const refocus = (): void => {
      if (waitDisposition.current === 'editing') {
        pending?.engage?.()
        return
      }
      if (answerSurface.current?.contains(document.activeElement) === true) pending?.holdFocus?.()
    }
    const visibilityChanged = (): void => { if (document.hidden) release(); else refocus() }
    window.addEventListener('blur', release)
    window.addEventListener('focus', refocus)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      release()
      window.removeEventListener('blur', release)
      window.removeEventListener('focus', refocus)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [pending])

  /**
   * Close the panel.
   *
   * A tool-call-keyed panel only leaves the seat: nothing is sent and nothing
   * is persisted, and the tool call row brings it back. A card the Host never
   * named has no way back, so closing it ends the request — which is why it
   * needs a channel to cancel through.
   */
  const dismissFlow = (): void => {
    if (pending?.dismiss === undefined) return
    if (pending.dismissal === 'hide') {
      void pending.dismiss()
      return
    }
    if (!canSubmit) {
      setError({ key: 'error.unavailable' })
      return
    }
    setBusy('cancel')
    setError(null)
    sentVia.current = 'waterfall'
    void pending.dismiss().catch((cause: unknown) => {
      if (!active.current) return
      sentVia.current = null
      setBusy(null)
      setError({ text: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  const updateDraft = (
    update: (current: QuestionDraftAnswer) => QuestionDraftAnswer,
    nextIndex = progress.index,
  ): void => {
    engage()
    const nextDrafts = progress.drafts.map((item, itemIndex) => itemIndex === progress.index ? update(item) : item)
    replaceProgress(nextIndex, nextDrafts)
  }

  const choose = (label: string): void => {
    updateDraft((current) => {
      if (question.multiSelect === true) {
        const selected = current.selected.includes(label)
          ? current.selected.filter(item => item !== label)
          : [...current.selected, label]
        return { ...current, selected, skipped: false }
      }
      return { selected: [label], custom: '', skipped: false }
    }, question.multiSelect !== true && progress.index < questions.length - 1 ? progress.index + 1 : progress.index)
  }

  const answered = (item: QuestionDraftAnswer): boolean =>
    item.selected.length > 0 || item.custom.trim() !== ''

  const completed = (item: QuestionDraftAnswer): boolean => answered(item) || item.skipped

  const submitDrafts = (values: QuestionDraftAnswer[]): void => {
    if (pending === undefined) return
    const token = guard.begin()
    if (token === undefined) return
    const missing = values.findIndex(item => !completed(item))
    if (missing >= 0) {
      guard.finish(token)
      replaceProgress(missing, values)
      setError({ key: 'error.incomplete' })
      return
    }
    if (!canSubmit) {
      guard.finish(token)
      setError({ key: 'error.unavailable' })
      return
    }
    setBusy('answer')
    setError(null)
    // The external-store render can lag the carrier as a timed call continues.
    // Read the channel used by answer() in this same event turn.
    const channel = pending.getSnapshot?.().channel ?? card.channel
    sentVia.current = channel === 'waterfall' ? 'waterfall' : null
    void pending.answer(answerBatchOf(questions, values))
      .then(() => {
        // A re-armed panel has already moved on: this outcome belongs to a
        // submission the retry replaced, so it neither paints nor dismisses.
        if (!guard.owns(token)) return
        if (channel !== 'rpc') return
        sentVia.current = null
        setBusy(null)
        setError(null)
        void pending.dismiss?.().catch(() => { setError({ key: 'status.sent' }) })
      })
      .catch((cause: unknown) => {
        // Only the submission that still owns the guard reports a failure; the
        // one a re-arm retired was dropped, and its rejection is not the retry's.
        if (!guard.finish(token)) return
        if (!active.current) return
        sentVia.current = null
        setBusy(null)
        setError({ text: cause instanceof Error ? cause.message : String(cause) })
      })
  }

  const continueFlow = (): void => {
    if (!answered(draft)) {
      setError({ key: 'error.unanswered' })
      return
    }
    if (progress.index < questions.length - 1) {
      replaceProgress(progress.index + 1, progress.drafts)
      return
    }
    submitDrafts(progress.drafts)
  }

  // Shared by the inline custom field and the optionless one: a multi-select
  // draft retains checked labels, while a single-select custom answer replaces
  // its selection. Enter continues the flow, Shift+Enter breaks a line.
  const draftCustom = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const value = event.target.value
    updateDraft(current => ({
      ...current,
      selected: question.multiSelect === true ? current.selected : [],
      custom: value,
      skipped: false,
    }))
  }

  const continueFromCustom = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  }

  const skipQuestion = (): void => {
    engage()
    const nextDrafts = progress.drafts.map((item, itemIndex) => itemIndex === progress.index
      ? { selected: [], custom: '', skipped: true }
      : item)
    replaceProgress(progress.index < questions.length - 1 ? progress.index + 1 : progress.index, nextDrafts)
    if (progress.index < questions.length - 1) {
      return
    }
    submitDrafts(nextDrafts)
  }

  // The countdown is only a foreground presentation: the card keeps the
  // deadline, and the wait button is offered exactly while a deadline runs.
  const countdownVisible = countdown !== undefined
    && card.waitState !== 'waiting' && card.waitState !== 'editing' && card.waitState !== 'continued'
  return (
    <div className={css.root} data-question-key={matched.key} aria-busy={inert}>
      <section
        className={`${css.card}${minimized ? ` ${css.cardMinimized}` : ''}`}
        aria-labelledby={`question-${matched.key}-${String(progress.index)}`}
      >
        {/* The one state the shipped composer cannot reach: another surface
            already answered. The card closes with the log's own record and
            says so — a completion tone, not the approval panel's warning. */}
        {settledElsewhere && (
          <div className={css.strip}>
            <StateDot state="done" />
            {t('answeredElsewhere')}
          </div>
        )}
        <header className={css.header}>
          <div className={css.headingBlock}>
            {question.header !== undefined && <div className={css.eyebrow}>{question.header}</div>}
            <h2 className={css.title} id={`question-${matched.key}-${String(progress.index)}`}>
              {question.question}
            </h2>
          </div>
          <div className={css.headerActions}>
            {countdownVisible && (
              <span className={css.waitStatus}>
                {t(countdown.running ? 'wait.countdown' : 'wait.paused', {
                  seconds: Math.ceil(countdown.remainingMs / 1000),
                })}
              </span>
            )}
            {countdownVisible && (
              <Button variant="outline" className={css.waitButton} disabled={inert} onClick={takeTime}>
                {t('wait.takeTime')}
              </Button>
            )}
            {card.state === 'continued' && <span className={css.waitStatus}>{t('wait.continued')}</span>}
            {/* A held or frozen countdown says so; a request that never carried
                one waits silently, as the blocking question always has. */}
            {countdown !== undefined && (card.waitState === 'waiting' || card.waitState === 'editing') && (
              <span className={css.waitStatus}>{t('wait.held')}</span>
            )}
            {review !== undefined && <span className={css.waitStatus}>{t('review.status')}</span>}
            <button
              type="button" className={css.iconButton}
              aria-label={t(minimized ? 'nav.maximize' : 'nav.minimize')}
              title={t(minimized ? 'nav.maximize' : 'nav.minimize')}
              aria-expanded={!minimized}
              disabled={busy !== null}
              onClick={() => { setMinimized(current => !current) }}
            >
              {minimized ? <IconChevronUpOutlineRegular size={14} /> : <IconChevronDownOutlineRegular size={14} />}
            </button>
            {pending?.dismiss !== undefined && (
              <button
                type="button" className={css.iconButton}
                aria-label={t(pending.dismissal === 'hide' ? 'nav.close' : 'nav.cancel')}
                title={t(pending.dismissal === 'hide' ? 'nav.close' : 'nav.cancel')}
                disabled={busy !== null} onClick={dismissFlow}
              >
                <IconCloseOutlineRegular size={16} />
              </button>
            )}
          </div>
        </header>

        {!minimized && (
          <>
            <div
              ref={answerSurface}
              className={css.body}
              data-question-scroll
              onFocusCapture={focusAnswerSurface}
              onBlurCapture={blurAnswerSurface}
            >
              {question.detail !== undefined && (
                <div className={css.detail}><MarkdownText text={question.detail} labels={markdownLabels} /></div>
              )}
              <div className={css.options} role={question.multiSelect === true ? 'group' : 'radiogroup'}>
                {(question.options ?? []).map((option, optionIndex) => {
                  const selected = draft.selected.includes(option.label)
                  const display = parseRecommendedLabel(option.label)
                  const optionClasses = `${css.option}${selected && question.multiSelect !== true ? ` ${css.optionSelected}` : ''}`
                  return (
                    <button
                      type="button" key={`${option.label}-${String(optionIndex)}`}
                      className={optionClasses}
                      role={question.multiSelect === true ? 'checkbox' : 'radio'}
                      aria-checked={selected}
                      aria-label={display.label}
                      disabled={inert}
                      onClick={() => { choose(option.label) }}
                      onKeyDown={(event) => {
                        if (inert) return
                        if (event.key !== 'Enter' || !progress.drafts.every(completed)) return
                        event.preventDefault()
                        submitDrafts(progress.drafts)
                      }}
                    >
                      {question.multiSelect === true
                        ? (
                          <span className={`${css.checkbox}${selected ? ` ${css.checkboxChecked}` : ''}`} aria-hidden="true">
                            {selected && <IconCheckOutlineRegular size={12} />}
                          </span>
                        )
                        : <span className={css.number}>{optionIndex + 1}</span>}
                      <span className={css.optionCopy}>
                        <span className={css.optionLine}>
                          <span className={css.optionLabel}>{display.label}</span>
                          {display.recommended && (
                            <span className={css.badge}>{t('option.recommended')}</span>
                          )}
                          {option.description !== undefined && (
                            <span className={css.description}>{option.description}</span>
                          )}
                        </span>
                      </span>
                    </button>
                  )
                })}

                {/* A card holding a record keeps the skipped note in place of
                    the skipped question's choices. */}
                {readOnly && draft.skipped && (
                  <p className={css.reviewNote}>{t('review.skipped')}</p>
                )}

                {/* A card holding a record keeps the free-text field only when
                    the recorded answer used it; an empty disabled box with a
                    placeholder would read as somewhere to type. */}
                {(record === undefined || draft.custom !== '') && (hasOptions
                  ? (
                    <div className={`${css.customRow}${draft.custom !== '' ? ` ${css.customRowActive}` : ''}`}>
                      {question.multiSelect === true
                        ? (
                          <span
                            className={`${css.checkbox}${draft.custom !== '' ? ` ${css.checkboxChecked}` : ''}`}
                            aria-hidden="true"
                          >
                            {draft.custom !== '' && <IconCheckOutlineRegular size={12} />}
                          </span>
                        )
                        : (
                          <span className={css.number} aria-hidden="true">
                            <IconEditOutlineRegular size={12} />
                          </span>
                        )}
                      <AnswerField
                        variant="inline"
                        value={draft.custom}
                        disabled={inert}
                        placeholder={t('custom.placeholder')}
                        onChange={draftCustom}
                        onKeyDown={continueFromCustom}
                      />
                    </div>
                  )
                  : (
                    <AnswerField
                      autoFocus={!focusedQuestions.current.has(progress.index)}
                      variant="block"
                      value={draft.custom}
                      disabled={inert}
                      placeholder={t('custom.placeholder')}
                      onFocus={() => { focusedQuestions.current.add(progress.index) }}
                      onChange={draftCustom}
                      onKeyDown={continueFromCustom}
                    />
                  ))}
              </div>
            </div>

            <footer className={css.footer}>
              <div className={css.pager}>
                <button
                  type="button" className={css.iconButton} aria-label={t('nav.prev')}
                  disabled={progress.index === 0 || busy !== null}
                  onClick={() => { replaceProgress(progress.index - 1, progress.drafts) }}
                >
                  <IconChevronLeftOutlineRegular size={14} />
                </button>
                <span className={css.progress}>{progress.index + 1} / {questions.length}</span>
                <button
                  type="button" className={css.iconButton} aria-label={t('nav.next')}
                  disabled={progress.index === questions.length - 1 || busy !== null}
                  onClick={() => { replaceProgress(progress.index + 1, progress.drafts) }}
                >
                  <IconChevronRightOutlineRegular size={14} />
                </button>
              </div>
              <div className={css.feedback} role="status">
                {error === null ? null : 'key' in error ? t(error.key) : error.text}
              </div>
              {/* A card holding a record has nothing to send: the pager alone
                  walks it. */}
              {!readOnly && (
                <div className={css.footerActions}>
                  <Button variant="outline" disabled={busy !== null} onClick={skipQuestion}>
                    {t('action.skip')}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busy !== null || !answered(draft)
                      || (progress.index === questions.length - 1 && !canSubmit)}
                    onClick={continueFlow}
                  >
                    {busy === 'answer'
                      ? t('submitting')
                      : progress.index === questions.length - 1 ? t('submit') : t('action.next')}
                  </Button>
                </div>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  )
}

/** Full props of this panel's registration, for tests and the register site. */
export type LarkQuestionPanelFullProps =
  PropsRuntime<'conversation.composer'>
  & { readonly matched: QuestionTarget }
  & PropsLocale<'larkQuestion'>
