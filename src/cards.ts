/**
 * The visual language every interactive card in this channel speaks.
 *
 * A bot that interrupts someone's chat to ask for a decision should look like
 * it belongs to the product, so the cards here are built from a small fixed
 * vocabulary rather than composed ad hoc: one ink colour per semantic state,
 * one type role per text purpose, a 20px content grid, and copy that names the
 * action rather than the gesture. Callers pick a state and pass content; every
 * other visual decision is made once, here.
 *
 * Three rules are load-bearing rather than cosmetic:
 *
 * - **Model-authored text never renders as markup.** A command's arguments,
 *   the model's justification, the question it wrote and the options it offers
 *   are all untrusted; each rides a `plain_text` element so it renders
 *   literally and cannot forge the card's own words.
 * - **This module's own copy is bilingual.** Every string authored here ships
 *   as a {@link Copy}, and the platform renders the reader's own language from
 *   the element's `i18n` map — which only `plain_text` carries, so nothing
 *   here uses markdown, bold included. One card serves a mixed room without
 *   anyone detecting a locale. Model-authored text stays in whatever language
 *   the model wrote: translating a command would be a lie about what runs.
 * - **No images.** These cards are built at runtime and every image would need
 *   an uploaded `img_key`, so headers are text and status is carried by ink.
 * @module dsh-lark-channel/cards
 */

import { formatByteSize, formatTokenCount } from './format.ts'

/**
 * One string this module authored, in the languages a card can carry.
 *
 * `zh` is also the fallback every other locale gets, matching a channel whose
 * default deployment is Feishu.
 */
export interface Copy {
  readonly zh: string
  readonly en: string
}

/**
 * A string a card renders: a {@link Copy} this module wrote, or a bare string
 * from the model or the host, which is shown exactly as it arrived.
 */
type Line = Copy | string

/** Semantic state of a card, which picks its title ink. */
export type CardState = 'info' | 'success' | 'warning' | 'danger' | 'neutral'

/**
 * Title ink per state. The names are card-local colour variables declared in
 * `config.style.color`, so each card ships only the one pair it uses.
 */
const INK: Record<CardState, { readonly token: string; readonly light: string; readonly dark: string }> = {
  info: { token: 'dsh_ink_info', light: 'rgba(20, 86, 240, 1)', dark: 'rgba(117, 164, 255, 1)' },
  success: { token: 'dsh_ink_success', light: 'rgba(26, 117, 38, 1)', dark: 'rgba(81, 186, 67, 1)' },
  warning: { token: 'dsh_ink_warning', light: 'rgba(164, 73, 4, 1)', dark: 'rgba(243, 135, 27, 1)' },
  danger: { token: 'dsh_ink_danger', light: 'rgba(192, 42, 38, 1)', dark: 'rgba(246, 130, 126, 1)' },
  neutral: { token: 'dsh_ink', light: 'rgba(28, 31, 36, 1)', dark: 'rgba(244, 246, 248, 1)' },
}

/**
 * Type roles. Titles sit one step above a plain heading because a localizable
 * title cannot be bold — weight is markdown's, and markdown has no `i18n`.
 */
const SIZE = { title: 'heading-2', body: 'normal', label: 'notation', foot: 'small' } as const

/** Whether a line is this module's own copy rather than someone else's text. */
function isCopy(value: Line): value is Copy {
  return typeof value === 'object'
}

/** Join our copy to a value from elsewhere, in each language's own punctuation. */
function fill(copy: { readonly zh: string; readonly en: string }, value: string): Copy {
  return { zh: copy.zh.replace('%s', value), en: copy.en.replace('%s', value) }
}

/**
 * Append text from elsewhere to this module's copy, in every language.
 * @param copy - the localized half.
 * @param tail - the untranslated half, or its Chinese form.
 * @param englishTail - the English form, when it differs.
 * @returns one copy carrying both halves.
 */
function join(copy: Copy, tail: string, englishTail = tail): Copy {
  return { zh: `${copy.zh}${tail}`, en: `${copy.en}${englishTail}` }
}

/**
 * One rendered string, localized when it is ours.
 * @param value - the copy or the literal text.
 * @param size - which type role it plays.
 * @param color - a declared colour token; omitted leaves the default ink.
 * @param align - horizontal alignment within its slot.
 * @returns a `plain_text` node, for a `div` or a control's `text` field.
 */
function textNode(
  value: Line,
  size: (typeof SIZE)[keyof typeof SIZE],
  color?: string,
  align: 'left' | 'center' = 'left',
): object {
  return {
    tag: 'plain_text',
    content: isCopy(value) ? value.zh : value,
    ...isCopy(value) ? { i18n: { zh_cn: value.zh, en_us: value.en } } : {},
    text_size: size,
    ...color === undefined ? {} : { text_color: color },
    text_align: align,
  }
}

/**
 * One paragraph.
 * @param value - the copy or the literal text.
 * @param size - which type role it plays.
 * @param margin - grid position, in the card's `top right bottom left` form.
 * @param color - a declared colour token, when the role is not default ink.
 * @returns a body element.
 */
function line(
  value: Line,
  size: (typeof SIZE)[keyof typeof SIZE],
  margin: string,
  color?: string,
): object {
  return { tag: 'div', text: textNode(value, size, color), margin }
}

/**
 * Root card scaffolding shared by every card here.
 * @param state - which ink the title uses; only that one pair is declared.
 * @param summary - the notification line shown outside the card.
 * @param elements - body elements, already margined.
 * @returns a schema 2.0 card object.
 */
function card(state: CardState, summary: Copy, elements: readonly object[]): object {
  const ink = INK[state]
  return {
    schema: '2.0',
    config: {
      // Shared rather than per-viewer: one decision, one state, and a card
      // that repaints for everyone who can see it.
      update_multi: true,
      compact_width: false,
      enable_forward: true,
      streaming_mode: false,
      summary: { content: summary.zh, i18n_content: { zh_cn: summary.zh, en_us: summary.en } },
      style: {
        color: { [ink.token]: { light_mode: ink.light, dark_mode: ink.dark } },
      },
    },
    body: {
      direction: 'vertical',
      horizontal_spacing: '8px',
      vertical_spacing: '8px',
      horizontal_align: 'left',
      vertical_align: 'top',
      padding: '0px 0px 20px 0px',
      elements,
    },
  }
}

