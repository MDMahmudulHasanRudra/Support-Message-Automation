import type { NormalizedChannelEvent } from "./channels.js";

/**
 * Website live chat rules shared by the web app (public widget API, settings) and the worker
 * (turning a visitor's message into a conversation). WEBSITE_CHAT.md is the reference.
 */

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
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  title: "Chat with us",
  welcome: "Hi! How can we help you today?",
  color: "#2563eb",
  position: "right",
  askName: true,
  askEmail: false,
  replyNote: "We usually reply within a few minutes.",
};

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
  };
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
  text: string;
  /** Display name, already marked "(unverified)" by the web when the site did not sign it. */
  name: string | null;
  email: string | null;
  occurredAt: string;
}

/** The worker's reading of a recorded visitor message. Anything malformed is IGNORED, never guessed. */
export function normalizeWebchatEvent(payload: unknown): NormalizedChannelEvent {
  const p = payload && typeof payload === "object" ? (payload as Partial<WebchatInboundPayload>) : {};
  if (!isVisitorId(p.visitorId) || !isClientNonce(p.nonce) || typeof p.text !== "string" || !p.text.trim()) {
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
    text: p.text.trim().slice(0, WEBCHAT_MAX_TEXT),
    contentType: "TEXT",
    attachments: [],
    appId: null,
    metadata: null,
    replyToExternalId: null,
  };
}
