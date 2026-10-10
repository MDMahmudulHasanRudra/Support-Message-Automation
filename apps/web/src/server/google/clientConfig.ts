import {
  CLIENT_CHANGED_MESSAGE,
  decideGoogleClient,
  isPlausibleGoogleClientId,
  isPlausibleGoogleClientSecret,
  type GoogleClientStatus,
} from "@support-automation/shared";
import { decryptSecret, encryptSecret } from "@support-automation/db";
import { platformPrisma, prisma } from "@/server/db";
import { checkGoogleClient, revokeToken, type FetchImpl } from "@/server/google/api";
import { expectedRedirectUri, type GoogleOAuthConfig } from "@/server/google/oauth";

/**
 * A project's own Google OAuth client and its on/off switch (GOOGLE_SHEETS.md §22). Every Google call
 * the dashboard makes gets its client from `resolveProjectGoogleClient()`, inside the project the
 * request is for — the scoped client confines the row to that project, so one project can never use
 * another's client, accounts or tokens.
 *
 * The secret is written only as an `encryptSecret` envelope (the same rotatable key as AI provider
 * keys and Google tokens) and is read only here. `getGoogleIntegrationView()` is the only shape that
 * leaves for a page: it says whether a secret is set, never what it is.
 */

const env = () => ({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? null, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? null });

export type ProjectGoogleClient =
  | { ok: true; config: GoogleOAuthConfig; source: "PROJECT" | "ENVIRONMENT" }
  | { ok: false; reason: "DISABLED" | "NOT_CONFIGURED" | "INVALID"; message: string };

const ROW_SELECT = {
  enabled: true,
  clientId: true,
  clientSecretCiphertext: true,
  validationStatus: true,
  validatedAt: true,
  validationError: true,
  credentialsUpdatedAt: true,
  credentialsUpdatedByUsername: true,
  enabledChangedAt: true,
  enabledChangedByUsername: true,
} as const;

const readRow = () => prisma.googleIntegrationConfig.findUnique({ where: { id: "global" }, select: ROW_SELECT });

/** The client THIS project talks to Google with right now, or why it may not. */
export async function resolveProjectGoogleClient(): Promise<ProjectGoogleClient> {
  const redirectUri = expectedRedirectUri();
  if (!redirectUri) {
    return { ok: false, reason: "NOT_CONFIGURED", message: "The server's public address (NEXTAUTH_URL) is not set, so Google sign-in cannot be used." };
  }
  const decision = decideGoogleClient(await readRow(), env());
  if (!decision.ok) return decision;
  if (decision.source === "ENVIRONMENT") return { ok: true, source: "ENVIRONMENT", config: { clientId: decision.clientId, clientSecret: decision.secret, redirectUri } };
  try {
    return { ok: true, source: "PROJECT", config: { clientId: decision.clientId, clientSecret: decryptSecret(decision.secretCiphertext), redirectUri } };
  } catch {
    return { ok: false, reason: "INVALID", message: "This project's saved Google client secret could not be read (the server's encryption key changed). Enter it again under Settings → Google Sheets." };
  }
}

/** What the settings page may know. No secret, no ciphertext. */
export interface GoogleIntegrationView {
  enabled: boolean;
  /** Which client is in use, or why none is. */
  source: "PROJECT" | "ENVIRONMENT" | null;
  refusal: string | null;
  clientId: string | null;
  hasSecret: boolean;
  validationStatus: GoogleClientStatus | null;
  validatedAt: Date | null;
  validationError: string | null;
  credentialsUpdatedAt: Date | null;
  credentialsUpdatedByUsername: string | null;
  enabledChangedAt: Date | null;
  enabledChangedByUsername: string | null;
  environmentClientAvailable: boolean;
  redirectUri: string | null;
}