/**
 * Title and one line of context. The ink follows the card's state, which is
 * how a settled card reads as settled before any word is parsed.
 */
function heading(state: CardState, title: Line, context: Line): object[] {
  return [
    line(title, SIZE.title, '20px 20px 0px 20px', INK[state].token),
    line(context, SIZE.body, '2px 20px 0px 20px', 'grey'),
  ]
}

/**
 * A labelled block of text from elsewhere, on a tinted surface.
 * @param label - what the block holds, in this module's words.
 * @param value - the text itself, rendered exactly as it arrived.
 * @param surface - the tint, which says whose words these are.
 * @param hidden - characters the clip dropped, when it dropped any.
 * @returns a body element.
 */
function quoted(
  label: Copy,
  value: string,
  surface: 'grey-50' | 'orange-50',
  hidden = 0,
): object {
  return {
    tag: 'interactive_container',
    background_style: surface,
    corner_radius: '10px',
    has_border: false,
    padding: '14px 16px 14px 16px',
    direction: 'vertical',
    horizontal_spacing: '8px',
    vertical_spacing: '0px',
    horizontal_align: 'left',
    vertical_align: 'top',
    // A surface, not a control: the container tag is the only one that carries
    // both a tint and a corner radius, so it is used with its interaction off.
    disabled: true,
    behaviors: [],
    margin: '12px 20px 0px 20px',
    elements: [
      line(label, SIZE.label, '0px 0px 0px 0px', 'grey'),
      line(value, SIZE.body, '4px 0px 0px 0px'),
      // The clip is announced in its own line rather than appended to the
      // text: a note glued to untrusted content could not be localized, and a
      // silently shortened command is one a reader approves believing they
      // saw all of it.
      ...hidden === 0 ? [] : [line(fill(TRUNCATED, String(hidden)), SIZE.label, '6px 0px 0px 0px', 'grey')],
    ],
  }
}

/**
 * The page-foot note.
 *
 * A hairline and a quiet line of type, not a coloured band: the footnote is
 * the least important thing on the card, and a filled bar at the bottom pulls
 * the eye exactly where it should not go. The rule does the separating; the
 * grey does the receding.
 */
function footer(note: Copy): object[] {
  return [
    { tag: 'hr', margin: '16px 20px 0px 20px' },
    line(note, SIZE.foot, '10px 20px 0px 20px', 'grey'),
  ]
}

/** One button in an action row. */
interface CardButton {
  readonly label: Line
  /** Callback payload delivered to the card-action handler. */
  readonly value: object
  readonly kind?: 'primary' | 'danger' | 'default'
}

/**
 * An equal-width action row: emphasis comes from button type, never from
 * column width, so no button reads as bigger than the choice it represents.
 * @param buttons - the row's controls, in reading order.
 * @param compact - size buttons to their labels instead of filling the row,
 * for a secondary action that should not look like the card's main event.
 * @returns a body element.
 */
function actions(buttons: readonly CardButton[], compact = false): object {
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    background_style: 'default',
    horizontal_spacing: '8px',
    horizontal_align: 'left',
    margin: '16px 20px 0px 20px',
    columns: buttons.map(button => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'top',
      elements: [{
        tag: 'button',
        text: textNode(button.label, SIZE.body, undefined, compact ? 'left' : 'center'),
        type: button.kind === 'primary' ? 'primary_filled' : button.kind === 'danger' ? 'danger' : 'default',
        width: compact ? 'default' : 'fill',
        behaviors: [{ type: 'callback', value: button.value }],
      }],
    })),
  }
}

/**
 * One option rendered as a full-width clickable row: label above, the reason
 * to pick it below.
 *
 * A row is used instead of a button whenever an option carries an
 * explanation, because a button that swallows a sentence stops looking like a
 * button — and a legend printed under the row makes the reader match labels to
 * lines by eye. Here the explanation sits inside the thing you click.
 * @param option - the untrusted label and its untrusted description.
 * @param value - the callback payload for this option.
 * @returns a body element.
 */
function optionRow(
  option: { readonly label: Line; readonly description?: Line | undefined },
  value: object,
): object {
  return {
    tag: 'interactive_container',
    background_style: 'default',
    corner_radius: '10px',
    has_border: true,
    border_color: 'grey-300',
    padding: '12px 16px 12px 16px',
    direction: 'vertical',
    horizontal_spacing: '8px',
    vertical_spacing: '2px',
    horizontal_align: 'left',
    vertical_align: 'top',
    disabled: false,
    margin: '8px 20px 0px 20px',
    behaviors: [{ type: 'callback', value }],
    elements: [
      line(option.label, SIZE.body, '0px 0px 0px 0px'),
      ...option.description === undefined || option.description === ''
        ? []
        : [line(option.description, SIZE.label, '0px 0px 0px 0px', 'grey')],
    ],
  }
}

/**
 * One row of a settings readout: what the field is, and what it holds.
 *
 * Two weighted columns rather than one line of `label: value`, because the
 * values here are paths and ids that wrap — and a wrapped value that starts
 * under its own label stays readable, while one that wraps under a label does
 * not.
 * @param label - the field name, in this module's words.
 * @param value - the value, shown exactly as it is.
 * @param note - a qualifier under the value, such as "this is the default".
 * @returns a body element.
 */
function field(label: Copy, value: Line, note?: Copy, first = false): object[] {
  return [
    line(label, SIZE.label, first ? '0px 0px 0px 0px' : '14px 0px 0px 0px', 'grey'),
    line(value, SIZE.body, '2px 0px 0px 0px'),
    ...note === undefined ? [] : [line(note, SIZE.label, '2px 0px 0px 0px', 'grey')],
  ]
}

/** The panel a readout's fields sit on: one surface, so they read as one set. */
function panel(elements: readonly object[]): object {
  return {
    tag: 'interactive_container',
    background_style: 'grey-50',
    corner_radius: '10px',
    has_border: false,
    padding: '16px 16px 16px 16px',
    direction: 'vertical',
    horizontal_spacing: '8px',
    vertical_spacing: '0px',
    horizontal_align: 'left',
    vertical_align: 'top',
    disabled: true,
    behaviors: [],
    margin: '14px 20px 0px 20px',
    elements,
  }
}

