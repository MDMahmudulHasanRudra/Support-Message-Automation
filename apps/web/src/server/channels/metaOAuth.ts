import { createHash, randomBytes } from "node:crypto";
import {
  assetKey,
  classifyMetaAssets,
  META_REQUESTED_SCOPES,
  readGrantedScopes,
  metaProjectAllowed,
  readMetaPlatformConfig,
  type ClassifiedAsset,
  type DiscoveredPage,
  type MetaPlatformConfig,
  type MetaPlatformConfigReading,
} from "@support-automation/shared";
import { decryptSecret, encryptSecret } from "@support-automation/db";
import { Prisma, type ChannelConnectionStatus, type MetaOAuthPurpose } from "@prisma/client";
import { platformPrisma, prisma } from "@/server/db";
import { publicOrigin } from "@/server/google/oauth";
import { activeProjectId } from "@/server/projectContext";
import {
  exchangeLongLivedUserToken,
  exchangeMetaCode,
  listMetaAccounts,
  readLinkedInstagram,
  readMetaPage,
  readMetaPermissions,
  readMetaUser,
  subscribeMetaPage,
  type FetchImpl,
  type MetaAccountRow,
} from "@/server/channels/providerApi";

/**
 * "Connect with Facebook" (docs/meta-integration/05-oauth-and-webhook-security.md).
 *
 * A customer authorises their own Pages at Meta through the PLATFORM's app; they never create an app
 * or paste a token. The flow, and what guards each step:
 *
 *   1. start    (customer's address, signed in, channels.manage): a session row with random state,
 *               browser-binding and (later) claim values, each stored only as a SHA-256 hash. The
 *               binding value goes into an HTTP-only cookie on THIS browser. → Meta's dialog.
 *   2. callback (the ONE registered redirect URI, no session needed there): the state must name a
 *               STARTED, unexpired session, which is moved on with a conditional update so a replay
 *               finds nothing. The code is redeemed server-side, the token made long-lived and kept
 *               encrypted, and the browser is sent back to the address it started from, with a
 *               one-time claim code.
 *   3. claim    (customer's address again): the same signed-in person, the claim code AND the binding
 *               cookie. An attacker who gets a victim to authorise with the attacker's state cannot
 *               finish it: the victim's browser has the claim but not the attacker's binding cookie,
 *               and the attacker's browser has the cookie but never sees the claim.
 *   4. choose   the Pages and Instagram accounts the person chose at Meta, each classified
 *               (packages/shared `classifyMetaAssets`); only connectable ones can be ticked.
 *   5. connect  each chosen account is checked with its own Page token, the Page is subscribed to
 *               the app, and the connection saved. It reads CONNECTED only if the subscription
 *               succeeded. The user token is wiped when the session ends, however it ends.
 *
 * The user token and Page tokens are decrypted only here and in `connections.ts`; nothing returned to
 * a page carries one.
 */

export class MetaOAuthError extends Error {
  constructor(
    readonly code: MetaOAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MetaOAuthError";
  }
}

export type MetaOAuthErrorCode =
  | "not_configured"
  | "not_allowed"
  | "too_many"
  | "expired"
  | "denied"
  | "exchange_failed"
  | "session"
  | "binding"
  | "permission"
  | "not_found";

/** Every refusal code the callback or claim can put in a URL, with the sentence the page shows. */
export const META_ERROR_TEXT: Record<MetaOAuthErrorCode, string> = {
  not_configured: "Connecting with Facebook is not available on this server yet. Ask your platform administrator, or connect with your own app's credentials below.",
  not_allowed: "Connecting with Facebook is not available in this workspace yet. Ask your platform administrator, or connect with your own app's credentials below.",
  too_many: "Too many connection attempts in the last hour. Wait a little and try again.",
  expired: "That Facebook connection attempt expired or was already used. Start again.",
  denied: "Facebook was not authorised, so nothing was connected. Start again when you are ready.",
  exchange_failed: "Facebook did not complete the authorisation. Nothing was connected. Start again.",
  session: "Finish the connection in the same account that started it. Sign in as that person and start again.",
  binding: "Finish the connection in the same browser that started it. Start again from this browser.",
  permission: "You need the permission to manage messaging channels in this project.",
  not_found: "That Facebook connection attempt was not found. Start again.",
};

