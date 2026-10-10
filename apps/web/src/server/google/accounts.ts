import { decryptSecret, encryptSecret } from "@support-automation/db";
import { platformPrisma, prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import {
  exchangeCode,
  fetchIdentity,
  GoogleApiError,
  refreshAccessToken,
  revokeToken,
  type FetchImpl,
} from "@/server/google/api";
import { REQUIRED_SCOPES, type GoogleOAuthConfig } from "@/server/google/oauth";

/**
 * Connected Google accounts of the CURRENT project (GOOGLE_SHEETS.md). Every query goes through the
 * project-scoped client, so another project's account id is simply "not found".
 *
 * Tokens are written only as `encryptSecret` envelopes and read only inside this file. Nothing here
 * returns a token, a ciphertext or the client secret: `PUBLIC_ACCOUNT_SELECT` is the only shape that
 * leaves it.
 */

export const PUBLIC_ACCOUNT_SELECT = {
  id: true,
  email: true,
  displayName: true,
  pictureUrl: true,
  grantedScopes: true,
  status: true,
  lastError: true,
  spreadsheetCount: true,
  spreadsheetsCountedAt: true,
  connectedAt: true,
  disconnectedAt: true,
  disconnectedByUsername: true,
  connectedBy: { select: { id: true, name: true, username: true } },
} as const;

export interface PublicGoogleAccount {
  id: string;
  email: string;
  displayName: string | null;
  pictureUrl: string | null;
  grantedScopes: string[];
  status: "CONNECTED" | "NEEDS_RECONNECT" | "DISCONNECTED";
  lastError: string | null;
  spreadsheetCount: number | null;
  spreadsheetsCountedAt: Date | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
  disconnectedByUsername: string | null;
  connectedBy: { id: string; name: string; username: string } | null;
}

/** Why a connection could not be completed, as a code the settings page turns into words. */
export class GoogleConnectionError extends Error {
  constructor(
    public readonly code: "MISSING_SCOPES" | "NO_REFRESH_TOKEN" | "GOOGLE_REFUSED",
    message: string,
  ) {
    super(message);
    this.name = "GoogleConnectionError";
  }
}

/** The account cannot be used until somebody connects it again (or it was never there). */
export class GoogleAccountUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAccountUnavailableError";
  }
}

export async function listGoogleAccounts(): Promise<PublicGoogleAccount[]> {
  const rows = await prisma.googleIntegrationAccount.findMany({ select: PUBLIC_ACCOUNT_SELECT, orderBy: [{ email: "asc" }] });
  const rank = { CONNECTED: 0, NEEDS_RECONNECT: 1, DISCONNECTED: 2 } as const;
  return [...rows].sort((a, b) => rank[a.status] - rank[b.status]) as PublicGoogleAccount[];
}

/**
 * Finish a connection: redeem the code, check what was granted, learn who the account is, and store
 * it — on the SAME row if this Google account was connected to this project before, so whatever
 * history names that row keeps naming it. Reading its spreadsheet list is the caller's next step
 * (`syncAccountSpreadsheets`), best effort: a failed list must not lose a connection that worked.
 */
export async function completeGoogleConnection(input: {
  config: GoogleOAuthConfig;
  code: string;
  verifier: string;
  userId: string;
  fetchImpl?: FetchImpl;
}): Promise<PublicGoogleAccount> {
  let tokens;
  try {
    tokens = await exchangeCode(input.config, input.code, input.verifier, input.fetchImpl);
  } catch (err) {
    throw new GoogleConnectionError("GOOGLE_REFUSED", (err as Error).message);
  }
  const missing = REQUIRED_SCOPES.filter((scope) => !tokens.scopes.includes(scope));
  if (missing.length > 0) {
    // Revoke what was granted: a half-permitted grant is of no use and should not linger at Google —
    // unless this Google account is connected to another project, whose access shares the grant.
    const subject = await fetchIdentity(tokens.accessToken, input.fetchImpl).then((i) => i.subject, () => null);
    const elsewhere = subject ? await platformPrisma.googleIntegrationAccount.count({ where: { googleSubject: subject, status: "CONNECTED" } }) : 0;
    if (elsewhere === 0) await revokeToken(tokens.refreshToken ?? tokens.accessToken, input.fetchImpl);
    throw new GoogleConnectionError(
      "MISSING_SCOPES",
      "Google did not grant access to see and edit spreadsheets. Connect again and leave every permission ticked on Google's screen.",
    );
  }
  if (!tokens.refreshToken) {
    throw new GoogleConnectionError(
      "NO_REFRESH_TOKEN",
      "Google did not grant offline access. Remove this app at myaccount.google.com/permissions, then connect again.",
    );
  }
  const identity = await fetchIdentity(tokens.accessToken, input.fetchImpl);
  const projectId = await activeProjectId();
  const now = new Date();

  const secrets = {
    refreshTokenCiphertext: encryptSecret(tokens.refreshToken),
    accessTokenCiphertext: encryptSecret(tokens.accessToken),
    accessTokenExpiresAt: tokens.expiresAt,
  };
  const fields = {
    email: identity.email,
    displayName: identity.name,
    pictureUrl: identity.picture,
    grantedScopes: tokens.scopes,
    status: "CONNECTED" as const,
    lastError: null,
    connectedById: input.userId,
    connectedAt: now,
    disconnectedAt: null,
    disconnectedByUsername: null,
    ...secrets,
  };
  const saved = await prisma.googleIntegrationAccount.upsert({
    where: { projectId_googleSubject: { projectId, googleSubject: identity.subject } },
    create: { projectId, googleSubject: identity.subject, ...fields },
    update: fields,
    select: PUBLIC_ACCOUNT_SELECT,
  });
  return saved as PublicGoogleAccount;
}

