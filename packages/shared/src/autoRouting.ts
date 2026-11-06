import { DHAKA_OFFSET_MS } from "./dhakaDay.js";

/**
 * Automatic conversation routing (AUTO_ROUTING.md; features AUTO_ROUTING + UNIFIED_INBOX_V3, both off by
 * default). The pure half: what the settings may say, who is eligible for one conversation and why the others
 * are not, and whom to pick. The worker's automatic routing, the inbox's "Distribute evenly" and the settings
 * page's Routing panel all decide through these functions, so the three can never disagree.
 *
 * Eligibility is decided at the moment of routing from facts loaded then (packages/db `loadRoutingCandidates`)
 * and never stored. Nobody eligible means the conversation stays unassigned — routing never falls back to
 * somebody who failed a check.
 */

export const ROUTING_CHANNELS = ["WEBCHAT", "MESSENGER", "INSTAGRAM", "TELEGRAM", "WHATSAPP_PERSONAL"] as const;
export type RoutingChannel = (typeof ROUTING_CHANNELS)[number];
export const ROUTING_CHANNEL_LABELS: Record<RoutingChannel, string> = {
  WEBCHAT: "Website chat",
  MESSENGER: "Messenger",
  INSTAGRAM: "Instagram",
  TELEGRAM: "Telegram",
  WHATSAPP_PERSONAL: "WhatsApp personal chats",
};
export function isRoutingChannel(value: unknown): value is RoutingChannel {
  return typeof value === "string" && (ROUTING_CHANNELS as readonly string[]).includes(value);
}

/** What one conversation is, for routing: a channel, or a WhatsApp group (offered separately). */
export type RoutingConversationKind = RoutingChannel | "WHATSAPP_GROUP";

export const ROUTING_METHODS = ["ROUND_ROBIN", "LEAST_OPEN"] as const;
export type RoutingMethod = (typeof ROUTING_METHODS)[number];
export const ROUTING_METHOD_LABELS: Record<RoutingMethod, string> = {
  ROUND_ROBIN: "Round robin — take turns",
  LEAST_OPEN: "Least busy — fewest open conversations",
};
export function isRoutingMethod(value: unknown): value is RoutingMethod {
  return typeof value === "string" && (ROUTING_METHODS as readonly string[]).includes(value);
}

export const ROUTING_CAPACITY_MIN = 1;
export const ROUTING_CAPACITY_MAX = 200;
export const ROUTING_CAPACITY_DEFAULT = 15;
/**
 * "Seen in the dashboard" reads a session's last use, which the dashboard refreshes at most every five
 * minutes (server/auth.ts). A window shorter than ten minutes would drop people who are plainly working.
 */
export const ROUTING_SEEN_MIN_MINUTES = 10;
export const ROUTING_SEEN_MAX_MINUTES = 1440;
export const ROUTING_SEEN_DEFAULT_MINUTES = 15;
/** The automatic sweep looks this far back for a customer's message, and never before routing was switched on. */
export const ROUTING_LOOKBACK_HOURS = 24;
/** At most this many people in one pool (Teams expanded). */
export const ROUTING_POOL_MAX = 200;

export interface RoutingSettingsValue {
  enabled: boolean;
  channels: RoutingChannel[];
  includeWhatsAppGroups: boolean;
  method: RoutingMethod;
  maxOpenPerAgent: number;
  poolTeamIds: string[];
  poolUserIds: string[];
  onlyOnDuty: boolean;
  requireRecentlySeen: boolean;
  recentlySeenMinutes: number;
}

export const DEFAULT_ROUTING_SETTINGS: RoutingSettingsValue = {
  enabled: false,
  channels: [],
  includeWhatsAppGroups: false,
  method: "ROUND_ROBIN",
  maxOpenPerAgent: ROUTING_CAPACITY_DEFAULT,
  poolTeamIds: [],
  poolUserIds: [],
  onlyOnDuty: false,
  requireRecentlySeen: false,
  recentlySeenMinutes: ROUTING_SEEN_DEFAULT_MINUTES,
};

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v)))].slice(0, ROUTING_POOL_MAX) : [];
const int = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) ? n : null;
};

