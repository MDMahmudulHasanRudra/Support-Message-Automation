/**
 * Which Google OAuth client a project uses (GOOGLE_SHEETS.md §22) — ONE rule, read by the dashboard and
 * the worker, so "may this project talk to Google right now, and as which client?" has one answer.
 *
 *   1. The project switched the integration OFF → nothing talks to Google for it. Its credentials,
 *      accounts and tokens are kept, so switching it back on resumes without reconnecting.
 *   2. The project saved its OWN client (Settings → Google Sheets) → that one, unless Google rejected it.
 *   3. Otherwise the server's environment client (`GOOGLE_OAUTH_CLIENT_ID` / `_SECRET`), kept only so an
 *      installation configured before project settings existed keeps working unchanged.
 *   4. Otherwise: not configured.
 *
 * Pure: the secret stays an encrypted envelope here, and each app decrypts it on the server.
 */

export const GOOGLE_CLIENT_STATUSES = ["UNVALIDATED", "VALID", "INVALID"] as const;
export type GoogleClientStatus = (typeof GOOGLE_CLIENT_STATUSES)[number];

export interface GoogleClientConfigRow {
  enabled: boolean;
  clientId: string | null;
  clientSecretCiphertext: string | null;
  validationStatus: GoogleClientStatus;
}

export interface EnvironmentGoogleClient {
  clientId?: string | null;
  clientSecret?: string | null;
}

export type GoogleClientDecision =
  | { ok: true; source: "PROJECT"; clientId: string; secretCiphertext: string }
  | { ok: true; source: "ENVIRONMENT"; clientId: string; secret: string }
  | { ok: false; reason: "DISABLED" | "NOT_CONFIGURED" | "INVALID"; message: string };

export const GOOGLE_CLIENT_REFUSALS = {
  DISABLED: "The Google integration is switched off for this project. Nothing is sent to Google until a Google Sheets manager switches it back on (Settings → Google Sheets).",
  NOT_CONFIGURED: "Google sign-in is not set up for this project yet. A Google Sheets manager adds the OAuth client under Settings → Google Sheets.",
  INVALID: "Google rejected this project's OAuth client ID or secret. A Google Sheets manager updates them under Settings → Google Sheets.",
} as const;

export function decideGoogleClient(row: GoogleClientConfigRow | null, env: EnvironmentGoogleClient = {}): GoogleClientDecision {
  if (row && !row.enabled) return { ok: false, reason: "DISABLED", message: GOOGLE_CLIENT_REFUSALS.DISABLED };
  if (row?.clientId && row.clientSecretCiphertext) {
    if (row.validationStatus === "INVALID") return { ok: false, reason: "INVALID", message: GOOGLE_CLIENT_REFUSALS.INVALID };
    return { ok: true, source: "PROJECT", clientId: row.clientId, secretCiphertext: row.clientSecretCiphertext };
  }
  const clientId = env.clientId?.trim();
  const secret = env.clientSecret?.trim();
  if (clientId && secret) return { ok: true, source: "ENVIRONMENT", clientId, secret };
  return { ok: false, reason: "NOT_CONFIGURED", message: GOOGLE_CLIENT_REFUSALS.NOT_CONFIGURED };
}

/**
 * Whether an account's tokens were issued to the client in use now. A refresh token only works with
 * the client that issued it, so a project that changed its client must connect its accounts again.
 * An account connected before the issuer was recorded was issued to the environment client; when
 * that is unknown too, the answer is "maybe" and Google's own refusal decides.
 */
export function tokensIssuedTo(account: { oauthClientId: string | null }, currentClientId: string, envClientId: string | null | undefined): boolean {
  const issuer = account.oauthClientId ?? envClientId?.trim() ?? null;
  return issuer === null || issuer === currentClientId;
}

export const CLIENT_CHANGED_MESSAGE =
  "This project's Google OAuth client changed after this account was connected, and Google only accepts its access through the client that issued it. Connect the account again.";

/** A Google OAuth client ID has this shape; anything else is a paste of the wrong value. */
export function isPlausibleGoogleClientId(value: string): boolean {
  return /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(value.trim()) && value.trim().length <= 200;
}

/** A plausible client secret: no whitespace, a sane length. Google's own format is not documented. */
export function isPlausibleGoogleClientSecret(value: string): boolean {
  const v = value.trim();
  return v.length >= 10 && v.length <= 200 && !/\s/.test(v);
}
