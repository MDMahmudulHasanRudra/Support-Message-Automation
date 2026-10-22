import { prisma as globalPrisma } from "@support-automation/db";
import { subscriptionState, type SaasSubscriptionState } from "@support-automation/shared";

/**
 * Central monitoring for the RELQIVO platform (SAAS_PLATFORM_PLAN.md §12). Two different questions,
 * kept apart on purpose because every customer shares ONE deployment:
 *   - PLATFORM health: the one worker, its loops, the shared queues and the database. A problem here
 *     affects every customer at once.
 *   - CUSTOMER health: one customer's own WhatsApp numbers, sends, data collection and usage.
 * Everything here is a count or a timestamp from tables the software already keeps — never a message
 * body, never a conversation. Read with the unscoped client: only platform operators see it.
 */

const DAY = 24 * 60 * 60_000;

export interface PlatformHealth {
  /** When the worker last reported in, and whether that is recent. */
  workerHeartbeatAt: string | null;
  workerStale: boolean;
  workerStartedAt: string | null;
  /** Loops whose last finished tick is well overdue (a wedged loop). */
  stalledLoops: Array<{ name: string; lastTickAt: string | null }>;
  outboundPending: number;
  failedSends24h: number;
  failedNotifications24h: number;
  failedCommands24h: number;
  openCollectionGaps: number;
  whatsapp: { total: number; connected: number; needsPhone: number; down: number };
}

