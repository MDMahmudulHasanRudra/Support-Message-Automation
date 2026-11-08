import { formatHoursMinutes } from "./duration.js";
import { parseDhakaDateTimeInput } from "./followUps.js";
import { isConversationPriority, type ConversationPriorityValue } from "./inboxWorkspace.js";

/**
 * Support tickets (TICKETS.md, feature TICKETS): a numbered case with an owner, a due time and a history. Separate from
 * a conversation, which it may link to, because one problem can outlast many waits and a conversation can hold several
 * problems. Pure rules only: no database and no clock except the one passed in. A ticket never sends anything.
 */

export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"] as const;
export type TicketStatusValue = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_LABEL: Record<TicketStatusValue, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  WAITING_CUSTOMER: "Waiting on customer",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

export const TICKET_ACTIVE_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"] as const satisfies readonly TicketStatusValue[];
export const TICKET_FINISHED_STATUSES = ["RESOLVED", "CLOSED"] as const satisfies readonly TicketStatusValue[];

export const isTicketStatus = (value: unknown): value is TicketStatusValue => (TICKET_STATUSES as readonly unknown[]).includes(value);
export const isTicketActive = (status: TicketStatusValue): boolean => (TICKET_ACTIVE_STATUSES as readonly string[]).includes(status);

export const TICKET_EVENT_KINDS = ["CREATED", "STATUS", "ASSIGNED", "TEAM", "PRIORITY", "CATEGORY", "DUE", "EDITED", "NOTE"] as const;
export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];

export const TICKET_VIEWS = ["MINE", "UNASSIGNED", "ACTIVE", "WAITING", "OVERDUE", "RESOLVED"] as const;
export type TicketView = (typeof TICKET_VIEWS)[number];

export const TICKET_VIEW_LABEL: Record<TicketView, string> = {
  MINE: "Mine",
  UNASSIGNED: "Unassigned",
  ACTIVE: "All open",
  WAITING: "Waiting on customer",
  OVERDUE: "Overdue",
  RESOLVED: "Resolved",
};

export const isTicketView = (value: unknown): value is TicketView => (TICKET_VIEWS as readonly unknown[]).includes(value);

export const MAX_TICKET_SUBJECT = 200;
export const MAX_TICKET_DESCRIPTION = 4000;
export const MAX_TICKET_NOTE = 4000;
export const MAX_TICKET_CATEGORIES = 30;
export const MAX_TICKET_CATEGORY_LENGTH = 40;

export const formatTicketNumber = (number: number): string => `T-${String(number).padStart(4, "0")}`;

/** A number somebody typed into search: "T-0012", "t12" or "12". */
export function parseTicketNumber(value: string): number | null {
  const match = value.trim().match(/^t?-?0*(\d{1,9})$/i);
  return match ? Number(match[1]) : null;
}

/** The line a person may drop into their reply. It only fills the box: sending stays their own press. */
export const ticketReferenceText = (number: number): string => `Your ticket number is ${formatTicketNumber(number)}. We are working on it.`;

// ---------------------------------------------------------------------------------------------
// Due times

export interface TicketTargets {
  urgentHours: number;
  highHours: number;
  normalHours: number;
  lowHours: number;
}

export const DEFAULT_TICKET_TARGETS: TicketTargets = { urgentHours: 4, highHours: 24, normalHours: 72, lowHours: 168 };
export const DEFAULT_TICKET_CATEGORIES = ["General", "Billing", "Technical"];

export function ticketTargetHours(priority: ConversationPriorityValue, targets: TicketTargets): number {
  switch (priority) {
    case "URGENT":
      return targets.urgentHours;
    case "HIGH":
      return targets.highHours;
    case "LOW":
      return targets.lowHours;
    default:
      return targets.normalHours;
  }
}

export function ticketDueFrom(start: Date, priority: ConversationPriorityValue, targets: TicketTargets): Date {
  return new Date(start.getTime() + ticketTargetHours(priority, targets) * 3_600_000);
}

const DUE_SOON_MS = 2 * 3_600_000;
const SHOW_REMAINING_MS = 48 * 3_600_000;

export type TicketClockTone = "danger" | "warning" | "neutral" | "paused" | "done";

const dhakaWhen = (when: Date): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(when);

/** What the due time means right now, in words: the same reading on the list, the ticket and the side panel. */
export function ticketClock(
  ticket: { status: TicketStatusValue; dueAt: Date | null; resolvedAt: Date | null },
  now: Date,
): { tone: TicketClockTone; text: string; overdue: boolean } {
  if (ticket.status === "RESOLVED" || ticket.status === "CLOSED") {
    return { tone: "done", text: ticket.resolvedAt ? `Resolved ${dhakaWhen(ticket.resolvedAt)}` : "Resolved", overdue: false };
  }
  if (ticket.status === "WAITING_CUSTOMER") return { tone: "paused", text: "Paused until the customer answers", overdue: false };
  if (!ticket.dueAt) return { tone: "neutral", text: "No due time", overdue: false };
  const left = ticket.dueAt.getTime() - now.getTime();
  if (left < 0) return { tone: "danger", text: `Overdue by ${formatHoursMinutes(Math.floor(-left / 1000))}`, overdue: true };
  if (left <= DUE_SOON_MS) return { tone: "warning", text: `${formatHoursMinutes(Math.floor(left / 1000))} left`, overdue: false };
  if (left <= SHOW_REMAINING_MS) return { tone: "neutral", text: `${formatHoursMinutes(Math.floor(left / 1000))} left`, overdue: false };
  return { tone: "neutral", text: `Due ${dhakaWhen(ticket.dueAt)}`, overdue: false };
}

