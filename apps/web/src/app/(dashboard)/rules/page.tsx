import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, PageHeader } from "@/components/ui";
import { isRuleActionArray } from "@support-automation/shared";
import { RulesTable, type RuleRow } from "./RulesTable";

export default async function RulesPage() {
  await requireSession();
  const rules = await prisma.automationRule.findMany({ orderBy: [{ priority: "desc" }, { createdAt: "desc" }] });

  const priorityCounts = new Map<number, number>();
  for (const rule of rules) {
    priorityCounts.set(rule.priority, (priorityCounts.get(rule.priority) ?? 0) + 1);
  }

  const rows: RuleRow[] = rules.map((rule) => {
    const actions = isRuleActionArray(rule.actions) ? rule.actions : [];
    const trigger =
      rule.matchType +
      (rule.matchValue ? `: ${rule.matchValue}` : rule.keywords.length ? `: ${rule.keywords.join(", ")}` : "");
    return {
      id: rule.id,
      name: rule.name,
      type: rule.type,
      trigger,
      actionsSummary: actions.map((a) => a.type).join(", ") || "—",
      priority: rule.priority,
      status: rule.status,
      executionCount: rule.executionCount,
      updatedAtLabel: rule.updatedAt.toLocaleDateString(),
      hasPriorityConflict: (priorityCounts.get(rule.priority) ?? 0) > 1,
    };
  });

  return (
    <div>
      <PageHeader
        title="Automation Rules"
        description="Higher priority rules are evaluated first."
        actions={
          <Link href="/rules/new">
            <Button>Create Rule</Button>
          </Link>
        }
      />

      <RulesTable rules={rows} />
    </div>
  );
}
