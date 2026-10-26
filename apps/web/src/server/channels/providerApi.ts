import { createHmac } from "node:crypto";
import { readMetaError, readTelegramError, type ProviderErrorReading } from "@support-automation/shared";

/**
 * The few provider calls the DASHBOARD makes: checking credentials, subscribing a Page to the app,
 * registering a Telegram webhook, and the health check (OMNICHANNEL.md §6). Sending is the worker's
 * job (apps/worker/src/channels/send.ts). Plain `fetch`, no SDK — the same choice as the Google and
 * Forge clients — and `fetchImpl` is injectable so tests never reach the network.
 *
 * Server-only: tokens pass through here and nowhere else in the web app. Errors are returned as
 * `ProviderErrorReading`s whose text never contains a token (packages/shared redacts them).
 */

export type FetchImpl = typeof fetch;

const TIMEOUT_MS = 15_000;

/** The Graph API version. Meta keeps each version for about two years; overridable without a release. */
export function graphBase(): string {
  const version = process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
  return `https://graph.facebook.com/${version}`;
}

export type ProviderResult<T> = { ok: true; data: T } | { ok: false; error: ProviderErrorReading; status: number };

const networkError = (provider: "Meta" | "Telegram"): ProviderErrorReading => ({
  retryable: true,
  needsReauth: false,
  message: `${provider} could not be reached from this server (network error or timeout). Try again in a minute.`,
});

/** `appsecret_proof` — Meta's proof that a call comes from the app's own server. Sent on every call. */
function appSecretProof(token: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(token).digest("hex");
}

