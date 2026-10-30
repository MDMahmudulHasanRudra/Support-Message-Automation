/**
 * Calls to couriers and shops (COMMERCE_INTEGRATIONS.md). One rule matters more than the rest: a call
 * that may have reached the provider and whose answer we never saw is UNKNOWN, never failed — a booking
 * retried after a timeout can book the same parcel twice. Only an error that proves the request never
 * left (the name did not resolve, the connection was refused) is a plain failure.
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The request may have been received; nothing is known about its outcome. */
export class ProviderUnknownOutcome extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnknownOutcome";
  }
}

const NEVER_SENT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ERR_INVALID_URL", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

export interface ProviderResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

/** JSON over https with a deadline. Never follows a redirect (a redirect could carry credentials elsewhere). */
export async function callProvider(url: string, init: RequestInit & { timeoutMs?: number; who: string }): Promise<ProviderResponse> {
  const { timeoutMs = 20_000, who, ...rest } = init;
  if (!url.startsWith("https://")) throw new ProviderError(`${who} must be reached over https://.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...rest, signal: controller.signal, redirect: "manual", cache: "no-store" });
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code && NEVER_SENT.has(code)) throw new ProviderError(`${who} could not be reached (${code}).`);
    if ((err as Error).name === "AbortError") throw new ProviderUnknownOutcome(`${who} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    throw new ProviderUnknownOutcome(`The connection to ${who} broke before it answered.`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 300 && response.status < 400) throw new ProviderError(`${who} answered with a redirect; check the address.`, response.status);
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 300) };
    }
  }
  return { status: response.status, body, headers: response.headers };
}

type Obj = Record<string, unknown>;
export const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** The most useful sentence a provider's error body offers, never more than 300 characters. */
export function providerMessage(body: unknown, fallback: string): string {
  const o = asObj(body);
  const candidates: unknown[] = [o.message, o.error, o.error_description, o.errors, asObj(o.data).message, o.raw];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 300);
    if (Array.isArray(c) && c.length) return c.map((x) => (typeof x === "string" ? x : asObj(x).message ?? JSON.stringify(x))).join("; ").slice(0, 300);
    if (c && typeof c === "object") {
      const first = Object.entries(c as Obj)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
        .join("; ");
      if (first) return first.slice(0, 300);
    }
  }
  return fallback;
}
