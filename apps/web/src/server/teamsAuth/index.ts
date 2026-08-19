import { randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { encryptSecret, prisma } from "@support-automation/db";
import { TeamsAuthClient, TeamsGraphClient, TeamsOAuthError, loadTeamsClientConfigFromEnv } from "@support-automation/teams-client";
import { logSystemEvent } from "@/server/logSystemEvent";

const STATE_COOKIE = "teams_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — just long enough for the Microsoft consent redirect round trip

/** Redirect the admin's browser here to start the Microsoft consent flow. The state value is
 * stored in a short-lived httpOnly cookie and verified on callback — CSRF protection for the
 * standard OAuth authorization-code flow (someone else's callback code can't be replayed against
 * this admin's session without also having stolen this cookie). */
export async function buildConnectRedirectUrl(): Promise<string> {
  const client = new TeamsAuthClient(loadTeamsClientConfigFromEnv());
  const state = randomBytes(24).toString("base64url");

  const store = await cookies();
  store.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_MS / 1000,
  });

  return client.getAuthorizationUrl(state);
}

export type CallbackResult = { ok: true } | { ok: false; error: string; cancelled?: boolean };

/** Queues an immediate sync right after a successful connect, so the customer sees their Teams/
 * channels appear within moments rather than waiting for the next scheduled poll (up to
 * `TeamsIntegrationSettings.pollingIntervalMinutes`) or having to click "Sync Now" themselves —
 * "automatic discovery" per the one-click connection UX. Never blocks the HTTP callback: this only
 * inserts a WorkerCommand row for the worker to pick up, same dedupe shape as
 * triggerTeamsSyncNow() (apps/web/src/server/actions/teamsIntegration.ts). */
async function queueImmediateSync(): Promise<void> {
  const existing = await prisma.workerCommand.findFirst({
    where: { type: "TEAMS_SYNC_NOW", status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (!existing) {
    await prisma.workerCommand.create({ data: { type: "TEAMS_SYNC_NOW" } });
  }
}

/** A customer-safe message for every OAuth failure mode — never the raw exception text, which can
 * contain Microsoft's internal AADSTS error codes/descriptions. Full detail always goes to
 * SystemLog via logSystemEvent for whoever's debugging the connection, never to the browser. */
const GENERIC_CONNECT_FAILURE = "We couldn't connect to Microsoft Teams. Please try again.";

/** Verifies the callback's `state` against the cookie set by buildConnectRedirectUrl, exchanges
 * the code for tokens, fetches the connected user's identity, and stores everything encrypted on
 * the singleton TeamsAccount row. `microsoftError` is Microsoft's own `?error=` redirect param
 * (present instead of `?code=` when the user cancels or denies consent, or Microsoft itself
 * rejects the request) — handled before ever looking at `code`. */
export async function handleOAuthCallback(
  code: string | null,
  state: string | null,
  microsoftError: string | null,
  microsoftErrorDescription: string | null,
): Promise<CallbackResult> {
  const store = await cookies();
  const expectedState = store.get(STATE_COOKIE)?.value;
  store.delete(STATE_COOKIE);

  if (microsoftError) {
    await logSystemEvent("INFO", "teams", "TEAMS_OAUTH_CALLBACK_ERROR", { error: microsoftError, description: microsoftErrorDescription });
    if (microsoftError === "access_denied") {
      return { ok: false, error: "Connection cancelled — Microsoft Teams was not connected.", cancelled: true };
    }
    return { ok: false, error: GENERIC_CONNECT_FAILURE };
  }

  if (!code) return { ok: false, error: GENERIC_CONNECT_FAILURE };
  if (!state || !expectedState) {
    return { ok: false, error: "Your connection attempt expired or could not be verified. Please try again." };
  }
  const stateBuf = Buffer.from(state);
  const expectedBuf = Buffer.from(expectedState);
  if (stateBuf.length !== expectedBuf.length || !timingSafeEqual(stateBuf, expectedBuf)) {
    await logSystemEvent("WARN", "teams", "TEAMS_OAUTH_STATE_MISMATCH", {});
    return { ok: false, error: "Your connection attempt expired or could not be verified. Please try again." };
  }

  try {
    const config = loadTeamsClientConfigFromEnv();
    const authClient = new TeamsAuthClient(config);
    const tokens = await authClient.acquireTokenByCode(code);

    const graph = new TeamsGraphClient(tokens.accessToken);
    const user = await graph.getCurrentUser();

    await prisma.teamsAccount.upsert({
      where: { id: "global" },
      update: {
        tenantId: config.tenantId,
        externalUserId: user.id,
        email: user.mail ?? user.userPrincipalName,
        displayName: user.displayName,
        status: "CONNECTED",
        accessTokenCiphertext: encryptSecret(tokens.accessToken),
        refreshTokenCiphertext: encryptSecret(tokens.refreshToken),
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        lastSyncError: null,
      },
      create: {
        id: "global",
        tenantId: config.tenantId,
        externalUserId: user.id,
        email: user.mail ?? user.userPrincipalName,
        displayName: user.displayName,
        status: "CONNECTED",
        accessTokenCiphertext: encryptSecret(tokens.accessToken),
        refreshTokenCiphertext: encryptSecret(tokens.refreshToken),
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      },
    });

    await logSystemEvent("INFO", "teams", "TEAMS_ACCOUNT_CONNECTED", { email: user.mail ?? user.userPrincipalName });
    await queueImmediateSync();

    return { ok: true };
  } catch (err) {
    const message = err instanceof TeamsOAuthError ? `${err.message} (code: ${err.code ?? "none"})` : ((err as Error).message ?? String(err));
    await prisma.teamsAccount.upsert({
      where: { id: "global" },
      update: { status: "ERROR", lastSyncError: message },
      create: { id: "global", status: "ERROR", lastSyncError: message },
    });
    await logSystemEvent("ERROR", "teams", "TEAMS_OAUTH_CALLBACK_FAILED", { error: message });
    return { ok: false, error: GENERIC_CONNECT_FAILURE };
  }
}
