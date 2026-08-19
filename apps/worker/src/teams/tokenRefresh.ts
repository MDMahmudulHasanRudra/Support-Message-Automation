import { decryptSecret, encryptSecret, prisma } from "@support-automation/db";
import { TeamsAuthClient, classifyTokenError, isTeamsClientConfigured, loadTeamsClientConfigFromEnv } from "@support-automation/teams-client";
import { logSystemEvent } from "../logging/logSystemEvent.js";

/** Refresh proactively once less than this much time remains — avoids a sync tick starting a
 * Graph call with a token that expires mid-request. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Statuses from which a refresh attempt is worth making. Deliberately excludes REAUTH_REQUIRED —
 * classifyTokenError() already determined the stored refresh token itself was rejected by
 * Microsoft, so retrying it again on a timer would just fail identically every time and spam logs/
 * API calls for no benefit; only the customer completing OAuth again (via the Reconnect button)
 * can fix that state. DISCONNECTED means there's nothing to refresh at all. */
const REFRESHABLE_STATUSES = new Set(["CONNECTED", "ERROR"]);

/**
 * Returns a valid access token for the connected TeamsAccount, refreshing it first if it's
 * expiring soon. Returns null (never throws) when there is no connected account, the client isn't
 * configured yet, or the account needs the customer to reconnect — every caller (graphSync.ts)
 * treats null as "nothing to do this tick", same no-op-when-unconfigured convention as every other
 * optional feature in this app.
 */
export async function getValidTeamsAccessToken(): Promise<string | null> {
  if (!isTeamsClientConfigured()) return null;

  const account = await prisma.teamsAccount.findUnique({ where: { id: "global" } });
  if (!account || !REFRESHABLE_STATUSES.has(account.status) || !account.accessTokenCiphertext || !account.refreshTokenCiphertext) {
    return null;
  }

  const expiresSoon = !account.tokenExpiresAt || account.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!expiresSoon) {
    return decryptSecret(account.accessTokenCiphertext);
  }

  try {
    const client = new TeamsAuthClient(loadTeamsClientConfigFromEnv());
    const refreshed = await client.refreshAccessToken(decryptSecret(account.refreshTokenCiphertext));
    await prisma.teamsAccount.update({
      where: { id: "global" },
      data: {
        accessTokenCiphertext: encryptSecret(refreshed.accessToken),
        refreshTokenCiphertext: encryptSecret(refreshed.refreshToken),
        tokenExpiresAt: refreshed.expiresAt,
        scopes: refreshed.scopes,
        status: "CONNECTED",
        lastSyncError: null,
      },
    });
    return refreshed.accessToken;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const classification = classifyTokenError(err);
    await prisma.teamsAccount.update({
      where: { id: "global" },
      data: {
        status: classification === "REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : "ERROR",
        lastSyncError: `Token refresh failed: ${message}`,
      },
    });
    await logSystemEvent(
      "ERROR",
      "teams",
      classification === "REAUTH_REQUIRED" ? "TEAMS_REAUTHENTICATION_REQUIRED" : "TEAMS_TOKEN_REFRESH_FAILED",
      { error: message },
    );
    return null;
  }
}
