import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { updateTeamsResolutionRule } from "@/server/actions/teamsResolutionRules";
import { TeamsResolutionRuleForm } from "../../TeamsResolutionRuleForm";

export default async function EditTeamsResolutionRulePage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const [rule, keywords] = await Promise.all([
    prisma.teamsResolutionRule.findUnique({ where: { id }, include: { keywords: true } }),
    prisma.teamsResolutionKeyword.findMany({ where: { isActive: true }, orderBy: { value: "asc" }, select: { id: true, value: true } }),
  ]);
  if (!rule) notFound();

  const updateWithId = updateTeamsResolutionRule.bind(null, rule.id);

  return (
    <div>
      <PageHeader title={`Edit ${rule.name}`} />
      <TeamsResolutionRuleForm
        action={updateWithId}
        submitLabel="Save"
        defaults={{
          name: rule.name,
          description: rule.description ?? undefined,
          keywordIds: rule.keywords.map((k) => k.keywordId),
        }}
        keywordOptions={keywords.map((k) => ({ id: k.id, label: k.value }))}
      />
    </div>
  );
}
