const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15; // E.164 max, including country code

/**
 * Normalizes a user-typed phone number (with or without "+", spaces,
 * dashes, parentheses) down to the digits-only form OpenWA's ContactId
 * expects (`<digits>@c.us`). Returns null if it doesn't look like a real
 * phone number, so callers can reject bad input before ever touching the
 * WhatsApp session.
 */
export function normalizePhoneNumber(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return null;
  return digits;
}

/**
 * Whether a team member's stored `phoneNumber` is a number you can actually message.
 *
 * WhatsApp identifies group participants by a "LID" now — an opaque 14-15 digit id that is
 * deliberately not their phone number. Adding someone from message history is the only way to map
 * them, and all that history carries is the LID, so it is stored as both their `whatsappId` and,
 * because `phoneNumber` is required and unique, as their `phoneNumber` too.
 *
 * That is fine for RECOGNISING them — matching is by identifier. It is not fine for MESSAGING
 * them: a direct message to a LID goes nowhere. The two are equal exactly when no human ever typed
 * a real number, which is what this checks.
 *
 * Used before any send addressed to a person rather than a group, so a support escalation that
 * cannot reach someone says so instead of failing quietly.
 */
export function hasReachablePhoneNumber(member: {
  phoneNumber: string;
  whatsappId?: string | null;
}): boolean {
  if (!member.whatsappId) return true;
  return member.phoneNumber.trim() !== member.whatsappId.trim();
}

/** Turns a normalized digits-only phone number into a 1:1 WhatsApp chat id (OpenWA's ContactId format). */
export function buildWhatsAppContactId(digitsOnlyPhone: string): string {
  return `${digitsOnlyPhone}@c.us`;
}