/** Validates what a form sent. Refuses rather than clamps, so nobody saves a value they did not see. */
export function sanitizeRoutingSettings(input: unknown): { ok: true; value: RoutingSettingsValue } | { ok: false; error: string } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const channels = Array.isArray(raw.channels) ? [...new Set(raw.channels.filter(isRoutingChannel))] : [];
  if (!isRoutingMethod(raw.method)) return { ok: false, error: "Choose how conversations are shared out." };
  const capacity = int(raw.maxOpenPerAgent);
  if (capacity === null || capacity < ROUTING_CAPACITY_MIN || capacity > ROUTING_CAPACITY_MAX) {
    return { ok: false, error: `The most open conversations per person must be a whole number from ${ROUTING_CAPACITY_MIN} to ${ROUTING_CAPACITY_MAX}.` };
  }
  const seen = int(raw.recentlySeenMinutes);
  if (seen === null || seen < ROUTING_SEEN_MIN_MINUTES || seen > ROUTING_SEEN_MAX_MINUTES) {
    return { ok: false, error: `"Seen in the dashboard" must be from ${ROUTING_SEEN_MIN_MINUTES} to ${ROUTING_SEEN_MAX_MINUTES} minutes.` };
  }
  const value: RoutingSettingsValue = {
    enabled: raw.enabled === true,
    channels: ROUTING_CHANNELS.filter((c) => channels.includes(c)),
    includeWhatsAppGroups: raw.includeWhatsAppGroups === true,
    method: raw.method,
    maxOpenPerAgent: capacity,
    poolTeamIds: ids(raw.poolTeamIds),
    poolUserIds: ids(raw.poolUserIds),
    onlyOnDuty: raw.onlyOnDuty === true,
    requireRecentlySeen: raw.requireRecentlySeen === true,
    recentlySeenMinutes: seen,
  };
  if (value.enabled && value.channels.length === 0 && !value.includeWhatsAppGroups) return { ok: false, error: "Choose at least one kind of conversation to route." };
  if (value.enabled && value.poolTeamIds.length === 0 && value.poolUserIds.length === 0) return { ok: false, error: "Choose the Teams or people conversations go to." };
  return { ok: true, value };
}

/** Whether routing covers this kind of conversation. */
export function routingCovers(settings: Pick<RoutingSettingsValue, "channels" | "includeWhatsAppGroups">, kind: RoutingConversationKind): boolean {
  return kind === "WHATSAPP_GROUP" ? settings.includeWhatsAppGroups : settings.channels.includes(kind);
}

/** The permission a person needs to answer this kind of conversation — the conversation module's reply key. */
export function routingReplyKey(kind: RoutingConversationKind): "messages.reply" | "conversations.reply" {
  return kind === "WHATSAPP_PERSONAL" || kind === "WHATSAPP_GROUP" ? "messages.reply" : "conversations.reply";
}

/**
 * The pages (project-role sections, apps/web projectSections.ts) one of which a member's page selection must
 * give at Full for them to answer this kind of conversation. Section ids are page paths; a web test pins
 * each one as a real section whose changes need `routingReplyKey(kind)`.
 */
export function routingReplyPages(kind: RoutingConversationKind): readonly string[] {
  switch (kind) {
    case "WHATSAPP_PERSONAL":
    case "WHATSAPP_GROUP":
      return ["/chat"];
    case "MESSENGER":
      return ["/conversations/all", "/conversations/messenger"];
    case "INSTAGRAM":
      return ["/conversations/all", "/conversations/instagram"];
    case "TELEGRAM":
      return ["/conversations/all", "/conversations/telegram"];
    case "WEBCHAT":
      return ["/conversations/all", "/conversations/website"];
  }
}

// ── Duty now ─────────────────────────────────────────────────────────────────────────────────────

/** The roster's plan for one date (DutyAssignment), as routing reads it. */
export interface RosterDay {
  status: "DUTY" | "OFF" | "LEAVE" | "HOLIDAY" | "COVERAGE" | "EXTRA_DUTY" | "UNASSIGNED";
  shiftStartMinute: number | null;
  shiftEndMinute: number | null;
}

