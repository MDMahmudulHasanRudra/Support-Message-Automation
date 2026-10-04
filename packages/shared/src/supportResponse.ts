/**
 * Support response tracking (SUPPORT_RESPONSE.md): the rules behind Messages → Unanswered Groups
 * and Response Time, as pure functions so the worker that records episodes and the tests that pin
 * them read one definition.
 *
 * An EPISODE is one wait in one group: it opens on the first customer message after the previous
 * Support Team reply, every further customer message extends it (one wait, however many lines),
 * and the first reply from a Support Team member closes it with a response time.
 *
 * Deliberately stricter than the Team Report's "wait" (packages/shared/src/teamReport.ts), which
 * any reply closes — a business-number reply, any roster member. Here only a person in the
 * configured Support Team counts, because the question is "how long did SUPPORT take", and a reply
 * from another department, a rule or the AI does not answer it. The Team Report and the Response
 * SLA report are unchanged; the two definitions answer different questions.
 */

/** What one stored message is, for response tracking. */
export type ResponseMessageRole =
  /** Somebody who is not on the roster: a customer. Opens or extends an episode. */
  | "CUSTOMER"
  /** A roster member who was in a Support Team when they sent it. Answers an open episode. */
  | "SUPPORT"
  /** A roster member in no Support Team at that moment. Neither opens nor answers anything. */
  | "OTHER_TEAM"
  /**
   * Sent by the connected WhatsApp number itself — a rule, the AI, the dashboard chat, or a person
   * on the business phone. WhatsApp names no individual for these, so they never answer an episode
   * (the Support Team is a set of people, and guessing which one is not attribution).
   */
  | "BUSINESS"
  /** A system message. */
  | "IGNORED";

export function classifyResponseMessage(input: {
  direction: "INCOMING" | "OUTGOING" | "SYSTEM";
  /** The roster member who sent it, or null for a sender who is not on the roster. */
  memberId: string | null;
  /** Whether that member was in a Support Team at the moment of the message. */
  inSupportTeam: boolean;
}): ResponseMessageRole {
  if (input.direction === "SYSTEM") return "IGNORED";
  if (input.direction === "OUTGOING") return "BUSINESS";
  if (!input.memberId) return "CUSTOMER";
  return input.inSupportTeam ? "SUPPORT" : "OTHER_TEAM";
}

export interface OpenEpisodeTimes {
  firstIncomingAt: number;
  latestIncomingAt: number;
}

export type EpisodeAction =
  | { kind: "OPEN" }
  | { kind: "EXTEND"; firstIncomingAt: number; latestIncomingAt: number; movesFirst: boolean; movesLatest: boolean }
  | { kind: "ANSWER"; responseSeconds: number }
  /** An earlier Support reply than the one already recorded for the last episode: it is the answer. */
  | { kind: "REANSWER"; responseSeconds: number }
  | { kind: "NONE" };

/**
 * What a message does to its group's episode.
 *
 * Timestamps, not arrival order, decide: a message recovered after a gap can arrive minutes late.
 * - A customer message older than the group's last Support Team reply was answered by it already
 *   (or, older than a cleared episode's last message, was dismissed with it), so it opens nothing.
 * - A customer message extends an open episode; if it is older than the episode's first message
 *   it becomes the first (the wait started earlier than we knew).
 * - A Support Team reply answers an open episode only if it was sent at or after the episode's
 *   first message — a reply that predates the question cannot be its answer.
 * - Two members replying moments apart can be processed in either order. If a Support reply finds
 *   nothing open but is EARLIER than the reply recorded on the last answered episode (and not before
 *   that episode began), it is the real first answer and replaces it.
 */
export function applyResponseMessage(input: {
  role: ResponseMessageRole;
  at: number;
  open: OpenEpisodeTimes | null;
  /**
   * How far the group's closed episodes reach: the last Support reply's time, or the last message of
   * a cleared episode, whichever is later. A customer message at or before it was already answered
   * or dismissed, so it opens nothing new.
   */
  closedThroughAt: number | null;
  /** The group's most recently answered episode, for the out-of-order Support reply above. */
  lastAnswered?: { firstIncomingAt: number; supportRepliedAt: number } | null;
}): EpisodeAction {
  const { role, at, open } = input;
  if (role === "CUSTOMER") {
    if (!open) {
      if (input.closedThroughAt !== null && at <= input.closedThroughAt) return { kind: "NONE" };
      return { kind: "OPEN" };
    }
    return {
      kind: "EXTEND",
      firstIncomingAt: Math.min(open.firstIncomingAt, at),
      latestIncomingAt: Math.max(open.latestIncomingAt, at),
      movesFirst: at < open.firstIncomingAt,
      movesLatest: at >= open.latestIncomingAt,
    };
  }
  if (role === "SUPPORT" && open && at >= open.firstIncomingAt) {
    return { kind: "ANSWER", responseSeconds: Math.round((at - open.firstIncomingAt) / 1000) };
  }
  const last = input.lastAnswered;
  if (role === "SUPPORT" && !open && last && at >= last.firstIncomingAt && at < last.supportRepliedAt) {
    return { kind: "REANSWER", responseSeconds: Math.round((at - last.firstIncomingAt) / 1000) };
  }
  return { kind: "NONE" };
}

/** "18m 42s", "2h 05m", "3d 4h", "45s". */
export function formatResponseDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The status labels shown in the two tabs. */
export const SUPPORT_EPISODE_STATUS_LABELS = {
  UNANSWERED: "Unanswered",
  ANSWERED: "Answered",
  CLEARED: "Cleared",
} as const;

/**
 * An Excel serial date-time for an instant, as a Dhaka wall clock — the app's one timezone. Written
 * as a number with a date format, so the cell is a real date Excel can sort and subtract, and it
 * shows the time the team lived rather than UTC.
 */
export function excelDhakaSerial(at: Date): number {
  return (at.getTime() + 6 * 60 * 60 * 1000) / 86_400_000 + 25_569;
}
