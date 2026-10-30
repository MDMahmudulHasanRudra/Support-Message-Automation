/**
 * Social Studio (SOCIAL_STUDIO.md): Get Assist's own social publishing. The rules of the workflow and of
 * the publishing engine, independent of any platform. Pure functions only — the web app's server code
 * applies them, the tests pin them, and the browser uses them to explain why a button is not offered.
 *
 * A post is written, reviewed and approved in Get Assist; each chosen account is one publish TARGET
 * (a job with its own status, attempts and outcome), published by the engine when it is due. Nothing
 * is published without a person holding `social.approve` having approved exactly what is sent, and a
 * publication whose outcome was not seen is never repeated by the engine.
 */

// ── Post statuses (the post as a whole) ──────────────────────────────────────────────────────────

export const SOCIAL_POST_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "SCHEDULED", "PUBLISHED", "PARTIAL", "FAILED", "UNKNOWN", "CANCELLED"] as const;
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];

export const SOCIAL_POST_STATUS_LABELS: Record<SocialPostStatus, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "Waiting for approval",
  APPROVED: "Approved",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  PARTIAL: "Partly published",
  FAILED: "Failed",
  UNKNOWN: "Outcome unknown",
  CANCELLED: "Cancelled",
};

export type SocialStatusTone = "neutral" | "info" | "success" | "warning" | "danger";

export const SOCIAL_POST_STATUS_TONES: Record<SocialPostStatus, SocialStatusTone> = {
  DRAFT: "neutral",
  IN_REVIEW: "info",
  APPROVED: "info",
  SCHEDULED: "info",
  PUBLISHED: "success",
  PARTIAL: "warning",
  FAILED: "danger",
  UNKNOWN: "warning",
  CANCELLED: "neutral",
};

export function isSocialPostStatus(value: unknown): value is SocialPostStatus {
  return typeof value === "string" && (SOCIAL_POST_STATUSES as readonly string[]).includes(value);
}

/** Statuses whose content can still be changed (a change always sends the post back to DRAFT). */
export const SOCIAL_EDITABLE_STATUSES: readonly SocialPostStatus[] = ["DRAFT", "IN_REVIEW", "APPROVED", "FAILED", "CANCELLED"];

// ── Target statuses (one account's publish job) ──────────────────────────────────────────────────

export const SOCIAL_TARGET_STATUSES = ["PENDING", "DUE", "PUBLISHING", "PUBLISHED", "FAILED", "UNKNOWN", "CANCELLED"] as const;
export type SocialTargetStatus = (typeof SOCIAL_TARGET_STATUSES)[number];

export const SOCIAL_TARGET_STATUS_LABELS: Record<SocialTargetStatus, string> = {
  PENDING: "Not scheduled",
  DUE: "Scheduled",
  PUBLISHING: "Publishing",
  PUBLISHED: "Published",
  FAILED: "Failed",
  UNKNOWN: "Outcome unknown",
  CANCELLED: "Cancelled",
};

export const SOCIAL_TARGET_STATUS_TONES: Record<SocialTargetStatus, SocialStatusTone> = {
  PENDING: "neutral",
  DUE: "info",
  PUBLISHING: "info",
  PUBLISHED: "success",
  FAILED: "danger",
  UNKNOWN: "warning",
  CANCELLED: "neutral",
};

export function isSocialTargetStatus(value: unknown): value is SocialTargetStatus {
  return typeof value === "string" && (SOCIAL_TARGET_STATUSES as readonly string[]).includes(value);
}

/**
 * The post's status once it was scheduled, from its targets. While any target is still waiting or
 * being published the post is SCHEDULED; an unknown outcome outranks a settled one, because it needs a
 * person; then all published → PUBLISHED, none → FAILED (or CANCELLED when every one was), some → PARTIAL.
 */
export function overallPostStatus(targets: readonly SocialTargetStatus[]): SocialPostStatus {
  if (targets.length === 0) return "CANCELLED";
  if (targets.some((s) => s === "DUE" || s === "PUBLISHING" || s === "PENDING")) return "SCHEDULED";
  if (targets.some((s) => s === "UNKNOWN")) return "UNKNOWN";
  const published = targets.filter((s) => s === "PUBLISHED").length;
  if (published === targets.length) return "PUBLISHED";
  if (published === 0) return targets.every((s) => s === "CANCELLED") ? "CANCELLED" : "FAILED";
  return "PARTIAL";
}

// ── Post transitions ─────────────────────────────────────────────────────────────────────────────