/** A dialog left open longer than this is started again. */
export const META_STATE_TTL_MS = 10 * 60_000;
/** After Meta answers, the person has this long to choose their Pages. */
export const META_CHOICE_TTL_MS = 30 * 60_000;
/** At most this many attempts per person per hour. */
const MAX_STARTS_PER_HOUR = 20;

export const META_BINDING_COOKIE = "softify-meta-oauth";

export function metaBindingCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** The platform's Meta configuration, read from the environment each time (a restart is not needed to fix it). */
export function metaPlatformConfig(): MetaPlatformConfigReading {
  return readMetaPlatformConfig(process.env, publicOrigin());
}

function requireConfig(): MetaPlatformConfig {
  const reading = metaPlatformConfig();
  if (!reading.ok) throw new MetaOAuthError("not_configured", META_ERROR_TEXT.not_configured);
  return reading.config;
}

/** Whether one-click Meta may be used in this project (`META_ALLOWED_PROJECT_IDS`, fails closed). */
export function metaAllowedForProject(projectId: string | null | undefined): boolean {
  return metaProjectAllowed(process.env, projectId);
}

/** Inside a project: the configuration, and this project on the allowlist — or a refusal. */
async function requireProjectConfig(): Promise<MetaPlatformConfig> {
  const config = requireConfig();
  if (!metaAllowedForProject(await activeProjectId())) throw new MetaOAuthError("not_allowed", META_ERROR_TEXT.not_allowed);
  return config;
}

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/;

/**
 * The address a request came to, as the visitor saw it (x-forwarded-host / -proto first, the same
 * reading as the SaaS host rules), or null when it is not a plain host. Behind the reverse proxy
 * `request.nextUrl.origin` would be the app's internal address.
 */
export function visitorOrigin(headers: Headers, fallback: URL): string | null {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]!.trim().toLowerCase();
  const proto = (headers.get("x-forwarded-proto") ?? fallback.protocol.replace(":", "")).split(",")[0]!.trim().toLowerCase();
  if (!HOST_RE.test(host) || (proto !== "https" && proto !== "http")) return null;
  return `${proto}://${host}`;
}

const random = (bytes: number) => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Meta's login dialog. With a Facebook Login for Business configuration, its id replaces the scopes. */
export function metaDialogUrl(config: MetaPlatformConfig, state: string, opts: { rerequest: boolean }): string {
  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (config.loginConfigId) {
    url.searchParams.set("config_id", config.loginConfigId);
    url.searchParams.set("override_default_response_type", "true");
  } else {
    url.searchParams.set("scope", META_REQUESTED_SCOPES.join(","));
  }
  // A reconnect asks again for anything declined last time (Meta otherwise remembers the refusal).
  if (opts.rerequest) url.searchParams.set("auth_type", "rerequest");
  return url.toString();
}

// ─── 1. start ───────────────────────────────────────────────────────────────────────────────────

export interface StartedMetaOAuth {
  dialogUrl: string;
  /** The value for the HTTP-only binding cookie. */
  binding: string;
}

/**
 * Inside the project (scoped client). The caller has already checked the session, `channels.manage`
 * and the Omnichannel feature. `returnOrigin` is the address the request came to, already checked to
 * be one this installation serves for projects.
 */