/** Names the form and the select inside it, so a submission can be read back. */
export const QUESTION_FORM = 'dsh_question_form'
export const QUESTION_SELECT = 'dsh_question_options'

/**
 * The options as a multiple choice: a form holding one multi-select and the
 * button that submits it.
 *
 * A form rather than a row of toggles, because a toggle answers on every
 * press — and a question that may take three answers must not settle on the
 * first. The platform collects the set and delivers it once, on submit.
 * Values are indices, not labels: what comes back is then a position in the
 * question we asked, not a string a card round-trip could have altered.
 * @param options - the untrusted labels, in the model's own order.
 * @param submit - the callback payload the submit button carries.
 * @returns a body element.
 */
function multipleChoice(
  options: readonly { readonly label: string; readonly description?: string | undefined }[],
  submit: object,
): object {
  return {
    tag: 'form',
    name: QUESTION_FORM,
    direction: 'vertical',
    horizontal_spacing: '8px',
    vertical_spacing: '8px',
    horizontal_align: 'left',
    vertical_align: 'top',
    padding: '0px 0px 0px 0px',
    margin: '12px 0px 0px 0px',
    elements: [
      {
        tag: 'multi_select_static',
        name: QUESTION_SELECT,
        placeholder: textNode(QUESTION.pick, SIZE.body),
        // The platform enforces it, so a submission can never be an empty
        // answer the model would read as "they declined".
        required: true,
        width: 'fill',
        margin: '0px 20px 0px 20px',
        options: options.map((option, index) => ({
          value: String(index),
          text: textNode(option.label, SIZE.body),
        })),
      },
      // A dropdown has nowhere to put an explanation, so the ones the model
      // wrote sit under it rather than being dropped.
      ...options.flatMap((option, index) => option.description === undefined || option.description === ''
        ? []
        : [line(`${index + 1}. ${option.label} — ${option.description}`, SIZE.label, '6px 20px 0px 20px', 'grey')]),
      {
        tag: 'button',
        text: textNode(QUESTION.submit, SIZE.body, undefined, 'center'),
        type: 'primary_filled',
        width: 'default',
        form_action_type: 'submit',
        name: 'dsh_question_submit',
        margin: '14px 20px 0px 20px',
        behaviors: [{ type: 'callback', value: submit }],
      },
    ],
  }
}

/**
 * How full the context is: what the next request carries, and — when the
 * provider says how big the window is — the share of it that leaves.
 * @param context - the used tokens and the window they sit in.
 * @returns the reading, localized.
 */
function contextReading(context: { readonly used: number; readonly window?: number | undefined }): Copy {
  const used = formatTokenCount(context.used)
  const window = context.window
  if (window === undefined || window <= 0) return { zh: used, en: used }
  const share = Math.round((context.used / window) * 100)
  return {
    zh: `${used} / ${formatTokenCount(window)}（${share}%）`,
    en: `${used} / ${formatTokenCount(window)} (${share}%)`,
  }
}

/** Cut a string to a budget, reporting what was left out. */
function clip(value: string, max: number): { readonly shown: string; readonly hidden: number } {
  return value.length <= max
    ? { shown: value, hidden: 0 }
    : { shown: value.slice(0, max), hidden: value.length - max }
}

/** How much of a pending call's arguments an approval card shows. */
const COMMAND_MAX_CHARS = 600

/** How much of a model's justification an approval card shows. */
const REASON_MAX_CHARS = 300

/** Every string this module says, in the languages it says them. */
const TRUNCATED = { zh: '已截断 %s 个字符', en: '%s characters truncated' }
const APPROVAL = {
  title: { zh: '需要你的授权', en: 'Approval needed' },
  context: { zh: '%s · 沙箱之外的操作，等待确认', en: '%s · outside the sandbox, awaiting your call' },
  command: { zh: '将执行', en: 'Will run' },
  reason: { zh: '模型说明', en: "Model's reason" },
  allow: { zh: '允许执行一次', en: 'Allow once' },
  reject: { zh: '拒绝执行', en: 'Reject' },
  foot: {
    zh: '授权仅对这一次调用生效，批准前请确认上面的内容确实是你要执行的。',
    en: 'This grant covers a single call. Check the command above before you allow it.',
  },
  escalation: { zh: '沙箱提权', en: 'Sandbox escalation' },
  escalationTo: { zh: '这次调用要求提升到 %s', en: 'this call asks to be raised to %s' },
  always: { zh: '不再询问，放开本会话', en: 'Stop asking, open this session' },
  alwaysFoot: {
    zh: '「不再询问」会把本会话切到 %s：完全不沙箱，且之后不再有审批卡（仍需审批的动作会被直接拒绝）。重启后依然有效，用 /permission 可随时切回。',
    en: 'Stop asking switches this session to %s: no sandbox at all, and no approval cards after it (anything still needing approval is refused outright). It survives a restart; /permission switches back.',
  },
  summary: { zh: '需要授权：%s', en: 'Approval needed: %s' },
  closed: { zh: '这条授权已结束，按钮不再可用。', en: 'This request is closed; its buttons no longer work.' },
  decidedBy: { zh: '%s · 决定人：', en: '%s · decided by ' },
}
const QUESTION = {
  title: { zh: '需要你确认', en: 'A decision is needed' },
  context: { zh: '助手需要一个决定才能继续', en: 'The assistant needs your answer to continue' },
  answered: { zh: '已作答', en: 'Answered' },
  cancelled: { zh: '这个提问已取消', en: 'Question cancelled' },
  answer: { zh: '你的回答', en: 'Your answer' },
  replyWithOptions: {
    zh: '选项都不合适时直接回复消息，你的下一条消息就是答案。',
    en: 'If none of these fit, just reply — your next message is the answer.',
  },
  replyOnly: {
    zh: '直接回复消息作答，你的下一条消息就是答案。',
    en: 'Just reply — your next message is the answer.',
  },
  received: { zh: '助手已收到，正在继续。', en: 'Received; the assistant is continuing.' },
  pick: { zh: '可以多选', en: 'Pick any number' },
  submit: { zh: '提交', en: 'Submit' },
  replyWithChoices: {
    zh: '选好后点提交；都不合适时直接回复消息，你的下一条消息就是答案。',
    en: 'Submit once you have picked; if none fit, just reply — your next message is the answer.',
  },
  dropped: { zh: '助手已不再等待这个回答。', en: 'The assistant is no longer waiting on this.' },
}

