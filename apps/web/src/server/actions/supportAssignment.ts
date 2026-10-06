"use server";

import { revalidatePath } from "next/cache";
import { buildSupportAssignmentNotices, queueSupportAssignmentNotices } from "@support-automation/db";
import {
  cleanIgnoredKeywords,
  cleanIgnoredSenders,
  clampMinutes,
  qualifyCustomerMessage,
  SUPPORT_ASSIGNMENT_ESCALATION_BOUNDS,
  SUPPORT_ASSIGNMENT_SLA_BOUNDS,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { SUPPORT_ASSIGNMENT_MAX_SELECTION } from "@/server/supportAssignment";

/**
 * Support Assignment actions (SUPPORT_ASSIGNMENT.md).
 *
 * Every change to a case is a conditional update on the state the person was looking at, inside one
 * transaction with its history line and its WhatsApp notification — so two managers assigning the
 * same case at once cannot both win, a case is never assigned without its notification being queued
 * (or the reason it could not be), and a notification is never queued for an assignment that rolled
 * back. A failed notification never fails the assignment: it is recorded on the case instead.
 */

export interface AssignResult {
  error?: string;
  assigned?: number;
  reassigned?: number;
  /** Cases left as they were, with the reason — e.g. somebody else assigned it a moment earlier. */
  skipped?: { groupName: string; reason: string }[];
  /** Notifications that could not be queued (no phone number, muted, no connected account…). */
  notifySkipped?: number;
}

async function revalidateModule() {
  for (const path of ["/support-assignment/unanswered", "/support-assignment/mine", "/support-assignment/completed"]) {
    revalidatePath(await projectPath(path));
  }
}

/**
 * Assign the chosen cases to one person. An unassigned case is assigned; an assigned or overdue one
 * is REASSIGNED only when `reassign` is set (the dialog asks), with its history kept and a fresh
 * deadline. Anything already finished is left alone and reported.
 */
export async function assignSupportCases(input: { ids: string[]; memberId: string; reassign?: boolean }): Promise<AssignResult> {
  const granted = await checkPermission("support_assignment.assign");
  if ("denied" in granted) return { error: granted.denied };
  const userId = granted.session.userId;

  const settings = await prisma.supportAssignmentSettings.findUnique({ where: { id: "global" } });
  if (!settings?.enabled) return { error: "Support Assignment is switched off. Turn it on under Settings → Support Assignment first." };

  const ids = [...new Set((input.ids ?? []).filter((id) => typeof id === "string" && id))].slice(0, SUPPORT_ASSIGNMENT_MAX_SELECTION);
  if (ids.length === 0) return { error: "Choose at least one case." };

  const member = await prisma.internalTeamMember.findFirst({
    where: {
      id: input.memberId,
      status: "ACTIVE",
      ...(settings.assignableTeamIds.length ? { teamId: { in: settings.assignableTeamIds } } : {}),
    },
    select: { id: true, name: true },
  });
  if (!member) return { error: "That team member cannot be assigned: they are inactive, or not in a Team that takes assignments. Nothing was changed." };

  const result: Required<Omit<AssignResult, "error">> = { assigned: 0, reassigned: 0, skipped: [], notifySkipped: 0 };
  for (const id of ids) {
    const row = await prisma.supportAssignment.findFirst({
      where: { id },
      select: {
        id: true,
        status: true,
        closedAt: true,
        assignmentRound: true,
        assignedMemberId: true,
        group: { select: { name: true, isActive: true } },
        assignedMember: { select: { name: true } },
      },
    });
    if (!row) {
      result.skipped.push({ groupName: "(unknown case)", reason: "It no longer exists." });
      continue;
    }
    const groupName = row.group.name;
    if (row.closedAt || !["UNASSIGNED", "ASSIGNED", "OVERDUE"].includes(row.status)) {
      result.skipped.push({ groupName, reason: "It is already finished." });
      continue;
    }
    if (!row.group.isActive) {
      result.skipped.push({ groupName, reason: "The WhatsApp account is no longer in this group." });
      continue;
    }
    const isReassign = row.status !== "UNASSIGNED";
    if (isReassign && row.assignedMemberId === member.id) {
      result.skipped.push({ groupName, reason: `It is already ${member.name}'s.` });
      continue;
    }
    if (isReassign && !input.reassign) {
      result.skipped.push({ groupName, reason: `Already assigned to ${row.assignedMember?.name ?? "someone"}.` });
      continue;
    }

    const now = new Date();
    const outcome = await prisma.$transaction(async (tx) => {
      const changed = await tx.supportAssignment.updateMany({
        // The exact state the decision was made on: a concurrent assign, a completion or the SLA loop
        // marking it overdue makes this match nothing, and the person is told rather than overwritten.
        where: { id: row.id, status: row.status, assignmentRound: row.assignmentRound, closedAt: null },
        data: {
          status: "ASSIGNED",
          assignedMemberId: member.id,
          assignedAt: now,
          assignedByUserId: userId,
          assignmentRound: row.assignmentRound + 1,
          slaMinutes: settings.slaMinutes,
          dueAt: new Date(now.getTime() + settings.slaMinutes * 60_000),
          overdueAt: null,
          escalationLevel: 0,
          nextEscalationAt: null,
        },
      });
      if (changed.count === 0) return null;
      await tx.supportAssignmentEvent.create({
        data: {
          assignmentId: row.id,
          type: isReassign ? "REASSIGNED" : "ASSIGNED",
          at: now,
          actorUserId: userId,
          memberId: member.id,
          detail: isReassign
            ? `Reassigned from ${row.assignedMember?.name ?? "someone"} to ${member.name}. Due in ${settings.slaMinutes} minute(s).`
            : `Assigned to ${member.name}. Due in ${settings.slaMinutes} minute(s).`,
        },
      });
      return queueSupportAssignmentNotices(
        tx,
        await buildSupportAssignmentNotices(tx, {
          assignmentId: row.id,
          kind: isReassign ? "REASSIGNED" : "ASSIGNED",
          settings,
          now,
          actorUserId: userId,
          previousEmployee: isReassign ? row.assignedMember?.name ?? null : null,
        }),
      );
    });
    if (!outcome) {
      result.skipped.push({ groupName, reason: "It changed while you were deciding (assigned, answered or overdue). Refresh and try again." });
      continue;
    }
    if (isReassign) result.reassigned += 1;
    else result.assigned += 1;
    result.notifySkipped += outcome.skipped;
  }

  await logSystemEvent(
    "INFO",
    "support-assignment",
    `Assigned ${result.assigned} and reassigned ${result.reassigned} support case(s) to ${member.name}`,
    { memberId: member.id, requested: ids.length, skipped: result.skipped.length },
    { actorUserId: userId, targetType: "SupportAssignment" },
  );
  await revalidateModule();
  return result;
}

export interface CancelResult {
  error?: string;
  cancelled?: number;
  skipped?: number;
}

/**
 * Close cases that are not support work after all. Nothing about the conversation changes; the next
 * customer message opens a new case, exactly as Clear does on Messages → Unanswered groups.
 */
export async function cancelSupportCases(input: { ids: string[]; reason?: string }): Promise<CancelResult> {
  const granted = await checkPermission("support_assignment.assign");
  if ("denied" in granted) return { error: granted.denied };
  const userId = granted.session.userId;
  const ids = [...new Set((input.ids ?? []).filter((id) => typeof id === "string" && id))].slice(0, SUPPORT_ASSIGNMENT_MAX_SELECTION);
  if (ids.length === 0) return { error: "Choose at least one case." };
  const reason = input.reason?.trim().slice(0, 300) || null;
  const now = new Date();

  // One guarded update per case, and a history line only where it actually cancelled: a case that
  // completes in the same moment keeps its completion and gets no "Cancelled" line.
  let cancelled = 0;
  for (const id of ids) {
    const done = await prisma.$transaction(async (tx) => {
      const { count } = await tx.supportAssignment.updateMany({
        where: { id, closedAt: null, status: { in: ["UNASSIGNED", "ASSIGNED", "OVERDUE"] } },
        data: { status: "CANCELLED", closedAt: now, nextEscalationAt: null, closeReason: reason ?? "Cancelled by an admin." },
      });
      if (count === 1) {
        await tx.supportAssignmentEvent.create({ data: { assignmentId: id, type: "CANCELLED", at: now, actorUserId: userId, detail: reason ?? "Cancelled by an admin." } });
      }
      return count;
    });
    cancelled += done;
  }

  await logSystemEvent(
    "INFO",
    "support-assignment",
    `Cancelled ${cancelled} support case(s)`,
    { ids: ids.slice(0, 200), reason },
    { actorUserId: userId, targetType: "SupportAssignment" },
  );
  await revalidateModule();
  return { cancelled, skipped: ids.length - cancelled };
}

export interface SettingsState {
  error?: string;
  saved?: boolean;
  /** Open waits brought in when the module was switched on. */
  imported?: number;
}

const flag = (formData: FormData, name: string) => formData.get(name) === "on";

/** Settings → Support Assignment. Every value is validated and clamped here, never trusted from the form. */
export async function saveSupportAssignmentSettings(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const granted = await checkPermission("support_assignment.manage");
  if ("denied" in granted) return { error: granted.denied };
  const userId = granted.session.userId;

  const teamIds = [...new Set(formData.getAll("assignableTeamIds").map(String).filter(Boolean))];
  const adminIds = [...new Set(formData.getAll("adminMemberIds").map(String).filter(Boolean))];
  const groupIds = [...new Set(formData.getAll("managerGroupIds").map(String).filter(Boolean))];

  const [teams, admins, groups] = await Promise.all([
    teamIds.length ? prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true } }) : [],
    adminIds.length ? prisma.internalTeamMember.findMany({ where: { id: { in: adminIds } }, select: { id: true } }) : [],
    groupIds.length ? prisma.whatsAppGroup.findMany({ where: { whatsappGroupId: { in: groupIds } }, select: { whatsappGroupId: true }, distinct: ["whatsappGroupId"] }) : [],
  ]);
  if (teams.length !== teamIds.length) return { error: "One of those Teams is not in this project. Nothing was saved." };
  if (admins.length !== adminIds.length) return { error: "One of those admins is not a team member in this project. Nothing was saved." };
  if (groups.length !== groupIds.length) return { error: "One of those manager groups is not a group of this project. Nothing was saved." };

  const before = await prisma.supportAssignmentSettings.findUnique({ where: { id: "global" } });
  const data = {
    enabled: flag(formData, "enabled"),
    slaMinutes: clampMinutes(Number(formData.get("slaMinutes")), SUPPORT_ASSIGNMENT_SLA_BOUNDS, before?.slaMinutes ?? 15),
    escalationEnabled: flag(formData, "escalationEnabled"),
    escalationAfterMinutes: clampMinutes(Number(formData.get("escalationAfterMinutes")), SUPPORT_ASSIGNMENT_ESCALATION_BOUNDS, before?.escalationAfterMinutes ?? 15),
    ignoredKeywords: cleanIgnoredKeywords(String(formData.get("ignoredKeywords") ?? "").split(/\r?\n|,/)),
    ignoredSenders: cleanIgnoredSenders([
      ...formData.getAll("ignoredSenders").map(String),
      ...String(formData.get("ignoredSendersText") ?? "").split(/\r?\n|,/),
    ]),
    assignableTeamIds: teamIds,
    managerGroupIds: groupIds,
    adminMemberIds: adminIds,
    notifyEmployeeOnAssign: flag(formData, "notifyEmployeeOnAssign"),
    notifyEmployeeOnReassign: flag(formData, "notifyEmployeeOnReassign"),
    notifyManagerOnOverdue: flag(formData, "notifyManagerOnOverdue"),
    notifyAdminOnOverdue: flag(formData, "notifyAdminOnOverdue"),
    notifyAdminOnEscalation: flag(formData, "notifyAdminOnEscalation"),
    notifyAdminOnCompletion: flag(formData, "notifyAdminOnCompletion"),
    updatedById: userId,
  };
  await prisma.supportAssignmentSettings.upsert({ where: { id: "global" }, update: data, create: { id: "global", ...data } });

  const switchedOn = data.enabled && !before?.enabled;
  const imported = switchedOn ? await importOpenWaits(data) : 0;

  await logSystemEvent(
    "INFO",
    "support-assignment",
    switchedOn ? `Support Assignment switched on; ${imported} open wait(s) brought in` : "Support Assignment settings saved",
    {
      enabled: data.enabled,
      slaMinutes: data.slaMinutes,
      escalationEnabled: data.escalationEnabled,
      escalationAfterMinutes: data.escalationAfterMinutes,
      ignoredKeywords: data.ignoredKeywords.length,
      ignoredSenders: data.ignoredSenders.length,
      assignableTeamIds: teamIds,
      managerGroupIds: groupIds,
      adminMemberIds: adminIds,
    },
    { actorUserId: userId, targetType: "SupportAssignmentSettings" },
  );
  revalidatePath(await projectPath("/support-assignment/settings"));
  await revalidateModule();
  return { saved: true, imported };
}

