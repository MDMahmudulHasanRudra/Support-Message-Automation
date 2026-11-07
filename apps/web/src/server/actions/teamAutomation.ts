"use server";

import { revalidatePath } from "next/cache";
import { fillRosterFromPattern, matchTeamMembersToWhatsApp } from "@support-automation/db";
import { checkPermission, PERMISSION_DENIED_ERROR } from "@/server/authorize";
import { prisma } from "@/server/db";
import { logSystemEvent } from "@/server/logSystemEvent";
import { activeProjectId } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";
import { refreshFutureRoster } from "@/server/teamRoster";
import { memberIdentifiers, queueReattribution } from "@/server/reattribution";

/** Team automation (TEAM_AUTOMATION.md): everything here is on by default and needs setting up once at most. */

export interface TeamAutomationResult {
  error?: string;
  message?: string;
}

const refused = (denied: string) => ({ error: denied === PERMISSION_DENIED_ERROR ? "You do not have permission to change this." : denied });

async function revalidateTeam(): Promise<void> {
  for (const path of ["/team-members", "/team-management", "/team-management/schedule", "/team-management/settings", "/team-report"]) {
    revalidatePath(await projectPath(path));
  }
}

async function settingsWhere(data: Record<string, unknown>): Promise<void> {
  const projectId = await activeProjectId();
  await prisma.teamManagementSettings.upsert({
    where: { projectId },
    update: data,
    create: { id: `team-settings-${projectId}`, ...data },
  });
}

/**
 * "Match now": what the loop does every ten minutes, at once. The name match runs here so the person sees the
 * result; the contact list lives in the worker's browser, so that part follows within half a minute.
 */
export async function matchMembersNow(): Promise<TeamAutomationResult> {
  const access = await checkPermission("whatsapp.manage");
  if ("denied" in access) return refused(access.denied);
  await settingsWhere({ matchRequestedAt: new Date() });
  const matches = await matchTeamMembersToWhatsApp(prisma, await activeProjectId());
  for (const match of matches) {
    await logSystemEvent("INFO", "team-automation", "Matched a team member to their WhatsApp ID", {
      memberId: match.memberId,
      how: match.how,
      userId: access.session.userId,
    });
  }
  await revalidateTeam();
  return {
    message: matches.length
      ? `Matched ${matches.map((m) => m.memberName).join(", ")}. Their past work now shows in every report.`
      : "Checked. WhatsApp's contact list is being read too; anyone found will appear in about a minute.",
  };
}

/** The automatic match was wrong: forget it, and never match this member by themselves again. */
export async function undoAutomaticMatch(memberId: string): Promise<TeamAutomationResult> {
  const access = await checkPermission("whatsapp.manage");
  if ("denied" in access) return refused(access.denied);
  const member = await prisma.internalTeamMember.findUnique({ where: { id: memberId }, select: { id: true, name: true, phoneNumber: true, whatsappId: true } });
  if (!member) return { error: "That team member no longer exists." };
  await prisma.internalTeamMember.update({ where: { id: memberId }, data: { whatsappId: null, identityLinkSource: null, autoLinkOff: true } });
  await logSystemEvent("INFO", "team-automation", "Undid an automatic WhatsApp ID match", { memberId, userId: access.session.userId });
  await queueReattribution({ reason: `Automatic match undone: ${member.name}`, memberIds: [memberId], identifiers: memberIdentifiers(member), userId: access.session.userId });
  await revalidateTeam();
  return { message: `${member.name} is no longer matched. Link them by hand from the list below when you know who they are.` };
}

/**
 * The same person is on the roster twice, usually once by number and once from a group's history under their
 * private WhatsApp ID, which split their work between two rows. One row keeps both identifiers; the other is
 * retired, and the re-attribution moves its Duty History and activity across. Nothing is deleted.
 */
export async function mergeTeamMembers(keepId: string, otherId: string): Promise<TeamAutomationResult> {
  const access = await checkPermission("whatsapp.manage");
  if ("denied" in access) return refused(access.denied);
  if (keepId === otherId) return { error: "Choose two different team members." };
  const select = { id: true, name: true, phoneNumber: true, whatsappId: true, userId: true } as const;
  const [keep, other] = await Promise.all([
    prisma.internalTeamMember.findUnique({ where: { id: keepId }, select }),
    prisma.internalTeamMember.findUnique({ where: { id: otherId }, select }),
  ]);
  if (!keep || !other) return { error: "One of those team members no longer exists." };
  const typed = (m: { phoneNumber: string; whatsappId: string | null }) => m.phoneNumber.trim().startsWith("+");
  const realId = (m: { phoneNumber: string; whatsappId: string | null }) =>
    m.whatsappId && !(typed(m) && m.whatsappId.replace(/\D/g, "") === m.phoneNumber.replace(/\D/g, "")) ? m.whatsappId : null;
  const keepReal = realId(keep);
  const otherReal = realId(other) ?? (typed(other) ? null : other.phoneNumber.replace(/\D/g, "") || null);
  if (keepReal && otherReal && keepReal !== otherReal) {
    return { error: `${keep.name} and ${other.name} have different WhatsApp IDs, so they may be two people. Check their edit pages.` };
  }
  await prisma.$transaction(async (tx) => {
    // The retired row gives up its identifiers first: both are unique, and neither may match a message any more.
    await tx.internalTeamMember.update({
      where: { id: other.id },
      data: { status: "INACTIVE", whatsappId: null, userId: null, autoLinkOff: true, phoneNumber: `merged-${other.id.replace(/\d/g, "x")}` },
    });
    await tx.internalTeamMember.update({
      where: { id: keep.id },
      data: {
        ...(keepReal ? {} : otherReal ? { whatsappId: otherReal, identityLinkSource: null } : {}),
        ...(keep.userId ? {} : other.userId ? { userId: other.userId } : {}),
      },
    });
    await tx.whatsAppNumberOperator.updateMany({ where: { teamMemberId: other.id, endedAt: null }, data: { endedAt: new Date() } });
  });
  await logSystemEvent("INFO", "team-automation", "Merged two team member rows for one person", { keepId, otherId, userId: access.session.userId });
  await queueReattribution({
    reason: `Merged ${other.name} into ${keep.name}`,
    memberIds: [keep.id, other.id],
    identifiers: [...memberIdentifiers(keep), ...memberIdentifiers(other)],
    userId: access.session.userId,
  });
  await revalidateTeam();
  return { message: `Merged. ${keep.name} now has all of this person's work.` };
}

