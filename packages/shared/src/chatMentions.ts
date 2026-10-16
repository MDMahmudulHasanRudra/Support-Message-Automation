/**
 * WhatsApp Chat v2 (CHAT_UI_V2.md): who may be @-mentioned in a reply, and checking a request.
 *
 * WhatsApp names a mentioned person by their id. This product only ever sends a mention for an id that
 * is PROVABLY a phone number — `<digits>@c.us`, as WhatsApp itself delivered it on a stored message, or a
 * roster member's number that a person typed (`hasReachablePhoneNumber`). A LID (`…@lid`) is an opaque
 * private id: it is never offered, never converted into a "number", and a mention is never invented
 * for it. The text must carry `@<digits>` for each mention, because that is what WhatsApp turns into the
 * highlighted name on the reader's phone.
 *
 * The server recomputes the candidates on every send and refuses anything outside them — the browser's
 * list is a convenience, not the authority.
 */

export const MAX_MENTIONS = 20;

/** The digits of a phone-number WhatsApp id (`8801…@c.us` / `@s.whatsapp.net`), else null. */
export function phoneJidDigits(jid: string | null | undefined): string | null {
  const match = /^(\d{8,15})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(String(jid ?? "").trim());
  return match ? match[1]! : null;
}

/** The canonical id a mention is sent with. */
export function mentionJidForDigits(digits: string): string {
  return `${digits}@c.us`;
}

export interface MentionCandidate {
  /** `<digits>@c.us` — what is sent. */
  jid: string;
  /** What the picker shows: the roster name, else their WhatsApp name, else the number. */
  label: string;
  /** Why this person is offered: they wrote in this group, or they are on the roster and wrote here. */
  source: "SENDER" | "TEAM_MEMBER";
}

export type MentionCheck = { ok: true; mentions: string[] } | { ok: false; error: string };

/**
 * Checks a requested mention list against the server's own candidate ids and the message text.
 * Duplicates collapse; order is kept.
 */
export function validateMentions(requested: unknown, candidateJids: ReadonlySet<string>, body: string): MentionCheck {
  if (requested === undefined || requested === null || requested === "") return { ok: true, mentions: [] };
  if (!Array.isArray(requested)) return { ok: false, error: "The mention list was not readable. Nothing was sent." };
  const mentions: string[] = [];
  for (const value of requested) {
    if (typeof value !== "string") return { ok: false, error: "The mention list was not readable. Nothing was sent." };
    const digits = phoneJidDigits(value);
    if (!digits) return { ok: false, error: "Only a person with a phone number WhatsApp has shared can be tagged. Nothing was sent." };
    const jid = mentionJidForDigits(digits);
    if (mentions.includes(jid)) continue;
    if (!candidateJids.has(jid)) {
      return { ok: false, error: "One of the people tagged has not written in this group, so they cannot be tagged from here. Nothing was sent." };
    }
    if (!new RegExp(`@${digits}(?!\\d)`).test(body)) {
      return { ok: false, error: "A tagged person's @number is no longer in the message. Tag them again, or remove the tag. Nothing was sent." };
    }
    mentions.push(jid);
  }
  if (mentions.length > MAX_MENTIONS) return { ok: false, error: `Tag at most ${MAX_MENTIONS} people in one message.` };
  return { ok: true, mentions };
}