// ---------------------------------------------------------------------------------------------
// Moving a ticket

export interface TicketMove {
  status: TicketStatusValue;
  pausedAt: Date | null;
  dueAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
}

/**
 * The one rule for a status change. Waiting on the customer stops the clock: the time spent waiting is added to the due
 * time when the ticket comes back. Reopening starts a new target, because the old one belonged to the old problem.
 */
export function decideTicketMove(
  ticket: { status: TicketStatusValue; dueAt: Date | null; pausedAt: Date | null; resolvedAt: Date | null; priority: ConversationPriorityValue },
  to: TicketStatusValue,
  now: Date,
  targets: TicketTargets,
): { ok: true; move: TicketMove } | { ok: false; error: string } {
  const from = ticket.status;
  if (from === to) return { ok: false, error: `This ticket is already ${TICKET_STATUS_LABEL[to].toLowerCase()}.` };
  if (from === "CLOSED" && to !== "OPEN") return { ok: false, error: "A closed ticket can only be reopened." };
  if (from === "RESOLVED" && to === "WAITING_CUSTOMER") return { ok: false, error: "Reopen this ticket first." };

  const reopening = (from === "RESOLVED" || from === "CLOSED") && isTicketActive(to);
  let dueAt = ticket.dueAt;
  if (reopening && dueAt) dueAt = ticketDueFrom(now, ticket.priority, targets);
  else if (from === "WAITING_CUSTOMER" && dueAt && ticket.pausedAt) dueAt = new Date(dueAt.getTime() + Math.max(0, now.getTime() - ticket.pausedAt.getTime()));

  const finished = to === "RESOLVED" || to === "CLOSED";
  return {
    ok: true,
    move: {
      status: to,
      pausedAt: to === "WAITING_CUSTOMER" ? now : null,
      dueAt,
      resolvedAt: finished ? (ticket.resolvedAt ?? now) : null,
      closedAt: to === "CLOSED" ? now : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// What a form sent

export interface TicketFields {
  subject: string;
  description: string | null;
  priority: ConversationPriorityValue;
  category: string | null;
  /** Null: use the target for this priority. */
  dueAt: Date | null;
}

export function readTicketFields(
  input: { subject?: unknown; description?: unknown; priority?: unknown; category?: unknown; due?: unknown },
  categories: readonly string[],
): { ok: true; fields: TicketFields } | { ok: false; error: string } {
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject) return { ok: false, error: "Write what the ticket is about." };
  if (subject.length > MAX_TICKET_SUBJECT) return { ok: false, error: `Keep the subject to ${MAX_TICKET_SUBJECT} characters.` };
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim() : null;
  if (description && description.length > MAX_TICKET_DESCRIPTION) return { ok: false, error: `Keep the description to ${MAX_TICKET_DESCRIPTION} characters.` };
  const priority: ConversationPriorityValue = isConversationPriority(input.priority) && input.priority !== "NONE" ? input.priority : "NORMAL";
  const category = typeof input.category === "string" && input.category.trim() ? input.category.trim() : null;
  if (category && !categories.includes(category)) return { ok: false, error: "Choose a category from the list." };
  let dueAt: Date | null = null;
  if (typeof input.due === "string" && input.due) {
    dueAt = parseDhakaDateTimeInput(input.due);
    if (!dueAt) return { ok: false, error: "That due time does not look right." };
  }
  return { ok: true, fields: { subject, description, priority, category, dueAt } };
}

/** The settings form: whole hours, a clean list of categories. */
export function readTicketSettings(input: {
  urgentHours?: unknown;
  highHours?: unknown;
  normalHours?: unknown;
  lowHours?: unknown;
  categories?: unknown;
}): { ok: true; targets: TicketTargets; categories: string[] } | { ok: false; error: string } {
  const hours = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 8760 ? n : null;
  };
  const urgentHours = hours(input.urgentHours);
  const highHours = hours(input.highHours);
  const normalHours = hours(input.normalHours);
  const lowHours = hours(input.lowHours);
  if (urgentHours === null || highHours === null || normalHours === null || lowHours === null) {
    return { ok: false, error: "Each target must be a whole number of hours, from 1 to 8760." };
  }
  const raw = typeof input.categories === "string" ? input.categories.split(/\r?\n|,/) : [];
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const line of raw) {
    const name = line.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    if (name.length > MAX_TICKET_CATEGORY_LENGTH) return { ok: false, error: `Keep each category to ${MAX_TICKET_CATEGORY_LENGTH} characters.` };
    seen.add(name.toLowerCase());
    categories.push(name);
  }
  if (categories.length > MAX_TICKET_CATEGORIES) return { ok: false, error: `Keep to ${MAX_TICKET_CATEGORIES} categories.` };
  return { ok: true, targets: { urgentHours, highHours, normalHours, lowHours }, categories };
}

export function readTicketNote(value: unknown): { ok: true; body: string } | { ok: false; error: string } {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) return { ok: false, error: "Write the note first." };
  if (body.length > MAX_TICKET_NOTE) return { ok: false, error: `Keep a note to ${MAX_TICKET_NOTE} characters.` };
  return { ok: true, body };
}
