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

  // ── V3 (docs/website-chat-v3). Every field below is optional in storage: a widget saved before V3
  // reads as the defaults, which render exactly as it looked before. ──────────────────────────────

  /** The preset the look started from; editing any field makes it CUSTOM. */
  preset: WidgetPreset;
  theme: "light" | "dark" | "auto";
  headerStyle: "solid" | "gradient" | "light";
  /** Null = the brand colour. */
  headerColor: string | null;
  /** Null = the theme's own background. */
  backgroundColor: string | null;
  /** Null = the brand colour (visitor's bubbles) / the theme's surface (team's bubbles). */
  visitorBubbleColor: string | null;
  teamBubbleColor: string | null;
  /** Panel corner radius, px. */
  radius: number;
  panelWidth: number;
  panelHeight: number;
  launcherSize: number;
  shadow: "none" | "soft" | "strong";
  font: WidgetFont;
  /** Full screen on phones (≤ 480 px); off = a large floating panel. */
  mobileFullscreen: boolean;
  launcherStyle: LauncherStyle;
  launcherIcon: "chat" | "help" | "message" | "headset";
  /** What the open panel's header shows beside the title. */
  headerVisual: "LOGO" | "AVATARS" | "NONE";
  /** Uploaded images (logo, launcher icon, approved team photos). Served only while listed here. */
  assets: WidgetAsset[];
  logoAssetId: string | null;
  launcherAssetId: string | null;
  /** Approved team members shown in the header and launcher. Never "online": nothing here knows who is. */
  team: WidgetTeamMember[];
  /** Seconds after the page loads before the launcher appears. */
  showDelaySec: number;
  teaser: WidgetTeaser;
  autoOpen: { enabled: boolean; delaySec: number };
  pages: WidgetPages;
  devices: { desktop: boolean; mobile: boolean };
  /** PDFs as well as photos. Widgets made before V3 keep what they had; new widgets are photos only. */
  allowPdf: boolean;
  emoji: boolean;
}

export type WidgetPreset = "MODERN_MINIMAL" | "CORPORATE" | "FRIENDLY" | "DARK_PREMIUM" | "CUSTOM";
export type WidgetFont = "system" | "rounded" | "humanist" | "serif";
export type LauncherStyle = "ICON" | "ICON_TEXT" | "LOGO" | "AVATAR" | "CUSTOM_ICON";

