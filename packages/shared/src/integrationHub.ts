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

/** IPv4 ranges that are not ordinary public unicast (RFC 6890 special-purpose, private, shared, multicast). */
function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Eight 16-bit groups of an IPv6 literal (a trailing dotted IPv4 allowed), or null when it is not one. */
function ipv6Groups(raw: string): number[] | null {
  let h = raw;
  const v4tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4tail) {
    const o = v4tail.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    h = `${v4tail[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const part = (s: string) => (s === "" ? [] : s.split(":"));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/**
 * IPv4/IPv6 literals that are not reachable on the public internet — private, loopback, link-local,
 * shared, documentation, benchmark, multicast, and IPv6 forms that carry such an IPv4 address (mapped,
 * compatible, NAT64, 6to4) — so an address cannot slip through by changing its notation. An IPv6 literal
 * that cannot be read, or that names an interface (`%zone`), counts as private. A name is never private here.
 */
export function isPrivateAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    return privateV4(a, b, c);
  }
  if (!host.includes(":")) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h.includes("%")) return true;
  const g = ipv6Groups(h);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => privateV4(hi >> 8, hi & 0xff, lo >> 8);
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6]!, g[7]!); // mapped / compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] !== 0 || embedded(g[6]!, g[7]!); // NAT64 (local-use /48 is private)
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  const first = g[0]!;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
}