/**
 * The card that asks a human to approve one escalated tool call.
 * @param input - what is being asked, and the payloads its buttons carry.
 * @returns a schema 2.0 card object.
 */
export function approvalCard(input: {
  readonly toolName: string
  readonly reason?: string | undefined
  readonly command?: string | undefined
  /** The sandbox mode this call asked to be raised to, when it asked. */
  readonly escalateTo?: string | undefined
  readonly allow: object
  readonly reject: object
  /** Payload for the button that switches the session, when one is offered. */
  readonly always?: object | undefined
}): object {
  const command = clip(input.command ?? '', COMMAND_MAX_CHARS)
  const reason = clip(input.reason ?? '', REASON_MAX_CHARS)
  const escalated = input.escalateTo !== undefined && input.escalateTo !== ''
  return card('warning', fill(APPROVAL.summary, input.toolName), [
    ...heading(
      'warning',
      APPROVAL.title,
      escalated
        // What is actually being granted, not merely which tool ran: an
        // escalation is a wider reach for one call, and the card that hides
        // that is asking for consent to something it did not name.
        ? join(fill(APPROVAL.context, input.toolName), `｜${fill(APPROVAL.escalationTo, input.escalateTo!).zh}`,
          ` | ${fill(APPROVAL.escalationTo, input.escalateTo!).en}`)
        : fill(APPROVAL.context, input.toolName),
    ),
    ...command.shown === '' ? [] : [quoted(APPROVAL.command, command.shown, 'grey-50', command.hidden)],
    ...reason.shown === '' ? [] : [quoted(APPROVAL.reason, reason.shown, 'orange-50', reason.hidden)],
    actions([
      { label: APPROVAL.allow, value: input.allow, kind: 'primary' },
      ...input.always === undefined ? [] : [{ label: APPROVAL.always, value: input.always, kind: 'danger' as const }],
      { label: APPROVAL.reject, value: input.reject, kind: 'danger' as const },
    ]),
    ...footer(
      input.always === undefined
        ? APPROVAL.foot
        : join(APPROVAL.foot, `\n${fill(APPROVAL.alwaysFoot, UNCONFINED_LABEL).zh}`,
          `\n${fill(APPROVAL.alwaysFoot, UNCONFINED_LABEL).en}`),
    ),
  ])
}

/** The preset the loud button switches to; named once so card and bridge agree. */
const UNCONFINED_LABEL = 'danger-full-access'

/** How one approval ended, in the words and colour the settled card uses. */
const APPROVAL_OUTCOME: Record<string, { readonly state: CardState; readonly title: Copy }> = {
  'allowed-once': { state: 'success', title: { zh: '已允许执行一次', en: 'Allowed once' } },
  rejected: { state: 'danger', title: { zh: '已拒绝执行', en: 'Rejected' } },
  cancelled: { state: 'neutral', title: { zh: '请求已撤回', en: 'Request withdrawn' } },
  unavailable: { state: 'neutral', title: { zh: '无法作答', en: 'Could not be answered' } },
}

/**
 * The card an approval is replaced with once decided — no live buttons, and
 * the decision legible from the ink alone.
 * @param input - the tool, the outcome, and who decided when someone did.
 * @returns a schema 2.0 card object.
 */
export function settledApprovalCard(input: {
  readonly toolName: string
  readonly outcome: string
  readonly decidedBy?: string | undefined
}): object {
  const settled = APPROVAL_OUTCOME[input.outcome] ?? APPROVAL_OUTCOME.cancelled!
  // Who decided, named rather than withheld: with approvals open to a room,
  // the room should see whose press granted the escalation.
  const context = input.decidedBy === undefined || input.decidedBy === ''
    ? input.toolName
    : join(fill(APPROVAL.decidedBy, input.toolName), input.decidedBy)
  return card(settled.state, join(settled.title, `：${input.toolName}`, `: ${input.toolName}`), [
    ...heading(settled.state, settled.title, context),
    ...footer(APPROVAL.closed),
  ])
}

/** Every string the outbound-file approval says, in both its languages. */
const FILE_SEND = {
  // The same heading a tool escalation wears, referenced rather than repeated:
  // two rooms being asked to authorize something should not be able to end up
  // asked in two different words because one copy was edited.
  title: APPROVAL.title,
  context: { zh: 'Agent 想把一个文件发到这个群', en: 'The agent wants to send a file to this group' },
  path: { zh: '文件', en: 'File' },
  workspace: { zh: '工作区', en: 'Workspace' },
  size: { zh: '大小', en: 'Size' },
  allow: { zh: '允许发送', en: 'Send it' },
  reject: { zh: '拒绝', en: 'Reject' },
  foot: {
    zh: '文件会对群内所有人可见。确认这份内容可以公开后再允许。',
    en: 'Everyone in this group will see it. Allow only if the content can be shared.',
  },
}

/**
 * The card that asks a group to authorize one outbound file.
 *
 * The file, the workspace and the size are the whole card: an approver who
 * cannot see what is leaving cannot judge whether it may leave, which is the
 * same reason the tool approval prints its command verbatim.
 *
 * The file is named by its place INSIDE the workspace, and the workspace by its
 * own name. An absolute path would publish the host's directory layout — the
 * operator's login name included — to everyone in the room, none of which is
 * what an approver is judging. What makes that safe to shorten is where the
 * relative form comes from: `resolveOutboundFile` derives it from the canonical
 * path it just cleared, so the room still reads the real object and a symlink
 * cannot present itself as a file the room believes it is approving. A
 * prettified path — `~`, an ellipsis, a bare basename — would give that away,
 * and is exactly what this is not.
 * @param input - the file being offered, and the payloads its buttons carry.
 * @returns a schema 2.0 card object.
 */
