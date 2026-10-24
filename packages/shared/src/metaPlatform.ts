import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * "Connect with Facebook" — the platform's own Meta app (docs/meta-integration). Everything here is
 * pure: reading and checking the platform configuration, which permissions each channel needs, how
 * each Page or Instagram account found after authorisation is classified, and Meta's
 * `signed_request` (deauthorize and data-deletion callbacks). The web app and the worker both call
 * these, so the two can never disagree about whether an asset is connectable or which secret signs.
 *
 * The configuration is the PLATFORM's, read from the environment. A customer never sees, enters or
 * needs any of it: they authorise their own Pages at Meta through this one app.
 */

export const DEFAULT_META_GRAPH_VERSION = "v25.0";
export const META_OAUTH_CALLBACK_PATH = "/api/meta/oauth/callback";

export interface MetaPlatformConfig {
  appId: string;
  appSecret: string;
  graphVersion: string;
  redirectUri: string;
  webhookVerifyToken: string;
  /** A Facebook Login for Business configuration id. When absent, permissions are requested by `scope`. */
  loginConfigId: string | null;
}

export type MetaPlatformConfigReading =
  | { ok: true; config: MetaPlatformConfig }
  /** `problems` names environment variables and what is wrong with them — never a value. */
  | { ok: false; enabled: boolean; problems: string[] };

type Env = Record<string, string | undefined>;

const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

/**
 * The platform's Meta configuration, or every reason it cannot be used. Off unless
 * `META_INTEGRATION_ENABLED=true`, so an incomplete setup is never half-active.
 *
 * `publicOrigin` is the installation's own address (NEXTAUTH_URL); the redirect URI defaults to the
 * fixed callback on it.
 */
export function readMetaPlatformConfig(env: Env, publicOrigin: string | null): MetaPlatformConfigReading {
  const get = (k: string) => env[k]?.trim() || "";
  const enabled = get("META_INTEGRATION_ENABLED") === "true";
  const problems: string[] = [];
  if (!enabled) problems.push("META_INTEGRATION_ENABLED is not \"true\".");

  const appId = get("META_APP_ID");
  if (!appId) problems.push("META_APP_ID is not set.");
  else if (!/^\d{5,20}$/.test(appId)) problems.push("META_APP_ID must be the app's numeric id.");

  const appSecret = get("META_APP_SECRET");
  if (!appSecret) problems.push("META_APP_SECRET is not set.");
  else if (!/^[a-f0-9]{32}$/i.test(appSecret)) problems.push("META_APP_SECRET must be the 32-character app secret.");

  const graphVersion = get("META_GRAPH_API_VERSION") || DEFAULT_META_GRAPH_VERSION;
  if (!/^v\d{1,3}\.0$/.test(graphVersion)) problems.push("META_GRAPH_API_VERSION must look like v25.0.");

  const webhookVerifyToken = get("META_WEBHOOK_VERIFY_TOKEN");
  if (!webhookVerifyToken) problems.push("META_WEBHOOK_VERIFY_TOKEN is not set.");
  else if (!/^[A-Za-z0-9_-]{16,128}$/.test(webhookVerifyToken)) problems.push("META_WEBHOOK_VERIFY_TOKEN must be 16–128 letters, digits, - or _.");

  const loginConfigId = get("META_LOGIN_CONFIG_ID") || null;
  if (loginConfigId && !/^\d{5,25}$/.test(loginConfigId)) problems.push("META_LOGIN_CONFIG_ID must be the numeric Facebook Login for Business configuration id.");

  let redirectUri = get("META_OAUTH_REDIRECT_URI");
  if (!redirectUri && publicOrigin) redirectUri = `${publicOrigin}${META_OAUTH_CALLBACK_PATH}`;
  if (!redirectUri) {
    problems.push("META_OAUTH_REDIRECT_URI is not set and NEXTAUTH_URL is unknown.");
  } else {
    let url: URL | null = null;
    try {
      url = new URL(redirectUri);
    } catch {
      problems.push("META_OAUTH_REDIRECT_URI is not a valid address.");
    }
    if (url) {
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) problems.push("META_OAUTH_REDIRECT_URI must use https:// (Meta refuses anything else outside localhost).");
      if (url.pathname !== META_OAUTH_CALLBACK_PATH) problems.push(`META_OAUTH_REDIRECT_URI must end in ${META_OAUTH_CALLBACK_PATH}.`);
      if (url.search || url.hash) problems.push("META_OAUTH_REDIRECT_URI must not carry a query or fragment.");
    }
  }

  if (problems.length > 0) return { ok: false, enabled, problems };
  return { ok: true, config: { appId, appSecret, graphVersion, redirectUri, webhookVerifyToken, loginConfigId } };
}