/** "Sync history" on one member: re-reads their messages into Duty History and the Activity Feed. */
export async function syncMemberHistory(memberId: string): Promise<TeamAutomationResult> {
  const access = await checkPermission("whatsapp.manage");
  if ("denied" in access) return refused(access.denied);
  const member = await prisma.internalTeamMember.findUnique({ where: { id: memberId }, select: { id: true, name: true, phoneNumber: true, whatsappId: true } });
  if (!member) return { error: "That team member no longer exists." };
  await queueReattribution({ reason: `History sync: ${member.name}`, memberIds: [memberId], identifiers: memberIdentifiers(member), userId: access.session.userId });
  await revalidateTeam();
  return { message: `Syncing ${member.name}'s history. The result appears under their name.` };
}

export async function setTeamAutomation(key: "autoLinkMembers" | "autoRoster", on: boolean): Promise<TeamAutomationResult> {
  const access = await checkPermission(key === "autoRoster" ? "team_management.manage" : "whatsapp.manage");
  if ("denied" in access) return refused(access.denied);
  await settingsWhere({ [key]: on });
  if (key === "autoRoster" && on) await fillRosterFromPattern(prisma);
  await revalidateTeam();
  return {};
}

/**
 * Who answers from this number on their own phone. A person's first period on a number starts "since before this
 * was recorded", so their earlier replies count too; somebody joining later counts from today, and somebody
 * leaving keeps what they already did.
 */
export async function setNumberOperators(accountId: string, memberIds: string[]): Promise<TeamAutomationResult> {
  const access = await checkPermission("whatsapp.manage");
  if ("denied" in access) return refused(access.denied);
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId }, select: { id: true, label: true } });
  if (!account) return { error: "That WhatsApp number no longer exists." };
  const wanted = new Set(memberIds);
  const known = await prisma.internalTeamMember.findMany({ where: { id: { in: [...wanted] } }, select: { id: true } });
  if (known.length !== wanted.size) return { error: "One of those team members no longer exists." };

  const now = new Date();
  const periods = await prisma.whatsAppNumberOperator.findMany({ where: { accountId }, select: { id: true, teamMemberId: true, endedAt: true } });
  const open = periods.filter((p) => p.endedAt === null);
  const leaving = open.filter((p) => !wanted.has(p.teamMemberId));
  const joining = [...wanted].filter((id) => !open.some((p) => p.teamMemberId === id));
  if (leaving.length === 0 && joining.length === 0) return {};
  const firstEver = periods.length === 0;
  await prisma.$transaction(async (tx) => {
    if (leaving.length) await tx.whatsAppNumberOperator.updateMany({ where: { id: { in: leaving.map((p) => p.id) } }, data: { endedAt: now } });
    for (const teamMemberId of joining) {
      await tx.whatsAppNumberOperator.create({ data: { accountId, teamMemberId, startedAt: firstEver ? null : now } });
    }
  });
  await logSystemEvent("INFO", "team-automation", "Changed who answers from a WhatsApp number's phone", {
    accountId,
    joined: joining.length,
    left: leaving.length,
    userId: access.session.userId,
  });
  await queueReattribution({
    reason: `Who answers from ${account.label} changed`,
    memberIds: [...joining, ...leaving.map((p) => p.teamMemberId)],
    identifiers: [],
    userId: access.session.userId,
  });
  await revalidateTeam();
  return { message: "Saved. Replies sent from this number's phone are credited from now on, in every report." };
}

/**
 * The one-time schedule: everybody chosen works this shift, with these days off, every week. The roster then fills
 * itself. Dates a manager already changed, and leave, are never touched.
 */
export async function applyWeeklySchedule(input: { shiftTemplateId: string; daysOff: number[]; memberIds: string[] }): Promise<TeamAutomationResult> {
  const access = await checkPermission("team_management.manage");
  if ("denied" in access) return refused(access.denied);
  const template = await prisma.shiftTemplate.findUnique({ where: { id: input.shiftTemplateId }, select: { id: true, isActive: true, name: true } });
  if (!template?.isActive) return { error: "Choose a shift first." };
  if (input.memberIds.length === 0) return { error: "Choose at least one team member." };
  const known = await prisma.internalTeamMember.findMany({ where: { id: { in: input.memberIds } }, select: { id: true } });
  const off = new Set(input.daysOff);
  for (const member of known) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const shiftTemplateId = off.has(weekday) ? null : template.id;
      await prisma.weeklyScheduleEntry.upsert({
        where: { teamMemberId_weekday: { teamMemberId: member.id, weekday } },
        create: { teamMemberId: member.id, weekday, shiftTemplateId },
        update: { shiftTemplateId },
      });
    }
  }
  await refreshFutureRoster(known.map((m) => m.id));
  await revalidateTeam();
  return { message: `${known.length} ${known.length === 1 ? "person is" : "people are"} on ${template.name}. The roster now fills itself.` };
}