export async function startMetaOAuth(input: {
  userId: string;
  purpose: MetaOAuthPurpose;
  channelType: "MESSENGER" | "INSTAGRAM" | null;
  connectionId: string | null;
  returnOrigin: string;
  returnPath: string;
  now?: Date;
}): Promise<StartedMetaOAuth> {
  const config = await requireProjectConfig();
  const now = input.now ?? new Date();
  const recent = await prisma.metaOAuthSession.count({ where: { userId: input.userId, createdAt: { gt: new Date(now.getTime() - 60 * 60_000) } } });
  if (recent >= MAX_STARTS_PER_HOUR) throw new MetaOAuthError("too_many", META_ERROR_TEXT.too_many);
  if (input.purpose === "RECONNECT") {
    const target = input.connectionId ? await prisma.channelConnection.findUnique({ where: { id: input.connectionId }, select: { type: true } }) : null;
    if (!target || target.type === "TELEGRAM") throw new MetaOAuthError("not_found", "That connection no longer exists.");
  }
  const state = random(32);
  const binding = random(32);
  await prisma.metaOAuthSession.create({
    data: {
      userId: input.userId,
      purpose: input.purpose,
      channelType: input.channelType,
      connectionId: input.purpose === "RECONNECT" ? input.connectionId : null,
      stateHash: sha256(state),
      browserBindingHash: sha256(binding),
      returnOrigin: input.returnOrigin,
      returnPath: input.returnPath,
      expiresAt: new Date(now.getTime() + META_STATE_TTL_MS),
    },
  });
  return { dialogUrl: metaDialogUrl(config, state, { rerequest: input.purpose === "RECONNECT" }), binding };
}

// ─── 2. callback ────────────────────────────────────────────────────────────────────────────────

/**
 * Meta's redirect. Outside any project and without a session: the state is the only authority, and it
 * is single-use. Always returns a redirect target; never throws for anything Meta or the browser sent.
 */
export async function completeMetaCallback(input: { params: URLSearchParams; fetchImpl?: FetchImpl; now?: Date }): Promise<{ redirect: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const fallback = (code: MetaOAuthErrorCode) => {
    const origin = publicOrigin() ?? "";
    return { redirect: `${origin}/open?next=${encodeURIComponent(`/settings/channels?meta_error=${code}`)}` };
  };
  const state = input.params.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) return fallback("expired");
  const row = await platformPrisma.metaOAuthSession.findUnique({ where: { stateHash: sha256(state) }, select: { id: true, projectId: true, status: true, expiresAt: true, returnOrigin: true, returnPath: true } });
  if (!row) return fallback("expired");
  const back = (query: string) => ({ redirect: `${row.returnOrigin}${row.returnPath}/settings/channels?${query}` });

  // Single use: only the request that moves it out of STARTED, before it expires, continues.
  const taken = await platformPrisma.metaOAuthSession.updateMany({
    where: { id: row.id, status: "STARTED", expiresAt: { gt: now } },
    data: { status: "AUTHORIZED", expiresAt: new Date(now.getTime() + META_CHOICE_TTL_MS) },
  });
  if (taken.count !== 1) return back("meta_error=expired");

  const fail = async (status: "CANCELLED" | "FAILED", code: MetaOAuthErrorCode, reason: string) => {
    await platformPrisma.metaOAuthSession.update({ where: { id: row.id }, data: { status, failureReason: reason, userTokenCiphertext: null, completedAt: now } });
    return back(`meta_error=${code}`);
  };

  if (input.params.get("error")) return fail("CANCELLED", "denied", "Declined at Facebook.");
  const code = input.params.get("code") ?? "";
  if (!code || code.length > 2048) return fail("FAILED", "exchange_failed", "Facebook returned no authorisation code.");

  let config: MetaPlatformConfig;
  try {
    config = requireConfig();
  } catch {
    return fail("FAILED", "not_configured", "Meta integration was switched off before the code could be redeemed.");
  }
  // The workspace may have been taken off the allowlist while its person was at Meta.
  if (!metaAllowedForProject(row.projectId)) return fail("FAILED", "not_allowed", "This workspace is not allowed to use one-click Meta (META_ALLOWED_PROJECT_IDS).");
  const short = await exchangeMetaCode({ appId: config.appId, appSecret: config.appSecret, redirectUri: config.redirectUri, code }, fetchImpl);
  if (!short.ok) return fail("FAILED", "exchange_failed", `The authorisation code could not be redeemed: ${short.error.message}`);
  // Meta sometimes hands back a long-lived token already; exchanging is still harmless, and keeps the
  // choice step working for the full 30 minutes whichever kind came back.
  const long = await exchangeLongLivedUserToken({ appId: config.appId, appSecret: config.appSecret, token: short.data.accessToken }, fetchImpl);
  const token = long.ok ? long.data : short.data;
  const me = await readMetaUser(token.accessToken, config.appSecret, fetchImpl);
  if (!me.ok) return fail("FAILED", "exchange_failed", `Facebook did not say who authorised: ${me.error.message}`);
  const perms = await readMetaPermissions(token.accessToken, config.appSecret, fetchImpl);
  const scopes = perms.ok ? readGrantedScopes(perms.data) : { granted: [], declined: [] };

  const claim = random(32);
  await platformPrisma.metaOAuthSession.update({
    where: { id: row.id },
    data: {
      metaUserId: me.data.id,
      metaUserName: me.data.name?.slice(0, 120) ?? null,
      userTokenCiphertext: encryptSecret(token.accessToken),
      userTokenExpiresAt: token.expiresIn ? new Date(now.getTime() + token.expiresIn * 1000) : null,
      grantedScopes: scopes.granted,
      declinedScopes: scopes.declined,
      claimHash: sha256(claim),
    },
  });
  return { redirect: `${row.returnOrigin}${row.returnPath}/api/meta/claim?c=${encodeURIComponent(claim)}` };
}

