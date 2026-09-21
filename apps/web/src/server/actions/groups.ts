"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { SupportPriority } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { buildGroupWhere, isGroupFilterKey, type GroupFilterKey } from "@/lib/groupFilters";

const PRIORITIES: SupportPriority[] = ["P1", "P2", "P3"];

function isPriority(value: string): value is SupportPriority {
  return (PRIORITIES as string[]).includes(value);
}

/** Priority-Based Support Monitoring & Escalation config, lives on the group row itself (see schema.prisma). */
export async function setGroupPriority(
  groupId: string,
  formData: FormData,
): Promise<void> {
  await requireSession();
  const priorityRaw = String(formData.get("priority") ?? "");
  const assignedTeamMemberId = String(formData.get("assignedTeamMemberId") ?? "").trim() || null;
  const escalationMonitoringEnabled = formData.get("escalationMonitoringEnabled") === "on";

  await prisma.whatsAppGroup.update({
    where: { id: groupId },
    data: {
      priority: isPriority(priorityRaw) ? priorityRaw : null,
      assignedTeamMemberId,
      escalationMonitoringEnabled,
    },
  });
  revalidatePath("/groups");
}

export async function toggleGroupMonitoring(id: string): Promise<void> {
  await requireSession();
  const group = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id } });
  await prisma.whatsAppGroup.update({ where: { id }, data: { isMonitored: !group.isMonitored } });
  revalidatePath("/groups");
}

/**
 * Hybrid AI Automation's per-group opt-in (see WhatsAppGroup.aiAutomationEnabled and
 * apps/worker/src/aiFallback/eligibility.ts, which also requires isMonitored + the global AI
 * Settings gates before the fallback layer ever runs for this group). Lower-stakes than
 * toggleGroupMonitoring — disabling it only stops the AI fallback stage for this group and fails
 * safe to nothing happening, so unlike monitoring this doesn't need a confirmation step.
 */
export async function toggleGroupAiAutomation(id: string): Promise<void> {
  await requireSession();
  const group = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id } });
  await prisma.whatsAppGroup.update({ where: { id }, data: { aiAutomationEnabled: !group.aiAutomationEnabled } });
  revalidatePath("/groups");
}

/**
 * Marks a group as a testing group, exempting it from the anti-spam THROTTLES so every message and
 * rule type can be exercised back-to-back — no cooldowns, no per-client or global rate limits, no
 * randomised reply delay, and rule types SAFE_AUTO_REPLY would otherwise hold back.
 *
 * It lifts throttles only. The kill switch, MANUAL_ONLY, the monitored-group requirement, group
 * membership verification, the outbound queue, idempotency, account isolation and loop prevention
 * all stay fully active — that is this project's own written policy for test-group testing, and it
 * is what keeps a test group from becoming a way around the safety layer.
 *
 * Higher stakes than the AI toggle above, which fails safe to nothing happening: this one makes
 * MORE messages go out, on the same WhatsApp number that serves every real customer. Rate limits
 * are what stop that number being banned, so this belongs only on a group nobody outside the team
 * is in.
 */
export async function toggleGroupTestMode(id: string): Promise<void> {
  await requireSession();
  const group = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id } });
  await prisma.whatsAppGroup.update({ where: { id }, data: { testModeEnabled: !group.testModeEnabled } });
  revalidatePath("/groups");
}

/**
 * A hard "never let AI answer here", honoured under every AiAutomationScope — including
 * ALL_MONITORED_GROUPS. For the groups where a wrong answer costs more than a slow one.
 * Deliberately separate from aiAutomationEnabled above, which is an opt-IN and therefore
 * meaningless as a way to hold a group back once the scope has opted everything in.
 */
export async function toggleGroupAiExcluded(id: string): Promise<void> {
  await requireSession();
  const group = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id } });
  await prisma.whatsAppGroup.update({ where: { id }, data: { aiAutomationExcluded: !group.aiAutomationExcluded } });
  revalidatePath("/groups");
}

/**
 * Queues a "read this group's conversation and distil it into knowledge" run, instead of
 * waiting for the group's turn in the worker's hourly rotation. Same insert-a-WorkerCommand
 * hand-off every other on-demand worker action uses — the web app never calls the worker.
 * Deduplicated against an already-queued run for the same group so repeated clicks are free.
 */