export async function platformHealth(now = new Date()): Promise<PlatformHealth> {
  const since = new Date(now.getTime() - DAY);
  const [snapshot, newestHeartbeat, outboundPending, failedSends24h, failedNotifications24h, failedCommands24h, openCollectionGaps, accounts] = await Promise.all([
    globalPrisma.workerHealthSnapshot.findUnique({ where: { id: "global" } }),
    globalPrisma.whatsAppAccount.findFirst({ where: { lastHeartbeatAt: { not: null } }, orderBy: { lastHeartbeatAt: "desc" }, select: { lastHeartbeatAt: true } }),
    globalPrisma.outboundMessage.count({ where: { status: { in: ["PENDING", "PROCESSING", "RATE_LIMITED"] } } }),
    globalPrisma.outboundMessage.count({ where: { status: "FAILED", updatedAt: { gte: since } } }),
    globalPrisma.notification.count({ where: { status: "FAILED", updatedAt: { gte: since } } }),
    globalPrisma.workerCommand.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
    globalPrisma.collectionGap.count({ where: { endedAt: null } }),
    globalPrisma.whatsAppAccount.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const heartbeat = newestHeartbeat?.lastHeartbeatAt ?? snapshot?.updatedAt ?? null;
  const loops = Array.isArray(snapshot?.loops) ? (snapshot.loops as Array<{ name?: string; intervalMs?: number; lastTickAt?: string | null }>) : [];
  const stalledLoops = loops
    .filter((l) => l.name && l.intervalMs && (!l.lastTickAt || now.getTime() - new Date(l.lastTickAt).getTime() > Math.max(l.intervalMs * 10, 10 * 60_000)))
    .map((l) => ({ name: l.name!, lastTickAt: l.lastTickAt ?? null }));
  return {
    workerHeartbeatAt: heartbeat?.toISOString() ?? null,
    workerStale: !heartbeat || now.getTime() - heartbeat.getTime() > 2 * 60_000,
    workerStartedAt: snapshot?.startedAt.toISOString() ?? null,
    stalledLoops,
    outboundPending,
    failedSends24h,
    failedNotifications24h,
    failedCommands24h,
    openCollectionGaps,
    whatsapp: whatsappCounts(accounts.map((a) => ({ status: a.status, count: a._count._all }))),
  };
}

function whatsappCounts(rows: Array<{ status: string; count: number }>) {
  const n = (statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).reduce((sum, r) => sum + r.count, 0);
  return {
    total: rows.reduce((sum, r) => sum + r.count, 0),
    connected: n(["CONNECTED"]),
    needsPhone: n(["AUTHENTICATION_REQUIRED", "SESSION_ERROR"]),
    down: n(["DISCONNECTED", "RECONNECTING", "ERROR"]),
  };
}

export interface CustomerHealth {
  customerId: string;
  name: string;
  isFounding: boolean;
  subscription: { planName: string; state: SaasSubscriptionState; accessUntil: string | null; held: boolean } | null;
  workspaces: number;
  people: number;
  whatsapp: { total: number; connected: number; needsPhone: number; down: number };
  messages24h: number;
  lastMessageAt: string | null;
  failedSends24h: number;
  failedNotifications24h: number;
  openCollectionGaps: number;
  mediaBytes: number;
  addressLive: boolean;
  /** Plain-language reasons this customer needs attention; empty when all is well. */
  attention: string[];
}

/**
 * One row per customer, plus the original installation when it has not been adopted yet. Every
 * figure is grouped by project and added up per customer, so a customer with several workspaces
 * is one row.
 */
export async function customersHealth(now = new Date()): Promise<CustomerHealth[]> {
  const since = new Date(now.getTime() - DAY);
  const week = new Date(now.getTime() - 7 * DAY);
  const [customers, projects, subscriptions, users, accounts, messages, failedSends, failedNotifications, gaps, media] = await Promise.all([
    globalPrisma.customer.findMany({ select: { id: true, name: true, isFounding: true, domains: { select: { status: true } } }, orderBy: { createdAt: "asc" } }),
    globalPrisma.project.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, customerId: true } }),
    globalPrisma.subscription.findMany({ where: { endedAt: null } }),
    globalPrisma.user.groupBy({ by: ["customerId"], where: { supportOperatorId: null, isActive: true }, _count: { _all: true } }),
    globalPrisma.whatsAppAccount.groupBy({ by: ["projectId", "status"], _count: { _all: true } }),
    globalPrisma.message.groupBy({ by: ["projectId"], where: { timestampWa: { gte: week } }, _max: { timestampWa: true } }),
    globalPrisma.outboundMessage.groupBy({ by: ["projectId"], where: { status: "FAILED", updatedAt: { gte: since } }, _count: { _all: true } }),
    globalPrisma.notification.groupBy({ by: ["projectId"], where: { status: "FAILED", updatedAt: { gte: since } }, _count: { _all: true } }),
    globalPrisma.collectionGap.groupBy({ by: ["projectId"], where: { endedAt: null }, _count: { _all: true } }),
    globalPrisma.messageMedia.groupBy({ by: ["projectId"], where: { status: "STORED" }, _sum: { sizeBytes: true } }),
  ]);
  const messages24 = await globalPrisma.message.groupBy({ by: ["projectId"], where: { timestampWa: { gte: since } }, _count: { _all: true } });

  const founding = customers.find((c) => c.isFounding)?.id ?? null;
  const ORIGINAL = "__original__";
  const ownerOf = (customerId: string | null) => customerId ?? founding ?? ORIGINAL;
  const projectOwner = new Map(projects.map((p) => [p.id, ownerOf(p.customerId)]));
  const rows = new Map<string, CustomerHealth>();
  const ensure = (id: string, name: string, isFounding: boolean, addressLive: boolean) => {
    if (!rows.has(id)) {
      rows.set(id, {
        customerId: id,
        name,
        isFounding,
        subscription: null,
        workspaces: 0,
        people: 0,
        whatsapp: { total: 0, connected: 0, needsPhone: 0, down: 0 },
        messages24h: 0,
        lastMessageAt: null,
        failedSends24h: 0,
        failedNotifications24h: 0,
        openCollectionGaps: 0,
        mediaBytes: 0,
        addressLive,
        attention: [],
      });
    }
    return rows.get(id)!;
  };
  for (const c of customers) ensure(c.id, c.name, c.isFounding, c.domains.some((d) => d.status === "ACTIVE" || d.status === "VERIFIED"));
  if (!founding && projects.some((p) => p.customerId === null)) ensure(ORIGINAL, "Original installation (not adopted yet)", true, false);

  for (const p of projects) {
    const row = rows.get(projectOwner.get(p.id)!);
    if (row) row.workspaces += 1;
  }
  for (const s of subscriptions) {
    const row = rows.get(s.customerId);
    if (!row) continue;
    const reading = subscriptionState(s, now);
    row.subscription = { planName: s.planName, state: reading.state, accessUntil: reading.accessUntil?.toISOString() ?? null, held: reading.held };
  }
  for (const u of users) {
    const row = rows.get(ownerOf(u.customerId));
    if (row) row.people += u._count._all;
  }
  const byProject = <T>(list: T[], key: (item: T) => string, apply: (row: CustomerHealth, item: T) => void) => {
    for (const item of list) {
      const owner = projectOwner.get(key(item));
      const row = owner ? rows.get(owner) : undefined;
      if (row) apply(row, item);
    }
  };
  byProject(accounts, (a) => a.projectId, (row, a) => {
    const add = whatsappCounts([{ status: a.status, count: a._count._all }]);
    row.whatsapp.total += add.total;
    row.whatsapp.connected += add.connected;
    row.whatsapp.needsPhone += add.needsPhone;
    row.whatsapp.down += add.down;
  });
  byProject(messages, (m) => m.projectId, (row, m) => {
    const at = m._max.timestampWa?.toISOString() ?? null;
    if (at && (!row.lastMessageAt || at > row.lastMessageAt)) row.lastMessageAt = at;
  });
  byProject(messages24, (m) => m.projectId, (row, m) => (row.messages24h += m._count._all));
  byProject(failedSends, (m) => m.projectId, (row, m) => (row.failedSends24h += m._count._all));
  byProject(failedNotifications, (m) => m.projectId, (row, m) => (row.failedNotifications24h += m._count._all));
  byProject(gaps, (g) => g.projectId, (row, g) => (row.openCollectionGaps += g._count._all));
  byProject(media, (m) => m.projectId, (row, m) => (row.mediaBytes += Number(m._sum.sizeBytes ?? 0)));

  for (const row of rows.values()) {
    const a = row.attention;
    if (row.subscription?.held) a.push("Suspended by its subscription — read-only, nothing is sent.");
    else if (row.subscription?.state === "PAST_DUE") a.push("Payment is due.");
    else if (row.subscription?.accessUntil && new Date(row.subscription.accessUntil).getTime() - now.getTime() < 7 * DAY) a.push("Renews within 7 days.");
    if (row.whatsapp.needsPhone > 0) a.push(`${row.whatsapp.needsPhone} WhatsApp number(s) need someone with the phone to link again.`);
    if (row.whatsapp.down > 0) a.push(`${row.whatsapp.down} WhatsApp number(s) not connected.`);
    if (row.whatsapp.connected > 0 && row.messages24h === 0) a.push("Connected, but no message stored in 24 hours.");
    if (row.openCollectionGaps > 0) a.push(`${row.openCollectionGaps} open collection gap(s).`);
    if (row.failedSends24h > 0) a.push(`${row.failedSends24h} failed send(s) in 24 hours.`);
    if (row.failedNotifications24h > 0) a.push(`${row.failedNotifications24h} failed alert(s) in 24 hours.`);
    if (!row.isFounding && row.customerId !== ORIGINAL && !row.addressLive) a.push("Its address is not verified yet.");
  }
  return [...rows.values()];
}

export async function customerHealth(customerId: string): Promise<CustomerHealth | null> {
  return (await customersHealth()).find((row) => row.customerId === customerId) ?? null;
}