export async function getGoogleIntegrationView(): Promise<GoogleIntegrationView> {
  const [row, resolved] = await Promise.all([readRow(), resolveProjectGoogleClient()]);
  const e = env();
  return {
    enabled: row?.enabled ?? true,
    source: resolved.ok ? resolved.source : null,
    refusal: resolved.ok ? null : resolved.message,
    clientId: row?.clientId ?? null,
    hasSecret: Boolean(row?.clientSecretCiphertext),
    validationStatus: row?.clientId ? row.validationStatus : null,
    validatedAt: row?.validatedAt ?? null,
    validationError: row?.validationError ?? null,
    credentialsUpdatedAt: row?.credentialsUpdatedAt ?? null,
    credentialsUpdatedByUsername: row?.credentialsUpdatedByUsername ?? null,
    enabledChangedAt: row?.enabledChangedAt ?? null,
    enabledChangedByUsername: row?.enabledChangedByUsername ?? null,
    environmentClientAvailable: Boolean(e.clientId?.trim() && e.clientSecret?.trim()),
    redirectUri: expectedRedirectUri(),
  };
}

export class GoogleClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleClientConfigError";
  }
}

export interface SaveClientResult {
  status: GoogleClientStatus;
  /** A warning to show when Google could not be reached to check the pair. */
  warning: string | null;
  /** Accounts that must be connected again because the client changed. */
  accountsToReconnect: number;
  clientChanged: boolean;
}

/**
 * Save (or update) the project's own client. Checked with Google first: a pair Google rejects is NOT
 * saved, so a working client is never replaced by a broken one. A blank secret keeps the stored one —
 * but only for the same client ID. When the client ID changes, every account whose tokens another
 * client issued must be connected again: its tokens are wiped (and revoked at Google unless another
 * project still uses that grant) and it is marked "Needs reconnecting", saying why.
 */
export async function saveProjectGoogleClient(input: { clientId: string; clientSecret: string; username: string; fetchImpl?: FetchImpl; now?: Date }): Promise<SaveClientResult> {
  const clientId = input.clientId.trim();
  const typedSecret = input.clientSecret.trim();
  if (!isPlausibleGoogleClientId(clientId)) {
    throw new GoogleClientConfigError("That is not a Google OAuth client ID. It ends in “.apps.googleusercontent.com” — copy it from Google Cloud → Google Auth Platform → Clients.");
  }
  const redirectUri = expectedRedirectUri();
  if (!redirectUri) throw new GoogleClientConfigError("The server's public address (NEXTAUTH_URL) is not set, so there is no redirect URI to register.");

  const row = await prisma.googleIntegrationConfig.findUnique({ where: { id: "global" }, select: { clientId: true, clientSecretCiphertext: true } });
  let secret = typedSecret;
  if (!secret) {
    if (row?.clientId !== clientId || !row.clientSecretCiphertext) throw new GoogleClientConfigError("Enter the client secret. It is needed whenever the client ID is new or changes.");
    try {
      secret = decryptSecret(row.clientSecretCiphertext);
    } catch {
      throw new GoogleClientConfigError("The saved client secret could not be read. Enter it again.");
    }
  } else if (!isPlausibleGoogleClientSecret(secret)) {
    throw new GoogleClientConfigError("That does not look like a client secret. Copy it again from the client's page in Google Cloud.");
  }

  const check = await checkGoogleClient(clientId, secret, redirectUri, input.fetchImpl);
  if (check.result === "INVALID") throw new GoogleClientConfigError(check.message);

  const now = input.now ?? new Date();
  const previousClientId = row?.clientId ?? env().clientId?.trim() ?? null;
  const clientChanged = previousClientId !== null && previousClientId !== clientId;
  const status: GoogleClientStatus = check.result === "VALID" ? "VALID" : "UNVALIDATED";
  const data = {
    clientId,
    clientSecretCiphertext: encryptSecret(secret),
    validationStatus: status,
    validatedAt: check.result === "VALID" ? now : null,
    validationError: check.result === "VALID" ? null : check.message,
    credentialsUpdatedAt: now,
    credentialsUpdatedByUsername: input.username,
  };
  await prisma.googleIntegrationConfig.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  const accountsToReconnect = await invalidateAccountsNotIssuedTo(clientId, input.fetchImpl);
  return { status, warning: check.result === "VALID" ? null : check.message, accountsToReconnect, clientChanged };
}

