import { decryptSecret, encryptSecret } from "@support-automation/db";
import { classifyMetaSocialAccounts, readGrantedScopes, type MetaPageRow } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { listMetaAccounts, readMetaPermissions, readMetaUser } from "@/server/channels/providerApi";
import { metaPlatformConfig } from "@/server/channels/metaOAuth";
import type { AdapterAccount } from "./adapters/types";

/**
 * Social Studio's connections and accounts (SOCIAL_STUDIO.md §Accounts). The ONLY file that decrypts a
 * Social Studio token: the engine and the pages receive an `AdapterAccount` or a view, never a stored
 * credential. Everything runs inside a project through the scoped client, so one project can never read
 * or use another's accounts. These tables are separate from the messaging channels' — connecting a Page
 * for publishing never touches its Messenger connection, and the reverse.
 */

export class SocialAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialAccountError";
  }
}

export interface SocialAccountView {
  id: string;
  platform: string;
  name: string;
  username: string | null;
  pictureUrl: string | null;
  status: string;
  enabled: boolean;
  lastError: string | null;
  connectionId: string;
  connectedBy: string;
  parentExternalId: string | null;
  publishedLast30d: number;
}

export async function listSocialAccounts(opts: { includeRemoved?: boolean } = {}): Promise<SocialAccountView[]> {
  const rows = await prisma.socialAccount.findMany({
    where: opts.includeRemoved ? {} : { status: { not: "REMOVED" } },
    orderBy: [{ platform: "asc" }, { name: "asc" }],
    take: 500,
    select: {
      id: true,
      platform: true,
      name: true,
      username: true,
      pictureUrl: true,
      status: true,
      enabled: true,
      lastError: true,
      connectionId: true,
      parentExternalId: true,
      connection: { select: { connectedByUsername: true } },
    },
  });
  const since = new Date(Date.now() - 30 * 86_400_000);
  const counts = rows.length
    ? await prisma.socialPostTarget.groupBy({ by: ["accountId"], where: { accountId: { in: rows.map((r) => r.id) }, status: "PUBLISHED", publishedAt: { gte: since } }, _count: { _all: true } })
    : [];
  const byAccount = new Map(counts.map((c) => [c.accountId, c._count._all]));
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    name: r.name,
    username: r.username,
    pictureUrl: r.pictureUrl,
    status: r.status,
    enabled: r.enabled,
    lastError: r.lastError,
    connectionId: r.connectionId,
    connectedBy: r.connection.connectedByUsername,
    parentExternalId: r.parentExternalId,
    publishedLast30d: byAccount.get(r.id) ?? 0,
  }));
}

export interface SocialConnectionView {
  id: string;
  provider: string;
  status: string;
  externalUserName: string | null;
  grantedScopes: string[];
  declinedScopes: string[];
  tokenExpiresAt: string | null;
  connectedByUsername: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  accounts: number;
}

export async function listSocialConnections(): Promise<SocialConnectionView[]> {
  const rows = await prisma.socialConnection.findMany({
    where: { status: { not: "DISCONNECTED" } },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { accounts: { where: { status: { not: "REMOVED" } } } } } },
  });
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    status: r.status,
    externalUserName: r.externalUserName,
    grantedScopes: r.grantedScopes,
    declinedScopes: r.declinedScopes,
    tokenExpiresAt: r.tokenExpiresAt?.toISOString() ?? null,
    connectedByUsername: r.connectedByUsername,
    lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
    lastError: r.lastError,
    accounts: r._count.accounts,
  }));
}

/** The account with its token decrypted, for one adapter call, or a sentence saying why it cannot be used. */
export async function adapterAccount(accountId: string): Promise<{ ok: true; account: AdapterAccount } | { ok: false; reason: string; reconnect: boolean }> {
  const row = await prisma.socialAccount.findFirst({ where: { id: accountId }, select: { platform: true, externalId: true, parentExternalId: true, tokenCiphertext: true, status: true, connection: { select: { status: true } } } });
  if (!row) return { ok: false, reason: "The account no longer exists.", reconnect: false };
  if (row.status === "REMOVED" || row.connection.status === "DISCONNECTED") return { ok: false, reason: "The account was disconnected.", reconnect: true };
  if (row.status === "NEEDS_RECONNECT") return { ok: false, reason: "The account needs to be reconnected.", reconnect: true };
  if (!row.tokenCiphertext) return { ok: false, reason: "The account has no authorization stored.", reconnect: true };
  let token: string;
  try {
    token = decryptSecret(row.tokenCiphertext);
  } catch {
    return { ok: false, reason: "The account's authorization cannot be read on this server. Reconnect it.", reconnect: true };
  }
  return { ok: true, account: { platform: row.platform as AdapterAccount["platform"], externalId: row.externalId, parentExternalId: row.parentExternalId, token } };
}

export async function markAccountNeedsReconnect(accountId: string, reason: string): Promise<void> {
  await prisma.socialAccount.updateMany({ where: { id: accountId, status: "ACTIVE" }, data: { status: "NEEDS_RECONNECT", lastError: reason.slice(0, 500) } });
}

export async function setSocialAccountEnabled(accountId: string, enabled: boolean): Promise<void> {
  const updated = await prisma.socialAccount.updateMany({ where: { id: accountId, status: { not: "REMOVED" } }, data: { enabled } });
  if (updated.count === 0) throw new SocialAccountError("That account no longer exists.");
}

/**
 * Saves what a Meta authorization found (the callback, or a refresh with the stored user token). Each
 * Page / Instagram account is one row per project: one found again — even through another person's
 * authorization — is moved to this connection with its fresh token, so the newest authorization wins and
 * the same account can never be published to twice. Accounts this connection brought before and no
 * longer lists are marked removed (their history stays).
 */
