/**
 * Post-conversation CSAT ("How did we do? 1–5"), feature CSAT_SURVEYS, off by default (CSAT.md). Pure rules
 * shared by the dashboard (which records a survey when a person resolves a conversation), the worker (which
 * asks it and reads the answer) and the website chat API (which takes the widget's answer), so the three can
 * never disagree about what counts as a rating.
 *
 * A survey is asked ONCE per resolution, never in a group, never to a team member, at most once per customer
 * per cooldown, and only on a channel the project switched on. An answer is final: nothing may change it.
 */

/** Where a survey can be asked. A WhatsApp GROUP is deliberately not one of them. */
export const CSAT_CHANNELS = ["WHATSAPP_PERSONAL", "WEBCHAT", "MESSENGER", "INSTAGRAM", "TELEGRAM"] as const;
export type CsatChannel = (typeof CSAT_CHANNELS)[number];

export const CSAT_CHANNEL_LABELS: Record<CsatChannel, string> = {
  WHATSAPP_PERSONAL: "WhatsApp (personal chats)",
  WEBCHAT: "Website chat",
  MESSENGER: "Facebook Messenger",
  INSTAGRAM: "Instagram DM",
  TELEGRAM: "Telegram",
};

export function isCsatChannel(value: unknown): value is CsatChannel {
  return typeof value === "string" && (CSAT_CHANNELS as readonly string[]).includes(value);
}

/** The outbound idempotency variant of the WhatsApp survey message (one per customer message, ever). */
export const CSAT_SURVEY_VARIANT = "csat-survey";

/** How long after the survey went out the customer's next message is read as a possible answer. */
export const CSAT_ANSWER_WINDOW_HOURS = 24;
/** A survey the worker has not asked within this long after the resolution is skipped, never sent late. */
export const CSAT_DISPATCH_MAX_DELAY_MINUTES = 30;

export const CSAT_COOLDOWN_DEFAULT_DAYS = 7;
export const CSAT_COOLDOWN_MIN_DAYS = 0;
export const CSAT_COOLDOWN_MAX_DAYS = 365;
export const CSAT_QUESTION_MAX_LENGTH = 500;
export const CSAT_COMMENT_MAX_LENGTH = 1000;

/** The text-message question (WhatsApp, Messenger, Instagram, Telegram): the customer answers with a number. */
export const DEFAULT_CSAT_QUESTION =
  "আমাদের সেবা কেমন লাগলো? ১ থেকে ৫ এর মধ্যে একটি সংখ্যা লিখে উত্তর দিন (৫ = খুব ভালো)।\nHow did we do? Reply with a number from 1 to 5 (5 = excellent).";

/** The website chat card's question: the visitor taps a rating, so no instruction to type one. */
export const DEFAULT_CSAT_WIDGET_QUESTION = "আমাদের সেবা কেমন লাগলো? / How did we do?";

/** The question asked on a channel: the admin's wording, or the built-in one (null = built-in, so Reset is "forget my edit"). */
export function csatQuestionFor(channel: CsatChannel, custom: string | null | undefined): string {
  const text = custom?.trim();
  if (text) return text.slice(0, CSAT_QUESTION_MAX_LENGTH);
  return channel === "WEBCHAT" ? DEFAULT_CSAT_WIDGET_QUESTION : DEFAULT_CSAT_QUESTION;
}

export interface CsatChannelSwitches {
  whatsappPersonalEnabled: boolean;
  webchatEnabled: boolean;
  messengerEnabled: boolean;
  instagramEnabled: boolean;
  telegramEnabled: boolean;
}

/** No settings row = every channel off: a project that switched the feature on still chooses its channels. */
export const DEFAULT_CSAT_SWITCHES: CsatChannelSwitches = {
  whatsappPersonalEnabled: false,
  webchatEnabled: false,
  messengerEnabled: false,
  instagramEnabled: false,
  telegramEnabled: false,
};

export function csatChannelEnabled(settings: CsatChannelSwitches, channel: CsatChannel): boolean {
  switch (channel) {
    case "WHATSAPP_PERSONAL":
      return settings.whatsappPersonalEnabled;
    case "WEBCHAT":
      return settings.webchatEnabled;
    case "MESSENGER":
      return settings.messengerEnabled;
    case "INSTAGRAM":
      return settings.instagramEnabled;
    case "TELEGRAM":
      return settings.telegramEnabled;
  }
}

/**
 * Which survey channel a conversation is, or null when a survey may never be asked there: a WhatsApp group,
 * anything that is not a WhatsApp personal chat, or a channel group thread (a Telegram group).
 */
export function csatChannelForWhatsApp(chatId: string): CsatChannel | null {
  if (chatId.endsWith("@g.us")) return null;
  return chatId.endsWith("@c.us") || chatId.endsWith("@lid") ? "WHATSAPP_PERSONAL" : null;
}
export function csatChannelForConversation(type: string, kind: string): CsatChannel | null {
  if (kind !== "DIRECT") return null;
  return isCsatChannel(type) && type !== "WHATSAPP_PERSONAL" ? type : null;
}