/**
 * Whether a team member is on duty RIGHT NOW by the plan — the roster, approved leave and a manager's
 * verdict. Not the attendance evidence: silence is not absence (CLAUDE.md, Team Management), and routing
 * must be able to give the first conversation of the day to somebody who has not written yet.
 *
 *   ON_LEAVE        approved leave today, or the roster says LEAVE
 *   MARKED_ABSENT   a manager marked today ABSENT or EXCUSED
 *   ON_DUTY         a working assignment (DUTY / COVERAGE / EXTRA_DUTY) whose shift covers this minute (no
 *                   shift times = the whole day), or yesterday's shift that runs past midnight into now
 *   OFF_SHIFT       working today, but not at this minute
 *   OFF             a day off or a holiday
 *   NOT_SCHEDULED   nobody has decided this date
 */
export type DutyNow = "ON_DUTY" | "OFF_SHIFT" | "OFF" | "ON_LEAVE" | "MARKED_ABSENT" | "NOT_SCHEDULED";

const WORKING = new Set<RosterDay["status"]>(["DUTY", "COVERAGE", "EXTRA_DUTY"]);

/** Minutes since Dhaka midnight. */
export function dhakaMinuteOfDay(at: Date): number {
  const ms = (at.getTime() + DHAKA_OFFSET_MS) % 86_400_000;
  return Math.floor((ms < 0 ? ms + 86_400_000 : ms) / 60_000);
}

export function dutyNow(input: { today: RosterDay | null; yesterday: RosterDay | null; onApprovedLeave: boolean; override: "ABSENT" | "EXCUSED" | "WORKED" | null; minuteOfDay: number }): DutyNow {
  const { today, yesterday, minuteOfDay: m } = input;
  if (input.onApprovedLeave || today?.status === "LEAVE") return "ON_LEAVE";
  if (input.override === "ABSENT" || input.override === "EXCUSED") return "MARKED_ABSENT";
  // Yesterday's late shift that crosses midnight is still running.
  if (yesterday && WORKING.has(yesterday.status) && yesterday.shiftStartMinute !== null && yesterday.shiftEndMinute !== null) {
    if (yesterday.shiftEndMinute <= yesterday.shiftStartMinute && m < yesterday.shiftEndMinute) return "ON_DUTY";
  }
  if (!today || today.status === "UNASSIGNED") return "NOT_SCHEDULED";
  if (today.status === "OFF" || today.status === "HOLIDAY") return "OFF";
  const start = today.shiftStartMinute;
  const end = today.shiftEndMinute;
  if (start === null || end === null) return "ON_DUTY";
  const inside = end > start ? m >= start && m < end : m >= start; // a cross-midnight shift: from start to midnight today
  return inside ? "ON_DUTY" : "OFF_SHIFT";
}

// ── Eligibility ──────────────────────────────────────────────────────────────────────────────────

export const ROUTING_INELIGIBLE_REASONS = [
  "INACTIVE_LOGIN",
  "NO_PROJECT_ACCESS",
  "NO_PERMISSION",
  "ON_LEAVE",
  "NOT_ON_ROSTER",
  "NOT_ON_DUTY",
  "NOT_SEEN_RECENTLY",
  "AT_CAPACITY",
] as const;
export type RoutingIneligibleReason = (typeof ROUTING_INELIGIBLE_REASONS)[number];
export const ROUTING_REASON_LABELS: Record<RoutingIneligibleReason, string> = {
  INACTIVE_LOGIN: "Login is deactivated",
  NO_PROJECT_ACCESS: "No access to this project",
  NO_PERMISSION: "Role cannot reply here",
  ON_LEAVE: "On leave",
  NOT_ON_ROSTER: "Not linked to a team member on the roster",
  NOT_ON_DUTY: "Not on duty now",
  NOT_SEEN_RECENTLY: "Not seen in the dashboard recently",
  AT_CAPACITY: "At capacity",
};

