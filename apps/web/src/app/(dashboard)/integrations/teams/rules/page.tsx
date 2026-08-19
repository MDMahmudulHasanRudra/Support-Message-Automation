import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { TeamsResolutionRulesTable, type TeamsResolutionRuleRow } from "./TeamsResolutionRulesTable";

export default async function TeamsResolutionRulesPage() {
  await requireSession();
  const rules = await prisma.teamsResolutionRule.findMany({
    orderBy: { createdAt: "desc" },
    include: { keywords: { include: { keyword: true } } },
  });

  const rows: TeamsResolutionRuleRow[] = rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    isActive: rule.isActive,
    keywordsSummary: rule.keywords.map((k) => k.keyword.value).join(", ") || "—",
  }));

  return (
    <div>
      <PageHeader
        title="Resolution Rules"
        description="A rule fires when a developer's Teams reply matches one of its keywords, notifying the linked issue's customer."
        actions={
          <>
            <HelpButton moduleTitle="Resolution Rules">
              <HelpSection title="What this page is for">
                <p>
                  When a new Teams message in a channel linked to an open Issue matches an active
                  resolution rule, the issue is marked resolved and (if customer notification is
                  enabled) the customer gets a WhatsApp message automatically.
                </p>
              </HelpSection>
            </HelpButton>
            <Link href="/integrations/teams/rules/new">
              <Button>
                <Plus className="size-3.5" aria-hidden />
                Create Rule
              </Button>
            </Link>
          </>
        }
      />

      <TeamsResolutionRulesTable rules={rows} />
    </div>
  );
}
