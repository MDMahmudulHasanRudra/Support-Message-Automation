import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@support-automation/db";
import { META_SOCIAL_SCOPES, metaProjectAllowed, readGrantedScopes, SOCIAL_META_CALLBACK_PATH, type MetaPageRow } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { publicOrigin } from "@/server/google/oauth";
import { exchangeLongLivedUserToken, exchangeMetaCode, listMetaAccounts, readMetaPermissions, readMetaUser } from "@/server/channels/providerApi";
import { metaPlatformConfig } from "@/server/channels/metaOAuth";
import { saveMetaDiscovery, SocialAccountError } from "./accounts";

/**
 * Connecting Facebook Pages and Instagram accounts for PUBLISHING (SOCIAL_STUDIO.md §Meta). It uses the
 * platform's existing Meta app (META_APP_ID / META_APP_SECRET, META_INTEGRATION_ENABLED, the
 * META_ALLOWED_PROJECT_IDS gate) and its token helpers, but it is a separate flow with its own callback
 * (`/api/social/meta/callback`, which must be added to the app's Valid OAuth Redirect URIs), its own
 * permissions (publishing, never messaging), and its own tables. The messaging "Connect with Facebook"
 * flow, its callback, webhooks and ChannelConnection rows are not touched.
 *
 * The state, the project, the person and the time travel in an encrypted, HTTP-only cookie scoped to the
 * callback path (the same design as the Google connection); the callback checks the state, the signed-in
 * person, their project access and `social.manage` again before redeeming the code server-side.
 */

export const SOCIAL_META_STATE_COOKIE = "softify-social-meta";
export const SOCIAL_META_STATE_TTL_MS = 10 * 60_000;

export type SocialMetaReadiness = { ok: true; redirectUri: string } | { ok: false; problems: string[] };

/** Whether this project can connect Meta for publishing, and if not, every reason (names, never values). */
export function socialMetaReadiness(projectId: string | null): SocialMetaReadiness {
  const reading = metaPlatformConfig();
  const problems: string[] = reading.ok ? [] : [...reading.problems];
  if (!metaProjectAllowed(process.env, projectId)) problems.push("This workspace is not in META_ALLOWED_PROJECT_IDS.");
  const origin = publicOrigin();
  if (!origin) problems.push("NEXTAUTH_URL is not set, so no callback address can be built.");
  else if (!origin.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) problems.push("NEXTAUTH_URL must be https for Meta.");
  if (problems.length) return { ok: false, problems };
  return { ok: true, redirectUri: `${origin}${SOCIAL_META_CALLBACK_PATH}` };
}

export interface SocialMetaState {
  state: string;
  projectSlug: string;
  userId: string;
  expiresAt: number;
}

export function sealSocialMetaState(state: SocialMetaState): string {
  return encryptSecret(JSON.stringify(state));
}

export function openSocialMetaState(sealed: string | null | undefined, now = Date.now()): SocialMetaState | null {
  if (!sealed) return null;
  try {
    const s = JSON.parse(decryptSecret(sealed)) as Partial<SocialMetaState>;
    if (typeof s.state !== "string" || typeof s.projectSlug !== "string" || typeof s.userId !== "string" || typeof s.expiresAt !== "number" || s.expiresAt < now) return null;
    return s as SocialMetaState;
  } catch {
    return null;
  }
}

export function newSocialMetaState(projectSlug: string, userId: string, now = Date.now()): SocialMetaState {
  return { state: randomBytes(32).toString("base64url"), projectSlug, userId, expiresAt: now + SOCIAL_META_STATE_TTL_MS };
}

/** Meta's dialog with the publishing permissions (or the Login-for-Business configuration made for them). */
export async function socialMetaDialogUrl(state: SocialMetaState): Promise<string> {
  const ready = socialMetaReadiness(await activeProjectId());
  const reading = metaPlatformConfig();
  if (!ready.ok || !reading.ok) throw new SocialAccountError("Meta publishing is not set up on this server.");
  const url = new URL(`https://www.facebook.com/${reading.config.graphVersion}/dialog/oauth`);
  url.searchParams.set("client_id", reading.config.appId);
  url.searchParams.set("redirect_uri", ready.redirectUri);
  url.searchParams.set("state", state.state);
  url.searchParams.set("response_type", "code");
  const configId = process.env.META_SOCIAL_LOGIN_CONFIG_ID?.trim();
  if (configId && /^\d{5,25}$/.test(configId)) {
    url.searchParams.set("config_id", configId);
    url.searchParams.set("override_default_response_type", "true");
  } else {
    url.searchParams.set("scope", META_SOCIAL_SCOPES.join(","));
  }
  url.searchParams.set("auth_type", "rerequest");
  return url.toString();
}

export function socialMetaCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    path: SOCIAL_META_CALLBACK_PATH,
    maxAge: maxAgeSeconds,
  };
}

/**
 * Inside the project (the callback re-entered it and checked `social.manage`): redeems the code, makes
 * the user token long-lived, reads who authorised and what was granted, and saves the connection and its
 * accounts. The user token is kept encrypted for refreshing the account list later.
 */
export async function completeSocialMetaConnection(input: { code: string; username: string; fetchImpl?: typeof fetch; now?: Date }): Promise<{ active: number; needsAttention: number }> {
  const now = input.now ?? new Date();
  const ready = socialMetaReadiness(await activeProjectId());
  const reading = metaPlatformConfig();
  if (!ready.ok || !reading.ok) throw new SocialAccountError("Meta publishing is not set up on this server.");
  const { appId, appSecret } = reading.config;
  const f = input.fetchImpl ?? fetch;
  const short = await exchangeMetaCode({ appId, appSecret, redirectUri: ready.redirectUri, code: input.code }, f);
  if (!short.ok) throw new SocialAccountError(`Meta did not accept the authorization: ${short.error.message}`);
  const long = await exchangeLongLivedUserToken({ appId, appSecret, token: short.data.accessToken }, f);
  const token = long.ok ? long.data.accessToken : short.data.accessToken;
  const expiresIn = long.ok ? long.data.expiresIn : short.data.expiresIn;
  const me = await readMetaUser(token, appSecret, f);
  if (!me.ok) throw new SocialAccountError(`Meta could not say who authorised: ${me.error.message}`);
  const perms = await readMetaPermissions(token, appSecret, f);
  const scopes = perms.ok ? readGrantedScopes(perms.data) : { granted: [], declined: [] };
  const accounts = await listMetaAccounts(token, appSecret, { withTokens: true }, f);
  if (!accounts.ok) throw new SocialAccountError(`Meta could not list the Pages: ${accounts.error.message}`);

  const data = {
    status: "CONNECTED",
    externalUserName: me.data.name ?? null,
    credentialCiphertext: encryptSecret(token),
    tokenExpiresAt: expiresIn ? new Date(now.getTime() + expiresIn * 1000) : null,
    grantedScopes: scopes.granted,
    declinedScopes: scopes.declined,
    connectedByUsername: input.username,
    lastCheckedAt: now,
    lastError: null,
    disconnectedAt: null,
  };
  const existing = await prisma.socialConnection.findFirst({ where: { provider: "META", externalUserId: me.data.id }, select: { id: true } });
  const connection = existing
    ? await prisma.socialConnection.update({ where: { id: existing.id }, data, select: { id: true } })
    : await prisma.socialConnection.create({ data: { provider: "META", externalUserId: me.data.id, ...data }, select: { id: true } });
  return saveMetaDiscovery({ connectionId: connection.id, rows: accounts.data.accounts as MetaPageRow[], granted: scopes.granted, now });
}