// ─── 3. claim ───────────────────────────────────────────────────────────────────────────────────

/** Inside the project. Returns the session id to open the choice screen with. */
export async function claimMetaSession(input: { claim: string; binding: string | null | undefined; userId: string; now?: Date }): Promise<string> {
  const now = input.now ?? new Date();
  await requireProjectConfig();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(input.claim)) throw new MetaOAuthError("expired", META_ERROR_TEXT.expired);
  // Scoped client: a claim of another project's session is simply not found here.
  const row = await prisma.metaOAuthSession.findUnique({
    where: { claimHash: sha256(input.claim) },
    select: { id: true, userId: true, status: true, claimedAt: true, expiresAt: true, browserBindingHash: true },
  });
  if (!row || row.status !== "AUTHORIZED" || row.expiresAt <= now) throw new MetaOAuthError("expired", META_ERROR_TEXT.expired);
  if (row.userId !== input.userId) throw new MetaOAuthError("session", META_ERROR_TEXT.session);
  if (!input.binding || sha256(input.binding) !== row.browserBindingHash) throw new MetaOAuthError("binding", META_ERROR_TEXT.binding);
  const done = await prisma.metaOAuthSession.updateMany({ where: { id: row.id, claimedAt: null, status: "AUTHORIZED" }, data: { claimedAt: now } });
  if (done.count !== 1) throw new MetaOAuthError("expired", META_ERROR_TEXT.expired);
  return row.id;
}

// ─── 4. choose ──────────────────────────────────────────────────────────────────────────────────

const SESSION_SELECT = {
  id: true,
  userId: true,
  status: true,
  purpose: true,
  channelType: true,
  connectionId: true,
  claimedAt: true,
  expiresAt: true,
  metaUserId: true,
  metaUserName: true,
  userTokenCiphertext: true,
  grantedScopes: true,
  declinedScopes: true,
} as const;

