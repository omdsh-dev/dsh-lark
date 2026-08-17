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
  option: { readonly label: string; readonly description?: string | undefined },
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
 * A token count at a glance: thousands past a thousand, whole below it. An
 * exact 127,431 is a number to parse; 127.4k is a number to read.
 * @param tokens - the count.
 * @returns the short form.
 */
function compactCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const thousands = tokens / 1000
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`
}

/** Units past a byte, in the order a size climbs through them. */
const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/**
 * A file size at a glance: binary steps, one decimal once it leaves bytes, and
 * no `.0` on a whole one.
 *
 * A bare `string` rather than a {@link Copy}, because digits and a unit symbol
 * read identically in both languages — a translated pair would only give the
 * two halves a way to drift apart while saying the same thing.
 * @param bytes - the size on disk.
 * @returns the short form, such as `1.2 MB`, `840 KB` or `12 B`.
 */
function formatBytes(bytes: number): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  let unit = 'B'
  for (const larger of BYTE_UNITS) {
    if (value < 1024) break
    value /= 1024
    unit = larger
  }
  const digits = unit === 'B' ? String(Math.round(value)) : value.toFixed(1)
  return `${digits.endsWith('.0') ? digits.slice(0, -2) : digits} ${unit}`
}

/**
 * How full the context is: what the next request carries, and — when the
 * provider says how big the window is — the share of it that leaves.
 * @param context - the used tokens and the window they sit in.
 * @returns the reading, localized.
 */
function contextReading(context: { readonly used: number; readonly window?: number | undefined }): Copy {
  const used = compactCount(context.used)
  const window = context.window
  if (window === undefined || window <= 0) return { zh: used, en: used }
  const share = Math.round((context.used / window) * 100)
  return {
    zh: `${used} / ${compactCount(window)}（${share}%）`,
    en: `${used} / ${compactCount(window)} (${share}%)`,
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
  readonly allow: object
  readonly reject: object
}): object {
  const command = clip(input.command ?? '', COMMAND_MAX_CHARS)
  const reason = clip(input.reason ?? '', REASON_MAX_CHARS)
  return card('warning', fill(APPROVAL.summary, input.toolName), [
    ...heading('warning', APPROVAL.title, fill(APPROVAL.context, input.toolName)),
    ...command.shown === '' ? [] : [quoted(APPROVAL.command, command.shown, 'grey-50', command.hidden)],
    ...reason.shown === '' ? [] : [quoted(APPROVAL.reason, reason.shown, 'orange-50', reason.hidden)],
    actions([
      { label: APPROVAL.allow, value: input.allow, kind: 'primary' },
      { label: APPROVAL.reject, value: input.reject, kind: 'danger' },
    ]),
    ...footer(APPROVAL.foot),
  ])
}

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
  title: { zh: '需要你的授权', en: 'Approval needed' },
  context: { zh: 'Agent 想把一个文件发到这个群', en: 'The agent wants to send a file to this group' },
  path: { zh: '文件', en: 'File' },
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
 * The path and the size are the whole card: an approver who cannot see what is
 * leaving cannot judge whether it may leave, which is the same reason the tool
 * approval prints its command verbatim. The path arrives canonical and is shown
 * that way — a prettified or shortened form would let a symlink present itself
 * as a file the room believes it is approving.
 * @param input - the file being offered, and the payloads its buttons carry.
 * @returns a schema 2.0 card object.
 */
export function fileApprovalCard(input: {
  readonly path: string
  readonly bytes: number
  readonly allow: object
  readonly reject: object
}): object {
  const path = clip(input.path, COMMAND_MAX_CHARS)
  return card('warning', join(FILE_SEND.title, `：${path.shown}`, `: ${path.shown}`), [
    ...heading('warning', FILE_SEND.title, FILE_SEND.context),
    quoted(FILE_SEND.path, path.shown, 'grey-50', path.hidden),
    quoted(FILE_SEND.size, formatBytes(input.bytes), 'grey-50'),
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
 * @param input - the file, the outcome, and who decided when someone did.
 * @returns a schema 2.0 card object.
 */
export function settledFileApprovalCard(input: {
  readonly path: string
  readonly outcome: string
  readonly decidedBy?: string | undefined
}): object {
  const settled = FILE_SEND_OUTCOME[input.outcome] ?? FILE_SEND_OUTCOME.cancelled!
  const path = clip(input.path, COMMAND_MAX_CHARS)
  // Who decided, named rather than withheld: with approvals open to a room, the
  // room should see whose press let the file out. The file itself stays in the
  // record too — a settled card that only said "allowed" would leave nobody
  // able to tell what was allowed.
  const context = input.decidedBy === undefined || input.decidedBy === ''
    ? path.shown
    : join(fill(APPROVAL.decidedBy, path.shown), input.decidedBy)
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
  pending: { zh: '待审批', en: 'Awaiting approval' },
  context: { zh: '上下文', en: 'Context' },
  usage: { zh: '本会话用量', en: 'Tokens this session' },
  usageOf: {
    zh: '输入 %s · 输出 %s',
    en: '%s in · %s out',
  },
  cached: { zh: '，缓存命中 %s', en: ', %s cached' },
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
function settledRow(label: string, detail: string | undefined, note: Copy): object {
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
      line(note, SIZE.label, '2px 0px 0px 0px', INK.info.token),
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
  readonly refresh: object
}): object {
  return card('neutral', STATUS.summary, [
    ...heading('neutral', STATUS.title, STATUS.subtitle),
    panel([
      ...field(STATUS.workspace, input.workspace, input.workspaceIsDefault ? STATUS.isDefault : undefined, true),
      ...field(STATUS.model, input.route, input.routeIsDefault ? STATUS.isDefault : undefined),
      ...field(STATUS.activity, STATUS[input.activity]),
      ...input.pendingApprovals === 0
        ? []
        : field(STATUS.pending, fill(STATUS.pendingCount, String(input.pendingApprovals))),
      ...input.context === undefined
        ? []
        : field(STATUS.context, contextReading(input.context)),
      ...input.usage === undefined
        ? []
        : field(STATUS.usage, join(
          fill(fill(STATUS.usageOf, compactCount(input.usage.input)), compactCount(input.usage.output)),
          input.usage.cacheRead === 0 ? '' : fill(STATUS.cached, compactCount(input.usage.cacheRead)).zh,
          input.usage.cacheRead === 0 ? '' : fill(STATUS.cached, compactCount(input.usage.cacheRead)).en,
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
