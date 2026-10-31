import { randomBytes } from "node:crypto";
import { readMetaSignedRequest } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { publicOrigin } from "@/server/google/oauth";
import { metaPlatformConfig, sha256 } from "@/server/channels/metaOAuth";

/**
 * Meta telling the platform that a person took back what they granted (docs/meta-integration/05):
 *
 *  - Deauthorize callback: they removed the app on Facebook. Every Page token they gave is dead, so
 *    each one-click connection they authorised is marked NEEDS_RECONNECT and its token is wiped —
 *    nothing is sent with it again, and the connection page asks for "Reconnect with Facebook".
 *    Conversations and history stay.
 *  - Data-deletion request: the same, plus the person's Facebook id and name are removed from the
 *    connection and session rows. The conversations belong to the business's own customers, not to
 *    this person, and are kept. Meta gets a status URL and a confirmation code.
 *
 * Both arrive signed with the platform app secret (`signed_request`); an unsigned or wrongly signed
 * request changes nothing. Platform client: the request names a Facebook user, not a project, and the
 * rows it reaches are exactly the ones that user authorised.
 */

const REVOKED = "The person who connected this account removed the app on Facebook, so Meta no longer accepts its access. Reconnect with Facebook.";

async function revoke(metaUserId: string, now: Date, forget: boolean): Promise<number> {
  const rows = await platformPrisma.channelConnection.findMany({
    where: { authMode: "PLATFORM", metaUserId, status: { not: "DISCONNECTED" } },
    select: { id: true, projectId: true, type: true },
  });
  if (rows.length > 0) {
    await platformPrisma.channelConnection.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: "NEEDS_RECONNECT", accessTokenCiphertext: null, lastError: REVOKED, lastErrorAt: now, lastCheckedAt: now },
    });
    await platformPrisma.systemLog.createMany({
      data: rows.map((r) => ({
        projectId: r.projectId,
        level: "WARN" as const,
        scope: "channels",
        message: forget ? "Meta data-deletion request: connection needs reconnecting" : "Facebook access removed: connection needs reconnecting",
        metadata: { type: r.type },
        targetType: "ChannelConnection",
        targetId: r.id,
      })),
    });
  }
  await platformPrisma.metaOAuthSession.updateMany({
    where: { metaUserId, status: { in: ["STARTED", "AUTHORIZED"] } },
    data: { status: "CANCELLED", userTokenCiphertext: null, failureReason: "Access removed at Facebook.", completedAt: now },
  });
  if (forget) {
    await platformPrisma.channelConnection.updateMany({ where: { metaUserId }, data: { metaUserId: null } });
    await platformPrisma.metaOAuthSession.updateMany({ where: { metaUserId }, data: { metaUserId: null, metaUserName: null, userTokenCiphertext: null } });
  }
  return rows.length + (await revokeSocialStudio(metaUserId, now, forget));
}

/**
 * Social Studio's publishing connections (SOCIAL_STUDIO.md §Meta) use the same Meta app, so the same
 * person's removal reaches them too: the stored user token and every Page / Instagram token it gave are
 * wiped and the accounts need reconnecting — a scheduled post then fails with "reconnect", it is never
 * sent with a dead token. A data-deletion request also removes the person's Facebook id and name (the id
 * is part of a unique key, so it becomes an anonymous marker). Posts and their history stay: they are the
 * business's own.
 */
async function revokeSocialStudio(metaUserId: string, now: Date, forget: boolean): Promise<number> {
  const connections = await platformPrisma.socialConnection.findMany({ where: { provider: "META", externalUserId: metaUserId }, select: { id: true, projectId: true, status: true } });
  if (connections.length === 0) return 0;
  const live = connections.filter((c) => c.status !== "DISCONNECTED");
  const ids = connections.map((c) => c.id);
  await platformPrisma.socialConnection.updateMany({ where: { id: { in: live.map((c) => c.id) } }, data: { status: "NEEDS_RECONNECT", lastError: REVOKED, lastCheckedAt: now } });
  await platformPrisma.socialConnection.updateMany({ where: { id: { in: ids } }, data: { credentialCiphertext: null, tokenExpiresAt: null } });
  const accounts = await platformPrisma.socialAccount.updateMany({ where: { connectionId: { in: ids }, status: { not: "REMOVED" } }, data: { status: "NEEDS_RECONNECT", tokenCiphertext: null, lastError: REVOKED } });
  await platformPrisma.socialAccount.updateMany({ where: { connectionId: { in: ids }, status: "REMOVED" }, data: { tokenCiphertext: null } });
  if (live.length > 0) {
    await platformPrisma.systemLog.createMany({
      data: live.map((c) => ({
        projectId: c.projectId,
        level: "WARN" as const,
        scope: "social",
        message: forget ? "Meta data-deletion request: Social Studio connection needs reconnecting" : "Facebook access removed: Social Studio connection needs reconnecting",
        metadata: { accounts: accounts.count },
        targetType: "SocialConnection",
        targetId: c.id,
      })),
    });
  }
  if (forget) {
    for (const c of connections) {
      await platformPrisma.socialConnection.update({ where: { id: c.id }, data: { externalUserId: `deleted-${randomBytes(9).toString("hex")}`, externalUserName: null } });
    }
  }
  return live.length;
}

export async function handleMetaDeauthorize(signedRequest: string | null, now = new Date()): Promise<{ status: number }> {
  const config = metaPlatformConfig();
  if (!config.ok) return { status: 404 };
  const request = readMetaSignedRequest(signedRequest, config.config.appSecret);
  if (!request) return { status: 400 };
  await revoke(request.userId, now, false);
  return { status: 200 };
}

export async function handleMetaDataDeletion(signedRequest: string | null, now = new Date()): Promise<{ status: number; body?: { url: string; confirmation_code: string } }> {
  const config = metaPlatformConfig();
  if (!config.ok) return { status: 404 };
  const request = readMetaSignedRequest(signedRequest, config.config.appSecret);
  if (!request) return { status: 400 };
  const affected = await revoke(request.userId, now, true);
  const confirmationCode = randomBytes(12).toString("hex");
  await platformPrisma.metaDataDeletionRequest.create({
    data: { confirmationCode, metaUserIdHash: sha256(request.userId), connectionsAffected: affected, receivedAt: now, completedAt: now },
  });
  const origin = publicOrigin() ?? "";
  return { status: 200, body: { url: `${origin}/api/meta/data-deletion?code=${confirmationCode}`, confirmation_code: confirmationCode } };
}

/** The status Meta's user can look up with their confirmation code. Says only what was done. */
export async function metaDataDeletionStatus(code: string | null): Promise<string | null> {
  if (!code || !/^[a-f0-9]{24}$/.test(code)) return null;
  const row = await platformPrisma.metaDataDeletionRequest.findUnique({ where: { confirmationCode: code }, select: { receivedAt: true, completedAt: true, connectionsAffected: true } });
  if (!row) return null;
  return [
    `Data deletion request ${code}`,
    `Received: ${row.receivedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    row.completedAt ? `Completed: ${row.completedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Status: in progress",
    "",
    "Your Facebook account id and name were removed from this service, and every access you had granted to it was revoked.",
    `${row.connectionsAffected} connected Page or Instagram account(s) were disconnected from your access and now need to be reconnected by someone else at the business.`,
    "Messages exchanged with the business's own customers are the business's records and are kept by the business.",
  ].join("\n");
}