/**
 * A working access token for one connected account, refreshed when it is about to expire — or
 * when `forceRefresh` says Google just refused the cached one. When Google refuses the refresh token
 * itself the account is marked NEEDS_RECONNECT and its dead tokens are wiped — retrying a revoked
 * grant forever helps nobody, and the page says what to do.
 */
export async function getAccessToken(
  accountId: string,
  options: { config: GoogleOAuthConfig; fetchImpl?: FetchImpl; now?: Date; forceRefresh?: boolean },
): Promise<string> {
  const row = await prisma.googleIntegrationAccount.findUnique({
    where: { id: accountId },
    select: { id: true, email: true, status: true, refreshTokenCiphertext: true, accessTokenCiphertext: true, accessTokenExpiresAt: true },
  });
  if (!row) throw new GoogleAccountUnavailableError("That Google account is not connected to this project.");
  if (row.status !== "CONNECTED" || !row.refreshTokenCiphertext) {
    throw new GoogleAccountUnavailableError(`${row.email} needs to be connected again before it can be used.`);
  }
  const now = options.now ?? new Date();
  if (!options.forceRefresh && row.accessTokenCiphertext && row.accessTokenExpiresAt && row.accessTokenExpiresAt > now) {
    return decryptSecret(row.accessTokenCiphertext);
  }

  try {
    const tokens = await refreshAccessToken(options.config, decryptSecret(row.refreshTokenCiphertext), options.fetchImpl);
    await prisma.googleIntegrationAccount.update({
      where: { id: row.id },
      data: {
        accessTokenCiphertext: encryptSecret(tokens.accessToken),
        accessTokenExpiresAt: tokens.expiresAt,
        // Google may rotate the refresh token; keep the newest one.
        ...(tokens.refreshToken ? { refreshTokenCiphertext: encryptSecret(tokens.refreshToken) } : {}),
        lastError: null,
      },
    });
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof GoogleApiError && err.needsReconnect) {
      await prisma.googleIntegrationAccount.update({
        where: { id: row.id },
        data: {
          status: "NEEDS_RECONNECT",
          refreshTokenCiphertext: null,
          accessTokenCiphertext: null,
          accessTokenExpiresAt: null,
          lastError: "Google no longer accepts this connection (access was removed, it expired, or the password changed). Connect the account again.",
        },
      });
      throw new GoogleAccountUnavailableError(`${row.email} needs to be connected again: Google no longer accepts the stored access.`);
    }
    throw err;
  }
}

/**
 * Disconnect: ask Google to forget the grant (best effort), wipe the tokens, keep the row. Its
 * history — every activity and session recorded through it — keeps its meaning. Connecting the same
 * Google account again revives this row. The caller then marks the spreadsheets it reached
 * (`markAccountSpreadsheetsUnreachable`).
 *
 * Google revokes a WHOLE grant (this app × that Google account), not one token. So when the same
 * Google account is still connected to another project, nothing is revoked at Google — that would
 * silently disconnect the other project too; this project's copy of the tokens is wiped all the same.
 */
export async function disconnectGoogleAccount(accountId: string, username: string, fetchImpl?: FetchImpl): Promise<PublicGoogleAccount | null> {
  const row = await prisma.googleIntegrationAccount.findUnique({
    where: { id: accountId },
    select: { id: true, googleSubject: true, refreshTokenCiphertext: true, accessTokenCiphertext: true },
  });
  if (!row) return null;
  const stored = row.refreshTokenCiphertext ?? row.accessTokenCiphertext;
  const connectedElsewhere = await platformPrisma.googleIntegrationAccount.count({
    where: { googleSubject: row.googleSubject, status: "CONNECTED", id: { not: row.id } },
  });
  if (stored && connectedElsewhere === 0) {
    try {
      await revokeToken(decryptSecret(stored), fetchImpl);
    } catch {
      /* an undecryptable token is already useless; the wipe below still happens */
    }
  }
  return (await prisma.googleIntegrationAccount.update({
    where: { id: row.id },
    data: {
      status: "DISCONNECTED",
      refreshTokenCiphertext: null,
      accessTokenCiphertext: null,
      accessTokenExpiresAt: null,
      disconnectedAt: new Date(),
      disconnectedByUsername: username,
      lastError: null,
    },
    select: PUBLIC_ACCOUNT_SELECT,
  })) as PublicGoogleAccount;
}