export type SocialAction = "EDIT" | "SUBMIT" | "APPROVE" | "REJECT" | "SCHEDULE" | "CANCEL" | "DELETE" | "DUPLICATE";

/** The permission key each action needs. Writing, approving and publishing are separate keys on purpose. */
export const SOCIAL_ACTION_KEYS: Record<SocialAction, "social.edit" | "social.approve" | "social.publish"> = {
  EDIT: "social.edit",
  SUBMIT: "social.edit",
  APPROVE: "social.approve",
  REJECT: "social.approve",
  SCHEDULE: "social.publish",
  CANCEL: "social.publish",
  DELETE: "social.edit",
  DUPLICATE: "social.edit",
};

export interface SocialTransitionInput {
  status: SocialPostStatus;
  /** The approval still covers the material on the post (text, variants, media, accounts, settings). */
  approvalMatches: boolean;
  /** CANCEL: how many targets are already publishing or settled (they cannot be called back by cancelling). */
  startedTargets?: number;
}

export type SocialTransition = { ok: true; next: SocialPostStatus } | { ok: false; reason: string };

/**
 * What an action does to a post, or why it is refused — the single rulebook for the server actions:
 *   - any edit returns the post to DRAFT, so an approval never covers text it did not see;
 *   - only an approved post whose material still matches the approval can be scheduled;
 *   - cancelling stops every target that has not started; one already publishing or published is not
 *     recalled by cancelling (deleting a publication is a separate, per-platform action).
 */
export function decideSocialTransition(action: SocialAction, input: SocialTransitionInput): SocialTransition {
  const { status } = input;
  switch (action) {
    case "EDIT":
      if (!SOCIAL_EDITABLE_STATUSES.includes(status)) return { ok: false, reason: editRefusal(status) };
      return { ok: true, next: "DRAFT" };
    case "SUBMIT":
      if (status !== "DRAFT") return { ok: false, reason: "Only a draft can be sent for approval." };
      return { ok: true, next: "IN_REVIEW" };
    case "APPROVE":
      if (status !== "IN_REVIEW") return { ok: false, reason: "Only a post waiting for approval can be approved." };
      return { ok: true, next: "APPROVED" };
    case "REJECT":
      if (status !== "IN_REVIEW") return { ok: false, reason: "Only a post waiting for approval can be sent back." };
      return { ok: true, next: "DRAFT" };
    case "SCHEDULE":
      if (status !== "APPROVED") return { ok: false, reason: "Only an approved post can be scheduled." };
      if (!input.approvalMatches) return { ok: false, reason: "The post changed after it was approved. Send it for approval again." };
      return { ok: true, next: "SCHEDULED" };
    case "CANCEL":
      if (status === "APPROVED" || status === "IN_REVIEW") return { ok: true, next: "CANCELLED" };
      if (status !== "SCHEDULED") return { ok: false, reason: "Only a post that is scheduled or waiting can be cancelled." };
      return { ok: true, next: (input.startedTargets ?? 0) > 0 ? "SCHEDULED" : "CANCELLED" };
    case "DELETE":
      if (status !== "DRAFT" && status !== "CANCELLED" && status !== "IN_REVIEW") {
        return { ok: false, reason: "Only a draft or a cancelled post can be deleted. Scheduled and published posts are kept as history." };
      }
      return { ok: true, next: status };
    case "DUPLICATE":
      return { ok: true, next: "DRAFT" };
  }
}

function editRefusal(status: SocialPostStatus): string {
  if (status === "SCHEDULED") return "Cancel the scheduled post first, then edit it.";
  if (status === "UNKNOWN") return "Settle the unknown outcome before changing this post.";
  return "A published post can no longer be changed here. Duplicate it to post again.";
}

// ── Target (job) actions ─────────────────────────────────────────────────────────────────────────

export type SocialTargetAction = "RETRY" | "SEND_AGAIN" | "MARK_PUBLISHED" | "MARK_FAILED" | "CANCEL";

export type TargetDecision = { ok: true; next: SocialTargetStatus } | { ok: false; reason: string };

/**
 * A person's action on one account's job:
 *   - RETRY a FAILED job (its outcome is known: nothing was published), or cancel a waiting one;
 *   - an UNKNOWN job is never simply retried: SEND_AGAIN needs the person to confirm they checked the
 *     account and it is not there; MARK_PUBLISHED / MARK_FAILED record what they found.
 */
