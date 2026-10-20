import { normalizePhoneNumber } from "../groupParticipantAdd.js";
import { whatsappIdKey } from "../whatsappIdentity.js";

/**
 * Which "needs attention" badge a roster row shows for a member whose stored WhatsApp ID is only their phone
 * number (unified reporting WP11). DISPLAY ONLY: `hasReachablePhoneNumber` and every sending rule are
 * untouched, and nothing is attributed or stored from this.
 *
 *  - `UNLINKED_BD_MOBILE`: the stored ID equals the phone, and that value is a Bangladeshi mobile number
 *    (8801[3-9] and 8 more digits). A real number was typed, so what is missing is the private WhatsApp ID
 *    WhatsApp shows this person by in groups: "WhatsApp ID not linked", fixed with Link in the Identity check.
 *  - `NEEDS_PHONE`: the stored ID equals the phone and is NOT such a number (typically a private ID that was
 *    stored in both fields). Nobody ever typed a number: "Needs phone number", as before.
 *  - `NONE`: the ID is empty or differs from the phone.
 */
export const BD_MOBILE_PATTERN = /^8801[3-9]\d{8}$/;

export type WhatsAppIdBadge = "NONE" | "NEEDS_PHONE" | "UNLINKED_BD_MOBILE";

export function whatsappIdBadge(member: { phoneNumber: string; whatsappId: string | null }): WhatsAppIdBadge {
  const idKey = whatsappIdKey(member.whatsappId);
  if (!idKey) return "NONE";
  // The same comparison the old badge made ("the stored id is only the phone"), on digits so "+8801…" equals "8801…".
  const idDigits = normalizePhoneNumber(idKey);
  const phoneDigits = normalizePhoneNumber(member.phoneNumber);
  const equal = idDigits !== null && idDigits === phoneDigits;
  // A value that has no digit form (cannot be a number) still counts as "equal" when the raw text is the same.
  const rawEqual = (member.whatsappId ?? "").trim() === member.phoneNumber.trim();
  if (!equal && !rawEqual) return "NONE";
  return idDigits !== null && BD_MOBILE_PATTERN.test(idDigits) ? "UNLINKED_BD_MOBILE" : "NEEDS_PHONE";
}