export function fileApprovalCard(input: {
  /** Where the file sits inside the workspace, derived from its canonical path. */
  readonly path: string
  /** The workspace's own name. */
  readonly workspace: string
  readonly bytes: number
  readonly allow: object
  readonly reject: object
}): object {
  const path = clip(input.path, COMMAND_MAX_CHARS)
  const workspace = clip(input.workspace, COMMAND_MAX_CHARS)
  return card('warning', join(FILE_SEND.title, `：${path.shown}`, `: ${path.shown}`), [
    ...heading('warning', FILE_SEND.title, FILE_SEND.context),
    quoted(FILE_SEND.path, path.shown, 'grey-50', path.hidden),
    quoted(FILE_SEND.workspace, workspace.shown, 'grey-50', workspace.hidden),
    quoted(FILE_SEND.size, formatByteSize(input.bytes), 'grey-50'),
    actions([
      { label: FILE_SEND.allow, value: input.allow, kind: 'primary' },
      { label: FILE_SEND.reject, value: input.reject, kind: 'danger' },
    ]),
    ...footer(FILE_SEND.foot),
  ])
}

/**
 * How one file approval ended. Its own set rather than {@link APPROVAL_OUTCOME}:
 * that one speaks of running something, and what happened here is a send.
 * A request nobody answered in time is presented as withdrawn, because from the
 * room's side that is what it was.
 */
const FILE_SEND_OUTCOME: Record<string, { readonly state: CardState; readonly title: Copy }> = {
  'allowed-once': { state: 'success', title: { zh: '已允许发送', en: 'Send allowed' } },
  rejected: { state: 'danger', title: { zh: '已拒绝发送', en: 'Send rejected' } },
  cancelled: { state: 'neutral', title: { zh: '请求已撤回', en: 'Request withdrawn' } },
  unavailable: { state: 'neutral', title: { zh: '无法发送', en: 'Could not be sent' } },
}

/**
 * The card a file approval is replaced with once decided — no live buttons, and
 * the decision legible from the ink alone.
 *
 * It names the same two things the live card named, and for the same reason it
 * named them that way: this card REPLACES the one the room read, so a record
 * that dropped the workspace would leave the room unable to tell later which
 * directory the file came out of — and one that spelled the absolute path would
 * put the host's layout back in the room the moment a decision was made.
 * @param input - the file, its workspace, the outcome, and who decided when someone did.
 * @returns a schema 2.0 card object.
 */
export function settledFileApprovalCard(input: {
  /** Where the file sits inside the workspace, derived from its canonical path. */
  readonly path: string
  /** The workspace's own name. */
  readonly workspace: string
  readonly outcome: string
  readonly decidedBy?: string | undefined
}): object {
  const settled = FILE_SEND_OUTCOME[input.outcome] ?? FILE_SEND_OUTCOME.cancelled!
  const path = clip(input.path, COMMAND_MAX_CHARS)
  // One line rather than the live card's two rows: a settled card carries no
  // labelled blocks, and the middot is the separator every other context line
  // here already uses.
  const where = `${clip(input.workspace, COMMAND_MAX_CHARS).shown} · ${path.shown}`
  // Who decided, named rather than withheld: with approvals open to a room, the
  // room should see whose press let the file out. The file itself stays in the
  // record too — a settled card that only said "allowed" would leave nobody
  // able to tell what was allowed.
  const context = input.decidedBy === undefined || input.decidedBy === ''
    ? where
    : join(fill(APPROVAL.decidedBy, where), input.decidedBy)
  return card(settled.state, join(settled.title, `：${path.shown}`, `: ${path.shown}`), [
    ...heading(settled.state, settled.title, context),
    ...footer(APPROVAL.closed),
  ])
}

/**
 * The card that carries one model question into the chat.
 * @param input - the question, its options, and each option's click payload.
 * @returns a schema 2.0 card object.
 */
export function questionCard(input: {
  readonly question: string
  readonly header?: string | undefined
  readonly options: readonly { readonly label: string; readonly description?: string | undefined }[]
  readonly valueFor: (index: number) => object
  /** Several answers may be chosen; the card then submits a set, not a press. */
  readonly multiSelect?: boolean | undefined
  /** The callback payload the submit button carries, for a multiple choice. */
  readonly submit?: object | undefined
}): object {
  // Bare labels fit a button row, which is the most obviously clickable shape
  // available; the moment any option needs a sentence to justify it, the whole
  // set becomes rows so the choices stay visually parallel.
  const explained = input.options.some(
    option => option.description !== undefined && option.description !== '',
  )
  const title = input.header ?? QUESTION.title
  return card('info', isCopy(title) ? title : { zh: title, en: title }, [
    ...heading('info', title, QUESTION.context),
    line(input.question, SIZE.body, '12px 20px 0px 20px'),
    ...input.options.length === 0
      ? []
      : input.multiSelect === true && input.submit !== undefined
        ? [multipleChoice(input.options, input.submit)]
        : explained
          ? input.options.map((option, index) => optionRow(option, input.valueFor(index)))
          // The first option carries the emphasis: by the tool's own convention
          // a recommendation is listed first, so a flat row of identical
          // buttons would throw away a signal the model already gave.
          : [actions(input.options.map((option, index) => ({
            label: option.label,
            value: input.valueFor(index),
            kind: index === 0 ? 'primary' as const : 'default' as const,
          })))],
    ...footer(
      input.options.length === 0
        ? QUESTION.replyOnly
        : input.multiSelect === true && input.submit !== undefined
          ? QUESTION.replyWithChoices
          : QUESTION.replyWithOptions,
    ),
  ])
}

/**
 * The card a question is replaced with once answered.
 * @param input - the question asked, and how it ended.
 * @returns a schema 2.0 card object.
 */
export function settledQuestionCard(input: {
  readonly question: string
  readonly header?: string | undefined
  readonly answer?: string | undefined
  readonly cancelled?: boolean | undefined
}): object {
  const state: CardState = input.cancelled === true ? 'neutral' : 'success'
  const title = input.cancelled === true ? QUESTION.cancelled : QUESTION.answered
  const answer = clip(input.answer ?? '', REASON_MAX_CHARS)
  const asked = input.header ?? QUESTION.title
  const summary = isCopy(asked)
    ? join(title, `：${asked.zh}`, `: ${asked.en}`)
    : join(title, `：${asked}`, `: ${asked}`)
  return card(state, summary, [
    ...heading(state, title, asked),
    line(input.question, SIZE.body, '12px 20px 0px 20px'),
    ...input.cancelled === true || input.answer === undefined || input.answer === ''
      ? []
      : [quoted(QUESTION.answer, answer.shown, 'grey-50', answer.hidden)],
    ...footer(input.cancelled === true ? QUESTION.dropped : QUESTION.received),
  ])
}