/** Ask Google again whether the stored pair is accepted, and record the answer. */
export async function revalidateProjectGoogleClient(fetchImpl?: FetchImpl, now: Date = new Date()): Promise<{ status: GoogleClientStatus; message: string | null }> {
  const row = await prisma.googleIntegrationConfig.findUnique({ where: { id: "global" }, select: { clientId: true, clientSecretCiphertext: true } });
  const redirectUri = expectedRedirectUri();
  if (!row?.clientId || !row.clientSecretCiphertext || !redirectUri) throw new GoogleClientConfigError("This project has no OAuth client of its own to validate.");
  let secret: string;
  try {
    secret = decryptSecret(row.clientSecretCiphertext);
  } catch {
    throw new GoogleClientConfigError("The saved client secret could not be read. Enter it again.");
  }
  const check = await checkGoogleClient(row.clientId, secret, redirectUri, fetchImpl);
  const status: GoogleClientStatus = check.result === "VALID" ? "VALID" : check.result === "INVALID" ? "INVALID" : "UNVALIDATED";
  await prisma.googleIntegrationConfig.update({
    where: { id: "global" },
    data: { validationStatus: status, validatedAt: check.result === "VALID" ? now : undefined, validationError: check.result === "VALID" ? null : check.message },
  });
  return { status, message: check.result === "VALID" ? null : check.message };
}

/** Switch the integration on or off. Nothing is deleted or disconnected either way. */
export async function setProjectGoogleIntegrationEnabled(enabled: boolean, username: string, now: Date = new Date()): Promise<boolean> {
  const row = await prisma.googleIntegrationConfig.findUnique({ where: { id: "global" }, select: { enabled: true } });
  if ((row?.enabled ?? true) === enabled) return false;
  const data = { enabled, enabledChangedAt: now, enabledChangedByUsername: username };
  await prisma.googleIntegrationConfig.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  return true;
}

/**
 * Accounts whose tokens a different client issued cannot be refreshed with this one. Their tokens are
 * wiped and they are marked to reconnect. Google is asked to forget the grant only when no other
 * project still has the same Google account connected through the same old client (a grant is per
 * client × Google account, and revoking it would disconnect that project too).
 */
async function invalidateAccountsNotIssuedTo(clientId: string, fetchImpl?: FetchImpl): Promise<number> {
  const envClientId = env().clientId?.trim() ?? null;
  const accounts = await prisma.googleIntegrationAccount.findMany({
    where: { status: "CONNECTED" },
    select: { id: true, googleSubject: true, oauthClientId: true, refreshTokenCiphertext: true, accessTokenCiphertext: true },
  });
  let count = 0;
  for (const account of accounts) {
    const issuer = account.oauthClientId ?? envClientId;
    if (issuer === null || issuer === clientId) continue;
    const sameGrantElsewhere = await platformPrisma.googleIntegrationAccount.count({
      where: {
        id: { not: account.id },
        googleSubject: account.googleSubject,
        status: "CONNECTED",
        ...(account.oauthClientId ? { oauthClientId: account.oauthClientId } : { OR: [{ oauthClientId: null }, { oauthClientId: envClientId }] }),
      },
    });
    const stored = account.refreshTokenCiphertext ?? account.accessTokenCiphertext;
    if (stored && sameGrantElsewhere === 0) {
      try {
        await revokeToken(decryptSecret(stored), fetchImpl);
      } catch {
        /* an unreadable token is already useless */
      }
    }
    await prisma.googleIntegrationAccount.update({
      where: { id: account.id },
      data: { status: "NEEDS_RECONNECT", refreshTokenCiphertext: null, accessTokenCiphertext: null, accessTokenExpiresAt: null, lastError: CLIENT_CHANGED_MESSAGE },
    });
    count++;
  }
  return count;
}
