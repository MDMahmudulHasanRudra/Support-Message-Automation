import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { createTeamsResolutionRule } from "@/server/actions/teamsResolutionRules";
import { TeamsResolutionRuleForm } from "../TeamsResolutionRuleForm";

export default async function NewTeamsResolutionRulePage() {
  await requireSession();
  const keywords = await prisma.teamsResolutionKeyword.findMany({
    where: { isActive: true },
    orderBy: { value: "asc" },
    select: { id: true, value: true },
  });

  return (
    <div>
      <PageHeader title="Create Resolution Rule" />
      <TeamsResolutionRuleForm
        action={createTeamsResolutionRule}
        submitLabel="Create Rule"
        keywordOptions={keywords.map((k) => ({ id: k.id, label: k.value }))}
      />
    </div>
  );
}