export function decideTargetAction(action: SocialTargetAction, input: { status: SocialTargetStatus; approvalMatches: boolean; confirmedNotPublished?: boolean }): TargetDecision {
  switch (action) {
    case "RETRY":
      if (input.status !== "FAILED") return { ok: false, reason: "Only a failed publication can be retried." };
      if (!input.approvalMatches) return { ok: false, reason: "The post changed after it was approved. Send it for approval again." };
      return { ok: true, next: "DUE" };
    case "SEND_AGAIN":
      if (input.status !== "UNKNOWN") return { ok: false, reason: "Only a publication whose outcome is unknown can be sent again." };
      if (!input.confirmedNotPublished) {
        return { ok: false, reason: "Confirm that you checked the account and the post is not there. Sending again otherwise can publish it twice." };
      }
      if (!input.approvalMatches) return { ok: false, reason: "The post changed after it was approved. Send it for approval again." };
      return { ok: true, next: "DUE" };
    case "MARK_PUBLISHED":
      if (input.status !== "UNKNOWN") return { ok: false, reason: "Only a publication whose outcome is unknown can be marked." };
      return { ok: true, next: "PUBLISHED" };
    case "MARK_FAILED":
      if (input.status !== "UNKNOWN") return { ok: false, reason: "Only a publication whose outcome is unknown can be marked." };
      return { ok: true, next: "FAILED" };
    case "CANCEL":
      if (input.status !== "DUE" && input.status !== "PENDING") return { ok: false, reason: "Only a publication that has not started can be cancelled." };
      return { ok: true, next: "CANCELLED" };
  }
}

// ── The engine's rules ───────────────────────────────────────────────────────────────────────────

/** How long a claimed job may run before its lease is considered abandoned. */
export const SOCIAL_LEASE_MS = 5 * 60_000;
/** After this many attempts that never reached the platform, a job is dead-lettered (FAILED). */
export const SOCIAL_MAX_ATTEMPTS = 8;

/** Waiting time after a refusal that is safe to repeat (rate limit, platform unreachable), growing to an hour. */
export function socialRetryDelayMs(attempt: number, rateLimited: boolean): number {
  const base = rateLimited ? 15 * 60_000 : 60_000;
  return Math.min(60 * 60_000, base * 2 ** Math.max(0, attempt - 1));
}

/**
 * A lease that ran out: if the attempt never reached the point of sending the publishing request, the
 * job is safe to run again; once the request may have left, the outcome is UNKNOWN and only a person or
 * the reconciler may settle it.
 */
export function expiredLeaseOutcome(requestSentAt: Date | null): "REQUEUE" | "UNKNOWN" {
  return requestSentAt ? "UNKNOWN" : "REQUEUE";
}

/** The result of one publish attempt, as every adapter reports it. */
export type PublishOutcome =
  | { kind: "PUBLISHED"; externalId: string; permalink: string | null }
  /** The platform refused for a reason a retry will not fix (validation, policy, missing permission). */
  | { kind: "REFUSED"; message: string; code?: string | null }
  /** The account's authorization is no longer accepted. Nothing was published. */
  | { kind: "AUTH"; message: string }
  /** Refused for its rate limit, or never reached; the same request may safely be repeated later. */
  | { kind: "RETRY_LATER"; message: string; rateLimited: boolean }
  /** The request may have been received and its answer was not seen. Never repeated by the engine. */
  | { kind: "UNKNOWN"; message: string };

// ── Drafts ───────────────────────────────────────────────────────────────────────────────────────

export const SOCIAL_MAX_CONTENT = 63_000;
export const SOCIAL_MAX_ACCOUNTS = 25;
export const SOCIAL_MAX_MEDIA = 10;
export const SOCIAL_MAX_SETTINGS_BYTES = 4_096;
/** A scheduled time must leave the engine a moment to pick it up. */
export const SOCIAL_MIN_LEAD_MS = 60_000;
export const SOCIAL_MAX_LEAD_MS = 365 * 86_400_000;

export interface SocialDraftInput {
  content: string;
  accountIds: string[];
  mediaIds: string[];
  /** Per account id: its own text (a channel-specific variant), or undefined for the main text. */
  variants: Record<string, string | null | undefined>;
  /** Per account id: platform settings (a JSON object) or undefined. */
  settings: Record<string, unknown>;
}

export interface SocialDraftProblem {
  field: "content" | "accounts" | "media" | "settings" | "variants";
  message: string;
}

