import {
  loadRoutingPool,
  noteUnrouted,
  readRoutingSettings,
  routeConversation,
  type RouteOutcome,
  type RoutingPoolMember,
  type RoutingSettingsRecord,
  type RoutingTargetRef,
} from "@support-automation/db";
import { ROUTING_LOOKBACK_HOURS, routingCovers, whatsAppConversationType, type RoutingConversationKind } from "@support-automation/shared";
import { prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { currentProjectId, forEachProject, projectIsOperating } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";

/**
 * Automatic conversation routing in the worker (AUTO_ROUTING.md; features AUTO_ROUTING + UNIFIED_INBOX_V3, both
 * off by default). Two entry points, both inside the current project and both no-ops unless both features are
 * on, the project is operating (never SUSPENDED / ARCHIVED / held) and its routing settings are switched on:
 *   - the message hooks: a customer's message in a channel conversation or a WhatsApp chat gives that
 *     conversation to one person, when it is OPEN and nobody has it;
 *   - the 60 s sweep: does the same for anything still OPEN and unassigned that a customer wrote in within the
 *     last day and since routing was switched on (nobody was eligible then, the worker restarted, …).
 * Who and how is packages/db `routeConversation`: one transaction under the project's routing lock. Never an
 * existing assignee replaced, never a group with an owner, never somebody who failed a check — nobody eligible
 * leaves it unassigned and records why (counts only).
 */

const LOOP_NAME = "auto-routing";
const SWEEP_BATCH = 100;

/** The project's routing settings when routing should act now, else null. */
async function activeRouting(): Promise<RoutingSettingsRecord | null> {
  if (!(await projectHasFeature("AUTO_ROUTING")) || !(await projectHasFeature("UNIFIED_INBOX_V3"))) return null;
  if (!(await projectIsOperating(currentProjectId()))) return null;
  const settings = await readRoutingSettings(prisma);
  return settings?.enabled ? settings : null;
}

/** The earliest customer message routing acts on: within the look-back, and never before it was switched on. */
function routedSince(settings: RoutingSettingsRecord, now: Date): Date {
  const lookback = now.getTime() - ROUTING_LOOKBACK_HOURS * 3_600_000;
  return new Date(Math.max(lookback, settings.enabledAt?.getTime() ?? now.getTime()));
}

/** Whether the kind's own module is on (a person can only answer from WhatsApp Chat or All Conversations). */
async function moduleOn(kind: RoutingConversationKind): Promise<boolean> {
  return kind === "WHATSAPP_PERSONAL" || kind === "WHATSAPP_GROUP" ? projectHasFeature("WHATSAPP_CHAT") : projectHasFeature("OMNICHANNEL");
}

async function routeOne(settings: RoutingSettingsRecord, target: RoutingTargetRef, kind: RoutingConversationKind, now: Date, pool?: RoutingPoolMember[]): Promise<RouteOutcome> {
  const projectId = currentProjectId();
  const result = await routeConversation(prisma, {
    projectId,
    target,
    kind,
    settings,
    method: settings.method,
    pool: pool ?? (await loadRoutingPool(prisma, projectId, settings, now)),
    via: "AUTOMATIC",
    actorId: null,
    now,
  });
  if (result.outcome === "NOBODY_ELIGIBLE") await noteUnrouted(prisma, result.reasons, now);
  return result;
}

/** A group with an owner (on any of our numbers' copies) is never routed: its owner is set on the Groups page. */
async function groupHasOwner(chatId: string): Promise<boolean> {
  return (await prisma.whatsAppGroup.count({ where: { whatsappGroupId: chatId, assignedTeamMemberId: { not: null } } })) > 0;
}

/**
 * The channel hook (inboundProcessor.ts, after a customer's message is stored and the lifecycle applied).
 * Direct conversations only. Never throws: routing must not cost a message its processing.
 */
export async function routeChannelConversationOnMessage(conversationId: string, at: Date, now: Date = new Date()): Promise<void> {
  try {
    const settings = await activeRouting();
    if (!settings || at < routedSince(settings, now)) return;
    const c = await prisma.channelConversation.findFirst({ where: { id: conversationId }, select: { type: true, kind: true, status: true, assignedUserId: true } });
    if (!c || c.kind !== "DIRECT" || c.status !== "OPEN" || c.assignedUserId || !routingCovers(settings, c.type)) return;
    await routeOne(settings, { kind: "channel", conversationId }, c.type, now);
  } catch (err) {
    console.error("[auto-routing] could not route a channel conversation", err);
  }
}

/**
 * The WhatsApp hook (persistIncomingMessage, after the Inbox V3 hook), for a customer's message only. Personal
 * chats by the WHATSAPP_PERSONAL scope; groups only when groups are switched on separately and the group has no
 * owner. Never throws.
 */
export async function routeWhatsAppConversationOnMessage(input: { accountId: string; chatId: string; at: Date; fromCustomer: boolean }, now: Date = new Date()): Promise<void> {
  try {
    if (!input.fromCustomer) return;
    const type = whatsAppConversationType(input.chatId);
    if (!type) return;
    const kind: RoutingConversationKind = type === "GROUP" ? "WHATSAPP_GROUP" : "WHATSAPP_PERSONAL";
    const settings = await activeRouting();
    if (!settings || !routingCovers(settings, kind) || input.at < routedSince(settings, now) || !(await moduleOn(kind))) return;
    if (kind === "WHATSAPP_GROUP" && (await groupHasOwner(input.chatId))) return;
    await routeOne(settings, { kind: "whatsapp", accountId: input.accountId, chatId: input.chatId }, kind, now);
  } catch (err) {
    console.error("[auto-routing] could not route a WhatsApp conversation", err);
  }
}

/**
 * One sweep of the current project: everything still OPEN and unassigned that routing covers and a customer
 * wrote in since `routedSince`, oldest first, at most SWEEP_BATCH of each kind. After a "nobody eligible" the
 * rest of that kind waits for the next pass. Returns how many it assigned.
 */
export async function runRoutingSweep(now: Date = new Date()): Promise<number> {
  const settings = await activeRouting();
  if (!settings) return 0;
  const projectId = currentProjectId();
  const since = routedSince(settings, now);
  const targets: Array<{ target: RoutingTargetRef; kind: RoutingConversationKind }> = [];

  const channelTypes = settings.channels.filter((c) => c !== "WHATSAPP_PERSONAL") as Array<"WEBCHAT" | "MESSENGER" | "INSTAGRAM" | "TELEGRAM">;
  if (channelTypes.length && (await moduleOn("WEBCHAT"))) {
    const rows = await prisma.channelConversation.findMany({
      where: { status: "OPEN", assignedUserId: null, kind: "DIRECT", type: { in: channelTypes }, lastInboundAt: { gte: since } },
      orderBy: { lastInboundAt: "asc" },
      take: SWEEP_BATCH,
      select: { id: true, type: true },
    });
    for (const r of rows) targets.push({ target: { kind: "channel", conversationId: r.id }, kind: r.type });
  }
  if (routingCovers(settings, "WHATSAPP_PERSONAL") && (await moduleOn("WHATSAPP_PERSONAL"))) {
    // A customer wrote in a one-to-one chat; the chat has no state row, or one that is OPEN and unassigned.
    const rows = await prisma.$queryRaw<Array<{ accountId: string; chatId: string }>>`
      SELECT m."accountId", m."chatId"
      FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."groupId" IS NULL AND m."direction" = 'INCOMING' AND m."isFromTeamMember" = false
        AND m."timestampWa" >= ${since} AND (m."chatId" LIKE '%@c.us' OR m."chatId" LIKE '%@lid')
        AND NOT EXISTS (
          SELECT 1 FROM "WhatsAppConversationState" s
          WHERE s."projectId" = ${projectId} AND s."accountId" = m."accountId" AND s."chatId" = m."chatId"
            AND (s."assignedUserId" IS NOT NULL OR s."status" <> 'OPEN'))
      GROUP BY m."accountId", m."chatId"
      ORDER BY max(m."timestampWa") ASC
      LIMIT ${SWEEP_BATCH}`;
    for (const r of rows) targets.push({ target: { kind: "whatsapp", accountId: r.accountId, chatId: r.chatId }, kind: "WHATSAPP_PERSONAL" });
  }
  if (settings.includeWhatsAppGroups && (await moduleOn("WHATSAPP_GROUP"))) {
    // A customer wrote in an active group nobody owns (on any copy), and no copy of it has a person yet.
    const rows = await prisma.$queryRaw<Array<{ accountId: string; chatId: string }>>`
      SELECT m."accountId", m."chatId"
      FROM "Message" m
      JOIN "WhatsAppGroup" g ON g."id" = m."groupId" AND g."projectId" = ${projectId} AND g."isActive" = true
      WHERE m."projectId" = ${projectId} AND m."direction" = 'INCOMING' AND m."isFromTeamMember" = false
        AND m."timestampWa" >= ${since} AND m."chatId" LIKE '%@g.us'
        AND NOT EXISTS (
          SELECT 1 FROM "WhatsAppGroup" o
          WHERE o."projectId" = ${projectId} AND o."whatsappGroupId" = m."chatId" AND o."assignedTeamMemberId" IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM "WhatsAppConversationState" s
          WHERE s."projectId" = ${projectId} AND s."chatId" = m."chatId"
            AND (s."assignedUserId" IS NOT NULL OR (s."accountId" = m."accountId" AND s."status" <> 'OPEN')))
      GROUP BY m."accountId", m."chatId"
      ORDER BY max(m."timestampWa") ASC
      LIMIT ${SWEEP_BATCH}`;
    for (const r of rows) targets.push({ target: { kind: "whatsapp", accountId: r.accountId, chatId: r.chatId }, kind: "WHATSAPP_GROUP" });
  }
  if (targets.length === 0) return 0;

  const pool = await loadRoutingPool(prisma, projectId, settings, now);
  let assigned = 0;
  // Nobody eligible for one kind stays so for the rest of this pass (the pool and its permissions are per kind).
  const blocked = new Set<RoutingConversationKind>();
  for (const t of targets) {
    if (blocked.has(t.kind)) continue;
    const result = await routeOne(settings, t.target, t.kind, now, pool);
    if (result.outcome === "ASSIGNED") assigned++;
    if (result.outcome === "NOBODY_ELIGIBLE") blocked.add(t.kind);
  }
  return assigned;
}

export function startAutoRoutingProcessor(intervalMs = 60_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void forEachProject(LOOP_NAME, () => runRoutingSweep(new Date()))
      .catch((err) => console.error("[auto-routing] sweep failed", err))
      .finally(() => {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
