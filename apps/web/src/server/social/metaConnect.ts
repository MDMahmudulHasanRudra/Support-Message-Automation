import { decryptSecret, encryptSecret } from "@support-automation/db";
import { metaProjectAllowed, type MetaPageRow } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { listMetaAccounts } from "@/server/channels/providerApi";
import { metaOAuthFlowOf, metaPlatformConfig } from "@/server/channels/metaOAuth";
import { saveMetaDiscovery, SocialAccountError } from "./accounts";

/**
 * Connecting Facebook Pages and Instagram accounts for PUBLISHING (SOCIAL_STUDIO.md §Meta).
 *
 * Since Meta expansion A2 (docs/meta-expansion/04 §2) it runs through the SAME secure handover as the
 * messaging "Connect with Facebook" (`server/channels/metaOAuth.ts`): start on the customer's address →
 * Meta's dialog → the platform's one registered callback (`META_OAUTH_REDIRECT_URI`) redeems the code →
 * back to the address it started from → claimed by the same person in the same browser, once. It used
 * to keep its state in a cookie on the callback's own address, which a customer's own address could never
 * set — so connecting worked only on the address NEXTAUTH_URL named.
 *
 * What stays separate from messaging: purpose SOCIAL_CONNECT, its own binding cookie and claim route, its
 * own permissions at Meta (`META_SOCIAL_SCOPES` / `META_SOCIAL_LOGIN_CONFIG_ID`, never `pages_messaging`),
 * and its own tables. A messaging attempt cannot be claimed here, nor this one on the messaging side.
 */

export type SocialMetaReadiness = { ok: true; redirectUri: string } | { ok: false; problems: string[] };

/** Whether this project can connect Meta for publishing, and if not, every reason (names, never values). */
export function socialMetaReadiness(projectId: string | null): SocialMetaReadiness {
  const reading = metaPlatformConfig();
  const problems: string[] = reading.ok ? [] : [...reading.problems];
  if (!metaProjectAllowed(process.env, projectId)) problems.push("This workspace is not in META_ALLOWED_PROJECT_IDS.");
  if (problems.length || !reading.ok) return { ok: false, problems };
  return { ok: true, redirectUri: reading.config.redirectUri };
}

/**
 * Inside the project, after the claim (same person, same browser, once): takes the attempt — so it can be
 * finished only once — wipes its user token from the attempt, lists the Pages with that token and saves
 * the publishing connection and its accounts. The user token is kept, encrypted, on the connection for
 * refreshing the account list later, as before.
 */
export async function completeSocialMetaSession(input: { sessionId: string; userId: string; username: string; fetchImpl?: typeof fetch; now?: Date }): Promise<{ active: number; needsAttention: number }> {
  const now = input.now ?? new Date();
  const ready = socialMetaReadiness(await activeProjectId());
  const reading = metaPlatformConfig();
  if (!ready.ok || !reading.ok) throw new SocialAccountError("Meta publishing is not set up on this server.");
  const row = await prisma.metaOAuthSession.findUnique({
    where: { id: input.sessionId },
    select: { id: true, userId: true, purpose: true, status: true, claimedAt: true, expiresAt: true, metaUserId: true, metaUserName: true, userTokenCiphertext: true, userTokenExpiresAt: true, grantedScopes: true, declinedScopes: true },
  });
  if (!row || metaOAuthFlowOf(row.purpose) !== "SOCIAL" || row.userId !== input.userId) throw new SocialAccountError("That connection attempt was not found.");
  if (row.status !== "AUTHORIZED" || !row.claimedAt || row.expiresAt <= now || !row.userTokenCiphertext || !row.metaUserId) throw new SocialAccountError("That connection attempt expired or was already used.");
  // Single use: only the request that moves it out of AUTHORIZED goes on, and the attempt keeps no token.
  const taken = await prisma.metaOAuthSession.updateMany({ where: { id: row.id, status: "AUTHORIZED" }, data: { status: "COMPLETED", userTokenCiphertext: null, completedAt: now } });
  if (taken.count !== 1) throw new SocialAccountError("That connection attempt expired or was already used.");

  let token: string;
  try {
    token = decryptSecret(row.userTokenCiphertext);
  } catch {
    throw new SocialAccountError("The authorization could not be read. Start again.");
  }
  const failed = async (message: string) => {
    await prisma.metaOAuthSession.update({ where: { id: row.id }, data: { status: "FAILED", failureReason: "Meta could not list the Pages for publishing." } });
    return new SocialAccountError(message);
  };
  const accounts = await listMetaAccounts(token, reading.config.appSecret, { withTokens: true }, input.fetchImpl ?? fetch);
  if (!accounts.ok) throw await failed(`Meta could not list the Pages: ${accounts.error.message}`);

  const data = {
    status: "CONNECTED",
    externalUserName: row.metaUserName,
    credentialCiphertext: encryptSecret(token),
    tokenExpiresAt: row.userTokenExpiresAt,
    grantedScopes: row.grantedScopes,
    declinedScopes: row.declinedScopes,
    connectedByUsername: input.username,
    lastCheckedAt: now,
    lastError: null,
    disconnectedAt: null,
  };
  const existing = await prisma.socialConnection.findFirst({ where: { provider: "META", externalUserId: row.metaUserId }, select: { id: true } });
  const connection = existing
    ? await prisma.socialConnection.update({ where: { id: existing.id }, data, select: { id: true } })
    : await prisma.socialConnection.create({ data: { provider: "META", externalUserId: row.metaUserId, ...data }, select: { id: true } });
  return saveMetaDiscovery({ connectionId: connection.id, rows: accounts.data.accounts as MetaPageRow[], granted: row.grantedScopes, now });
}