export async function requestGroupKnowledgeBuild(id: string): Promise<void> {
  await requireSession();

  const existing = await prisma.workerCommand.findFirst({
    where: {
      type: "BUILD_GROUP_KNOWLEDGE",
      status: { in: ["PENDING", "PROCESSING"] },
      // Scoped to this group, not just the type. Checking by type alone meant a queued build for
      // group A silently swallowed the click on group B — the action returned successfully and
      // group B was never built, which is the worst kind of no-op.
      payload: { path: ["groupId"], equals: id },
    },
  });
  // The worker processes commands strictly serially, so a second queued build for the *same*
  // group would only repeat work that is already about to happen.
  if (!existing) {
    await prisma.workerCommand.create({ data: { type: "BUILD_GROUP_KNOWLEDGE", payload: { groupId: id } } });
  }

  revalidatePath("/groups");
}

export interface BulkMonitoringResult {
  requested: number;
  updated: number;
  alreadyInTargetState: number;
  notFound: number;
  error?: string;
}

export interface BulkAiAutomationResult extends BulkMonitoringResult {
  /** Groups left alone because they carry the hard "never let AI answer here" opt-out. */
  skippedExcluded: number;
}

/**
 * Single atomic updateMany — Postgres already guarantees this is all-or-nothing, so there's no
 * separate transaction to wrap it in. Idempotent by construction: setting isMonitored to a value
 * rows already have is a no-op write, and re-running with the same ids/enabled always converges
 * to the same end state. Never trusts the client's selection as-is beyond deduping/filtering it.
 *
 * ENGINEERING_STANDARDS.md §2: a bulk action must report a meaningful breakdown ("8 updated, 1
 * already monitored, 1 not found"), never just "Done" — so this reads current state first to
 * distinguish "genuinely changed" from "already correct" before writing.
 */
