import { normalizePhoneNumber } from "@support-automation/shared";
import type { GroupParticipant, WhatsAppProvider } from "../provider/WhatsAppProvider.js";

/**
 * Deciding whether a number is already in a group, without attempting the add to find out.
 *
 * This is the whole reason the check phase exists. `addParticipant` will happily tell you somebody
 * is already a member — by returning 409 after the request has been made — but adding participants
 * is the strongest ban signal WhatsApp reacts to, so an answer that costs an add is not an answer
 * worth having for the hundreds of pairs a roster-wide job covers.
 *
 * Kept as a pure module with no database and no provider calls of its own, so the rules below can
 * be tested directly against a roster fixture rather than through the queue.
 */

/** A group's roster reduced to what a membership decision actually needs. */
export interface GroupRoster {
  /** Digits of every participant WhatsApp identified by a real phone number (`…@c.us`). */
  phoneDigits: Set<string>;
  /**
   * How many participants were identified by something that is NOT a phone number — in practice a
   * LID. Non-zero means absence cannot be proven for anybody, because one of these opaque ids
   * could belong to the person being asked about and nothing in the roster would say so.
   */
  opaqueCount: number;
  /** Total participants read, so an empty roster is distinguishable from a group of nobody. */
  total: number;
}

/**
 * A participant id is usable for matching only when WhatsApp gave it as a phone-number id.
 *
 * `@c.us` is a real number. `@lid` is a linked-device identifier: 14-15 opaque digits deliberately
 * unrelated to the person's number, which `normalizePhoneNumber` nevertheless accepts as "valid"
 * because it only checks length. That is the trap — once the domain is stripped the two are
 * indistinguishable, and a LID silently fails to match the person it belongs to.
 */
export function isPhoneNumberId(rawId: string): boolean {
  return rawId.includes("@c.us");
}

export function buildGroupRoster(participants: GroupParticipant[]): GroupRoster {
  const phoneDigits = new Set<string>();
  let opaqueCount = 0;

  for (const participant of participants) {
    if (isPhoneNumberId(participant.rawId)) {
      const digits = normalizePhoneNumber(participant.phoneNumber);
      if (digits) phoneDigits.add(digits);
      else opaqueCount += 1;
    } else {
      opaqueCount += 1;
    }
  }

  return { phoneDigits, opaqueCount, total: participants.length };
}

/** What the check concluded for one (number, group) pair. Mirrors GroupParticipantAddItemStatus. */
export type MembershipVerdict =
  | "ALREADY_MEMBER"
  | "READY"
  | "CANNOT_VERIFY"
  | "INVALID_NUMBER"
  | "NOT_ON_WHATSAPP"
  | "NO_PERMISSION"
  | "GROUP_UNAVAILABLE"
  | "CHECK_FAILED";

export interface MembershipInput {
  phoneNumber: string;
  roster: GroupRoster | null;
  /** True/false once known; null when the provider could not say which groups we administer. */
  isAdminOfGroup: boolean | null;
  /** True/false once known; null when the number could not be checked. */
  existsOnWhatsApp: boolean | null;
  groupAvailable: boolean;
}

/**
 * The decision, in the order the answers actually settle things.
 *
 * Order is load-bearing, and it runs cheapest-and-most-certain first:
 *
 * 1. A number that is not a number cannot be anything else.
 * 2. A group we cannot reach makes every other question moot.
 * 3. Not being an admin means WhatsApp refuses every add to this group regardless of who is in
 *    it — so it outranks membership, which would otherwise offer work that cannot succeed. An
 *    UNKNOWN admin state deliberately does NOT block: refusing work the account can actually do
 *    is worse than letting WhatsApp answer.
 * 4. Already being a member beats "not on WhatsApp", because a roster entry is direct evidence
 *    and `checkNumberStatus` is a lookup that can be wrong about a number that plainly exists.
 * 5. Only then does absence get decided — and only when it can be PROVEN.
 */
export function decideMembership(input: MembershipInput): MembershipVerdict {
  if (!normalizePhoneNumber(input.phoneNumber)) return "INVALID_NUMBER";
  if (!input.groupAvailable) return "GROUP_UNAVAILABLE";
  if (input.roster === null) return "CHECK_FAILED";
  if (input.isAdminOfGroup === false) return "NO_PERMISSION";

  const digits = normalizePhoneNumber(input.phoneNumber)!;
  if (input.roster.phoneDigits.has(digits)) return "ALREADY_MEMBER";

  // An empty roster is not a group of nobody — every group contains at least the account that
  // read it. It means the read came back hollow, which is a failure wearing a success's clothes.
  if (input.roster.total === 0) return "CHECK_FAILED";

  if (input.existsOnWhatsApp === false) return "NOT_ON_WHATSAPP";

  // Not matched, but the roster held ids we cannot compare against a phone number. One of them
  // could be this person. Saying READY here is what would spend a redundant add.
  if (input.roster.opaqueCount > 0) return "CANNOT_VERIFY";

  return "READY";
}

/** Reads one group's roster, returning null rather than an empty list when the read itself failed. */
export async function readGroupRoster(
  provider: WhatsAppProvider,
  whatsappGroupId: string,
): Promise<GroupRoster | null> {
  try {
    const participants = await provider.getGroupParticipants(whatsappGroupId);
    if (!Array.isArray(participants)) return null;
    return buildGroupRoster(participants);
  } catch {
    return null;
  }
}

/** Plain-language wording for each verdict, shown beside the status on the review screen. */
export const MEMBERSHIP_VERDICT_REASON: Record<MembershipVerdict, string> = {
  ALREADY_MEMBER: "Already in this group — nothing to do.",
  READY: "Not in this group yet.",
  CANNOT_VERIFY:
    "WhatsApp identifies some members of this group by an internal id rather than their number, so we cannot confirm whether this person is already in it. Adding is safe but may turn out to be unnecessary.",
  INVALID_NUMBER: "Not a usable phone number.",
  NOT_ON_WHATSAPP: "No WhatsApp account exists for this number.",
  NO_PERMISSION:
    "This account is not an admin of that group, so WhatsApp will not let it add anyone. Make it a group admin and re-check.",
  GROUP_UNAVAILABLE: "That group is no longer available to this account.",
  CHECK_FAILED: "The check could not be completed. Re-check to try again.",
};
