/**
 * The rules behind agent notifications (AGENT_APP.md), kept pure so they can be tested without a browser.
 */

/**
 * The server POSTs to whatever address a browser registers, so only the browsers' own push services are
 * accepted: anything else would let a signed-in person point the server at an address of their choosing.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  return PUSH_HOSTS.some((host) => host.test(url.hostname));
}

/** "Chrome on Android", for telling a person's devices apart. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const system = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "this device";
  return `${browser} on ${system}`;
}

export type PushKind = "ASSIGNED" | "MENTION" | "CUSTOMER" | "WAITING";

export interface PushAlert {
  kind: PushKind;
  projectId: string;
  /** One conversation, for the repeat limit and so a newer alert replaces an older one on the phone. */
  conversationKey: string;
  title: string;
  /** Shown only on a device that chose to show message text. */
  preview: string | null;
  url: string;
  /** Where a count of several conversations opens. */
  inboxUrl: string;
}

export interface PushPrefs {
  notifyAssigned: boolean;
  notifyCustomerMessages: boolean;
  notifyMentions: boolean;
  notifyWaiting: boolean;
  showPreview: boolean;
}

export function wantsAlert(kind: PushKind, prefs: PushPrefs): boolean {
  if (kind === "ASSIGNED") return prefs.notifyAssigned;
  if (kind === "MENTION") return prefs.notifyMentions;
  if (kind === "CUSTOMER") return prefs.notifyCustomerMessages;
  return prefs.notifyWaiting;
}

const PLAIN_BODY: Record<PushKind, string> = {
  ASSIGNED: "Assigned to you",
  MENTION: "You were mentioned in a note",
  CUSTOMER: "New message in your conversation",
  WAITING: "A customer is waiting",
};

/** Message text only on a device that asked for it: a phone's lock screen is visible to whoever is nearby. */
export function pushBody(alert: Pick<PushAlert, "kind" | "preview">, showPreview: boolean): string {
  const preview = showPreview ? alert.preview?.trim().replace(/\s+/g, " ") : "";
  return preview ? (preview.length > 120 ? `${preview.slice(0, 117)}…` : preview) : PLAIN_BODY[alert.kind];
}

/** Repeat limit per person per conversation, for customer messages; being assigned or mentioned always comes through. */
export const CONVERSATION_COOLDOWN_MS = 5 * 60_000;
/** At most one "waiting" alert a minute per person. A busy roster would otherwise buzz a phone without stopping. */
export const WAITING_GAP_MS = 60_000;

/** What a person's held "waiting" alerts become: the alert itself when there is one, a count when there are more. */
export function collapseWaiting(alerts: PushAlert[]): PushAlert | null {
  const last = alerts[alerts.length - 1];
  if (!last) return null;
  const conversations = new Set(alerts.map((a) => a.conversationKey)).size;
  if (conversations === 1) return last;
  return { ...last, conversationKey: "waiting", title: `${conversations} customers are waiting`, preview: null, url: last.inboxUrl };
}