/** A claimed, live session of this person, with its user token. Throws a reason otherwise. */
async function openSession(sessionId: string, userId: string, now: Date) {
  const row = await prisma.metaOAuthSession.findUnique({ where: { id: sessionId }, select: SESSION_SELECT });
  if (!row) throw new MetaOAuthError("not_found", META_ERROR_TEXT.not_found);
  if (row.userId !== userId) throw new MetaOAuthError("session", META_ERROR_TEXT.session);
  if (row.status !== "AUTHORIZED" || !row.claimedAt || !row.userTokenCiphertext || !row.metaUserId) throw new MetaOAuthError("expired", META_ERROR_TEXT.expired);
  if (row.expiresAt <= now) {
    await prisma.metaOAuthSession.update({ where: { id: row.id }, data: { status: "EXPIRED", userTokenCiphertext: null, completedAt: now } });
    throw new MetaOAuthError("expired", META_ERROR_TEXT.expired);
  }
  let token: string;
  try {
    token = decryptSecret(row.userTokenCiphertext);
  } catch {
    throw new MetaOAuthError("expired", META_ERROR_TEXT.expired);
  }
  return { row, token };
}

function toDiscovered(rows: MetaAccountRow[]): DiscoveredPage[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? r.id,
    tasks: Array.isArray(r.tasks) ? r.tasks.filter((t): t is string => typeof t === "string") : [],
    instagram: r.instagram_business_account?.id ? { id: r.instagram_business_account.id, username: r.instagram_business_account.username ?? null, name: r.instagram_business_account.name ?? null } : null,
  }));
}

async function classify(pages: DiscoveredPage[], grantedScopes: string[]): Promise<ClassifiedAsset[]> {
  const ids = new Set<string>();
  for (const p of pages) {
    ids.add(p.id);
    if (p.instagram) ids.add(p.instagram.id);
  }
  const accountIds = [...ids];
  const here = await prisma.channelConnection.findMany({
    where: { type: { in: ["MESSENGER", "INSTAGRAM"] }, externalAccountId: { in: accountIds }, status: { not: "DISCONNECTED" } },
    select: { id: true, type: true, externalAccountId: true, authMode: true },
  });
  const projectId = await activeProjectId();
  // Another project's one-click connections, read only to say "connected elsewhere" — never which.
  const others = await platformPrisma.channelConnection.findMany({
    where: { authMode: "PLATFORM", status: { not: "DISCONNECTED" }, type: { in: ["MESSENGER", "INSTAGRAM"] }, externalAccountId: { in: accountIds }, projectId: { not: projectId } },
    select: { type: true, externalAccountId: true },
  });
  return classifyMetaAssets({
    pages,
    grantedScopes,
    here: new Map(here.map((c) => [assetKey(c.type as "MESSENGER" | "INSTAGRAM", c.externalAccountId!), c.authMode])),
    elsewhere: new Set(others.map((c) => assetKey(c.type as "MESSENGER" | "INSTAGRAM", c.externalAccountId!))),
  });
}

export interface MetaChoice {
  sessionId: string;
  purpose: MetaOAuthPurpose;
  channelType: "MESSENGER" | "INSTAGRAM" | null;
  reconnectConnectionId: string | null;
  metaUserName: string | null;
  grantedScopes: string[];
  declinedScopes: string[];
  expiresAt: Date;
  assets: ClassifiedAsset[];
  /** More than 500 Pages: only the first 500 are listed. */
  truncated: boolean;
}

export async function loadMetaChoice(input: { sessionId: string; userId: string; fetchImpl?: FetchImpl; now?: Date }): Promise<MetaChoice> {
  const now = input.now ?? new Date();
  const config = await requireProjectConfig();
  const { row, token } = await openSession(input.sessionId, input.userId, now);
  const listed = await listMetaAccounts(token, config.appSecret, { withTokens: false }, input.fetchImpl ?? fetch);
  if (!listed.ok) throw new MetaOAuthError("exchange_failed", `Facebook would not list your Pages: ${listed.error.message}`);
  return {
    sessionId: row.id,
    purpose: row.purpose,
    channelType: row.channelType === "MESSENGER" || row.channelType === "INSTAGRAM" ? row.channelType : null,
    reconnectConnectionId: row.connectionId,
    metaUserName: row.metaUserName,
    grantedScopes: row.grantedScopes,
    declinedScopes: row.declinedScopes,
    expiresAt: row.expiresAt,
    assets: await classify(toDiscovered(listed.data.accounts), row.grantedScopes),
    truncated: listed.data.truncated,
  };
}

