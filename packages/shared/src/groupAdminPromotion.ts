import { normalizePhoneNumber } from "./groupParticipantAdd.js";

/**
 * WhatsApp Groups Admin Maker (GROUP_ADMIN_MAKER.md): make ONE existing member an admin in every
 * group where the selected account is itself an admin. It never adds anybody to a group.
 *
 * The decisions live here as pure functions so the worker and the web agree on them and they can be
 * tested without WhatsApp. The worker only reads what WhatsApp says and records the verdict.
 */

/** Statuses an Admin Maker job is still doing something in — at most one per account + number. */
export const ACTIVE_ADMIN_PROMOTION_JOB_STATUSES = ["CHECKING", "RUNNING", "PAUSED_DISCONNECTED", "STOPPED_KILL_SWITCH"] as const;

/** Pacing between two promotions on one account, so hundreds of groups never fire at once. */
export const ADMIN_PROMOTION_DELAY_MIN_MS = 8_000;
export const ADMIN_PROMOTION_DELAY_MAX_MS = 20_000;
/** A promotion or roster read that failed for a reason that may pass is tried this many times in all. */
export const ADMIN_PROMOTION_MAX_ATTEMPTS = 2;
/** Wait before trying a transient failure again. */
export const ADMIN_PROMOTION_RETRY_DELAY_MS = 60_000;

/**
 * The member's number as WhatsApp knows it: digits with the country code.
 *
 * The existing `normalizePhoneNumber` (digits only, 8–15 of them) decides validity, exactly as Add
 * Number to Groups does. The one addition is the Bangladeshi local mobile form: "01XXXXXXXXX" is the
 * same person as "8801XXXXXXXXX", but WhatsApp only knows the second, so a local number would
 * otherwise match nobody in any group. Anything else is taken as already international.
 */
export function normalizeAdminTargetNumber(input: string): string | null {
  const digits = normalizePhoneNumber(input);
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("01")) return `88${digits}`;
  return digits;
}

export type AdminPromotionVerdict = "PROMOTE" | "ALREADY_ADMIN" | "NOT_MEMBER" | "CANNOT_VERIFY" | "READ_FAILED";

export interface AdminPromotionInput {
  /** Every participant id exactly as WhatsApp gave it (`…@c.us` or `…@lid`). */
  participantIds: readonly string[];
  /** The group's admin ids, or null when they could not be read. */
  adminIds: readonly string[] | null;
  /** The target's digits with country code. */
  targetDigits: string;
}

const isPhoneId = (id: string) => id.endsWith("@c.us");
const digitsOf = (id: string) => id.split("@")[0]!.replace(/\D/g, "");

/**
 * What to do in one group where this account is an admin.
 *
 * - An empty member list is a failed read, never "nobody is here": the account itself is a member.
 * - The target is matched only through a phone-number id (`@c.us`). A LID is deliberately unrelated
 *   to a phone number, so when the target is not found and the list holds LIDs, membership cannot
 *   be proven either way — CANNOT_VERIFY, and nothing is attempted. Calling that NOT_MEMBER would
 *   be a guess presented as a fact.
 * - A member whose admin status cannot be read is a failed read too: promoting blind would label
 *   somebody who was already an admin as PROMOTED.
 */
export function decideAdminPromotion(input: AdminPromotionInput): AdminPromotionVerdict {
  if (input.participantIds.length === 0) return "READ_FAILED";
  const isTarget = (id: string) => isPhoneId(id) && digitsOf(id) === input.targetDigits;
  const isMember = input.participantIds.some(isTarget);
  if (!isMember) return input.participantIds.some((id) => !isPhoneId(id)) ? "CANNOT_VERIFY" : "NOT_MEMBER";
  if (input.adminIds === null) return "READ_FAILED";
  return input.adminIds.some(isTarget) ? "ALREADY_ADMIN" : "PROMOTE";
}

/** The participant id to promote: the exact id the member list carries for the target. */
export function targetParticipantId(participantIds: readonly string[], targetDigits: string): string {
  return participantIds.find((id) => isPhoneId(id) && digitsOf(id) === targetDigits) ?? `${targetDigits}@c.us`;
}

export type AdminPromotionFailureOutcome = "NOT_ACCOUNT_ADMIN" | "NOT_MEMBER" | "GROUP_UNAVAILABLE" | "RETRY_OR_FAIL";

/**
 * What WhatsApp's refusal means. Its documented codes are settled answers about the group, so they
 * become that group's result; anything else (a timeout, a dropped page) may pass, and is retried.
 */
export function classifyPromotionFailure(code: string | null | undefined): AdminPromotionFailureOutcome {
  switch ((code ?? "").toUpperCase()) {
    case "INSUFFICIENT_PERMISSIONS":
      return "NOT_ACCOUNT_ADMIN";
    case "NOT_A_PARTICIPANT":
      return "NOT_MEMBER";
    case "GROUP_DOES_NOT_EXIST":
    case "NOT_A_GROUP_CHAT":
      return "GROUP_UNAVAILABLE";
    default:
      return "RETRY_OR_FAIL";
  }
}

export const ADMIN_PROMOTION_ITEM_LABELS: Record<string, string> = {
  PENDING: "Waiting",
  PROMOTED: "Promoted",
  ALREADY_ADMIN: "Already admin",
  NOT_MEMBER: "Not a member",
  NOT_ACCOUNT_ADMIN: "Skipped — account is not an admin",
  CANNOT_VERIFY: "Could not verify membership",
  GROUP_UNAVAILABLE: "Group unavailable",
  FAILED: "Failed",
};

export const ADMIN_PROMOTION_JOB_LABELS: Record<string, string> = {
  CHECKING: "Checking groups",
  RUNNING: "Running",
  PAUSED_DISCONNECTED: "Paused — WhatsApp connection lost",
  STOPPED_KILL_SWITCH: "Paused — automation is off",
  COMPLETED: "Complete",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

/** The reason recorded beside each verdict, in an operator's words. */
export const ADMIN_PROMOTION_REASONS = {
  PROMOTED: "Made an admin. Confirmed by reading the group's admin list back.",
  ALREADY_ADMIN: "Already an admin of this group — nothing was changed.",
  NOT_MEMBER: "This number is not a member of the group. It was not added — this feature only promotes existing members.",
  NOT_ACCOUNT_ADMIN: "This account is not an admin of the group, so nothing was attempted.",
  CANNOT_VERIFY:
    "WhatsApp lists some members of this group by an internal id instead of their number, so whether this person is a member could not be confirmed. Nothing was attempted.",
  GROUP_UNAVAILABLE: "This group is no longer available to this account.",
} as const;