export interface WidgetAsset {
  id: string;
  kind: "LOGO" | "ICON" | "AVATAR";
  /** `webchat-brand/<projectId>/<connectionId>/<id>.<ext>`; never sent to a browser. */
  storageKey: string;
  mimeType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface WidgetTeamMember {
  /** The AVATAR asset. */
  assetId: string;
  /** First name or display name, as the admin typed it — nothing is read from an employee record. */
  name: string;
  /** Who confirmed the person agreed to their photo being shown publicly, and when. */
  consentBy: string;
  consentAt: string;
}

export interface WidgetTeaser {
  enabled: boolean;
  text: string;
  delaySec: number;
  /** Show at most once in a browser session. */
  oncePerSession: boolean;
  /** Show again only after this many days (0 = every session). A dismissal always waits at least a day. */
  capDays: number;
  mobile: boolean;
  /** Hide the teaser again after this many seconds (0 = until dismissed or the chat opens). */
  hideAfterSec: number;
}

export interface WidgetPages {
  /** ALL allowed pages, only the INCLUDE paths, or everything but the EXCLUDE paths. */
  mode: "ALL" | "INCLUDE" | "EXCLUDE";
  /** Paths like `/pricing` (exact) or `/blog/*` (the path and everything under it). */
  paths: string[];
  /** Never on checkout / cart / payment pages, whatever the mode. */
  hideCheckout: boolean;
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
  preset: "MODERN_MINIMAL",
  theme: "light",
  headerStyle: "solid",
  headerColor: null,
  backgroundColor: null,
  visitorBubbleColor: null,
  teamBubbleColor: null,
  radius: 16,
  panelWidth: 360,
  panelHeight: 540,
  launcherSize: 56,
  shadow: "soft",
  font: "system",
  mobileFullscreen: true,
  launcherStyle: "ICON",
  launcherIcon: "chat",
  headerVisual: "NONE",
  assets: [],
  logoAssetId: null,
  launcherAssetId: null,
  team: [],
  showDelaySec: 0,
  teaser: { enabled: false, text: "Hi! Need any help?", delaySec: 8, oncePerSession: true, capDays: 1, mobile: false, hideAfterSec: 0 },
  autoOpen: { enabled: false, delaySec: 30 },
  pages: { mode: "ALL", paths: [], hideCheckout: true },
  devices: { desktop: true, mobile: true },
  allowPdf: false,
  emoji: true,
};

/**
 * The four original looks. Each only fills appearance fields; every one stays editable afterwards.
 */
export const WIDGET_PRESETS: Record<Exclude<WidgetPreset, "CUSTOM">, { label: string; values: Partial<WidgetSettings> }> = {
  MODERN_MINIMAL: {
    label: "Modern Minimal",
    values: { theme: "light", headerStyle: "solid", color: "#2563eb", headerColor: null, backgroundColor: null, visitorBubbleColor: null, teamBubbleColor: null, radius: 16, shadow: "soft", font: "system", launcherSize: 56 },
  },
  CORPORATE: {
    label: "Corporate Support",
    values: { theme: "light", headerStyle: "solid", color: "#0f3d6e", headerColor: "#0f3d6e", backgroundColor: "#f5f7fa", visitorBubbleColor: "#0f3d6e", teamBubbleColor: "#ffffff", radius: 8, shadow: "soft", font: "humanist", launcherSize: 54 },
  },
  FRIENDLY: {
    label: "Friendly Rounded",
    values: { theme: "light", headerStyle: "gradient", color: "#e8590c", headerColor: null, backgroundColor: "#fff9f4", visitorBubbleColor: "#e8590c", teamBubbleColor: "#ffffff", radius: 24, shadow: "strong", font: "rounded", launcherSize: 60 },
  },
  DARK_PREMIUM: {
    label: "Dark Premium",
    values: { theme: "dark", headerStyle: "solid", color: "#c9a227", headerColor: "#111318", backgroundColor: "#16181d", visitorBubbleColor: "#c9a227", teamBubbleColor: "#23262d", radius: 14, shadow: "strong", font: "system", launcherSize: 56 },
  },
};

/** Safe font stacks only — nothing is downloaded from a font service onto the customer's site. */
export const WIDGET_FONT_STACKS: Record<WidgetFont, string> = {
  system: "system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Sans Bengali',sans-serif",
  rounded: "ui-rounded,'SF Pro Rounded','Nunito','Varela Round',system-ui,'Noto Sans Bengali',sans-serif",
  humanist: "'Segoe UI',Candara,'Trebuchet MS','Noto Sans',system-ui,'Noto Sans Bengali',sans-serif",
  serif: "Georgia,'Iowan Old Style','Times New Roman','Noto Serif','Noto Serif Bengali',serif",
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
    ...parseV3(v),
  };
}

