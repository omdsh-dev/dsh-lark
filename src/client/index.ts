/**
 * Browser half of the Lark channel: the approval panel the Web composer renders
 * in place of the shipped one.
 *
 * Registered as a `dsh.client` row so the Web module table loads it beside the
 * other browser plugins. It claims no service the Host half owns; every value
 * it reads comes from the shared Client services.
 *
 * An approval is offered on two surfaces at once — the channel's Feishu card
 * and whatever answerer follows its Host listener — and the first answer wins.
 * When another surface wins, this page's copy of the question has already
 * stopped deciding anything, and the shipped panel leaves it standing because
 * retiring it is the Host's call. This plugin supplies the missing half: it
 * renders that panel itself and settles a request the log shows another surface
 * already decided.
 *
 * The entry claims EVERY approval, and that reach is a property of the
 * mechanism rather than a choice. A chain selector is a pure function of the
 * owner props — the session id, the session snapshot, and the pending request —
 * so it can read no live fact, and "is a chat currently driving this
 * conversation" is a live fact that exists only on the Host: in the binding
 * table, or in the channel's own session projection. A session id does not
 * carry it either, because `/sessions` lets a chat continue a session it did
 * not derive. Claiming narrowly by name therefore missed real conversations,
 * and the request it missed is exactly the one whose shipped panel keeps its
 * buttons after the chat has already decided.
 *
 * TEMPORARY. The shipped approval panel keeps its buttons after the chat
 * answers because the gateway settles a forwarded request only when a client
 * replies or the request's lifetime ends, so a chat-side win has no way to
 * reach the browsers already holding the question. The durable fix belongs
 * there — either the gateway cancels delivered clients when an earlier listener
 * claims the waterfall, or the channel registers inside `forwardWaterfall` and
 * shares one settlement with the browser. When that lands, this whole browser
 * half should be deleted rather than extended.
 * @module dsh-lark-channel/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots) and the shipped
// approval domain's merge into SessionPendingInteractionMap, which is what makes
// `pending.toolName` / `pending.callId` readable on a projected interaction.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import { QuestionPanel } from './QuestionPanel.tsx'
import { SettledApprovalsRegistry, SettledSourceRegistry } from './decisions-source.ts'
import { foldSettledQuestions, type SettledQuestion } from './question-decisions.ts'
import { createQuestionDrafts } from './question-drafts.ts'
import { createPanelFace, type DisplayReason, type PanelTarget } from './panel-store.ts'
import { createQuestionFace, type QuestionSpec, type QuestionTarget } from './question-store.ts'
import { en, enQuestion, zh, zhQuestion } from './locales.ts'
import type {} from './contract.ts'

/** Cordis plugin name of the browser half; keep this stable after publishing. */
export const name = 'lark-channel-ui'

/**
 * Services that must exist before this plugin is applied. `sessions` owns the
 * conversation the panel folds its decisions out of; `slots` carries the
 * composer chain this entry joins.
 */
export const inject: string[] = ['sessions', 'slots', 'locale']

/** Dictionary namespace owned by this plugin. */
const NS = 'larkApproval'

/** Dictionary namespace for the question takeover. */
const QUESTION_NS = 'larkQuestion'