async function graph<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string>,
  auth: { token: string; appSecret: string } | { appAccessToken: string },
  fetchImpl: FetchImpl,
): Promise<ProviderResult<T>> {
  const url = new URL(`${graphBase()}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if ("token" in auth) {
    headers.Authorization = `Bearer ${auth.token}`;
    url.searchParams.set("appsecret_proof", appSecretProof(auth.token, auth.appSecret));
  } else {
    url.searchParams.set("access_token", auth.appAccessToken);
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, error: networkError("Meta"), status: 0 };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) return { ok: false, error: readMetaError(response.status, body), status: response.status };
  return { ok: true, data: body as T };
}

/** Whether Meta accepts this App ID + App Secret pair (an app access token is exactly `id|secret`). */
export function checkMetaApp(appId: string, appSecret: string, fetchImpl: FetchImpl = fetch) {
  return graph<{ id: string; name?: string }>("GET", `/${encodeURIComponent(appId)}`, { fields: "id,name" }, { appAccessToken: `${appId}|${appSecret}` }, fetchImpl);
}

/**
 * The Page a Page access token belongs to. `category` exists only on a Page, so asking for it is how a
 * user token pasted by mistake is told apart: Meta refuses the field on a user.
 */
export function readMetaPage(token: string, appSecret: string, fetchImpl: FetchImpl = fetch) {
  return graph<{ id: string; name: string; category?: string }>("GET", "/me", { fields: "id,name,category" }, { token, appSecret }, fetchImpl);
}

/** The Instagram professional account linked to a Page, if any. */
export function readLinkedInstagram(pageId: string, token: string, appSecret: string, fetchImpl: FetchImpl = fetch) {
  return graph<{ id: string; instagram_business_account?: { id: string; username?: string; name?: string } }>(
    "GET",
    `/${encodeURIComponent(pageId)}`,
    { fields: "instagram_business_account{id,username,name}" },
    { token, appSecret },
    fetchImpl,
  );
}

/** The webhook fields a Page is subscribed to for messaging. */
export const META_PAGE_FIELDS = ["messages", "message_echoes", "message_deliveries", "message_reads"] as const;

/** Subscribe the Page to this app, so Meta sends its messaging events to the app's webhook. */
export function subscribeMetaPage(pageId: string, token: string, appSecret: string, fetchImpl: FetchImpl = fetch) {
  return graph<{ success?: boolean }>("POST", `/${encodeURIComponent(pageId)}/subscribed_apps`, { subscribed_fields: META_PAGE_FIELDS.join(",") }, { token, appSecret }, fetchImpl);
}

export function unsubscribeMetaPage(pageId: string, token: string, appSecret: string, fetchImpl: FetchImpl = fetch) {
  return graph<{ success?: boolean }>("DELETE", `/${encodeURIComponent(pageId)}/subscribed_apps`, {}, { token, appSecret }, fetchImpl);
}

/** Which apps the Page is subscribed to — the health check looks for this app among them. */
export function readMetaPageSubscriptions(pageId: string, token: string, appSecret: string, fetchImpl: FetchImpl = fetch) {
  return graph<{ data?: Array<{ id?: string; name?: string; subscribed_fields?: string[] }> }>(
    "GET",
    `/${encodeURIComponent(pageId)}/subscribed_apps`,
    {},
    { token, appSecret },
    fetchImpl,
  );
}

// ─── "Connect with Facebook" (the platform's app; docs/meta-integration/05) ──────────────────────

export interface MetaUserToken {
  accessToken: string;
  /** Seconds, when Meta says. A long-lived user token is about 60 days; Page tokens taken from one do not expire. */
  expiresIn: number | null;
}

/**
 * The OAuth token endpoint. The app secret goes in the query of a server-to-server call, which is how
 * Meta defines it; it never reaches a browser, and the URL is never logged.
 */
async function oauthToken(params: Record<string, string>, fetchImpl: FetchImpl): Promise<ProviderResult<MetaUserToken>> {
  const url = new URL(`${graphBase()}/oauth/access_token`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, error: networkError("Meta"), status: 0 };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) return { ok: false, error: readMetaError(response.status, body), status: response.status };
  const token = typeof body === "object" && body !== null ? (body as { access_token?: unknown; expires_in?: unknown }) : {};
  if (typeof token.access_token !== "string" || token.access_token.length < 20) {
    return { ok: false, error: { retryable: false, needsReauth: false, message: "Meta answered without an access token. Try connecting again." }, status: response.status };
  }
  return { ok: true, data: { accessToken: token.access_token, expiresIn: typeof token.expires_in === "number" ? token.expires_in : null } };
}

/** Redeem the code Meta put on the callback. `redirectUri` must be exactly the one the dialog used. */
export function exchangeMetaCode(input: { appId: string; appSecret: string; redirectUri: string; code: string }, fetchImpl: FetchImpl = fetch) {
  return oauthToken({ client_id: input.appId, client_secret: input.appSecret, redirect_uri: input.redirectUri, code: input.code }, fetchImpl);
}

/** A short-lived user token → a long-lived one (about 60 days). */
export function exchangeLongLivedUserToken(input: { appId: string; appSecret: string; token: string }, fetchImpl: FetchImpl = fetch) {
  return oauthToken({ grant_type: "fb_exchange_token", client_id: input.appId, client_secret: input.appSecret, fb_exchange_token: input.token }, fetchImpl);
}

/** Who authorised: their app-scoped id and name. */
export function readMetaUser(token: string, appSecret: string, fetchImpl: FetchImpl = fetch) {
  return graph<{ id: string; name?: string }>("GET", "/me", { fields: "id,name" }, { token, appSecret }, fetchImpl);
}

/** What they granted and declined (packages/shared `readGrantedScopes` reads the body). */
export function readMetaPermissions(token: string, appSecret: string, fetchImpl: FetchImpl = fetch) {
  return graph<unknown>("GET", "/me/permissions", {}, { token, appSecret }, fetchImpl);
}

export interface MetaAccountRow {
  id: string;
  name?: string;
  tasks?: string[];
  /** Only when asked for (connecting), never for listing. */
  access_token?: string;
  instagram_business_account?: { id: string; username?: string; name?: string };
}

/** At most this many Pages are read (500); a person with more is told so rather than given a partial list silently. */
const MAX_ACCOUNT_PAGES = 5;

/**
 * The Pages the person chose in Meta's dialog, with their role and the linked Instagram account.
 * Page tokens are requested only when `withTokens` (the moment of connecting), so listing them on the
 * choice screen never handles a token. Paging follows Meta's cursor, never Meta's `next` URL (which
 * carries the token in its query).
 */
export async function listMetaAccounts(token: string, appSecret: string, opts: { withTokens: boolean }, fetchImpl: FetchImpl = fetch): Promise<ProviderResult<{ accounts: MetaAccountRow[]; truncated: boolean }>> {
  const fields = ["id", "name", "tasks", "instagram_business_account{id,username,name}", ...(opts.withTokens ? ["access_token"] : [])].join(",");
  const accounts: MetaAccountRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_ACCOUNT_PAGES; page++) {
    const params: Record<string, string> = { fields, limit: "100" };
    if (after) params.after = after;
    const result = await graph<{ data?: MetaAccountRow[]; paging?: { cursors?: { after?: string }; next?: string } }>("GET", "/me/accounts", params, { token, appSecret }, fetchImpl);
    if (!result.ok) return result;
    for (const row of result.data.data ?? []) if (row && typeof row.id === "string") accounts.push(row);
    const next = result.data.paging?.next ? (result.data.paging.cursors?.after ?? null) : null;
    if (!next) return { ok: true, data: { accounts, truncated: false } };
    after = next;
  }
  return { ok: true, data: { accounts, truncated: true } };
}

// ─── Telegram ──────────────────────────────────────────────────────────────────────────────────

const TELEGRAM_API = "https://api.telegram.org";

async function telegram<T>(token: string, method: string, payload: Record<string, unknown> | null, fetchImpl: FetchImpl): Promise<ProviderResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: payload ? "POST" : "GET",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: networkError("Telegram"), status: 0 };
  }
  let body: { ok?: boolean; result?: T } | null = null;
  try {
    body = (await response.json()) as { ok?: boolean; result?: T };
  } catch {
    body = null;
  }
  if (!response.ok || !body?.ok) return { ok: false, error: readTelegramError(response.status, body), status: response.status };
  return { ok: true, data: body.result as T };
}

export function telegramGetMe(token: string, fetchImpl: FetchImpl = fetch) {
  return telegram<{ id: number; is_bot: boolean; first_name: string; username?: string }>(token, "getMe", null, fetchImpl);
}

/** The updates the inbox uses. Edits are delivered only so they can be recorded and ignored. */
export const TELEGRAM_ALLOWED_UPDATES = ["message", "edited_message"] as const;

export function telegramSetWebhook(token: string, url: string, secret: string, fetchImpl: FetchImpl = fetch) {
  return telegram<boolean>(token, "setWebhook", { url, secret_token: secret, allowed_updates: TELEGRAM_ALLOWED_UPDATES, drop_pending_updates: false }, fetchImpl);
}

export function telegramDeleteWebhook(token: string, fetchImpl: FetchImpl = fetch) {
  return telegram<boolean>(token, "deleteWebhook", { drop_pending_updates: false }, fetchImpl);
}

export function telegramGetWebhookInfo(token: string, fetchImpl: FetchImpl = fetch) {
  return telegram<{ url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string }>(token, "getWebhookInfo", null, fetchImpl);
}
