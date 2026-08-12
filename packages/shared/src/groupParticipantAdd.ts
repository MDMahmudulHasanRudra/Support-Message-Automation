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
