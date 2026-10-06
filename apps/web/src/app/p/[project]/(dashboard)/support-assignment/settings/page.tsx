import { normalizeSenderKey } from "@support-automation/shared";
import { PageHeader, ViewOnlyNotice } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { hasSupportTeamConfigured } from "@/server/supportAssignment";
import { SupportAssignmentSettingsForm } from "./SupportAssignmentSettingsForm";

/** Recent customers offered in the ignored-senders picker: the most active in the last two weeks. */
const RECENT_SENDER_DAYS = 14;
const RECENT_SENDER_LIMIT = 300;

/** Settings → Support Assignment (SUPPORT_ASSIGNMENT.md). */
export default async function SupportAssignmentSettingsPage() {
  const { canManage } = await pageAccess("support_assignment.view", "support_assignment.manage");
  const settings = await prisma.supportAssignmentSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });

  const now = new Date();
  const since = new Date(now.getTime() - RECENT_SENDER_DAYS * 86_400_000);
  const [teams, members, groupRows, senders, supportTeam] = await Promise.all([
    prisma.team.findMany({
      where: { OR: [{ status: "ACTIVE" }, { id: { in: settings.assignableTeamIds } }] },
      select: { id: true, name: true, _count: { select: { members: { where: { status: "ACTIVE" } } } } },
      orderBy: { name: "asc" },
    }),
    prisma.internalTeamMember.findMany({
      where: { OR: [{ status: "ACTIVE" }, { id: { in: settings.adminMemberIds } }] },
      select: { id: true, name: true, role: true, phoneNumber: true, whatsappId: true, status: true },
      orderBy: { name: "asc" },
    }),
    prisma.whatsAppGroup.findMany({
      where: { isActive: true },
      select: { whatsappGroupId: true, name: true, isMonitored: true },
      orderBy: { name: "asc" },
    }),
    prisma.message.groupBy({
      by: ["senderPhone"],
      where: { direction: "INCOMING", isFromTeamMember: false, groupId: { not: null }, timestampWa: { gte: since } },
      _count: { _all: true },
      _max: { senderName: true },
      orderBy: { _count: { senderPhone: "desc" } },
      take: RECENT_SENDER_LIMIT,
    }),
    hasSupportTeamConfigured(),
  ]);

  // One row per WhatsApp group: two accounts in one group store two rows of it.
  const seen = new Set<string>();
  const groups = groupRows.filter((g) => (seen.has(g.whatsappGroupId) ? false : (seen.add(g.whatsappGroupId), true)));

  const recentSenders = senders.map((s) => ({ key: normalizeSenderKey(s.senderPhone), name: s._max.senderName ?? null, messages: s._count._all }));

  return (
    <div>
      <PageHeader
        title="Support Assignment"
        description="What counts as a support case, how long the assignee has to reply, and who is told when they do not."
      />
      {canManage ? null : <ViewOnlyNotice />}
      <SupportAssignmentSettingsForm
        canManage={canManage}
        supportTeamConfigured={supportTeam}
        settings={{
          enabled: settings.enabled,
          ignoredKeywords: settings.ignoredKeywords,
          ignoredSenders: settings.ignoredSenders,
          assignableTeamIds: settings.assignableTeamIds,
          slaMinutes: settings.slaMinutes,
          escalationEnabled: settings.escalationEnabled,
          escalationAfterMinutes: settings.escalationAfterMinutes,
          managerGroupIds: settings.managerGroupIds,
          adminMemberIds: settings.adminMemberIds,
          notifyEmployeeOnAssign: settings.notifyEmployeeOnAssign,
          notifyEmployeeOnReassign: settings.notifyEmployeeOnReassign,
          notifyManagerOnOverdue: settings.notifyManagerOnOverdue,
          notifyAdminOnOverdue: settings.notifyAdminOnOverdue,
          notifyAdminOnEscalation: settings.notifyAdminOnEscalation,
          notifyAdminOnCompletion: settings.notifyAdminOnCompletion,
        }}
        teams={teams.map((t) => ({ id: t.id, name: t.name, memberCount: t._count.members }))}
        members={members}
        groups={groups}
        recentSenders={recentSenders}
      />
    </div>
  );
}