/** The most waits brought in at once when the module is switched on. */
const IMPORT_LIMIT = 5000;

/**
 * Switching the module on brings in the waits that are open right now, so the list is not empty
 * until every waiting customer happens to write again. One case per WhatsApp group (the earliest
 * open wait across our accounts), qualified on the wait's first and latest customer messages — the
 * only ones the wait records. A group that already has a current case is left alone, so pressing
 * Save again never doubles anything.
 */
async function importOpenWaits(settings: { ignoredKeywords: string[]; ignoredSenders: string[] }): Promise<number> {
  const episodes = await prisma.supportResponseEpisode.findMany({
    where: { status: "UNANSWERED", group: { isActive: true } },
    orderBy: { firstIncomingAt: "asc" },
    take: IMPORT_LIMIT,
    select: {
      id: true,
      accountId: true,
      groupId: true,
      firstIncomingAt: true,
      incomingMessageCount: true,
      group: { select: { whatsappGroupId: true } },
      firstIncomingMessage: { select: { id: true, body: true, senderPhone: true, timestampWa: true, media: { select: { id: true } } } },
      latestIncomingMessage: { select: { id: true, body: true, senderPhone: true, timestampWa: true, media: { select: { id: true } } } },
    },
  });
  const current = new Set(
    (await prisma.supportAssignment.findMany({ where: { closedAt: null }, select: { whatsappGroupId: true } })).map((c) => c.whatsappGroupId),
  );

  let imported = 0;
  for (const episode of episodes) {
    const whatsappGroupId = episode.group.whatsappGroupId;
    if (current.has(whatsappGroupId)) continue;
    current.add(whatsappGroupId);

    const candidates = [episode.firstIncomingMessage, episode.latestIncomingMessage].filter((m): m is NonNullable<typeof m> => m !== null);
    const qualifying = candidates.find(
      (m) => qualifyCustomerMessage({ body: m.body, hasMedia: m.media !== null, senderPhone: m.senderPhone }, settings).qualifies,
    );
    try {
      await prisma.$transaction(async (tx) => {
        const created = await tx.supportAssignment.create({
          data: {
            episodeId: episode.id,
            accountId: episode.accountId,
            groupId: episode.groupId,
            whatsappGroupId,
            status: qualifying ? "UNASSIGNED" : "IGNORED",
            firstMessageId: qualifying?.id ?? null,
            firstMessageAt: qualifying?.timestampWa ?? null,
            ignoredMessageCount: qualifying ? 0 : episode.incomingMessageCount,
          },
          select: { id: true },
        });
        await tx.supportAssignmentEvent.create({
          data: {
            assignmentId: created.id,
            type: qualifying ? "OPENED" : "IGNORED",
            at: episode.firstIncomingAt,
            detail: "Already waiting when Support Assignment was switched on.",
          },
        });
      });
      imported += 1;
    } catch (err) {
      // P2002: the worker opened this group's case at the same moment. Its case stands.
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
  }
  return imported;
}