export function validateSocialDraft(input: SocialDraftInput): SocialDraftProblem[] {
  const problems: SocialDraftProblem[] = [];
  const accounts = new Set(input.accountIds);
  const anyText = input.content.trim() || [...accounts].some((id) => (input.variants[id] ?? "").trim());
  if (!anyText && input.mediaIds.length === 0) problems.push({ field: "content", message: "Write something or add a photo or video." });
  if (input.content.length > SOCIAL_MAX_CONTENT) problems.push({ field: "content", message: "The text is too long." });
  if (accounts.size === 0) problems.push({ field: "accounts", message: "Choose at least one account." });
  if (accounts.size > SOCIAL_MAX_ACCOUNTS) problems.push({ field: "accounts", message: `Choose at most ${SOCIAL_MAX_ACCOUNTS} accounts.` });
  if (new Set(input.mediaIds).size > SOCIAL_MAX_MEDIA) problems.push({ field: "media", message: `Attach at most ${SOCIAL_MAX_MEDIA} files.` });
  for (const [accountId, text] of Object.entries(input.variants)) {
    if (accounts.has(accountId) && typeof text === "string" && text.length > SOCIAL_MAX_CONTENT) problems.push({ field: "variants", message: "An account's own text is too long." });
  }
  for (const [accountId, value] of Object.entries(input.settings)) {
    if (value === undefined || value === null || !accounts.has(accountId)) continue;
    if (typeof value !== "object" || Array.isArray(value)) {
      problems.push({ field: "settings", message: "Account settings must be a JSON object." });
      continue;
    }
    if (JSON.stringify(value).length > SOCIAL_MAX_SETTINGS_BYTES) problems.push({ field: "settings", message: "Account settings are too long." });
  }
  return problems;
}

/** When the post is to go out, or why not. NOW is "as soon as the engine picks it up". */
export function validateSchedule(mode: SocialPublishMode, scheduledAt: Date | null, now: Date): { ok: true } | { ok: false; reason: string } {
  if (mode === "NOW") return { ok: true };
  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) return { ok: false, reason: "Choose when the post should be published." };
  if (scheduledAt.getTime() < now.getTime() + SOCIAL_MIN_LEAD_MS) return { ok: false, reason: "Choose a time at least a minute from now, or publish now." };
  if (scheduledAt.getTime() > now.getTime() + SOCIAL_MAX_LEAD_MS) return { ok: false, reason: "Choose a time within the next year." };
  return { ok: true };
}

export const SOCIAL_PUBLISH_MODES = ["SCHEDULE", "NOW"] as const;
export type SocialPublishMode = (typeof SOCIAL_PUBLISH_MODES)[number];

/**
 * The material an approval covers, as one canonical string (the server hashes it): the main text, each
 * account's own text and settings, and the media in order. The time is NOT part of it — moving a post is
 * the publisher's decision, not new content.
 */
export function socialApprovalMaterial(input: {
  content: string;
  accountIds: string[];
  mediaIds: string[];
  variants: Record<string, string | null | undefined>;
  settings: Record<string, unknown>;
}): string {
  const accounts = [...new Set(input.accountIds)].sort();
  return JSON.stringify({
    content: input.content,
    media: [...input.mediaIds],
    accounts: accounts.map((id) => [id, input.variants[id] ?? null, canonicalJson(input.settings[id] ?? null)]),
  });
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonicalJson((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The settings JSON typed for one account: an object, or a sentence saying why not. */
export function parseAccountSettings(raw: string): { ok: true; value: Record<string, unknown> | null } | { ok: false; reason: string } {
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  if (text.length > SOCIAL_MAX_SETTINGS_BYTES) return { ok: false, reason: "Account settings are too long." };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "Account settings must be a JSON object." };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "Account settings are not valid JSON." };
  }
}

// ── Project isolation of a publish request ──────────────────────────────────────────────────────

export interface SocialAccountRef {
  id: string;
  platform: string;
  status: string;
  enabled: boolean;
}

/**
 * The accounts a post may go to, or why it may not. `available` is every account of THIS project
 * (loaded through the project-scoped client): an id that is not in it — another project's, a removed
 * one, one needing reconnection — refuses the whole request rather than dropping it, so nothing is ever
 * published somewhere nobody chose.
 */
export function planPublishAccounts(wanted: readonly string[], available: readonly SocialAccountRef[]): { ok: true; accounts: SocialAccountRef[] } | { ok: false; reason: string } {
  const byId = new Map(available.map((a) => [a.id, a]));
  const accounts: SocialAccountRef[] = [];
  for (const id of new Set(wanted)) {
    const account = byId.get(id);
    if (!account) return { ok: false, reason: "A chosen account does not belong to this project." };
    if (account.status === "REMOVED") return { ok: false, reason: "A chosen account is no longer connected." };
    if (account.status === "NEEDS_RECONNECT") return { ok: false, reason: "A chosen account needs to be reconnected first." };
    if (!account.enabled) return { ok: false, reason: "A chosen account is switched off for publishing." };
    accounts.push(account);
  }
  if (accounts.length === 0) return { ok: false, reason: "Choose at least one account." };
  return { ok: true, accounts };
}

