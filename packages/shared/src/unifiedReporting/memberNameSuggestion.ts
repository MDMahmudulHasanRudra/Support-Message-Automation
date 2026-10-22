import { normalizePhoneNumber } from "../groupParticipantAdd.js";
import { whatsappIdKey } from "../whatsappIdentity.js";

/**
 * "Probably <member>" for an unknown sender (unified reporting WP11).
 *
 * The Team Members Identity check lists senders nobody on the roster matches. WhatsApp shows each with a
 * display name, and a colleague who is on the roster by phone number often appears there under the same
 * name, with their private WhatsApp ID (a LID) never linked. This compares the two NAMES and says which
 * roster member the sender might be.
 *
 * It is a SUGGESTION and nothing more: display only, never a link, never a change to how any message is
 * attributed. A person presses Link (the same server path as WhatsApp Chat's "This person is..."), or does
 * not. Names are weak evidence, so every ambiguity ends in "no single suggestion":
 *   - several members match: `SEVERAL`, never the first one;
 *   - a one-word containment ("Rina" inside "Rina Akter") is not a match;
 *   - only a member who could actually be the missing half is offered (see `isSuggestable`).
 * No identifier is derived from a name, and a LID is never turned into a phone number.
 */

export const NAME_SUGGESTION_VERSION = "name-suggestion-1";
/** A contained name needs at least this many words, so a first name alone never matches a longer one. */
export const MIN_CONTAINED_TOKENS = 2;

/**
 * A name as a set of comparable words: case folded, Latin diacritics removed, every punctuation mark and
 * symbol a separator, whitespace collapsed. Only U+0300-U+036F is stripped: those are the Latin accents,
 * whereas Bengali vowel signs are combining marks too and are part of the letters, not decoration.
 */
export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  const folded = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
  return folded ? [...new Set(folded.split(/\s+/))] : [];
}

/**
 * Whether two names are, as far as names can say, the same person: the same set of words in any order, or
 * one name's words all inside the other's with at least `MIN_CONTAINED_TOKENS` words (a display name with an
 * extra word such as the company, "Rina Akter SoftifyBD").
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const sa = new Set(ta);
  const sb = new Set(tb);
  if (sa.size === sb.size && ta.every((t) => sb.has(t))) return true;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  return small.size >= MIN_CONTAINED_TOKENS && [...small].every((t) => large.has(t));
}

export interface SuggestableMember {
  id: string;
  name: string;
  phoneNumber: string;
  whatsappId: string | null;
  /** Whether any stored message in the check's window matched this member's identifiers. */
  matchedRecently: boolean;
}

/** A stored WhatsApp ID that is empty, or only the member's own phone number (no identity anybody chose). */
export function hasNoRealWhatsAppId(member: Pick<SuggestableMember, "phoneNumber" | "whatsappId">): boolean {
  const key = whatsappIdKey(member.whatsappId);
  if (!key) return true;
  const stored = normalizePhoneNumber(key);
  return stored !== null && stored === normalizePhoneNumber(member.phoneNumber);
}

/** Only a member who matched no message recently, or who has no real WhatsApp ID, can be the missing half of a sender. */
export function isSuggestable(member: SuggestableMember): boolean {
  return !member.matchedRecently || hasNoRealWhatsAppId(member);
}

export type MemberSuggestion =
  | { kind: "NONE" }
  | { kind: "ONE"; memberId: string }
  | { kind: "SEVERAL"; memberIds: string[] };

/** The roster member an unknown sender's WhatsApp display name probably belongs to. Several candidates = no single suggestion. */
export function suggestMemberForSender(senderName: string | null | undefined, members: readonly SuggestableMember[]): MemberSuggestion {
  if (nameTokens(senderName).length === 0) return { kind: "NONE" };
  const matches = members.filter((m) => isSuggestable(m) && namesMatch(senderName, m.name)).map((m) => m.id).sort();
  if (matches.length === 0) return { kind: "NONE" };
  return matches.length === 1 ? { kind: "ONE", memberId: matches[0]! } : { kind: "SEVERAL", memberIds: matches };
}