/** The platform's app secret for the worker, which only needs it for `appsecret_proof`. */
export function metaPlatformAppSecret(env: Env): string | null {
  const secret = env.META_APP_SECRET?.trim() ?? "";
  return /^[a-f0-9]{32}$/i.test(secret) ? secret : null;
}

// ─── Permissions ────────────────────────────────────────────────────────────────────────────────

/**
 * What each channel needs from the person who authorises, and why.
 *  - `pages_show_list`        list the Pages they chose (/me/accounts);
 *  - `pages_manage_metadata`  subscribe the Page to the app, so its webhooks arrive;
 *  - `pages_messaging`        read and send Messenger messages as the Page;
 *  - `instagram_basic`        read the Instagram professional account linked to a Page;
 *  - `instagram_manage_messages` read and send its DMs (through the Page).
 * Nothing about posts, comments, ads, insights or leads is requested (see 02-meta-capability-matrix.md).
 */
export const META_REQUIRED_SCOPES = {
  MESSENGER: ["pages_show_list", "pages_manage_metadata", "pages_messaging"],
  INSTAGRAM: ["pages_show_list", "pages_manage_metadata", "instagram_basic", "instagram_manage_messages"],
} as const satisfies Record<"MESSENGER" | "INSTAGRAM", readonly string[]>;

/** Every permission the dialog asks for (when no Login-for-Business configuration is used). */
export const META_REQUESTED_SCOPES: readonly string[] = [...new Set([...META_REQUIRED_SCOPES.MESSENGER, ...META_REQUIRED_SCOPES.INSTAGRAM])];

export function missingScopes(type: "MESSENGER" | "INSTAGRAM", granted: readonly string[]): string[] {
  const have = new Set(granted);
  return META_REQUIRED_SCOPES[type].filter((s) => !have.has(s));
}

/** `/me/permissions` → what was granted and what was declined. Anything unrecognised is ignored. */
export function readGrantedScopes(body: unknown): { granted: string[]; declined: string[] } {
  const rows = isObj(body) && Array.isArray(body.data) ? body.data : [];
  const granted: string[] = [];
  const declined: string[] = [];
  for (const row of rows) {
    if (!isObj(row) || typeof row.permission !== "string") continue;
    if (row.status === "granted") granted.push(row.permission);
    else if (row.status === "declined" || row.status === "expired") declined.push(row.permission);
  }
  return { granted, declined };
}

// ─── Discovered assets ─────────────────────────────────────────────────────────────────────────

/** A Page as /me/accounts reports it (the token is kept server-side and never part of this). */
export interface DiscoveredPage {
  id: string;
  name: string;
  /** What the authorising person may do on the Page: MESSAGING, MODERATE, MANAGE, CREATE_CONTENT… */
  tasks: string[];
  instagram: { id: string; username: string | null; name: string | null } | null;
}

export type AssetAvailability =
  /** Can be connected now. */
  | "AVAILABLE"
  /** Already connected in this project with one-click. Reconnecting refreshes its token. */
  | "CONNECTED_HERE"
  /** Connected in this project with the project's own app and token; can be switched to one-click. */
  | "MANUAL_HERE"
  /** A one-click connection of ANOTHER workspace holds it. Which one is never said. */
  | "CONNECTED_ELSEWHERE"
  /** A permission the channel needs was not granted. */
  | "MISSING_PERMISSION"
  /** The person's role on the Page does not allow messaging or subscribing it. */
  | "MISSING_PAGE_ROLE"
  /** Instagram: the Page has no Instagram professional account linked. */
  | "NO_INSTAGRAM";

export interface ClassifiedAsset {
  key: string;
  type: "MESSENGER" | "INSTAGRAM";
  pageId: string;
  pageName: string;
  /** The Page id (Messenger) or the Instagram account id. */
  accountId: string | null;
  accountName: string;
  username: string | null;
  availability: AssetAvailability;
  /** Why it cannot be connected, in words; null when it can. */
  reason: string | null;
  selectable: boolean;
}

/** The tasks that let a person's token message as the Page and subscribe it to the app. */
const MESSAGING_TASKS = ["MESSAGING", "MODERATE", "MANAGE"];
const SUBSCRIBE_TASKS = ["MODERATE", "MANAGE"];

