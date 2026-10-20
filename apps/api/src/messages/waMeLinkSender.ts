// The MVP MessageSender (ADR-0003, option ג): it sends nothing over the network. It renders the
// message text (renderMessage, packages/shared) into a `https://wa.me/<phone>?text=<text>` link;
// the collector app shows it as a "שלח" button, which opens WhatsApp on Yoel's phone with the
// message already written, and Yoel taps "send" from his own number.
import { e164MobileSchema, renderMessage, type OutgoingMessage } from '@bottlerun/shared';
import type { MessageSender, SendResult } from './messageSender.ts';

/**
 * The phone part of a wa.me link: the E.164 number without its `+` (`+972501234567` →
 * `972501234567`). wa.me wants the full international number with no `+`, no leading 0 and no
 * separators; a stored phone is already E.164, so dropping the `+` is all it takes.
 *
 * @returns null for anything that is not a stored Israeli mobile (`+9725XXXXXXXX`, the shared
 *   `e164MobileSchema`): a local `050…`, a bare `972…`, a landline, an empty string.
 */
export function waMePhone(e164: string): string | null {
  return e164MobileSchema.safeParse(e164).success ? e164.slice(1) : null;
}

// Lone UTF-16 surrogates (half of an emoji, e.g. a name cut in the middle of one). In a `u` regex
// a character class of surrogates matches only unpaired ones; a proper pair is one code point.
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;

// The characters encodeURIComponent leaves as they are although RFC 3986 reserves them.
const RFC3986_RESERVED_LEFT_RAW = /[!'()*]/g;

/**
 * `text` percent-encoded for the `text` parameter of a wa.me link, strictly (RFC 3986, MDN's
 * `fixedEncodeURIComponent`): `encodeURIComponent` plus `!'()*`. So a space is `%20` (never `+`,
 * which some apps would show as a plus), a line break is `%0A`, and Hebrew becomes its UTF-8
 * bytes (`ש` → `%D7%A9`). Only `A-Z a-z 0-9 - _ . ~` stay raw; `decodeURIComponent` gives the
 * text back exactly.
 *
 * A lone surrogate, on which encodeURIComponent would throw, becomes U+FFFD (the replacement
 * character), like `String.prototype.toWellFormed`: one odd character is better than no link.
 */
export function encodeWaMeText(text: string): string {
  return encodeURIComponent(text.replace(LONE_SURROGATE, '\uFFFD')).replace(
    RFC3986_RESERVED_LEFT_RAW,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The wa.me "click to chat" link that opens WhatsApp on a chat with `e164`, with `text` already
 * written: `https://wa.me/972501234567?text=<encodeWaMeText(text)>`.
 *
 * @returns null when `e164` is not a stored Israeli mobile (see {@link waMePhone}).
 */
export function waMeUrl(e164: string, text: string): string | null {
  const phone = waMePhone(e164);
  return phone === null ? null : linkTo(phone, text);
}

/** The wa.me link for `phone`, already in wa.me's digits-only form ({@link waMePhone}). */
function linkTo(phone: string, text: string): string {
  return `https://wa.me/${phone}?text=${encodeWaMeText(text)}`;
}

/**
 * {@link MessageSender} that prepares a wa.me link for Yoel to open and send by hand (ADR-0003).
 * Nothing goes over the network, and nobody can know whether Yoel then really sent the message,
 * so the result is always `manual` (or `failed`), never `sent`.
 */
export class WaMeLinkSender implements MessageSender {
  /**
   * Resolves `{ mode: 'manual', url }` with the wa.me link of the rendered message, or
   * `{ mode: 'failed', reason: 'invalid_phone' }` when `message.to` is not an E.164 Israeli mobile
   * (no link can reach it; the reason holds no phone, since it is stored and may be logged).
   *
   * Rejects with renderMessage's RangeError when the message cannot be rendered (a
   * `confirmRequest` without a valid date, a malformed `pickupBy`): that is a bug in the caller,
   * not an expected failure.
   */
  send(message: OutgoingMessage): Promise<SendResult> {
    // The executor runs now; a throw inside it rejects the promise instead of escaping `send`.
    return new Promise((resolve) => {
      resolve(waMeResult(message));
    });
  }
}

/** The wa.me result for `message`; throws when the text cannot be rendered. */
function waMeResult(message: OutgoingMessage): SendResult {
  // The phone first: a number no link can reach fails the same way whatever the text.
  const phone = waMePhone(message.to);
  if (phone === null) return { mode: 'failed', reason: 'invalid_phone' };
  const text = renderMessage(message.kind, message.vars, message.personalText);
  return { mode: 'manual', url: linkTo(phone, text) };
}
