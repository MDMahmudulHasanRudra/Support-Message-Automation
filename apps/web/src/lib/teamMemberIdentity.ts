import { normalizePhoneNumber } from "@support-automation/shared";

/**
 * How a person picked out of a group is stored on the team roster.
 *
 * A LID only identifies them, so it is their WhatsApp ID (and, because a number is required, stands
 * in as one until somebody types the real number). A PHONE number is a number: stored as one, with
 * no WhatsApp ID. Storing it in both made `hasReachablePhoneNumber` read a real, dialable number as
 * "needs a phone number", so these people got no escalation or alert messages, and linking their LID
 * from the chat later was refused. Of unknown kind, a Bangladeshi mobile number is a number; anything
 * else is kept as an id, as before.
 */
export function rosterEntryFromGroup(
  name: string,
  identifier: string,
  kind: "LID" | "PHONE" | null,
): { name: string; phoneNumber: string; whatsappId: string | null } {
  const digits = normalizePhoneNumber(identifier) ?? identifier;
  const isPhone = kind === "PHONE" || (kind === null && /^8801\d{9}$/.test(digits));
  return isPhone ? { name, phoneNumber: `+${digits}`, whatsappId: null } : { name, phoneNumber: identifier, whatsappId: identifier };
}

/** The checkbox value Add from group posts: the identifier's kind as a prefix, then `|name`. */
export function addFromGroupValue(candidate: { phoneNumber: string; idKind: string | null; suggestedName: string | null }): string {
  const prefix = candidate.idKind === "LID" ? "lid:" : candidate.idKind === "PHONE" ? "pn:" : "";
  return `${prefix}${candidate.phoneNumber}|${candidate.suggestedName ?? ""}`;
}