// ─── 5. connect ─────────────────────────────────────────────────────────────────────────────────

export interface MetaConnectOutcome {
  key: string;
  name: string;
  outcome: "CONNECTED" | "SUBSCRIPTION_FAILED" | "REFUSED";
  message: string;
  connectionId: string | null;
}

const TAKEN_ELSEWHERE = "This account was connected in another workspace a moment ago. It has to be disconnected there first.";

export async function connectMetaAssets(input: { sessionId: string; userId: string; username: string; keys: string[]; fetchImpl?: FetchImpl; now?: Date }): Promise<MetaConnectOutcome[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const config = await requireProjectConfig();
  const wanted = [...new Set(input.keys)].slice(0, 100);
  if (wanted.length === 0) throw new MetaOAuthError("not_found", "Choose at least one Page or Instagram account to connect.");
  const { row, token } = await openSession(input.sessionId, input.userId, now);

  // Page tokens are fetched now, at the moment of connecting, and never shown or stored before this.
  const listed = await listMetaAccounts(token, config.appSecret, { withTokens: true }, fetchImpl);
  if (!listed.ok) throw new MetaOAuthError("exchange_failed", `Facebook would not list your Pages: ${listed.error.message}`);
  const assets = await classify(toDiscovered(listed.data.accounts), row.grantedScopes);
  const byKey = new Map(assets.map((a) => [a.key, a]));
  const pageToken = new Map(listed.data.accounts.map((a) => [a.id, a.access_token ?? null]));
  const tasksOf = new Map(listed.data.accounts.map((a) => [a.id, (a.tasks ?? []).filter((t): t is string => typeof t === "string")]));

  const outcomes: MetaConnectOutcome[] = [];
  for (const key of wanted) {
    const asset = byKey.get(key);
    if (!asset) {
      outcomes.push({ key, name: key, outcome: "REFUSED", message: "Facebook no longer lists this account for you.", connectionId: null });
      continue;
    }
    if (!asset.selectable || !asset.accountId) {
      outcomes.push({ key, name: asset.accountName, outcome: "REFUSED", message: asset.reason ?? "This account cannot be connected.", connectionId: null });
      continue;
    }
    const pt = pageToken.get(asset.pageId);
    if (!pt) {
      outcomes.push({ key, name: asset.accountName, outcome: "REFUSED", message: "Facebook did not give access to this Page's messages. Reconnect and allow it.", connectionId: null });
      continue;
    }
    outcomes.push(await connectOne({ asset, pageToken: pt, tasks: tasksOf.get(asset.pageId) ?? [], session: row, config, username: input.username, fetchImpl, now }));
  }

  await prisma.metaOAuthSession.update({ where: { id: row.id }, data: { status: "COMPLETED", userTokenCiphertext: null, completedAt: now } });
  return outcomes;
}

