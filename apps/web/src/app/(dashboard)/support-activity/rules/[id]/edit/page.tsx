import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { updateSupportRule } from "@/server/actions/supportRules";
import { SupportRuleForm } from "../../SupportRuleForm";

export default async function EditSupportRulePage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const [rule, groups, teamMembers, keywords] = await Promise.all([
    prisma.supportRule.findUnique({ where: { id }, include: { groups: true, teamMembers: true, keywords: true } }),
    prisma.whatsAppGroup.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.supportKeyword.findMany({ where: { isActive: true }, orderBy: { value: "asc" }, select: { id: true, value: true } }),
  ]);
  if (!rule) notFound();

  const updateWithId = updateSupportRule.bind(null, rule.id);

  return (
    <div>
      <PageHeader title={`Edit ${rule.name}`} />
      <SupportRuleForm
        action={updateWithId}
        submitLabel="Save"
        defaults={{
          name: rule.name,
          description: rule.description ?? undefined,
          appliesToAllGroups: rule.appliesToAllGroups,
          groupIds: rule.groups.map((g) => g.groupId),
          appliesToAllTeamMembers: rule.appliesToAllTeamMembers,
          teamMemberIds: rule.teamMembers.map((m) => m.teamMemberId),
          keywordIds: rule.keywords.map((k) => k.keywordId),
        }}
        groupOptions={groups.map((g) => ({ id: g.id, label: g.name }))}
        teamMemberOptions={teamMembers.map((m) => ({ id: m.id, label: m.name }))}
        keywordOptions={keywords.map((k) => ({ id: k.id, label: k.value }))}
      />
    </div>
  );
}