/** What routing knows about one person in the pool at this moment. */
export interface RoutingCandidateFacts {
  userId: string;
  name: string;
  activeLogin: boolean;
  projectAccess: boolean;
  /** Holds the reply key of THIS kind of conversation in this project (role, project role, access level, pages). */
  canReply: boolean;
  /** Their linked team member (InternalTeamMember.userId) in this project, active. */
  teamMemberLinked: boolean;
  /** Null without a linked team member. */
  duty: DutyNow | null;
  lastSeenAt: Date | null;
  /** OPEN + PENDING conversations assigned to them now. */
  openCount: number;
}

export type RoutingEligibility = { eligible: true } | { eligible: false; reason: RoutingIneligibleReason };

/**
 * Whether one person may be given a conversation now. Leave always excludes someone with a linked team member
 * (giving a conversation to somebody on approved leave is never right); the roster and "seen recently" apply
 * only when the settings ask for them. Capacity is checked last, so the panel names the more lasting reason.
 */
export function decideRoutingEligibility(
  f: RoutingCandidateFacts,
  settings: Pick<RoutingSettingsValue, "onlyOnDuty" | "requireRecentlySeen" | "recentlySeenMinutes" | "maxOpenPerAgent">,
  now: Date,
): RoutingEligibility {
  if (!f.activeLogin) return { eligible: false, reason: "INACTIVE_LOGIN" };
  if (!f.projectAccess) return { eligible: false, reason: "NO_PROJECT_ACCESS" };
  if (!f.canReply) return { eligible: false, reason: "NO_PERMISSION" };
  if (f.duty === "ON_LEAVE") return { eligible: false, reason: "ON_LEAVE" };
  if (settings.onlyOnDuty) {
    if (!f.teamMemberLinked || f.duty === null) return { eligible: false, reason: "NOT_ON_ROSTER" };
    if (f.duty !== "ON_DUTY") return { eligible: false, reason: "NOT_ON_DUTY" };
  }
  if (settings.requireRecentlySeen) {
    if (!f.lastSeenAt || now.getTime() - f.lastSeenAt.getTime() > settings.recentlySeenMinutes * 60_000) return { eligible: false, reason: "NOT_SEEN_RECENTLY" };
  }
  if (f.openCount >= settings.maxOpenPerAgent) return { eligible: false, reason: "AT_CAPACITY" };
  return { eligible: true };
}

/** Counts per reason, for "nobody could take it" — never names or ids. */
export function countIneligible(results: readonly RoutingEligibility[]): Partial<Record<RoutingIneligibleReason, number>> {
  const out: Partial<Record<RoutingIneligibleReason, number>> = {};
  for (const r of results) if (!r.eligible) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return out;
}

// ── Picking ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Whom to give the next conversation, among the ELIGIBLE (already within capacity). Order is by user id, so
 * every caller sees the same ring.
 *   ROUND_ROBIN  the first person after the last one picked (wrapping); the last one picked again only when
 *                they are the only one left.
 *   LEAST_OPEN   the fewest open conversations; ties go round the ring from the last one picked, so equal
 *                people still take turns.
 * Null when nobody is eligible.
 */
export function pickRoutingAgent(eligible: readonly { userId: string; openCount: number }[], method: RoutingMethod, lastPickedUserId: string | null): string | null {
  if (eligible.length === 0) return null;
  const ring = [...eligible].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  // Rotate so the person right after the last pick comes first (wrapping to the start of the ring).
  const next = lastPickedUserId === null ? 0 : ring.findIndex((c) => c.userId > lastPickedUserId);
  const start = next === -1 ? 0 : next;
  const rotated = [...ring.slice(start), ...ring.slice(0, start)];
  if (method === "ROUND_ROBIN") return rotated[0]!.userId;
  let best = rotated[0]!;
  for (const c of rotated) if (c.openCount < best.openCount) best = c;
  return best.userId;
}

/** The context every routing ConversationEvent carries (kind ASSIGNEE). Never message text. */
export interface RoutingEventContext {
  reason: "AUTO_ROUTING";
  method: RoutingMethod;
  /** How it was started: by the worker on its own, or by a person pressing "Distribute evenly". */
  via: "AUTOMATIC" | "DISTRIBUTE";
}
export function isAutoRoutingContext(context: unknown): boolean {
  return Boolean(context && typeof context === "object" && (context as { reason?: unknown }).reason === "AUTO_ROUTING");
}
