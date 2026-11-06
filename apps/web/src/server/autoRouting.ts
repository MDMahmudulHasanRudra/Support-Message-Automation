import { countOpenAssigned, loadRoutingPool, noteUnrouted, readRoutingSettings, routeConversation, type RoutingTargetRef } from "@support-automation/db";
import {
  decideRoutingEligibility,
  DEFAULT_ROUTING_SETTINGS,
  routingCovers,
  ROUTING_CHANNELS,
  whatsAppConversationType,
  type ConversationRef,
  type DutyNow,
  type RoutingConversationKind,
  type RoutingIneligibleReason,
  type RoutingSettingsValue,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { activeDisabledFeatures } from "@/server/projectFeatures";

/**
 * Automatic routing in the dashboard (AUTO_ROUTING.md): the settings, the read-only Routing panel and the
 * inbox's "Distribute evenly". Plain helpers; the Server Actions check the permission first. Who is eligible
 * and whom to pick are packages/db `loadRoutingPool` / `routeConversation` — the very code the worker routes
 * with — so the panel, a distribution and the automatic routing can never disagree.
 */

/** Both switches routing needs: its own feature and Inbox V3. */
export async function routingAvailable(): Promise<boolean> {
  const disabled = await activeDisabledFeatures();
  return !disabled.has("AUTO_ROUTING") && !disabled.has("UNIFIED_INBOX_V3");
}

export interface RoutingSettingsView extends RoutingSettingsValue {
  lastUnroutedAt: string | null;
  lastUnroutedReasons: Partial<Record<RoutingIneligibleReason, number>> | null;
}

export async function loadRoutingSettingsView(): Promise<RoutingSettingsView> {
  const [settings, note] = await Promise.all([
    readRoutingSettings(prisma),
    prisma.routingSettings.findFirst({ select: { lastUnroutedAt: true, lastUnroutedReasons: true } }),
  ]);
  const value: RoutingSettingsValue = settings ?? DEFAULT_ROUTING_SETTINGS;
  return {
    enabled: value.enabled,
    channels: value.channels,
    includeWhatsAppGroups: value.includeWhatsAppGroups,
    method: value.method,
    maxOpenPerAgent: value.maxOpenPerAgent,
    poolTeamIds: value.poolTeamIds,
    poolUserIds: value.poolUserIds,
    onlyOnDuty: value.onlyOnDuty,
    requireRecentlySeen: value.requireRecentlySeen,
    recentlySeenMinutes: value.recentlySeenMinutes,
    lastUnroutedAt: note?.lastUnroutedAt?.toISOString() ?? null,
    lastUnroutedReasons: (note?.lastUnroutedReasons as Partial<Record<RoutingIneligibleReason, number>> | null) ?? null,
  };
}

/**
 * Saves a validated value. Every Team must be this project's and every person must have access to it — a
 * pool is never allowed to name somebody from outside. Switching routing on stamps `enabledAt`, which is what
 * keeps an old backlog from being handed out by the sweep.
 */
export async function saveRoutingSettings(value: RoutingSettingsValue, actorId: string, now = new Date()): Promise<{ ok: true } | { error: string }> {
  const projectId = await activeProjectId();
  const [teams, access, existing] = await Promise.all([
    value.poolTeamIds.length ? prisma.team.findMany({ where: { id: { in: value.poolTeamIds } }, select: { id: true } }) : [],
    value.poolUserIds.length ? prisma.projectAccess.findMany({ where: { projectId, userId: { in: value.poolUserIds } }, select: { userId: true } }) : [],
    prisma.routingSettings.findFirst({ select: { enabled: true } }),
  ]);
  if (teams.length !== value.poolTeamIds.length) return { error: "One of the chosen Teams is not in this project any more. Reload and choose again." };
  if (access.length !== value.poolUserIds.length) return { error: "One of the chosen people has no access to this project. Reload and choose again." };
  const enabledAt = value.enabled && !existing?.enabled ? { enabledAt: now } : {};
  await prisma.routingSettings.upsert({
    where: { projectId },
    create: { projectId, ...value, ...(value.enabled ? { enabledAt: now } : {}), updatedById: actorId },
    update: { ...value, ...enabledAt, updatedById: actorId },
  });
  return { ok: true };
}

export interface RoutingPanelRow {
  userId: string;
  name: string;
  /** Eligible for at least one kind of conversation routing covers, or the reason they are not. */
  eligible: boolean;
  reason: RoutingIneligibleReason | null;
  /** Covered kinds this person could take (when eligible for some but not all). */
  onlyFor: RoutingConversationKind[] | null;
  openCount: number;
  duty: DutyNow | null;
}

/**
 * Who in the pool could be given a conversation right now, and why each other person could not — the same
 * facts and the same rule as a routing at this moment. Read-only.
 */
export async function loadRoutingPanel(now = new Date()): Promise<RoutingPanelRow[]> {
  const settings = (await readRoutingSettings(prisma)) ?? null;
  if (!settings) return [];
  const pool = await loadRoutingPool(prisma, await activeProjectId(), settings, now);
  const counts = await countOpenAssigned(prisma, pool.map((p) => p.userId));
  const covered: RoutingConversationKind[] = [...ROUTING_CHANNELS, "WHATSAPP_GROUP" as const].filter((k) => routingCovers(settings, k));
  // With nothing covered yet, say what the person could take on the channels at all.
  const kinds: RoutingConversationKind[] = covered.length ? covered : ["WEBCHAT"];
  return pool
    .map((p) => {
      const openCount = counts.get(p.userId) ?? 0;
      const results = kinds.map((k) => ({ k, d: decideRoutingEligibility({ ...p, canReply: p.replyByKind[k], openCount }, settings, now) }));
      const ok = results.filter((r) => r.d.eligible).map((r) => r.k);
      const firstRefusal = results.find((r) => !r.d.eligible)?.d;
      return {
        userId: p.userId,
        name: p.name,
        eligible: ok.length > 0,
        reason: ok.length === 0 && firstRefusal && !firstRefusal.eligible ? firstRefusal.reason : null,
        onlyFor: ok.length > 0 && ok.length < kinds.length ? ok : null,
        openCount,
        duty: p.duty,
      };
    })
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.name.localeCompare(b.name));
}

