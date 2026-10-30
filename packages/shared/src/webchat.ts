import type { ChannelAttachment, NormalizedChannelEvent } from "./channels.js";
import { planOutgoingFile } from "./chatFileSend.js";

/**
 * Website live chat rules shared by the web app (public widget API, settings) and the worker
 * (turning a visitor's message into a conversation). WEBSITE_CHAT.md is the reference.
 */

/** One day's opening hours, "HH:MM" 24-hour local time; null = closed that day. */
export interface DayHours {
  open: string;
  close: string;
}

/** When the team answers (WEBSITE_CHAT.md §Business hours). Off = always "online". */
export interface BusinessHours {
  enabled: boolean;
  /** An IANA time zone, e.g. "Asia/Dhaka". */
  timezone: string;
  /** Sunday first (index 0), as JavaScript counts days. */
  days: Array<DayHours | null>;
}

export interface WidgetSettings {
  title: string;
  welcome: string;
  /** #RRGGBB */
  color: string;
  position: "right" | "left";
  /** Ask for a name / email before the first message (optional fields, shown as unverified). */
  askName: boolean;
  askEmail: boolean;
  /** Shown under the header: when people can expect an answer. */
  replyNote: string;
  /** A short text beside the round button ("Chat with us"); empty = the button alone. */
  launcherLabel: string;
  /** Distance from the bottom of the window, px (to clear a cookie bar or a "back to top" button). */
  bottomOffset: number;
  /** Visitors may send photos and PDFs. */
  allowAttachments: boolean;
  hours: BusinessHours;
  /** Shown instead of the reply note outside business hours. */
  offlineMessage: string;
  /** Outside business hours, ask for an email so the team can answer later. */
  offlineAskEmail: boolean;
}

const WEEKDAY_HOURS: DayHours = { open: "09:00", close: "18:00" };

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  title: "Chat with us",
  welcome: "Hi! How can we help you today?",
  color: "#2563eb",
  position: "right",
  askName: true,
  askEmail: false,
  replyNote: "We usually reply within a few minutes.",
  launcherLabel: "",
  bottomOffset: 20,
  allowAttachments: true,
  // Saturday to Thursday, 09:00–18:00; Friday closed. Off until the business turns it on.
  hours: { enabled: false, timezone: "Asia/Dhaka", days: [WEEKDAY_HOURS, WEEKDAY_HOURS, WEEKDAY_HOURS, WEEKDAY_HOURS, WEEKDAY_HOURS, null, WEEKDAY_HOURS] },
  offlineMessage: "We're away right now. Leave a message and we'll reply as soon as we're back.",
  offlineAskEmail: true,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function validTimezone(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
    return tz.trim();
  } catch {
    return null;
  }
}

