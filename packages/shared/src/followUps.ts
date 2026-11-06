import { DHAKA_OFFSET_MS, getDhakaDayRange } from "./dhakaDay.js";
import { isConversationPriority, type ConversationPriorityValue } from "./inboxWorkspace.js";

/**
 * Follow-ups (FOLLOW_UPS.md, feature FOLLOW_UPS): a personal and team to-do list for call-backs,
 * technician visits and promised replies. Pure rules shared by the web app and its tests — buckets
 * by Dhaka day, the allowed status moves, due-time presets and input validation.
 *
 * Nothing here (or anywhere in the module) sends anything to a customer. A follow-up is internal work.
 */

export const FOLLOW_UP_STATUSES = ["OPEN", "DONE", "DISCARDED"] as const;
export type FollowUpStatusValue = (typeof FOLLOW_UP_STATUSES)[number];

export const FOLLOW_UP_STATUS_LABEL: Record<FollowUpStatusValue, string> = { OPEN: "Open", DONE: "Done", DISCARDED: "Discarded" };

/** The event kinds the history records (FollowUpEvent.kind, a CHECK in the migration). */
export const FOLLOW_UP_EVENT_KINDS = ["CREATED", "EDITED", "REASSIGNED", "RESCHEDULED", "DONE", "DISCARDED", "REOPENED"] as const;
export type FollowUpEventKind = (typeof FOLLOW_UP_EVENT_KINDS)[number];

/** Where an open follow-up sits on the calendar. A closed one sits under its status. */
export type FollowUpBucket = "OVERDUE" | "DUE_TODAY" | "UPCOMING" | "DONE" | "DISCARDED";

/**
 * The page's tabs. MINE and TEAM are WHO (open only, any date); the three date buckets are WHEN (open
 * only, everyone, narrowed by the filters); DONE and DISCARDED are the closed lists.
 */
export const FOLLOW_UP_VIEWS = ["MINE", "TEAM", "OVERDUE", "DUE_TODAY", "UPCOMING", "DONE", "DISCARDED"] as const;
export type FollowUpView = (typeof FOLLOW_UP_VIEWS)[number];

export const FOLLOW_UP_VIEW_LABEL: Record<FollowUpView, string> = {
  MINE: "Mine",
  TEAM: "Team",
  OVERDUE: "Overdue",
  DUE_TODAY: "Due today",
  UPCOMING: "Upcoming",
  DONE: "Done",
  DISCARDED: "Discarded",
};

export function isFollowUpView(value: unknown): value is FollowUpView {
  return typeof value === "string" && (FOLLOW_UP_VIEWS as readonly string[]).includes(value);
}

/**
 * The bucket of one follow-up at `now`. Overdue = its due time has passed (also earlier today — a
 * 10:00 call-back is overdue at 15:00); due today = later today, before the next Dhaka midnight;
 * upcoming = a later Dhaka day.
 */
export function followUpBucket(f: { status: FollowUpStatusValue; dueAt: Date }, now: Date): FollowUpBucket {
  if (f.status === "DONE") return "DONE";
  if (f.status === "DISCARDED") return "DISCARDED";
  if (f.dueAt.getTime() < now.getTime()) return "OVERDUE";
  return f.dueAt.getTime() < getDhakaDayRange(now).end.getTime() ? "DUE_TODAY" : "UPCOMING";
}

/**
 * The due-time window of an open-follow-up bucket as plain instants, so the server filters with an
 * ordinary `dueAt` range (no SQL day arithmetic at all). `gte` inclusive, `lt` exclusive.
 */
export function followUpBucketRange(bucket: "OVERDUE" | "DUE_TODAY" | "UPCOMING", now: Date): { gte?: Date; lt?: Date } {
  const endOfToday = getDhakaDayRange(now).end;
  if (bucket === "OVERDUE") return { lt: now };
  if (bucket === "DUE_TODAY") return { gte: now, lt: endOfToday };
  return { gte: endOfToday };
}

/** "Needs me now": overdue + due today = everything open due before the next Dhaka midnight. */
export function followUpAttentionCutoff(now: Date): Date {
  return getDhakaDayRange(now).end;
}

export type FollowUpAction = "DONE" | "DISCARD" | "REOPEN";

/**
 * The allowed status moves. DONE and DISCARD only from OPEN; REOPEN only from a closed one. Anything
 * else is refused (the server reports it as "already changed"), so a double click is one change.
 */
export function decideFollowUpAction(current: FollowUpStatusValue, action: FollowUpAction): { to: FollowUpStatusValue; event: FollowUpEventKind } | null {
  if (action === "DONE") return current === "OPEN" ? { to: "DONE", event: "DONE" } : null;
  if (action === "DISCARD") return current === "OPEN" ? { to: "DISCARDED", event: "DISCARDED" } : null;
  return current === "OPEN" ? null : { to: "OPEN", event: "REOPENED" };
}