export async function bulkSetMonitoring(groupIds: string[], enabled: boolean): Promise<BulkMonitoringResult> {
  await requireSession();

  const dedupedIds = [...new Set(groupIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (dedupedIds.length === 0) {
    return { requested: 0, updated: 0, alreadyInTargetState: 0, notFound: 0, error: "No groups selected." };
  }

  const existing = await prisma.whatsAppGroup.findMany({
    where: { id: { in: dedupedIds } },
    select: { id: true, isMonitored: true },
  });
  const existingIds = new Set(existing.map((g) => g.id));
  const notFound = dedupedIds.filter((id) => !existingIds.has(id)).length;
  const alreadyInTargetState = existing.filter((g) => g.isMonitored === enabled).length;
  const idsToChange = existing.filter((g) => g.isMonitored !== enabled).map((g) => g.id);

  let updated = 0;
  if (idsToChange.length > 0) {
    const result = await prisma.whatsAppGroup.updateMany({
      where: { id: { in: idsToChange } },
      data: { isMonitored: enabled },
    });
    updated = result.count;
  }

  revalidatePath("/groups");
  return { requested: dedupedIds.length, updated, alreadyInTargetState, notFound };
}

/**
 * The same bulk treatment for the AI opt-in, which had none: with 1,847 groups and one switch per
 * row, turning AI on for a batch meant 1,847 individual clicks.
 *
 * Reports the same breakdown as bulkSetMonitoring and converges the same way — re-running with the
 * same selection is a no-op rather than a second write.
 *
 * `aiAutomationExcluded` is deliberately NOT cleared here. It is a hard "never let AI answer in
 * this group", set on the groups where a wrong answer costs the most, and a bulk enable is exactly
 * the sort of broad gesture that should not quietly override a specific one. Those rows are
 * reported as skipped instead, so the operator can see the exclusion held.
 */
export async function bulkSetAiAutomation(groupIds: string[], enabled: boolean): Promise<BulkAiAutomationResult> {
  await requireSession();

  const dedupedIds = [...new Set(groupIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (dedupedIds.length === 0) {
    return { requested: 0, updated: 0, alreadyInTargetState: 0, notFound: 0, skippedExcluded: 0, error: "No groups selected." };
  }

  const existing = await prisma.whatsAppGroup.findMany({
    where: { id: { in: dedupedIds } },
    select: { id: true, aiAutomationEnabled: true, aiAutomationExcluded: true },
  });
  const existingIds = new Set(existing.map((g) => g.id));
  const notFound = dedupedIds.filter((id) => !existingIds.has(id)).length;

  // Only meaningful when switching AI on: excluding a group already stops AI, so turning the
  // opt-in off there changes nothing anyone would notice.
  const excluded = enabled ? existing.filter((g) => g.aiAutomationExcluded) : [];
  const eligible = existing.filter((g) => !enabled || !g.aiAutomationExcluded);

  const alreadyInTargetState = eligible.filter((g) => g.aiAutomationEnabled === enabled).length;
  const idsToChange = eligible.filter((g) => g.aiAutomationEnabled !== enabled).map((g) => g.id);

  let updated = 0;
  if (idsToChange.length > 0) {
    const result = await prisma.whatsAppGroup.updateMany({
      where: { id: { in: idsToChange } },
      data: { aiAutomationEnabled: enabled },
    });
    updated = result.count;
  }

  revalidatePath("/groups");
  return {
    requested: dedupedIds.length,
    updated,
    alreadyInTargetState,
    notFound,
    skippedExcluded: excluded.length,
  };
}

/**
 * A ceiling on one widened selection. This deployment has ~1,848 groups, so it is not reachable
 * today — it exists so that a roster an order of magnitude larger cannot turn one checkbox into an
 * unbounded id payload. Truncation is REPORTED rather than silent: a selection that quietly
 * stopped short would have the operator acting on a set they believe is complete.
 */
const MAX_SELECT_ALL_GROUP_IDS = 5000;

/**
 * Every group id matching the list's current search and filter chip — the server half of
 * "select all 1,798 matching", which a header checkbox cannot do on its own because the browser
 * only ever holds the page it rendered.
 *
 * Returns IDS rather than taking the filter into each bulk action, deliberately. The two bulk
 * actions already read current state and report a breakdown against a concrete id list, and
 * keeping one code path means the widened selection cannot develop its own reporting or its own
 * bugs. It also keeps the operation auditable: what gets written is exactly the set the operator
 * was shown a count of.
 *
 * The `where` comes from `lib/groupFilters`, the same builder the page itself uses, so the ids
 * returned here cannot describe a different set than the one on screen.
 */
export async function selectAllMatchingGroupIds(
  search: string,
  filter: string,
): Promise<{ ids: string[]; truncated: boolean }> {
  await requireSession();
  const safeFilter: GroupFilterKey = isGroupFilterKey(filter) ? filter : "all";

  const rows = await prisma.whatsAppGroup.findMany({
    where: buildGroupWhere(typeof search === "string" ? search : "", safeFilter),
    select: { id: true },
    // Same order as the list, so "the first 5,000" means the first 5,000 the operator would see.
    orderBy: { name: "asc" },
    take: MAX_SELECT_ALL_GROUP_IDS + 1,
  });

  return {
    ids: rows.slice(0, MAX_SELECT_ALL_GROUP_IDS).map((row) => row.id),
    truncated: rows.length > MAX_SELECT_ALL_GROUP_IDS,
  };
}

/**
 * Queues an on-demand participant-count lookup for one group — never part of the bulk resync
 * path. ENGINEERING_STANDARDS.md §9: skip creating a duplicate if one is already in flight for
 * this exact group (clicking "Fetch" twice quickly shouldn't queue two lookups).
 */
export async function requestGroupParticipantCount(groupId: string): Promise<void> {
  await requireSession();
  const existing = await prisma.workerCommand.findFirst({
    where: {
      type: "GET_GROUP_PARTICIPANT_COUNT",
      status: { in: ["PENDING", "PROCESSING"] },
      payload: { path: ["groupId"], equals: groupId },
    },
  });
  if (existing) return;

  await prisma.workerCommand.create({
    data: { type: "GET_GROUP_PARTICIPANT_COUNT", payload: { groupId } },
  });
  revalidatePath("/groups");
}
