import { DHAKA_OFFSET_MS, isLocalBangladeshMobile, normalizePhoneNumber, whatsappIdKey } from "@support-automation/shared";

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

/**
 * The identifier fields of a team member, read and checked the ONE way the save actions and the impact
 * preview both read them (so a preview can never accept what Save would refuse).
 *
 * A local Bangladeshi number ("01...") is stored with its country code, the form WhatsApp delivers and
 * the form a direct message needs; anything else is kept as typed. The WhatsApp id is the id as the
 * worker stores a sender: no "@lid" / "@c.us" suffix and no device part.
 */
export function readIdentityFields(input: {
  phoneNumber: string;
  whatsappId: string | null | undefined;
}): { phoneNumber: string; whatsappId: string | null } | { error: string } {
  const typedPhone = input.phoneNumber.trim();
  const typedDigits = typedPhone.replace(/\D/g, "");
  const phoneNumber = isLocalBangladeshMobile(typedDigits) ? `+88${typedDigits}` : typedPhone;
  const whatsappId = whatsappIdKey(String(input.whatsappId ?? "").replace(/\s+/g, ""));
  if (!phoneNumber) return { error: "Name, phone number and designation are all required." };
  if (!normalizePhoneNumber(phoneNumber)) {
    return { error: "That does not look like a phone number. Enter it with the country code, e.g. +8801XXXXXXXXX." };
  }
  if (whatsappId && !/^\d{6,}$/.test(whatsappId)) {
    return { error: "The WhatsApp ID is digits only (for example 145938777669643). Leave it empty if you do not have one." };
  }
  return { phoneNumber, whatsappId };
}

/** Dhaka midnight of a YYYY-MM-DD in a year a roster can mean, or undefined for anything else. */
export function dhakaDayStart(key: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 2000 || y > 2999) return undefined;
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) return undefined;
  return new Date(utc.getTime() - DHAKA_OFFSET_MS);
}