export const FOLLOW_UP_PRESETS = ["IN_1_HOUR", "TOMORROW_10"] as const;
export type FollowUpPreset = (typeof FOLLOW_UP_PRESETS)[number];
export const FOLLOW_UP_PRESET_LABEL: Record<FollowUpPreset, string> = { IN_1_HOUR: "In 1 hour", TOMORROW_10: "Tomorrow 10:00" };

/** A preset's due time. "Tomorrow 10:00" is 10:00 on the next Dhaka calendar day. */
export function followUpPresetDue(preset: FollowUpPreset, now: Date): Date {
  if (preset === "IN_1_HOUR") return new Date(now.getTime() + 60 * 60 * 1000);
  return new Date(getDhakaDayRange(now).end.getTime() + 10 * 60 * 60 * 1000);
}

/**
 * A `YYYY-MM-DDTHH:mm` value from `<input type="datetime-local">`, read as Dhaka wall-clock time (the
 * browser sends no zone; the team works in Dhaka, like every other date input here). Null when it is
 * not a real date and time.
 */
export function parseDhakaDateTimeInput(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (h > 23 || mi > 59) return null;
  const asUtc = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== mo - 1 || asUtc.getUTCDate() !== d) return null;
  return new Date(asUtc.getTime() - DHAKA_OFFSET_MS);
}

/** The `datetime-local` value (Dhaka wall clock) for an instant — the inverse of the parser above. */
export function formatDhakaDateTimeInput(when: Date): string {
  return new Date(when.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 16);
}

export const MAX_FOLLOW_UP_TITLE = 200;
export const MAX_FOLLOW_UP_NOTE = 2000;
/** A due time more than this far away is almost certainly a typo in the year. */
const MAX_FUTURE_MS = 2 * 366 * 24 * 60 * 60 * 1000;
/** Back-dating a little is allowed ("I promised this an hour ago"); a year back is a typo. */
const MAX_PAST_MS = 366 * 24 * 60 * 60 * 1000;

export interface FollowUpFields {
  title: string;
  note: string | null;
  dueAt: Date;
  priority: ConversationPriorityValue;
}

/**
 * Validates what the create / edit form sent. `due` is either a preset name or a `datetime-local`
 * value. Returns the cleaned fields, or the sentence to show.
 */
export function readFollowUpFields(input: { title?: unknown; note?: unknown; due?: unknown; priority?: unknown }, now: Date): FollowUpFields | { error: string } {
  const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
  if (!title) return { error: "Write what needs to be done." };
  if (title.length > MAX_FOLLOW_UP_TITLE) return { error: `Keep the title under ${MAX_FOLLOW_UP_TITLE} characters.` };
  const noteText = typeof input.note === "string" ? input.note.trim() : "";
  if (noteText.length > MAX_FOLLOW_UP_NOTE) return { error: `Keep the note under ${MAX_FOLLOW_UP_NOTE} characters.` };
  const dueAt =
    typeof input.due === "string" && (FOLLOW_UP_PRESETS as readonly string[]).includes(input.due)
      ? followUpPresetDue(input.due as FollowUpPreset, now)
      : parseDhakaDateTimeInput(input.due);
  if (!dueAt) return { error: "Choose when it is due." };
  if (dueAt.getTime() > now.getTime() + MAX_FUTURE_MS || dueAt.getTime() < now.getTime() - MAX_PAST_MS) return { error: "That due date looks wrong — check the year." };
  const priority = input.priority === undefined || input.priority === null || input.priority === "" ? "NONE" : input.priority;
  if (!isConversationPriority(priority)) return { error: "Choose a priority." };
  return { title, note: noteText || null, dueAt, priority };
}

/** "Today 15:30", "Tomorrow 10:00", "Fri 14 Nov, 09:00" — Dhaka wall clock, no Intl (server and browser agree). */
export function formatFollowUpDue(dueAt: Date, now: Date): string {
  const shifted = new Date(dueAt.getTime() + DHAKA_OFFSET_MS);
  const time = `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
  const today = getDhakaDayRange(now);
  const dayMs = 24 * 60 * 60 * 1000;
  if (dueAt >= today.start && dueAt < today.end) return `Today ${time}`;
  if (dueAt >= today.end && dueAt.getTime() < today.end.getTime() + dayMs) return `Tomorrow ${time}`;
  if (dueAt < today.start && dueAt.getTime() >= today.start.getTime() - dayMs) return `Yesterday ${time}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const sameYear = shifted.getUTCFullYear() === new Date(now.getTime() + DHAKA_OFFSET_MS).getUTCFullYear();
  return `${days[shifted.getUTCDay()]} ${shifted.getUTCDate()} ${months[shifted.getUTCMonth()]}${sameYear ? "" : ` ${shifted.getUTCFullYear()}`}, ${time}`;
}