/**
 * Install the Lark channel's approval presentation.
 *
 * The registry and face are created here rather than as module-level handles so
 * two assembled Clients in one process — tests, or a page reloaded through HMR
 * — never share one conversation's subscription state.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'lark-ui: dictionaries')
  ctx.effect(() => ctx.locale.register(QUESTION_NS, { zh: zhQuestion, en: enQuestion }), 'lark-ui: question dictionaries')
  const settled = new SettledApprovalsRegistry(ctx.sessions)
  const panel = createPanelFace(settled)
  ctx.effect(() => () => { settled.dispose() }, 'lark-ui: settled-approval reads')

  // The question half reads the same event window through a different fold: the
  // blocking tool's calls are not in the `userQuestions` projection, so the
  // `tool/call` + `tool/result` pair in the log is the only shared record.
  const settledQuestions = new SettledSourceRegistry<SettledQuestion>(ctx.sessions, {
    read: foldSettledQuestions,
    identityOf: question => question.callId,
  })
  const questionPanel = createQuestionFace(settledQuestions)
  ctx.effect(() => () => { settledQuestions.dispose() }, 'lark-ui: settled-question reads')

  // The wizard's answer drafts, owned per apply() like the settled reads above:
  // two assembled Clients in one process never share one conversation's drafts.
  const questionDrafts = createQuestionDrafts()
  ctx.effect(() => () => { questionDrafts.dispose() }, 'lark-ui: question drafts')

  // Register through slots.inject, not a bare register(): the composer chain
  // is declared by ui-conversation's own apply, and this fiber can activate
  // first — a direct register then throws "slot not declared" and fails the
  // whole Web boot. inject runs the callback once the declaration commits (or
  // synchronously when it already exists) and disposes with it, which is the
  // pattern the shipped approval panel below uses.
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    // Priority 0 places this entry ahead of the shipped approval panel (1) in
    // the chain's election.
    //
    // The entry claims EVERY approval, not only this channel's conversations.
    // A chain selector is a pure function of the owner props — `sessionId`,
    // `session`, and the pending interaction — so it cannot consult a live
    // fact, and the only live facts that distinguish "a chat is driving this
    // conversation" (the Host's binding table, or the channel's own session
    // projection) are unreadable from here. Session ids do not answer it
    // either: `/sessions` lets a chat adopt a session it did not derive, so a
    // conversation this channel drives may carry any id. Claiming narrowly by
    // name therefore misses real cases, and the request it misses keeps the
    // shipped panel's buttons after the chat has already decided. Claiming all
    // approvals is the honest reach of a selector, and it costs only this
    // plugin's own presentation: a conversation no chat drives never sees a
    // decision in its log, so the panel below behaves exactly as the shipped
    // one does.
    priority: 0,
    select: (owner: ComposerChainProps): PanelTarget | null => {
      const sessionId = owner.sessionId
      if (sessionId === undefined) return null
      const pending = owner.pendingInteraction
      if (pending === undefined || pending.kind !== 'approval') return null
      return {
        sessionId,
        key: pending.key,
        toolName: pending.toolName,
        ...pending.callId === undefined ? {} : { callId: pending.callId },
        ...pending.reason === undefined ? {} : { reason: pending.reason },
        ...pending.displayReason === undefined ? {} : { displayReason: pending.displayReason },
      }
    },
    locale: NS,
    // The `hooks` compartment is the registrant-private live-data channel: the
    // renderer binds this bare observable to `useLarkSettled`, so the component
    // subscribes through the framework rather than holding its own listener.
    inject: (sessionId) => ({
      panel,
      resolveReason: (reason: DisplayReason) => ctx.locale.resolveText(reason),
      hooks: { larkSettled: panel.settledSource(sessionId) },
    }),
  }, ApprovalPanel))

  // The question takeover, on the same terms and for the same reason. It claims
  // only `question`: a plan review is still answered by this channel's shadowed
  // plan tool in the chat, so the shipped panel keeps that one.
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 0,
    select: (owner: ComposerChainProps): QuestionTarget | null => {
      const sessionId = owner.sessionId
      if (sessionId === undefined) return null
      // Read structurally rather than through the shipped question domain's
      // merge: naming its package would put a second presentation package in
      // this channel's dependency list to describe a value it only reads. The
      // discriminator is `kind`, which the shared projection documents for
      // exactly this purpose, and the fields below are the ones the type admits.
      const pending = owner.pendingInteraction as
        | { readonly kind?: string; readonly key?: string; readonly questions?: readonly QuestionSpec[] }
        | undefined
      if (pending === undefined || pending.kind !== 'question') return null
      if (pending.key === undefined || pending.questions === undefined) return null
      return { sessionId, key: pending.key, questions: pending.questions }
    },
    locale: QUESTION_NS,
    inject: (sessionId) => ({
      panel: questionPanel,
      drafts: questionDrafts,
      hooks: { larkQuestionSettled: questionPanel.settledSource(sessionId) },
    }),
  }, QuestionPanel))
}

/** Re-exported for the panel half and its tests. */
export type { SettledApproval } from './decisions.ts'
export type { SettledQuestion, SettledQuestionAnswer } from './question-decisions.ts'
export type { PanelTarget, PanelFace, AnswerablePending } from './panel-store.ts'
export type { QuestionTarget, QuestionFace, AnswerableQuestion } from './question-store.ts'