export async function saveMetaDiscovery(input: {
  connectionId: string;
  rows: MetaPageRow[];
  granted: string[];
  now: Date;
}): Promise<{ active: number; needsAttention: number }> {
  const found = classifyMetaSocialAccounts(input.rows, input.granted);
  const projectId = await projectIdOfConnection(input.connectionId);
  const seen: string[] = [];
  for (const a of found) {
    const data = {
      connectionId: input.connectionId,
      parentExternalId: a.parentExternalId,
      name: a.name,
      username: a.username,
      pictureUrl: a.pictureUrl,
      tokenCiphertext: a.token ? encryptSecret(a.token) : null,
      status: a.status,
      lastError: a.problem,
      lastSeenAt: input.now,
      removedAt: null,
    };
    const row = await prisma.socialAccount.upsert({
      where: { projectId_platform_externalId: { projectId, platform: a.platform, externalId: a.externalId } },
      create: { platform: a.platform, externalId: a.externalId, ...data },
      update: data,
      select: { id: true },
    });
    seen.push(row.id);
  }
  await prisma.socialAccount.updateMany({
    where: { connectionId: input.connectionId, id: { notIn: seen }, status: { not: "REMOVED" } },
    data: { status: "REMOVED", removedAt: input.now, tokenCiphertext: null, lastError: "No longer included in the authorization." },
  });
  return { active: found.filter((a) => a.status === "ACTIVE").length, needsAttention: found.filter((a) => a.status !== "ACTIVE").length };
}

async function projectIdOfConnection(connectionId: string): Promise<string> {
  const row = await prisma.socialConnection.findFirst({ where: { id: connectionId }, select: { projectId: true } });
  if (!row) throw new SocialAccountError("The connection no longer exists.");
  return row.projectId;
}

/**
 * Re-reads a Meta connection with its stored user token: is it still accepted, which permissions remain,
 * and which Pages / Instagram accounts (with fresh Page tokens). Nothing is published or changed at Meta.
 */
export async function refreshSocialConnection(connectionId: string, now = new Date()): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.socialConnection.findFirst({ where: { id: connectionId }, select: { id: true, provider: true, credentialCiphertext: true, status: true } });
  if (!row || row.status === "DISCONNECTED" || !row.credentialCiphertext) throw new SocialAccountError("Connect again: this connection has no authorization stored.");
  const config = metaPlatformConfig();
  if (!config.ok) throw new SocialAccountError("The platform's Meta app is not configured on this server.");
  let token: string;
  try {
    token = decryptSecret(row.credentialCiphertext);
  } catch {
    throw new SocialAccountError("The stored authorization cannot be read on this server. Connect again.");
  }
  const appSecret = config.config.appSecret;
  const me = await readMetaUser(token, appSecret);
  if (!me.ok) {
    const status = me.error.needsReauth ? "NEEDS_RECONNECT" : "ERROR";
    await prisma.socialConnection.update({ where: { id: connectionId }, data: { status, lastCheckedAt: now, lastError: me.error.message.slice(0, 500) } });
    if (me.error.needsReauth) await prisma.socialAccount.updateMany({ where: { connectionId, status: "ACTIVE" }, data: { status: "NEEDS_RECONNECT", lastError: "The authorization expired or was revoked." } });
    return { ok: false, message: me.error.needsReauth ? "Meta no longer accepts this authorization. Connect again." : me.error.message };
  }
  const perms = await readMetaPermissions(token, appSecret);
  const scopes = perms.ok ? readGrantedScopes(perms.data) : { granted: [], declined: [] };
  const accounts = await listMetaAccounts(token, appSecret, { withTokens: true });
  if (!accounts.ok) {
    await prisma.socialConnection.update({ where: { id: connectionId }, data: { lastCheckedAt: now, lastError: accounts.error.message.slice(0, 500) } });
    return { ok: false, message: accounts.error.message };
  }
  await prisma.socialConnection.update({
    where: { id: connectionId },
    data: { status: "CONNECTED", lastCheckedAt: now, lastError: null, grantedScopes: scopes.granted, declinedScopes: scopes.declined, externalUserName: me.data.name ?? null },
  });
  const saved = await saveMetaDiscovery({ connectionId, rows: accounts.data.accounts as MetaPageRow[], granted: scopes.granted, now });
  return { ok: true, message: `${saved.active} account(s) ready${saved.needsAttention ? `, ${saved.needsAttention} need attention` : ""}.` };
}

/**
 * Disconnects: the user token and every account token are wiped; the rows, posts and history are kept.
 * Posts waiting for these accounts fail when due ("the account was disconnected") and can be retried
 * after connecting again. Access is revoked at Meta by the person (Facebook → Settings → Business
 * Integrations) — the page says so.
 */
export async function disconnectSocialConnection(connectionId: string, now = new Date()): Promise<{ accounts: number; waiting: number }> {
  return prisma.$transaction(async (tx) => {
    const conn = await tx.socialConnection.updateMany({ where: { id: connectionId, status: { not: "DISCONNECTED" } }, data: { status: "DISCONNECTED", credentialCiphertext: null, disconnectedAt: now } });
    if (conn.count === 0) throw new SocialAccountError("That connection is already disconnected.");
    const accounts = await tx.socialAccount.updateMany({
      where: { connectionId, status: { not: "REMOVED" } },
      data: { status: "REMOVED", removedAt: now, tokenCiphertext: null, lastError: "Disconnected." },
    });
    const waiting = await tx.socialPostTarget.count({ where: { account: { connectionId }, status: { in: ["DUE", "PENDING"] } } });
    return { accounts: accounts.count, waiting };
  });
}
