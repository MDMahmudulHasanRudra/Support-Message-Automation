import { decryptSecret } from "@support-automation/db";
import { metaPlatformAppSecret } from "@support-automation/shared";
import { platformPrisma, prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import { metaGraph, type FetchImpl } from "./providerApi.js";

/**
 * One-click (PLATFORM) Meta connections, checked on a schedule (docs/meta-integration/03 §Health).
 * A Page token taken from a long-lived user token does not expire on a date — it dies when the person
 * who authorised loses their Page role, changes their password, or removes the app — so there is no
 * refresh job (none exists for that token type). Instead, each connection is asked at most every
 * CHECK_EVERY_MS whether:
 *   - Meta still accepts its Page token (no → NEEDS_RECONNECT: nothing is sent with it again, and the
 *     page shows "Reconnect with Facebook");
 *   - an Instagram account is still linked to its Page;
 *   - the Page is still subscribed to the platform app — Meta unsubscribes an app after an hour of
 *     failed webhook deliveries. It is subscribed again once; if Meta refuses, the connection reads
 *     ERROR with the reason.
 * A network failure or a Meta outage changes no status; it is simply tried again next time.
 *
 * Bounded: at most CHECKS_PER_PROJECT_PER_TICK calls-worth of connections per project per tick, and
 * nothing at all unless the platform app is configured. It also expires abandoned "Connect with
 * Facebook" attempts, wiping any user token they still held.
 */

const LOOP_NAME = "meta-connection-health";
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
const CHECKS_PER_PROJECT_PER_TICK = 10;
const REVOKED = "Facebook no longer accepts this connection's access (the person who connected it lost their Page role, changed their password or removed the app). Reconnect with Facebook.";

export function startMetaConnectionHealthProcessor(intervalMs = 5 * 60_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void runMetaHealthTick()
      .catch((err) => console.error("[channels] unexpected error in the Meta connection health check", err))
      .finally(() => {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

export async function runMetaHealthTick(now: Date = new Date(), fetchImpl: FetchImpl = fetch, env: Record<string, string | undefined> = process.env): Promise<void> {
  // Abandoned attempts, in every project: a user token never outlives its 30-minute choice window.
  await platformPrisma.metaOAuthSession.updateMany({
    where: { status: { in: ["STARTED", "AUTHORIZED"] }, expiresAt: { lt: now } },
    data: { status: "EXPIRED", userTokenCiphertext: null, completedAt: now },
  });
  const appSecret = metaPlatformAppSecret(env);
  if (!appSecret) return;
  await forEachProject(LOOP_NAME, async () => {
    if (!(await projectHasFeature("OMNICHANNEL"))) return;
    const due = await prisma.channelConnection.findMany({
      where: {
        authMode: "PLATFORM",
        status: { in: ["CONNECTED", "ERROR"] },
        accessTokenCiphertext: { not: null },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - CHECK_EVERY_MS) } }],
      },
      orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      take: CHECKS_PER_PROJECT_PER_TICK,
      select: { id: true, type: true, name: true, status: true, appId: true, pageId: true, externalAccountId: true, accessTokenCiphertext: true },
    });
    for (const connection of due) await checkConnection(connection, appSecret, now, fetchImpl);
  });
}

type DueConnection = {
  id: string;
  type: "MESSENGER" | "INSTAGRAM" | "TELEGRAM";
  name: string;
  status: "CONNECTED" | "ERROR" | "SETUP_REQUIRED" | "NEEDS_RECONNECT" | "DISCONNECTED";
  appId: string | null;
  pageId: string | null;
  externalAccountId: string | null;
  accessTokenCiphertext: string | null;
};

export async function checkConnection(c: DueConnection, appSecret: string, now: Date, fetchImpl: FetchImpl): Promise<void> {
  const settle = async (status: DueConnection["status"], lastError: string | null) => {
    await prisma.channelConnection.update({ where: { id: c.id }, data: { status, lastCheckedAt: now, lastError, lastErrorAt: lastError ? now : null } });
    if (status !== c.status) {
      await logSystemEvent(status === "CONNECTED" ? "INFO" : "WARN", "channels", `Connection health: ${c.name} is now ${status}`, { reason: lastError }, { targetType: "ChannelConnection", targetId: c.id });
    }
  };
  /** Transient: nothing is known, so nothing changes — the check is simply due again later. */
  const later = () => prisma.channelConnection.update({ where: { id: c.id }, data: { lastCheckedAt: now } });

  if (!c.pageId || !c.accessTokenCiphertext) return settle("NEEDS_RECONNECT", REVOKED);
  let token: string;
  try {
    token = decryptSecret(c.accessTokenCiphertext);
  } catch {
    return settle("NEEDS_RECONNECT", "The saved access could not be read (the server's encryption key changed). Reconnect with Facebook.");
  }

  const page = await metaGraph<{ id: string; category?: string }>("GET", "/me", { fields: "id,category" }, { token, appSecret }, fetchImpl);
  if (!page.ok) {
    if (page.error.needsReauth) return settle("NEEDS_RECONNECT", REVOKED);
    if (page.error.retryable) return void (await later());
    return settle("ERROR", page.error.message);
  }
  if (page.data.id !== c.pageId) return settle("NEEDS_RECONNECT", "The saved access belongs to a different Page. Reconnect with Facebook.");

  if (c.type === "INSTAGRAM") {
    const ig = await metaGraph<{ instagram_business_account?: { id: string } }>("GET", `/${encodeURIComponent(c.pageId)}`, { fields: "instagram_business_account{id}" }, { token, appSecret }, fetchImpl);
    if (!ig.ok) return ig.error.retryable ? void (await later()) : settle(ig.error.needsReauth ? "NEEDS_RECONNECT" : "ERROR", ig.error.needsReauth ? REVOKED : ig.error.message);
    if (ig.data.instagram_business_account?.id !== c.externalAccountId) return settle("ERROR", "The Instagram account is no longer linked to its Facebook Page. Link it again in Meta Business Suite, then reconnect.");
  }

  const subs = await metaGraph<{ data?: Array<{ id?: string }> }>("GET", `/${encodeURIComponent(c.pageId)}/subscribed_apps`, {}, { token, appSecret }, fetchImpl);
  if (!subs.ok) return subs.error.retryable ? void (await later()) : settle("ERROR", subs.error.message);
  if (!(subs.data.data ?? []).some((app) => app.id && app.id === c.appId)) {
    const again = await metaGraph<{ success?: boolean }>(
      "POST",
      `/${encodeURIComponent(c.pageId)}/subscribed_apps`,
      { subscribed_fields: "messages,message_echoes,message_deliveries,message_reads" },
      { token, appSecret },
      fetchImpl,
    );
    if (!again.ok) return settle("ERROR", `The Page is no longer subscribed to the app, and Facebook refused to subscribe it again: ${again.error.message}`);
    await logSystemEvent("WARN", "channels", `Connection health: ${c.name} was unsubscribed at Facebook and has been subscribed again`, {}, { targetType: "ChannelConnection", targetId: c.id });
  }
  return settle("CONNECTED", null);
}
