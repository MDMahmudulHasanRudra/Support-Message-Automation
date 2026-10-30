/**
 * Integration Hub (INTEGRATION_HUB.md): scoped API keys for the public API, and signed outbound webhooks.
 * Pure rules shared by the web app's API routes, settings page and delivery loop.
 */

/** What a key may do. Each maps to one feature that must be on for the call to work. */
export const API_SCOPES = ["products:read", "orders:read", "leads:write", "shipments:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  "products:read": "Read products and stock",
  "orders:read": "Read orders",
  "leads:write": "Create leads",
  "shipments:read": "Read shipments",
};
export const API_SCOPE_FEATURE: Record<ApiScope, string> = {
  "products:read": "PRODUCT_CATALOG",
  "orders:read": "ORDERS",
  "leads:write": "SALES_PIPELINE",
  "shipments:read": "COURIER",
};

export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === "string" && (API_SCOPES as readonly string[]).includes(v);
}

/** A key as handed out: "ga_" + 40 url-safe characters. Only its SHA-256 is stored. */
export const API_KEY_PREFIX = "ga_";
export function looksLikeApiKey(raw: string): boolean {
  return /^ga_[A-Za-z0-9_-]{32,64}$/.test(raw);
}

export const WEBHOOK_EVENTS = [
  "order.created",
  "order.status_changed",
  "order.payment_recorded",
  "shipment.status_changed",
  "lead.created",
  "lead.stage_changed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  "order.created": "An order is created or imported",
  "order.status_changed": "An order changes status",
  "order.payment_recorded": "A payment is recorded on an order",
  "shipment.status_changed": "A shipment changes status",
  "lead.created": "A lead is added",
  "lead.stage_changed": "A lead moves stage",
};

export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(v);
}

/** Wait before each retry; after the last, the delivery is DEAD. 1 min, 5 min, 30 min, 2 h, 6 h, 24 h. */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000] as const;

export function nextWebhookAttempt(attemptsMade: number, now: Date): Date | null {
  const delay = WEBHOOK_RETRY_DELAYS_MS[attemptsMade - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay);
}

/**
 * Whether a webhook address may be saved: https, a public host name (no localhost, no private or link-local
 * IP literal, no internal suffixes). The delivery loop checks the RESOLVED address again before sending.
 */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "That is not a web address.";
  }
  if (url.protocol !== "https:") return "Webhooks are sent over https:// only.";
  if (url.username || url.password) return "Put no user name or password in the address.";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return "Use a public address.";
  if (isPrivateAddress(host)) return "Use a public address.";
  return null;
}

/** IPv4/IPv6 literals that are not reachable on the public internet. A name is never private here. */
export function isPrivateAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(":")) {
    const h = host.toLowerCase();
    return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:127.") || h.startsWith("::ffff:10.") || h.startsWith("::ffff:192.168.");
  }
  return false;
}