export interface DistributeResult {
  assigned: number;
  alreadyAssigned: number;
  skipped: number;
  notes: string[];
}

/**
 * "Distribute evenly": gives the selected conversations, one by one, to the eligible pool in turn — the same
 * eligibility, capacity and events as automatic routing, under the same lock, with the person who pressed it
 * as the actor. A conversation that already has somebody, is not Open, or is a WhatsApp group with an owner is
 * left alone. The caller has checked the person may change each conversation.
 */
export async function distributeConversations(refs: readonly ConversationRef[], actorId: string, now = new Date()): Promise<DistributeResult | { error: string }> {
  const settings = await readRoutingSettings(prisma);
  if (!settings || (settings.poolTeamIds.length === 0 && settings.poolUserIds.length === 0)) {
    return { error: "Choose who conversations go to first, in Settings → Automatic routing." };
  }
  const projectId = await activeProjectId();
  const pool = await loadRoutingPool(prisma, projectId, settings, now);
  const channelIds = refs.filter((r) => r.kind === "channel").map((r) => (r as { conversationId: string }).conversationId);
  const channelTypes = new Map(
    (channelIds.length ? await prisma.channelConversation.findMany({ where: { id: { in: channelIds } }, select: { id: true, type: true } }) : []).map((c) => [c.id, c.type]),
  );
  const groupChats = [...new Set(refs.filter((r) => r.kind === "whatsapp" && r.chatId.endsWith("@g.us")).map((r) => (r as { chatId: string }).chatId))];
  const owned = new Set(
    (groupChats.length ? await prisma.whatsAppGroup.findMany({ where: { whatsappGroupId: { in: groupChats }, assignedTeamMemberId: { not: null } }, select: { whatsappGroupId: true } }) : []).map(
      (g) => g.whatsappGroupId,
    ),
  );

  const result: DistributeResult = { assigned: 0, alreadyAssigned: 0, skipped: 0, notes: [] };
  const note = (s: string) => {
    if (!result.notes.includes(s)) result.notes.push(s);
  };
  const blocked = new Set<RoutingConversationKind>();
  for (const ref of refs) {
    let target: RoutingTargetRef;
    let kind: RoutingConversationKind;
    if (ref.kind === "channel") {
      const type = channelTypes.get(ref.conversationId);
      if (!type) {
        result.skipped++;
        continue;
      }
      target = { kind: "channel", conversationId: ref.conversationId };
      kind = type;
    } else {
      const type = whatsAppConversationType(ref.chatId);
      if (!type) {
        result.skipped++;
        continue;
      }
      if (type === "GROUP" && owned.has(ref.chatId)) {
        result.skipped++;
        note("WhatsApp groups with an owner were left alone: their owner is set on the Groups page.");
        continue;
      }
      target = { kind: "whatsapp", accountId: ref.accountId, chatId: ref.chatId };
      kind = type === "GROUP" ? "WHATSAPP_GROUP" : "WHATSAPP_PERSONAL";
    }
    if (blocked.has(kind)) {
      result.skipped++;
      continue;
    }
    const r = await routeConversation(prisma, { projectId, target, kind, settings, method: "ROUND_ROBIN", pool, via: "DISTRIBUTE", actorId, now });
    if (r.outcome === "ASSIGNED") result.assigned++;
    else if (r.outcome === "ALREADY_ASSIGNED") result.alreadyAssigned++;
    else {
      result.skipped++;
      if (r.outcome === "NOT_OPEN") note("Conversations that are not Open were left alone.");
      if (r.outcome === "NOBODY_ELIGIBLE") {
        blocked.add(kind);
        note("Nobody in the routing pool could take some of them right now (see Settings → Automatic routing).");
        await noteUnrouted(prisma, r.reasons, now);
      }
    }
  }
  return result;
}