export function parseBusinessHours(input: unknown): BusinessHours {
  const v = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawDays = Array.isArray(v.days) ? v.days : DEFAULT_WIDGET_SETTINGS.hours.days;
  const days: Array<DayHours | null> = [];
  for (let i = 0; i < 7; i++) {
    const d = rawDays[i] as Record<string, unknown> | null | undefined;
    if (d && typeof d.open === "string" && typeof d.close === "string" && HHMM.test(d.open) && HHMM.test(d.close) && minutesOf(d.open) < minutesOf(d.close)) {
      days.push({ open: d.open, close: d.close });
    } else days.push(null);
  }
  return { enabled: v.enabled === true, timezone: validTimezone(v.timezone) ?? DEFAULT_WIDGET_SETTINGS.hours.timezone, days };
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEKDAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function localNow(timezone: string, now: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const hour = Number(get("hour")) % 24;
  return { day: WEEKDAY_INDEX[get("weekday")] ?? 0, minutes: hour * 60 + Number(get("minute")) };
}

/**
 * Whether the team is answering now, and when it next opens ("Sunday 09:00", "today 09:00"). With
 * hours off it is always open; with every day closed it is never open and there is no next opening.
 */
export function businessHoursStatus(hours: BusinessHours, now: Date): { open: boolean; nextOpen: string | null } {
  if (!hours.enabled) return { open: true, nextOpen: null };
  const { day, minutes } = localNow(hours.timezone, now);
  const today = hours.days[day];
  if (today && minutes >= minutesOf(today.open) && minutes < minutesOf(today.close)) return { open: true, nextOpen: null };
  for (let offset = 0; offset < 8; offset++) {
    const d = (day + offset) % 7;
    const h = hours.days[d];
    if (!h) continue;
    if (offset === 0 && minutes >= minutesOf(h.open)) continue;
    return { open: false, nextOpen: offset === 0 ? `today ${h.open}` : offset === 1 ? `tomorrow ${h.open}` : `${WEEKDAY_NAME[d]} ${h.open}` };
  }
  return { open: false, nextOpen: null };
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const text = (v: unknown, max: number, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback);

/** Stored or submitted settings, reduced to valid values (anything unknown falls back to the default). */
export function parseWidgetSettings(input: unknown): WidgetSettings {
  const v = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    title: text(v.title, 60, DEFAULT_WIDGET_SETTINGS.title),
    welcome: text(v.welcome, 300, DEFAULT_WIDGET_SETTINGS.welcome),
    color: typeof v.color === "string" && COLOR.test(v.color) ? v.color.toLowerCase() : DEFAULT_WIDGET_SETTINGS.color,
    position: v.position === "left" ? "left" : "right",
    askName: typeof v.askName === "boolean" ? v.askName : DEFAULT_WIDGET_SETTINGS.askName,
    askEmail: typeof v.askEmail === "boolean" ? v.askEmail : DEFAULT_WIDGET_SETTINGS.askEmail,
    replyNote: typeof v.replyNote === "string" ? v.replyNote.trim().slice(0, 120) : DEFAULT_WIDGET_SETTINGS.replyNote,
    launcherLabel: typeof v.launcherLabel === "string" ? v.launcherLabel.trim().slice(0, 30) : DEFAULT_WIDGET_SETTINGS.launcherLabel,
    bottomOffset: typeof v.bottomOffset === "number" && Number.isFinite(v.bottomOffset) ? Math.min(200, Math.max(0, Math.round(v.bottomOffset))) : DEFAULT_WIDGET_SETTINGS.bottomOffset,
    allowAttachments: typeof v.allowAttachments === "boolean" ? v.allowAttachments : DEFAULT_WIDGET_SETTINGS.allowAttachments,
    hours: v.hours === undefined ? DEFAULT_WIDGET_SETTINGS.hours : parseBusinessHours(v.hours),
    offlineMessage: text(v.offlineMessage, 300, DEFAULT_WIDGET_SETTINGS.offlineMessage),
    offlineAskEmail: typeof v.offlineAskEmail === "boolean" ? v.offlineAskEmail : DEFAULT_WIDGET_SETTINGS.offlineAskEmail,
  };
}

/** Readable text on a header of this colour: white on dark colours, near-black on light ones (WCAG luminance). */
export function contrastTextColor(hex: string): "#ffffff" | "#0f172a" {
  const n = COLOR.test(hex) ? hex : DEFAULT_WIDGET_SETTINGS.color;
  const channel = (i: number) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.45 ? "#0f172a" : "#ffffff";
}

// ── Visitor attachments ───────────────────────────────────────────────────────────────────────

/** Photos and PDFs only, at most 10 MB, at most 10 per visitor per hour. */
export const WEBCHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const WEBCHAT_ATTACHMENTS_PER_HOUR = 10;

export interface WebchatAttachment {
  type: "IMAGE" | "FILE";
  name: string;
  mimeType: string;
  size: number;
  /** `webchat/<projectId>/<visitorId>/<random>.<ext>` on the media volume. */
  storageKey: string;
}

/**
 * Whether a visitor's file may be accepted, read from its BYTES (the same sniffing as files sent from
 * WhatsApp Chat): a photo (JPEG, PNG, WebP) or a PDF. Anything else — programs, scripts, HTML, SVG,
 * archives, office files — is refused, because it would be opened by an agent.
 */
export function planVisitorAttachment(input: { head: Uint8Array; fileName: string; size: number }): { ok: true; type: "IMAGE" | "FILE"; mimeType: string; fileName: string } | { ok: false; error: string } {
  if (input.size > WEBCHAT_ATTACHMENT_MAX_BYTES) return { ok: false, error: "Files can be at most 10 MB." };
  const plan = planOutgoingFile({ head: input.head, fileName: input.fileName, size: input.size, mode: "AUTO" });
  if (!plan.ok) return { ok: false, error: "Only photos (JPEG, PNG, WebP) and PDF files can be sent here." };
  if (plan.kind === "IMAGE" && /^image\/(jpeg|png|webp)$/.test(plan.mimeType)) return { ok: true, type: "IMAGE", mimeType: plan.mimeType, fileName: plan.fileName };
  if (plan.kind === "DOCUMENT" && plan.mimeType === "application/pdf") return { ok: true, type: "FILE", mimeType: plan.mimeType, fileName: plan.fileName };
  return { ok: false, error: "Only photos (JPEG, PNG, WebP) and PDF files can be sent here." };
}

/** A storage key the web wrote for this project's website chat; anything else is never served. */
export function isWebchatStorageKey(key: unknown, projectId: string): key is string {
  return typeof key === "string" && key.length <= 300 && new RegExp(`^webchat/${projectId.replace(/[^A-Za-z0-9_-]/g, "")}/v_[A-Za-z0-9_-]{16,40}/[A-Za-z0-9_-]{16,64}\\.(jpg|png|webp|pdf)$`).test(key);
}

/**
 * A website address as the browser sends it in `Origin`: scheme + host (+ port), lowercase, no path.
 * Null for anything that is not an http(s) origin. `localhost` may be http; everything else must be https.
 */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && !local) return null;
  if (url.username || url.password) return null;
  return url.origin.toLowerCase();
}