/** The customer a cooldown counts against: the WhatsApp chat (across our numbers) or the channel thread. */
export function csatCustomerKey(input: { kind: "whatsapp"; chatId: string } | { kind: "channel"; connectionId: string; externalThreadId: string }): string {
  return input.kind === "whatsapp" ? `wa:${input.chatId}` : `ch:${input.connectionId}:${input.externalThreadId}`;
}

export function clampCsatCooldownDays(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return CSAT_COOLDOWN_DEFAULT_DAYS;
  return Math.min(CSAT_COOLDOWN_MAX_DAYS, Math.max(CSAT_COOLDOWN_MIN_DAYS, Math.round(n)));
}

// ── Reading a rating out of a message ────────────────────────────────────────────────────────────

const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";
const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function asciiDigits(text: string): string {
  let out = "";
  for (const ch of text) {
    const b = BANGLA_DIGITS.indexOf(ch);
    const a = ARABIC_INDIC_DIGITS.indexOf(ch);
    out += b >= 0 ? String(b) : a >= 0 ? String(a) : ch;
  }
  return out;
}

const STAR = /[⭐★🌟]/gu;

/**
 * The rating a customer's message IS, or null when it is anything else. Deliberately strict: only a message
 * that is nothing but a rating counts, because reading "5 days and still no internet" as a five would be a
 * lie in the report. Accepted (Bangla and Arabic-Indic digits too, surrounding spaces and a full stop or "!"
 * allowed): "5", "৫", "4/5", "৪ / ৫", "5 out of 5", "5⭐", "⭐⭐⭐⭐", "★★★", "5️⃣". Everything else is an
 * ordinary message and leaves the survey unanswered.
 */
export function parseCsatRating(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  if (text.length > 40) return null;
  let s = asciiDigits(text.normalize("NFC"))
    .replace(/[️‍]/g, "")
    .trim()
    .replace(/[.!।]+$/u, "")
    .trim();
  if (!s) return null;
  // A keycap digit ("5️⃣" → "5⃣" once the variation selector is gone).
  s = s.replace(/^([0-9])⃣$/u, "$1");

  const digit = /^([1-5])$/.exec(s);
  if (digit) return Number(digit[1]);
  const outOfFive = /^([1-5])\s*(?:\/|out\s+of|of)\s*5$/i.exec(s);
  if (outOfFive) return Number(outOfFive[1]);
  const digitStar = /^([1-5])\s*(?:[⭐★🌟]|stars?)$/iu.exec(s);
  if (digitStar) return Number(digitStar[1]);
  const stars = s.replace(/\s+/g, "");
  if (stars.length > 0 && stars.replace(STAR, "") === "") {
    const count = stars.match(STAR)?.length ?? 0;
    return count >= 1 && count <= 5 ? count : null;
  }
  return null;
}

/** A rating from the widget: an integer 1–5, or null. */
export function readCsatRating(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^[1-5]$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/** A widget comment: trimmed, at most CSAT_COMMENT_MAX_LENGTH characters, empty = none. */
export function readCsatComment(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, CSAT_COMMENT_MAX_LENGTH);
  return text || null;
}

// ── The figures ──────────────────────────────────────────────────────────────────────────────────

export interface CsatSummary {
  /** Surveys that went out (or were shown in the widget). */
  asked: number;
  answered: number;
  /** answered / asked, 0–1; null when nothing was asked. */
  responseRate: number | null;
  /** Ratings of 4 or 5 among the answered, 0–1 — the usual CSAT score; null when nothing was answered. */
  csat: number | null;
  /** Mean rating 1–5; null when nothing was answered. */
  average: number | null;
  /** How many of each rating, index 0 = rating 1. */
  distribution: [number, number, number, number, number];
}

/** One formula for every place a CSAT figure is shown (report tiles, per-agent and per-channel rows). */
export function summarizeCsat(rows: ReadonlyArray<{ asked: boolean; rating: number | null }>): CsatSummary {
  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let asked = 0;
  let answered = 0;
  let satisfied = 0;
  let total = 0;
  for (const row of rows) {
    if (!row.asked) continue;
    asked++;
    if (row.rating === null || !Number.isInteger(row.rating) || row.rating < 1 || row.rating > 5) continue;
    answered++;
    total += row.rating;
    if (row.rating >= 4) satisfied++;
    distribution[row.rating - 1] = (distribution[row.rating - 1] ?? 0) + 1;
  }
  return {
    asked,
    answered,
    responseRate: asked ? answered / asked : null,
    csat: answered ? satisfied / answered : null,
    average: answered ? total / answered : null,
    distribution,
  };
}

export function formatCsatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