/** Every string the model picker and the status readout say. */
const MODEL = {
  title: { zh: '模型', en: 'Model' },
  context: { zh: '当前：%s', en: 'Currently: %s' },
  isDefault: { zh: '部署默认', en: 'deployment default' },
  inUse: { zh: '当前使用中', en: 'In use' },
  reset: { zh: '回到默认模型', en: 'Back to the default' },
  more: { zh: '目录里还有 %s 个，用下面的命令直接切换。', en: '%s more in the catalog — switch with the command below.' },
  empty: {
    zh: '本部署没有可枚举的模型目录，用 /model use <provider/model> 直接设置。',
    en: 'This deployment lists no catalog. Set a route with /model use <provider/model>.',
  },
  foot: {
    zh: '点选即可切换，上下文保留，下一条消息起生效；也可以直接发 /model use <provider/model>。',
    en: 'Pick one to switch — context is kept, effective from your next message. Or send /model use <provider/model>.',
  },
  summary: { zh: '模型：%s', en: 'Model: %s' },
}
const STATUS = {
  title: { zh: '本会话状态', en: 'This conversation' },
  subtitle: { zh: '你的下一条消息会怎么跑', en: 'What your next message will do' },
  workspace: { zh: '工作区', en: 'Workspace' },
  model: { zh: '模型', en: 'Model' },
  session: { zh: '会话', en: 'Session' },
  activity: { zh: '当前', en: 'Activity' },
  version: { zh: '版本', en: 'Version' },
  preset: { zh: '权限', en: 'Permissions' },
  presetOpen: { zh: '不沙箱，且不再弹审批卡', en: 'no sandbox, and no approval cards' },
  pending: { zh: '待审批', en: 'Awaiting approval' },
  context: { zh: '上下文', en: 'Context' },
  usage: { zh: '本会话用量', en: 'Tokens this session' },
  usageOf: {
    zh: '输入 %s · 输出 %s',
    en: '%s in · %s out',
  },
  cached: { zh: '，缓存命中 %s', en: ', %s cached' },
  compaction: { zh: '压缩', en: 'Compaction' },
  compactionOf: {
    zh: '已压缩 %s 次 · 累计折叠 %s',
    en: 'Compacted %s× · %s folded',
  },
  pendingCount: { zh: '%s 个审批卡片等待处理', en: '%s approval cards waiting' },
  isDefault: { zh: '部署默认', en: 'deployment default' },
  running: { zh: '正在跑一轮任务', en: 'Running a turn' },
  idle: { zh: '空闲', en: 'Idle' },
  unbound: { zh: '尚未创建，下一条消息会创建', en: 'Not created yet — your next message creates it' },
  refresh: { zh: '刷新', en: 'Refresh' },
  foot: {
    zh: '工作区用 /cd 切换，模型用 /model 切换，两者都只影响本会话。',
    en: 'Switch the workspace with /cd and the model with /model; both apply to this conversation only.',
  },
  summary: { zh: '本会话状态', en: 'This conversation' },
}

/**
 * The model picker: what this conversation runs on, and what else it could.
 *
 * The catalog is advertised, not exhaustive — the host's registry says so
 * itself — which is why the card never presents itself as the whole set of
 * choices and always names the typed form that can reach an unlisted route.
 * @param input - the current route and the routes worth offering.
 * @returns a schema 2.0 card object.
 */
export function modelCard(input: {
  readonly current: string
  readonly isDefault: boolean
  readonly entries: readonly {
    readonly label: string
    readonly detail?: string | undefined
    readonly current: boolean
    readonly value: object
  }[]
  readonly hidden: number
  readonly reset?: object | undefined
}): object {
  return card('info', fill(MODEL.summary, input.current), [
    ...heading(
      'info',
      MODEL.title,
      input.isDefault
        ? join(fill(MODEL.context, input.current), `（${MODEL.isDefault.zh}）`, ` (${MODEL.isDefault.en})`)
        : fill(MODEL.context, input.current),
    ),
    ...input.entries.length === 0 ? [line(MODEL.empty, SIZE.body, '12px 20px 0px 20px', 'grey')] : [],
    // The route in use is shown but not offered: a button that re-selects what
    // is already selected invites a click that can only be a no-op.
    ...input.entries.map(entry => entry.current
      ? settledRow(entry.label, entry.detail, MODEL.inUse)
      : optionRow({ label: entry.label, description: entry.detail }, entry.value)),
    ...input.hidden === 0 ? [] : [line(fill(MODEL.more, String(input.hidden)), SIZE.label, '10px 20px 0px 20px', 'grey')],
    ...input.reset === undefined ? [] : [actions([{ label: MODEL.reset, value: input.reset }], true)],
    ...footer(MODEL.foot),
  ])
}

/**
 * A row that states rather than offers: same shape as a pickable one, minus
 * the border and the click, so a list of choices keeps its rhythm where one
 * entry is the current answer.
 */
function settledRow(label: Line, detail: Line | undefined, note: Copy, ink: string = INK.info.token): object {
  return {
    tag: 'interactive_container',
    background_style: 'grey-50',
    corner_radius: '10px',
    has_border: false,
    padding: '12px 16px 12px 16px',
    direction: 'vertical',
    horizontal_spacing: '8px',
    vertical_spacing: '2px',
    horizontal_align: 'left',
    vertical_align: 'top',
    disabled: true,
    behaviors: [],
    margin: '8px 20px 0px 20px',
    elements: [
      line(label, SIZE.body, '0px 0px 0px 0px'),
      ...detail === undefined || detail === ''
        ? []
        : [line(detail, SIZE.label, '0px 0px 0px 0px', 'grey')],
      // The caller's own state ink: a card declares only the pair it uses, so
      // borrowing another card's token renders nothing and fails the card.
      line(note, SIZE.label, '2px 0px 0px 0px', ink),
    ],
  }
}

/**
 * The status readout: everything that decides what the next message does.
 * @param input - the resolved facts, and the payload its refresh carries.
 * @returns a schema 2.0 card object.
 */
