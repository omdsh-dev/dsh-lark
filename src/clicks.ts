/**
 * What makes one rendering of a control card's buttons distinct from the next.
 *
 * The transport drops a repeated card action for twelve hours, identifying it
 * by the message, the operator, and the button's own payload — which is right
 * for the platform's redelivery of one event, and wrong for a person pressing
 * the same button again on a card that stays in the chat. Refresh, pick a
 * model, switch a preset, then want any of them again: the second press
 * carries the same payload, so it never arrives, and the chat looks broken.
 *
 * So every payload a persistent control card hands out carries a mark that
 * changes each time the card is drawn. Pressing again after a repaint is a
 * different event; the same press redelivered by the platform is still the
 * same one. Single-use cards — an approval, a question — need none: they are
 * published once per question and settle when answered.
 * @module dsh-lark-channel/clicks
 */

/** Marks issued this process, so two payloads built in the same millisecond differ. */
let issued = 0

/**
 * One mark, unique across renderings and across restarts.
 * @returns the mark, short enough to leave the payload readable.
 */
export function clickMark(): string {
  issued += 1
  return `${Date.now().toString(36)}${issued.toString(36)}`
}

/**
 * Stamp a button payload with the rendering it belongs to.
 *
 * The mark is named `a` and inserted FIRST for one reason: the transport
 * identifies an action by the first 128 characters of the serialized payload,
 * and these payloads are longer than that. First by insertion order keeps it
 * inside that window as written, and first alphabetically keeps it there for
 * anything that re-serializes with sorted keys on the way back.
 * @param value - the payload the button carries.
 * @returns the same payload, marked.
 */
export function marked<T extends object>(value: T): T & { readonly a: string } {
  return { a: clickMark(), ...value }
}