async function connectOne(input: {
  asset: ClassifiedAsset;
  pageToken: string;
  tasks: string[];
  session: { id: string; metaUserId: string | null; grantedScopes: string[] };
  config: MetaPlatformConfig;
  username: string;
  fetchImpl: FetchImpl;
  now: Date;
}): Promise<MetaConnectOutcome> {
  const { asset, config, fetchImpl, now } = input;
  const name = asset.type === "INSTAGRAM" && asset.username ? `@${asset.username}` : asset.accountName;
  const refuse = (message: string): MetaConnectOutcome => ({ key: asset.key, name, outcome: "REFUSED", message, connectionId: null });

  // The token must really be this Page's (Meta answers `category` only for a Page).
  const page = await readMetaPage(input.pageToken, config.appSecret, fetchImpl);
  if (!page.ok || page.data.id !== asset.pageId || !page.data.category) return refuse(page.ok ? "Facebook gave a token for a different account." : page.error.message);
  if (asset.type === "INSTAGRAM") {
    const ig = await readLinkedInstagram(asset.pageId, input.pageToken, config.appSecret, fetchImpl);
    if (!ig.ok || ig.data.instagram_business_account?.id !== asset.accountId) return refuse(ig.ok ? "The Instagram account is no longer linked to this Page." : ig.error.message);
  }

  const subscribed = await subscribeMetaPage(asset.pageId, input.pageToken, config.appSecret, fetchImpl);
  const lastError = subscribed.ok ? null : `Facebook did not subscribe the Page to this app, so no messages will arrive: ${subscribed.error.message}`;
  const status: ChannelConnectionStatus = subscribed.ok ? "CONNECTED" : "ERROR";
  const data = {
    name,
    status,
    enabled: true,
    authMode: "PLATFORM" as const,
    externalAccountName: asset.accountName,
    externalUsername: asset.username,
    pageId: asset.pageId,
    appId: config.appId,
    accessTokenCiphertext: encryptSecret(input.pageToken),
    // The platform's secret is never stored per connection, and the manual-mode webhook secrets no
    // longer apply. A fresh key retires a manual connection's old webhook URL.
    appSecretCiphertext: null,
    verifyTokenCiphertext: null,
    webhookKey: random(24),
    webhookVerifiedAt: null,
    metaOAuthSessionId: input.session.id,
    metaUserId: input.session.metaUserId,
    grantedScopes: input.session.grantedScopes,
    pageTasks: input.tasks,
    lastCheckedAt: now,
    lastError,
    lastErrorAt: lastError ? now : null,
    credentialsUpdatedAt: now,
    credentialsUpdatedByUsername: input.username,
    disconnectedAt: null,
  };
  try {
    const existing = await prisma.channelConnection.findFirst({ where: { type: asset.type, externalAccountId: asset.accountId! }, select: { id: true } });
    const id = existing
      ? (await prisma.channelConnection.update({ where: { id: existing.id }, data, select: { id: true } })).id
      : (await prisma.channelConnection.create({ data: { ...data, type: asset.type, externalAccountId: asset.accountId!, createdByUsername: input.username }, select: { id: true } })).id;
    return {
      key: asset.key,
      name,
      outcome: subscribed.ok ? "CONNECTED" : "SUBSCRIPTION_FAILED",
      message: subscribed.ok ? (existing ? "Connected (updated the existing connection — its conversations are kept)." : "Connected.") : (lastError ?? ""),
      connectionId: id,
    };
  } catch (err) {
    // The installation-wide partial unique index: another project took it between listing and saving.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return refuse(TAKEN_ELSEWHERE);
    throw err;
  }
}

/**
 * A finished attempt, opened again (a reload, the back button): what it connected, for the same
 * person only. Null when the attempt is not theirs or did not complete.
 */
export async function loadCompletedMetaSession(input: { sessionId: string; userId: string }): Promise<{ connections: Array<{ id: string; name: string; type: string; status: string }> } | null> {
  const row = await prisma.metaOAuthSession.findUnique({ where: { id: input.sessionId }, select: { userId: true, status: true } });
  if (!row || row.userId !== input.userId || row.status !== "COMPLETED") return null;
  const connections = await prisma.channelConnection.findMany({
    where: { metaOAuthSessionId: input.sessionId },
    select: { id: true, name: true, type: true, status: true },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });
  return { connections };
}

/** The person stopped at the choice screen: nothing is connected and the token is wiped. */
export async function cancelMetaSession(input: { sessionId: string; userId: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await prisma.metaOAuthSession.updateMany({
    where: { id: input.sessionId, userId: input.userId, status: { in: ["STARTED", "AUTHORIZED"] } },
    data: { status: "CANCELLED", failureReason: "Cancelled on the choice screen.", userTokenCiphertext: null, completedAt: now },
  });
}