export function statusCard(input: {
  readonly context?: { readonly used: number; readonly window?: number | undefined } | undefined
  readonly usage?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  } | undefined
  readonly workspace: string
  readonly workspaceIsDefault: boolean
  readonly route: string
  readonly routeIsDefault: boolean
  readonly sessionId: string
  readonly activity: 'running' | 'idle' | 'unbound'
  readonly pendingApprovals: number
  readonly version: string
  /** The permission preset in force, as the deployment defines it. */
  readonly preset?: PresetRow | undefined
  /**
   * How much of this session's history has been folded into a summary. Absent
   * where nothing has been, which is why the row disappears rather than
   * reading zero.
   */
  readonly compaction?: { readonly count: number; readonly foldedTokens: number } | undefined
  readonly refresh: object
}): object {
  return card('neutral', STATUS.summary, [
    ...heading('neutral', STATUS.title, STATUS.subtitle),
    panel([
      ...field(STATUS.workspace, input.workspace, input.workspaceIsDefault ? STATUS.isDefault : undefined, true),
      ...field(STATUS.model, input.route, input.routeIsDefault ? STATUS.isDefault : undefined),
      ...field(STATUS.activity, STATUS[input.activity]),
      ...input.preset === undefined
        ? []
        // Named where someone looks for it: a session that stopped asking
        // should not be something you discover by noticing no card arrived.
        : field(
          STATUS.preset,
          input.preset.value,
          isUnconfinedRow(input.preset) ? STATUS.presetOpen : undefined,
        ),
      ...input.pendingApprovals === 0
        ? []
        : field(STATUS.pending, fill(STATUS.pendingCount, String(input.pendingApprovals))),
      ...input.context === undefined
        ? []
        : field(STATUS.context, contextReading(input.context)),
      // Right under the context reading, because the two answer halves of one
      // question: what the next message carries, and what it no longer can.
      ...input.compaction === undefined
        ? []
        : field(STATUS.compaction, fill(
          fill(STATUS.compactionOf, String(input.compaction.count)),
          formatTokenCount(input.compaction.foldedTokens),
        )),
      ...input.usage === undefined
        ? []
        : field(STATUS.usage, join(
          fill(fill(STATUS.usageOf, formatTokenCount(input.usage.input)), formatTokenCount(input.usage.output)),
          input.usage.cacheRead === 0 ? '' : fill(STATUS.cached, formatTokenCount(input.usage.cacheRead)).zh,
          input.usage.cacheRead === 0 ? '' : fill(STATUS.cached, formatTokenCount(input.usage.cacheRead)).en,
        )),
      ...field(STATUS.session, input.sessionId),
      ...input.version === '' ? [] : field(STATUS.version, input.version),
    ]),
    actions([{ label: STATUS.refresh, value: input.refresh }], true),
    ...footer(STATUS.foot),
  ])
}

/** Every toast this channel raises, in the languages it raises them. */
export const TOAST = {
  allowed: { zh: '已允许执行一次', en: 'Allowed once' },
  rejected: { zh: '已拒绝', en: 'Rejected' },
  approvalGone: { zh: '该审批已失效', en: 'This request is no longer open' },
  notApprover: { zh: '你无权批准此操作', en: 'You are not allowed to approve this' },
  answered: { zh: '已作答', en: 'Answered' },
  questionGone: { zh: '该提问已结束', en: 'This question is closed' },
  modelSwitched: { zh: '已切换模型，下一条消息起生效', en: 'Model switched — effective from your next message' },
  modelUnchanged: { zh: '本会话已经在用这个模型', en: 'This conversation already uses that model' },
  modelReset: { zh: '已回到默认模型', en: 'Back to the default model' },
  modelUnreadable: { zh: '这个路由无法解析', en: 'That route could not be read' },
  refreshed: { zh: '已刷新', en: 'Refreshed' },
  notYours: { zh: '你无权修改本会话', en: 'You are not allowed to change this conversation' },
  presetSwitching: { zh: '正在切换…', en: 'Switching…' },
  presetFailed: { zh: '切换失败，看操作台日志', en: 'The switch failed; see the operator console' },
  presetQueued: {
    zh: '已记下，当前这轮任务结束后生效',
    en: 'Noted — it applies once the running turn finishes',
  },
} as const

/**
 * The toast one click raises, in the reader's own language.
 * @param type - which of the platform's four toast styles to use.
 * @param copy - what it says.
 * @returns the `toast` field of a card-action response.
 */
export function toast(type: 'success' | 'info' | 'error' | 'warning', copy: Copy): object {
  return { type, content: copy.zh, i18n: { zh_cn: copy.zh, en_us: copy.en } }
}

/** Every string the permission picker says. */
const PERMISSION = {
  title: { zh: '权限预设', en: 'Permission preset' },
  context: { zh: '这个会话能碰到什么，以及会不会问你', en: 'What this session may touch, and whether it asks' },
  inUse: { zh: '当前使用中', en: 'In use' },
  confined: {
    zh: '只能写工作区和临时目录；更宽的操作会弹审批卡。',
    en: 'Writes inside the workspace and temp dirs; anything wider raises an approval card.',
  },
  // The host's third shipped sandbox mode. A deployment that overrides the
  // preset table usually writes only `sandbox` and `approval` — the shipped
  // descriptions go with the defaults it replaced — so a row this channel can
  // explain from the mode alone is a row that stays explained.
  readOnly: {
    zh: '只读：不写任何文件；需要写的操作会弹审批卡。',
    en: 'Read-only: writes nothing; anything that needs to write raises an approval card.',
  },
  // The two halves apart, for a deployment that mixed them: this channel's own
  // words still describe what the table says, not what the name suggests.
  unsandboxed: {
    zh: '完全不沙箱：可以读写任何文件；越界的操作仍会弹审批卡。',
    en: 'No sandbox: any file may be read or written; anything wider still raises an approval card.',
  },
  unasked: {
    zh: '不再有审批卡——仍需审批的动作会被直接拒绝；沙箱边界不变。',
    en: 'No approval cards — anything still needing approval is refused outright; the sandbox is unchanged.',
  },
  unconfined: {
    zh: '完全不沙箱，且不再有审批卡——仍需审批的动作会被直接拒绝。重启后依然有效。',
    en: 'No sandbox at all, and no approval cards — anything still needing approval is refused. Survives a restart.',
  },
  summary: { zh: '权限预设：%s', en: 'Permission preset: %s' },
  unknown: { zh: '未知', en: 'unknown' },
  foot: {
    zh: '切换只影响本会话，随时可以切回；/status 里能看到当前是哪个。',
    en: 'A switch applies to this conversation only and is reversible; /status shows which one is in force.',
  },
}

