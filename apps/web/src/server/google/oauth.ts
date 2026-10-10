import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@support-automation/db";

/**
 * Google OAuth for the Google Sheets module (GOOGLE_SHEETS.md): configuration, the consent URL, and
 * the short-lived state that ties Google's answer back to the person and project that asked.
 *
 * Each project uses its OWN OAuth client, saved under Settings → Google Sheets (`clientConfig.ts`); the
 * server's environment client (`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`) is only the
 * fallback for a project that has not saved one. A secret never leaves the server.
 * The callback is ONE fixed address (`/api/google/oauth/callback`) rather than one per project, so
 * the Google Cloud console needs a single redirect URI however many projects there are — the
 * project travels in the encrypted state instead.
 */

/**
 * What the module asks Google for, and why each is needed.
 *
 * - `openid email profile` — who the account is (its stable id, email, name).
 * - `drive.metadata.readonly` — list the spreadsheets the account can see, with names and modified
 *   times, WITHOUT reading their contents (Drive API `files.list`).
 * - `spreadsheets` — read and write cell values, add rows and columns (Sheets API).
 * - `drive.activity.readonly` — who changed a MONITORED sheet in Google directly (Drive Activity,
 *   Phase 8). Optional: an account that unticks it still connects, and the page says that changes
 *   made outside the app cannot be read through it.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.activity.readonly",
] as const;

/** Reading changes made in Google directly (Phase 8). Granted or not, per account. */
export const DRIVE_ACTIVITY_SCOPE = "https://www.googleapis.com/auth/drive.activity.readonly";

/**
 * A person linking their OWN Google identity (Phase 4): who they are, nothing more. No offline
 * access, no Drive, no Sheets — the token is used once to read the account id and then revoked.
 */
export const IDENTITY_SCOPES = ["openid", "email"] as const;

/** Without these the connection is refused: the module could not list or open a single sheet. */
export const REQUIRED_SCOPES = ["https://www.googleapis.com/auth/drive.metadata.readonly", "https://www.googleapis.com/auth/spreadsheets"] as const;

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const CALLBACK_PATH = "/api/google/oauth/callback";
export const STATE_COOKIE = "softify-google-oauth";
/** A consent screen left open longer than this is started again. */
export const STATE_TTL_MS = 10 * 60_000;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** The public address this installation is reached at — the same value sign-in depends on. */
export function publicOrigin(): string | null {
  const raw = process.env.NEXTAUTH_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * The server's ENVIRONMENT client only — the fallback. Every caller that acts for a project uses
 * `resolveProjectGoogleClient()` instead, which applies the project's own client and its on/off switch.
 */
export function googleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const origin = publicOrigin();
  if (!clientId || !clientSecret || !origin) return null;
  return { clientId, clientSecret, redirectUri: `${origin}${CALLBACK_PATH}` };
}

/** The redirect URI to register in Google Cloud, shown on the settings page even before setup. */
export function expectedRedirectUri(): string | null {
  const origin = publicOrigin();
  return origin ? `${origin}${CALLBACK_PATH}` : null;
}

/**
 * Why the person went to Google: to connect an account for the project (CONNECT), or to prove which
 * Google account is their own (IDENTITY). Sealed into the state, so the callback cannot be talked
 * into treating one as the other.
 */
export type OAuthPurpose = "CONNECT" | "IDENTITY";

/** What the state cookie carries between "Connect" and Google's answer. */
export interface OAuthState {
  purpose: OAuthPurpose;
  /** The client the consent screen was opened with. If the project's client changed meanwhile, the
   * code cannot be redeemed with the new one, so the callback refuses it. */
  clientId?: string;
  /** Random value echoed by Google; must match exactly. */
  state: string;
  /** PKCE verifier: proves the code is redeemed by the server that asked for it. */
  verifier: string;
  projectSlug: string;
  userId: string;
  expiresAt: number;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newOAuthState(projectSlug: string, userId: string, now = Date.now(), purpose: OAuthPurpose = "CONNECT", clientId?: string): OAuthState {
  return {
    purpose,
    ...(clientId ? { clientId } : {}),
    state: base64Url(randomBytes(32)),
    verifier: base64Url(randomBytes(48)),
    projectSlug,
    userId,
    expiresAt: now + STATE_TTL_MS,
  };
}

export function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

/**
 * The cookie value: the state ENCRYPTED with the installation's credential key, so it can be
 * neither read (the PKCE verifier is a secret) nor forged (the project and the user are in it).
 */
export function sealOAuthState(state: OAuthState): string {
  return encryptSecret(JSON.stringify(state));
}

/** The state back, or null when the cookie is missing, tampered with, malformed or expired. */
export function openOAuthState(sealed: string | undefined | null, now = Date.now()): OAuthState | null {
  if (!sealed) return null;
  try {
    const parsed = JSON.parse(decryptSecret(sealed)) as Partial<OAuthState>;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.verifier !== "string" ||
      typeof parsed.projectSlug !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    if (parsed.expiresAt < now) return null;
    // A state sealed before purposes existed was a connection.
    const purpose: OAuthPurpose = parsed.purpose === "IDENTITY" ? "IDENTITY" : "CONNECT";
    return { ...(parsed as OAuthState), purpose };
  } catch {
    return null;
  }
}

/**
 * Google's consent screen. `access_type=offline` + `prompt=consent` so Google always returns a
 * refresh token (without `prompt=consent` it only does so the first time an account consents, and
 * a reconnect would come back with nothing to keep). `include_granted_scopes` lets a later phase add
 * a scope without dropping the ones already granted.
 */
export function authorizationUrl(config: GoogleOAuthConfig, state: OAuthState): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  if (state.purpose === "IDENTITY") {
    // Who the person is, once: no refresh token is asked for, and the access token is revoked as
    // soon as the account id is read. Always the account chooser, so nobody links the wrong one.
    url.searchParams.set("scope", IDENTITY_SCOPES.join(" "));
    url.searchParams.set("prompt", "select_account");
  } else {
    url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent select_account");
    url.searchParams.set("include_granted_scopes", "true");
  }
  url.searchParams.set("state", state.state);
  url.searchParams.set("code_challenge", pkceChallenge(state.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** The cookie's attributes: unreadable by scripts, sent on Google's top-level redirect back. */
export function stateCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    path: CALLBACK_PATH,
    maxAge: maxAgeSeconds,
  };
}
