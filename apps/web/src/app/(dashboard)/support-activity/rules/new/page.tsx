import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { createSupportRule } from "@/server/actions/supportRules";
import { SupportRuleForm } from "../SupportRuleForm";

export default async function NewSupportRulePage() {
  await requireSession();
  const [groups, teamMembers, keywords] = await Promise.all([
    prisma.whatsAppGroup.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.supportKeyword.findMany({ where: { isActive: true }, orderBy: { value: "asc" }, select: { id: true, value: true } }),
  ]);

  return (
    <div>
      <PageHeader title="Create Support Rule" />
      <SupportRuleForm
        action={createSupportRule}
        submitLabel="Create Rule"
        groupOptions={groups.map((g) => ({ id: g.id, label: g.name }))}
        teamMemberOptions={teamMembers.map((m) => ({ id: m.id, label: m.name }))}
        keywordOptions={keywords.map((k) => ({ id: k.id, label: k.value }))}
      />
    </div>
  );
}
