/**
 * The two values every layer here eventually has to spell out for a reader: how
 * big something is, and what went wrong.
 *
 * Both had copies. A size was formatted twice — the card dividing by 1024 and
 * labelling the result `KB`, the note beside it dividing by 1024 and labelling
 * it `KiB` — so one 25 MiB file read as two different sizes depending on which
 * surface you looked at. A failure was rendered in three byte-identical places.
 * A copy is exactly where a unit label drifts from the arithmetic under it, so
 * there is one of each here: binary steps with binary labels, in whichever voice
 * the reader is being addressed in.
 * @module dsh-lark-channel/format
 */

/** Units past a byte, in the order a size climbs through them. */
const BINARY_UNITS = ['KiB', 'MiB', 'GiB', 'TiB'] as const

/**
 * A size at a glance: binary steps with the labels binary steps actually have,
 * one decimal once it leaves bytes, and no `.0` on a whole one.
 *
 * The unit for a raw count is the caller's, because that is the one word of this
 * that a reader reads in their own language — `字节` in the chat, `bytes` to the
 * model, `B` on a card. Everything above it needs no translation.
 * @param bytes - the count.
 * @param byteUnit - what a raw count is called.
 * @returns the short form, such as `1.2 MiB`, `840 KiB` or `12 B`.
 */
export function formatByteSize(bytes: number, byteUnit = 'B'): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  let unit = byteUnit
  let stepped = false
  for (const larger of BINARY_UNITS) {
    // The ROUNDED value decides the band, because the rounded value is what
    // gets printed: 1023.95 KiB renders as `1024.0 KiB` otherwise, a size
    // spelled in one unit that reads as the next one up.
    if (Number(value.toFixed(1)) < 1024) break
    value /= 1024
    unit = larger
    stepped = true
  }
  const digits = stepped ? value.toFixed(1) : String(Math.round(value))
  return `${digits.endsWith('.0') ? digits.slice(0, -2) : digits} ${unit}`
}

/**
 * A size for a human reading the chat.
 * @param bytes - the count.
 * @returns the Chinese-facing short form.
 */
export function formatBytesForChat(bytes: number): string {
  return formatByteSize(bytes, '字节')
}

/**
 * A size for the model reading a tool error.
 * @param bytes - the count.
 * @returns the English short form.
 */
export function formatBytesForModel(bytes: number): string {
  return formatByteSize(bytes, bytes === 1 ? 'byte' : 'bytes')
}

/**
 * Render a handled failure as one readable detail.
 * @param error - the rejection value, which need not be an `Error`.
 * @returns the message, or the stringified value for a non-error rejection.
 */
export function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