// ── Reconciliation of an unknown outcome ─────────────────────────────────────────────────────────

export interface RecentPublication {
  externalId: string;
  text: string;
  createdAt: Date;
  permalink: string | null;
}

const squash = (text: string) =>
  text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * For a job whose publishing request had an unknown outcome: the account's recent publications that
 * could be it — the same text (compared without markup or spacing) created from shortly before the
 * request until ten minutes after. Exactly one candidate is a match; none or several stays unknown for
 * a person to decide. A text-less post (media only) is never matched by guesswork.
 */
export function matchRecentPublication(
  job: { text: string; requestedAt: Date },
  recent: readonly RecentPublication[],
  alreadyLinked: ReadonlySet<string> = new Set(),
): { kind: "MATCH"; publication: RecentPublication } | { kind: "NONE" } | { kind: "SEVERAL"; count: number } {
  const want = squash(job.text);
  if (!want) return { kind: "NONE" };
  const from = job.requestedAt.getTime() - 2 * 60_000;
  const to = job.requestedAt.getTime() + 10 * 60_000;
  const candidates = recent.filter((p) => !alreadyLinked.has(p.externalId) && p.createdAt.getTime() >= from && p.createdAt.getTime() <= to && squash(p.text) === want);
  if (candidates.length === 1) return { kind: "MATCH", publication: candidates[0]! };
  if (candidates.length === 0) return { kind: "NONE" };
  return { kind: "SEVERAL", count: candidates.length };
}

// ── Media ────────────────────────────────────────────────────────────────────────────────────────

export const SOCIAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const SOCIAL_VIDEO_MAX_BYTES = 200 * 1024 * 1024;

export type SocialMediaKind = "IMAGE" | "VIDEO";

/**
 * What a file is, from its first bytes — never from its name or the browser's claim. JPEG, PNG, WebP,
 * GIF and MP4/MOV only. Whether a PLATFORM takes that type is the platform rules' job.
 */
export function sniffSocialMedia(head: Uint8Array): { kind: SocialMediaKind; mimeType: string; extension: string } | null {
  const at = (i: number) => head[i] ?? -1;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { kind: "IMAGE", mimeType: "image/jpeg", extension: "jpg" };
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return { kind: "IMAGE", mimeType: "image/png", extension: "png" };
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return { kind: "IMAGE", mimeType: "image/gif", extension: "gif" };
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    return { kind: "IMAGE", mimeType: "image/webp", extension: "webp" };
  }
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
    if (brand === "qt  ") return { kind: "VIDEO", mimeType: "video/quicktime", extension: "mov" };
    if (["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash"].includes(brand)) return { kind: "VIDEO", mimeType: "video/mp4", extension: "mp4" };
  }
  return null;
}

export function socialMediaLimit(kind: SocialMediaKind): number {
  return kind === "VIDEO" ? SOCIAL_VIDEO_MAX_BYTES : SOCIAL_IMAGE_MAX_BYTES;
}

// ── Time zones ───────────────────────────────────────────────────────────────────────────────────

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function zoneOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * "2026-11-05T09:30" read as a wall-clock time in `tz` → the instant. Two passes settle a time near a
 * daylight-saving change; a wall time that does not exist (skipped by DST) lands just after the gap.
 */
export function zonedLocalToUtc(local: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m || !isValidTimeZone(tz)) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let ts = guess - zoneOffsetMs(new Date(guess), tz);
  ts = guess - zoneOffsetMs(new Date(ts), tz);
  const result = new Date(ts);
  return Number.isNaN(result.getTime()) ? null : result;
}

/** The instant as "YYYY-MM-DDTHH:mm" on the wall clock of `tz` (what a datetime-local input shows). */
export function utcToZonedLocal(at: Date, tz: string): string {
  const shifted = new Date(at.getTime() + zoneOffsetMs(at, tz));
  return shifted.toISOString().slice(0, 16);
}

/** The calendar day ("YYYY-MM-DD") of an instant in `tz`. */
export function zonedDay(at: Date, tz: string): string {
  return utcToZonedLocal(at, tz).slice(0, 10);
}

// ── Metrics (only what a platform returns) ───────────────────────────────────────────────────────

export interface SocialMetricValue {
  /** The platform's own metric name (e.g. post_impressions, reach). */
  name: string;
  label: string;
  value: number;
}