export function hasPageRoleFor(tasks: readonly string[]): boolean {
  const t = new Set(tasks.map((x) => x.toUpperCase()));
  return MESSAGING_TASKS.some((x) => t.has(x)) && SUBSCRIBE_TASKS.some((x) => t.has(x));
}

export const assetKey = (type: "MESSENGER" | "INSTAGRAM", accountId: string) => `${type}:${accountId}`;

/**
 * Every Page offered twice — as Messenger and as Instagram — with whether it can be connected.
 * `connected` describes this project's and other projects' connections for the same accounts.
 */
export function classifyMetaAssets(input: {
  pages: readonly DiscoveredPage[];
  grantedScopes: readonly string[];
  /** This project's live connections, by `assetKey`. */
  here: ReadonlyMap<string, "MANUAL" | "PLATFORM">;
  /** `assetKey`s held by a live one-click connection of ANOTHER project. */
  elsewhere: ReadonlySet<string>;
}): ClassifiedAsset[] {
  const out: ClassifiedAsset[] = [];
  for (const page of input.pages) {
    for (const type of ["MESSENGER", "INSTAGRAM"] as const) {
      const ig = type === "INSTAGRAM" ? page.instagram : null;
      const accountId = type === "MESSENGER" ? page.id : (ig?.id ?? null);
      const base = {
        type,
        pageId: page.id,
        pageName: page.name,
        accountId,
        accountName: type === "MESSENGER" ? page.name : (ig?.name ?? ig?.username ?? page.name),
        username: ig?.username ?? null,
      };
      const key = accountId ? assetKey(type, accountId) : `${type}:page:${page.id}`;
      const decide = (availability: AssetAvailability, reason: string | null): ClassifiedAsset => ({
        ...base,
        key,
        availability,
        reason,
        selectable: availability === "AVAILABLE" || availability === "CONNECTED_HERE" || availability === "MANUAL_HERE",
      });
      if (type === "INSTAGRAM" && !accountId) {
        out.push(decide("NO_INSTAGRAM", "No Instagram professional account is linked to this Page. Link one in Meta Business Suite, then reconnect."));
        continue;
      }
      const missing = missingScopes(type, input.grantedScopes);
      if (missing.length > 0) {
        out.push(decide("MISSING_PERMISSION", `Facebook did not grant: ${missing.join(", ")}. Reconnect and allow every permission asked for.`));
        continue;
      }
      if (!hasPageRoleFor(page.tasks)) {
        out.push(decide("MISSING_PAGE_ROLE", "Your role on this Page cannot manage its messages. A Page admin (full control, or messages and community activity) has to connect it."));
        continue;
      }
      const mode = input.here.get(key);
      if (mode === "PLATFORM") {
        out.push(decide("CONNECTED_HERE", null));
        continue;
      }
      if (mode === "MANUAL") {
        out.push(decide("MANUAL_HERE", null));
        continue;
      }
      if (input.elsewhere.has(key)) {
        out.push(decide("CONNECTED_ELSEWHERE", "This account is already connected in another workspace. It has to be disconnected there first."));
        continue;
      }
      out.push(decide("AVAILABLE", null));
    }
  }
  return out;
}

// ─── signed_request (deauthorize and data-deletion callbacks) ──────────────────────────────────

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Meta's `signed_request`: `<base64url HMAC-SHA256 of the payload part>.<base64url JSON>`, signed with
 * the app secret. Returns the Facebook user id it names, or null when anything does not check out.
 */
export function readMetaSignedRequest(signedRequest: string | null | undefined, appSecret: string): { userId: string; issuedAt: number | null } | null {
  if (!signedRequest || signedRequest.length > 8192 || !appSecret) return null;
  const dot = signedRequest.indexOf(".");
  if (dot <= 0) return null;
  const sigPart = signedRequest.slice(0, dot);
  const payloadPart = signedRequest.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(sigPart) || !/^[A-Za-z0-9_-]+$/.test(payloadPart)) return null;
  const expected = createHmac("sha256", appSecret).update(payloadPart).digest();
  const given = base64UrlDecode(sigPart);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));
  } catch {
    return null;
  }
  if (!isObj(payload) || String(payload.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") return null;
  const userId = typeof payload.user_id === "string" ? payload.user_id : typeof payload.user_id === "number" ? String(payload.user_id) : null;
  if (!userId || !/^\d{1,30}$/.test(userId)) return null;
  return { userId, issuedAt: typeof payload.issued_at === "number" ? payload.issued_at : null };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