/**
 * The permission picker: which preset is in force, and what the others mean.
 *
 * The unconfined row is a danger row on purpose. Its name reads like "allow
 * everything", while what it actually does is remove the sandbox AND stop the
 * asking — so the row says both, in the place where someone is about to press
 * it rather than in documentation they have not opened.
 * @param input - the presets, which one is current, and each row's payload.
 * @returns a schema 2.0 card object.
 */
export function permissionCard(input: {
  readonly current?: string | undefined
  readonly presets: readonly PresetRow[]
  readonly valueFor: (preset: string) => object
}): object {
  const current = input.current ?? PERMISSION.unknown.zh
  return card('warning', fill(PERMISSION.summary, current), [
    ...heading('warning', PERMISSION.title, PERMISSION.context),
    ...input.presets.map(preset => preset.value === input.current
      ? settledRow(labelOf(preset), describePreset(preset), PERMISSION.inUse, INK.warning.token)
      : optionRow(
        { label: labelOf(preset), description: describePreset(preset) },
        input.valueFor(preset.value),
      )),
    ...footer(PERMISSION.foot),
  ])
}

/**
 * One preset as a card row: what the host called it, and what the host says it
 * does. Both optional, because a deployment may publish neither.
 */
export interface PresetRow {
  readonly value: string
  readonly name?: string | undefined
  readonly description?: string | undefined
  /** What the preset does, when the deployment's table could be read. */
  readonly sandbox?: string | undefined
  readonly approval?: string | undefined
}

/**
 * How a row is labelled: the preset's own value, which is what a person types
 * into `/permission`, with the host's display name beside it when it differs.
 * @param preset - the row's preset.
 * @returns the label line.
 */
function labelOf(preset: PresetRow): string {
  return preset.name === undefined || preset.name === preset.value
    ? preset.value
    : `${preset.value} · ${preset.name}`
}

/** What the settled picker says, in each of its two endings. */
const PERMISSION_SETTLED = {
  done: { zh: '已切到 %s', en: 'Switched to %s' },
  switching: { zh: '正在切到 %s…', en: 'Switching to %s…' },
  held: { zh: '本轮任务结束后切到 %s', en: 'Switching to %s once the running turn ends' },
  switchingContext: {
    zh: '切换完成后这张卡片会自己更新',
    en: 'This card updates itself once the switch lands',
  },
  heldContext: {
    zh: '会话日志同一时刻只能有一个写入者，所以不在任务中途改',
    en: 'A session log takes one writer at a time, so it is not changed mid-turn',
  },
  foot: { zh: '要再改的话，发一次 /permission。', en: 'Send /permission again to change it.' },
  /** For a preset only the deployment knows, where there is nothing to explain. */
  plain: { zh: '本会话的权限预设', en: "This conversation's permission preset" },
}

/**
 * The card a picker is replaced with once a preset was chosen.
 *
 * A picker that stays live after the choice invites pressing what is already
 * true, so it settles the way an approval does: the decision stated, nothing
 * clickable, and the way back said out loud rather than assumed.
 * @param input - the preset chosen, and whether it is in force yet.
 * @returns a schema 2.0 card object.
 */
export function settledPermissionCard(input: {
  /** The preset as this deployment defines it, not merely as it is named. */
  readonly preset: PresetRow
  /** Where the switch is: asked for, waiting on a turn, or in force. */
  readonly stage?: 'switching' | 'held' | 'done' | undefined
}): object {
  const stage = input.stage ?? 'done'
  const state: CardState = isUnconfinedRow(input.preset) ? 'warning' : 'success'
  const title = fill(PERMISSION_SETTLED[stage], input.preset.value)
  const context = stage === 'done'
    ? describePreset(input.preset) ?? PERMISSION_SETTLED.plain
    : stage === 'held' ? PERMISSION_SETTLED.heldContext : PERMISSION_SETTLED.switchingContext
  return card(state, title, [
    ...heading(state, title, context),
    // Only a landed switch says how to change it back; while one is in flight
    // that sentence would read as an invitation to press something else.
    ...stage === 'done' ? footer(PERMISSION_SETTLED.foot) : [],
  ])
}

/**
 * Whether one row is the preset this channel's loudest copy describes: no
 * sandbox AND no more asking. Judged from the deployment's table when it can
 * be read, and from the name only when it cannot — because then the name is
 * the only thing anyone, including this channel, has to go on.
 * @param row - the preset row.
 * @returns true when both halves hold.
 */
function isUnconfinedRow(row: PresetRow): boolean {
  if (row.sandbox !== undefined || row.approval !== undefined) {
    return row.sandbox === 'danger-full-access' && row.approval === 'never'
  }
  return row.value === UNCONFINED_LABEL
}

/**
 * What one preset means, for the row that offers it.
 *
 * This channel's own words for the two shipped presets — the unconfined one
 * needs saying that it also stops the asking, which the host's one-line
 * description does not — and the host's own text for everything else, left in
 * whatever language it was written in rather than guessed at.
 * @param preset - the row's preset.
 * @returns the description, or undefined when nobody described it.
 */
function describePreset(preset: PresetRow | string): Line | undefined {
  const row: PresetRow = typeof preset === 'string' ? { value: preset } : preset
  // What it DOES decides what it is called here. A deployment writes its own
  // table, so a preset named `workspace-write` can be unconfined underneath —
  // and describing it from the name would ask a room to authorize one thing
  // while granting another.
  if (row.sandbox !== undefined || row.approval !== undefined) {
    if (row.sandbox === 'danger-full-access' && row.approval === 'never') return PERMISSION.unconfined
    if (row.sandbox === 'danger-full-access') return PERMISSION.unsandboxed
    if (row.approval === 'never') return PERMISSION.unasked
    if (row.sandbox === 'read-only') return PERMISSION.readOnly
    if (row.sandbox === 'workspace-write') return PERMISSION.confined
    return row.description
  }
  // Nothing readable about what it does: the name is all there is, and these
  // three are the modes this channel ships against.
  if (row.value === UNCONFINED_LABEL) return PERMISSION.unconfined
  if (row.value === 'workspace-write') return PERMISSION.confined
  if (row.value === 'read-only') return PERMISSION.readOnly
  return row.description
}