const D = DEFAULT_WIDGET_SETTINGS;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);
const intIn = (value: unknown, min: number, max: number, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const colorOrNull = (value: unknown, fallback: string | null) => (value === null ? null : typeof value === "string" && COLOR.test(value) ? value.toLowerCase() : fallback);
const ASSET_ID = /^[A-Za-z0-9_-]{12,40}$/;
const ISO = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

function parseAssets(input: unknown): WidgetAsset[] {
  if (!Array.isArray(input)) return [];
  const out: WidgetAsset[] = [];
  for (const raw of input.slice(0, 12)) {
    const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const id = typeof a.id === "string" && ASSET_ID.test(a.id) ? a.id : null;
    const kind = oneOf(a.kind, ["LOGO", "ICON", "AVATAR"] as const, "LOGO");
    const storageKey = typeof a.storageKey === "string" && /^webchat-brand\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(a.storageKey) ? a.storageKey : null;
    const mimeType = oneOf(a.mimeType, ["image/jpeg", "image/png", "image/webp"] as const, "image/png");
    if (!id || !storageKey || out.some((x) => x.id === id)) continue;
    out.push({ id, kind, storageKey, mimeType, size: intIn(a.size, 0, 10_000_000, 0), uploadedBy: text(a.uploadedBy, 100, "unknown"), uploadedAt: ISO(a.uploadedAt) ?? new Date(0).toISOString() });
  }
  return out;
}

/** A path rule: `/x` exact (trailing slash ignored) or `/x/*` (the path and everything under it). */
export function cleanPathRule(raw: string): string | null {
  const p = raw.trim();
  if (!/^\/[A-Za-z0-9\-._~%!$&'()+,;=:@/]*(\*)?$/.test(p) || p.length > 200 || p.indexOf("*") !== p.lastIndexOf("*")) return null;
  return p;
}

type V1Keys = "title" | "welcome" | "color" | "position" | "askName" | "askEmail" | "replyNote" | "launcherLabel" | "bottomOffset" | "allowAttachments" | "hours" | "offlineMessage" | "offlineAskEmail";

function parseV3(v: Record<string, unknown>): Omit<WidgetSettings, V1Keys> {
  const assets = parseAssets(v.assets);
  const assetOf = (id: unknown, kind: WidgetAsset["kind"]) => (typeof id === "string" && assets.some((a) => a.id === id && a.kind === kind) ? id : null);
  const teamRaw = Array.isArray(v.team) ? v.team : [];
  const team: WidgetTeamMember[] = [];
  for (const raw of teamRaw.slice(0, 5)) {
    const t = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const assetId = assetOf(t.assetId, "AVATAR");
    const consentAt = ISO(t.consentAt);
    const name = typeof t.name === "string" ? t.name.trim().slice(0, 40) : "";
    // A photo is shown only with a recorded consent; without it the member is dropped, never shown.
    if (!assetId || !consentAt || !name || typeof t.consentBy !== "string" || !t.consentBy.trim() || team.some((m) => m.assetId === assetId)) continue;
    team.push({ assetId, name, consentBy: t.consentBy.trim().slice(0, 100), consentAt });
  }
  const teaser = v.teaser && typeof v.teaser === "object" ? (v.teaser as Record<string, unknown>) : {};
  const autoOpen = v.autoOpen && typeof v.autoOpen === "object" ? (v.autoOpen as Record<string, unknown>) : {};
  const pages = v.pages && typeof v.pages === "object" ? (v.pages as Record<string, unknown>) : {};
  const devices = v.devices && typeof v.devices === "object" ? (v.devices as Record<string, unknown>) : {};
  const paths = Array.isArray(pages.paths) ? [...new Set(pages.paths.filter((p): p is string => typeof p === "string").map(cleanPathRule).filter((p): p is string => p !== null))].slice(0, 30) : [];
  const allowAttachments = typeof v.allowAttachments === "boolean" ? v.allowAttachments : D.allowAttachments;
  const desktop = bool(devices.desktop, D.devices.desktop);
  const mobile = bool(devices.mobile, D.devices.mobile);
  return {
    preset: oneOf(v.preset, ["MODERN_MINIMAL", "CORPORATE", "FRIENDLY", "DARK_PREMIUM", "CUSTOM"] as const, D.preset),
    theme: oneOf(v.theme, ["light", "dark", "auto"] as const, D.theme),
    headerStyle: oneOf(v.headerStyle, ["solid", "gradient", "light"] as const, D.headerStyle),
    headerColor: colorOrNull(v.headerColor, D.headerColor),
    backgroundColor: colorOrNull(v.backgroundColor, D.backgroundColor),
    visitorBubbleColor: colorOrNull(v.visitorBubbleColor, D.visitorBubbleColor),
    teamBubbleColor: colorOrNull(v.teamBubbleColor, D.teamBubbleColor),
    radius: intIn(v.radius, 0, 28, D.radius),
    panelWidth: intIn(v.panelWidth, 320, 440, D.panelWidth),
    panelHeight: intIn(v.panelHeight, 420, 720, D.panelHeight),
    launcherSize: intIn(v.launcherSize, 44, 72, D.launcherSize),
    shadow: oneOf(v.shadow, ["none", "soft", "strong"] as const, D.shadow),
    font: oneOf(v.font, ["system", "rounded", "humanist", "serif"] as const, D.font),
    mobileFullscreen: bool(v.mobileFullscreen, D.mobileFullscreen),
    launcherStyle: oneOf(v.launcherStyle, ["ICON", "ICON_TEXT", "LOGO", "AVATAR", "CUSTOM_ICON"] as const, D.launcherStyle),
    launcherIcon: oneOf(v.launcherIcon, ["chat", "help", "message", "headset"] as const, D.launcherIcon),
    headerVisual: oneOf(v.headerVisual, ["LOGO", "AVATARS", "NONE"] as const, D.headerVisual),
    assets,
    logoAssetId: assetOf(v.logoAssetId, "LOGO"),
    launcherAssetId: assetOf(v.launcherAssetId, "ICON"),
    team,
    showDelaySec: intIn(v.showDelaySec, 0, 120, D.showDelaySec),
    teaser: {
      enabled: bool(teaser.enabled, D.teaser.enabled),
      text: text(teaser.text, 140, D.teaser.text),
      delaySec: intIn(teaser.delaySec, 0, 300, D.teaser.delaySec),
      oncePerSession: bool(teaser.oncePerSession, D.teaser.oncePerSession),
      capDays: intIn(teaser.capDays, 0, 90, D.teaser.capDays),
      mobile: bool(teaser.mobile, D.teaser.mobile),
      hideAfterSec: intIn(teaser.hideAfterSec, 0, 600, D.teaser.hideAfterSec),
    },
    autoOpen: { enabled: bool(autoOpen.enabled, false), delaySec: intIn(autoOpen.delaySec, 5, 600, D.autoOpen.delaySec) },
    pages: { mode: oneOf(pages.mode, ["ALL", "INCLUDE", "EXCLUDE"] as const, "ALL"), paths, hideCheckout: bool(pages.hideCheckout, D.pages.hideCheckout) },
    // Hidden everywhere is not a widget setting; it is switching the widget off.
    devices: desktop || mobile ? { desktop, mobile } : { desktop: true, mobile: true },
    // Before V3 one switch allowed photos AND PDFs: a stored widget without this field keeps PDFs exactly as it had them.
    allowPdf: typeof v.allowPdf === "boolean" ? v.allowPdf : "allowAttachments" in v ? allowAttachments : D.allowPdf,
    emoji: bool(v.emoji, D.emoji),
  };
}

// ── Code the widget script runs as-is (embedded with Function.prototype.toString) ─────────────────
// These three are self-contained: no imports, no outside names, ES2017. The widget embeds their source,
// so the browser runs exactly what the tests here check.

/** Whether the widget shows on this path. `rules` are `/x` (exact) or `/x/*` (that path and below). */
export function widgetPathAllowed(path: string, pages: { mode: string; paths: string[]; hideCheckout: boolean }): boolean {
  var clean = function (p: string) {
    var s = (p || "/").split("?")[0]!.split("#")[0]!.toLowerCase();
    return s.length > 1 && s.charAt(s.length - 1) === "/" ? s.slice(0, -1) : s;
  };
  var match = function (rule: string, p: string) {
    var r = rule.toLowerCase();
    if (r.charAt(r.length - 1) === "*") {
      var base = clean(r.slice(0, -1));
      return p === base || p.indexOf(base === "/" ? "/" : base + "/") === 0;
    }
    return clean(r) === p;
  };
  var p = clean(path);
  if (pages.hideCheckout) {
    // The path itself or anything below it: /checkout, /checkout/order-pay/12, /cart, Shopify's /checkouts/…
    var checkout = ["/checkout", "/checkouts", "/cart", "/basket", "/payment", "/pay", "/order-pay"];
    for (var i = 0; i < checkout.length; i++) if (p === checkout[i] || p.indexOf(checkout[i] + "/") === 0) return false;
  }
  if (pages.mode === "INCLUDE") {
    for (var j = 0; j < pages.paths.length; j++) if (match(pages.paths[j]!, p)) return true;
    return false;
  }
  if (pages.mode === "EXCLUDE") {
    for (var k = 0; k < pages.paths.length; k++) if (match(pages.paths[k]!, p)) return false;
  }
  return true;
}

/**
 * Whether the greeting teaser may show now. `memory` is what the browser remembered:
 * when it was last shown and dismissed (ms), and whether it showed in this browser session.
 * A dismissal is respected for max(capDays, 1) days; an active conversation never gets a teaser.
 */
export function widgetTeaserAllowed(
  teaser: { enabled: boolean; oncePerSession: boolean; capDays: number; mobile: boolean },
  memory: { shownAt: number | null; dismissedAt: number | null; shownThisSession: boolean },
  context: { now: number; mobile: boolean; hasConversation: boolean; panelOpen: boolean },
): boolean {
  if (!teaser.enabled || context.panelOpen || context.hasConversation) return false;
  if (context.mobile && !teaser.mobile) return false;
  var day = 86400000;
  if (memory.dismissedAt !== null && context.now - memory.dismissedAt < Math.max(teaser.capDays, 1) * day) return false;
  if (teaser.oncePerSession && memory.shownThisSession) return false;
  if (teaser.capDays > 0 && memory.shownAt !== null && context.now - memory.shownAt < teaser.capDays * day) return false;
  return true;
}

/**
 * What a person typed as a website address, as the browser's Origin: `getassist.pro` → `https://getassist.pro`,
 * `https://www.x.com/page` → `https://www.x.com`. Refuses other schemes, credentials, wildcards, spaces and
 * anything that is not a host name (or localhost / 127.0.0.1 for testing, which may be http).
 */
export function normalizeOriginInput(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 300 || /[\s*]/.test(value)) return null;
  // "host:8443" is a host and a port, not a scheme: only "x://" or a known non-web scheme counts as one.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(javascript|data|file|mailto|vbscript|blob|about):/i.test(value);
  if (hasScheme && !/^https?:\/\//i.test(value)) return null;
  const withScheme = hasScheme ? value : `https://${value.replace(/^\/\//, "")}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  if (!local && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/.test(host)) return null;
  return normalizeOrigin(url.origin);
}

/** For a bare domain, the www. address the person may want too — offered, never added by itself. */
export function wwwVariant(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.hostname.startsWith("www.") || url.hostname === "localhost" || /^\d/.test(url.hostname) || url.hostname.split(".").length !== 2) return null;
    return `${url.protocol}//www.${url.host}`;
  } catch {
    return null;
  }
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
export function planVisitorAttachment(input: { head: Uint8Array; fileName: string; size: number; allowPdf?: boolean }): { ok: true; type: "IMAGE" | "FILE"; mimeType: string; fileName: string } | { ok: false; error: string } {
  // Callers before V3 passed no flag and accepted PDFs; the widget passes its own `allowPdf`.
  const allowPdf = input.allowPdf !== false;
  const refusal = allowPdf ? "Only photos (JPEG, PNG, WebP) and PDF files can be sent here." : "Only photos (JPEG, PNG or WebP) can be sent here.";
  if (input.size > WEBCHAT_ATTACHMENT_MAX_BYTES) return { ok: false, error: "Files can be at most 10 MB." };
  const plan = planOutgoingFile({ head: input.head, fileName: input.fileName, size: input.size, mode: "AUTO" });
  if (!plan.ok) return { ok: false, error: refusal };
  if (plan.kind === "IMAGE" && /^image\/(jpeg|png|webp)$/.test(plan.mimeType)) return { ok: true, type: "IMAGE", mimeType: plan.mimeType, fileName: plan.fileName };
  if (allowPdf && plan.kind === "DOCUMENT" && plan.mimeType === "application/pdf") return { ok: true, type: "FILE", mimeType: plan.mimeType, fileName: plan.fileName };
  return { ok: false, error: refusal };
}

/** A brand image (logo, launcher icon, team photo): JPEG, PNG or WebP from the bytes, at most 512 KB. Never SVG. */
export const WEBCHAT_BRAND_MAX_BYTES = 512 * 1024;
export function planBrandImage(head: Uint8Array, size: number): { ok: true; mimeType: "image/jpeg" | "image/png" | "image/webp"; extension: "jpg" | "png" | "webp" } | { ok: false; error: string } {
  if (size === 0) return { ok: false, error: "The file is empty." };
  if (size > WEBCHAT_BRAND_MAX_BYTES) return { ok: false, error: "Images for the widget can be at most 512 KB. Export a smaller one (a logo needs at most 256 × 256 px)." };
  const at = (i: number) => head[i] ?? -1;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { ok: true, mimeType: "image/jpeg", extension: "jpg" };
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return { ok: true, mimeType: "image/png", extension: "png" };
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return { ok: true, mimeType: "image/webp", extension: "webp" };
  return { ok: false, error: "Use a JPEG, PNG or WebP image. SVG and other formats are not accepted." };
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
    // A bare domain is read as its https address (V3); the settings page shows the result before saving.
    const origin = normalizeOriginInput(line);
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