/** Parses a textarea of origins (one per line or comma separated). Invalid lines are returned separately. */
export function parseAllowedOrigins(input: string): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\n,]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const origin = normalizeOrigin(line);
    if (!origin) invalid.push(line);
    else if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins: origins.slice(0, 20), invalid };
}

/** Whether a request's Origin is one the widget may serve. No list = nobody (fails closed). */
export function originAllowed(origin: string | null, allowed: readonly string[]): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowed.includes(normalized);
}

export const WEBCHAT_MAX_TEXT = 2000;
const VISITOR_ID = /^v_[A-Za-z0-9_-]{16,40}$/;
const NONCE = /^[A-Za-z0-9_-]{8,64}$/;

export function isVisitorId(value: unknown): value is string {
  return typeof value === "string" && VISITOR_ID.test(value);
}
export function isClientNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE.test(value);
}

/** What the web records for one visitor message; the worker turns it into a conversation message. */
export interface WebchatInboundPayload {
  provider: "WEBCHAT";
  visitorId: string;
  nonce: string;
  /** May be empty when the message is a file. */
  text: string;
  /** Display name, already marked "(unverified)" by the web when the site did not sign it. */
  name: string | null;
  email: string | null;
  occurredAt: string;
  attachments?: WebchatAttachment[];
  /** Sent outside the widget's business hours. */
  offHours?: boolean;
}

/** The worker's reading of a recorded visitor message. Anything malformed is IGNORED, never guessed. */
export function normalizeWebchatEvent(payload: unknown): NormalizedChannelEvent {
  const p = payload && typeof payload === "object" ? (payload as Partial<WebchatInboundPayload>) : {};
  const attachments: ChannelAttachment[] = Array.isArray(p.attachments)
    ? p.attachments
        .filter((a) => a && typeof a.storageKey === "string" && (a.type === "IMAGE" || a.type === "FILE"))
        .slice(0, 5)
        .map((a) => ({ type: a.type, name: typeof a.name === "string" ? a.name.slice(0, 120) : undefined, storageKey: a.storageKey, mimeType: a.mimeType, size: a.size }))
    : [];
  const hasText = typeof p.text === "string" && p.text.trim() !== "";
  if (!isVisitorId(p.visitorId) || !isClientNonce(p.nonce) || typeof p.text !== "string" || (!hasText && attachments.length === 0)) {
    return { type: "IGNORED", reason: "Malformed website chat message." };
  }
  const occurredAt = new Date(String(p.occurredAt));
  return {
    type: "MESSAGE",
    direction: "INBOUND",
    externalMessageId: `wc-${p.nonce}`,
    threadId: p.visitorId,
    threadKind: "DIRECT",
    threadTitle: null,
    senderExternalId: p.visitorId,
    senderName: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 80) : null,
    senderUsername: typeof p.email === "string" && p.email.trim() ? p.email.trim().slice(0, 120) : null,
    senderIsBot: false,
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    text: hasText ? p.text.trim().slice(0, WEBCHAT_MAX_TEXT) : null,
    contentType: hasText ? "TEXT" : attachments[0]!.type,
    attachments,
    appId: null,
    metadata: null,
    replyToExternalId: null,
  };
}
