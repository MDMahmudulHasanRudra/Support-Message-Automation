import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { SupportRulesTable, type SupportRuleRow } from "./SupportRulesTable";

export default async function SupportRulesPage() {
  await requireSession();
  const rules = await prisma.supportRule.findMany({
    orderBy: { createdAt: "desc" },
    include: { keywords: { include: { keyword: true } }, groups: true, teamMembers: true },
  });

  const rows: SupportRuleRow[] = rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    isActive: rule.isActive,
    triggerType: rule.triggerType,
    keywordsSummary:
      rule.triggerType === "KEYWORD_MATCH" ? rule.keywords.map((k) => k.keyword.value).join(", ") || "—" : "—",
    groupsSummary: rule.appliesToAllGroups ? "All groups" : `${rule.groups.length} selected`,
    teamMembersSummary: rule.appliesToAllTeamMembers ? "All members" : `${rule.teamMembers.length} selected`,
  }));

  return (
    <div>
      <PageHeader
        title="Support Rules"
        description="Combines team-member scope, group scope, and keywords into one detection rule."
        actions={
          <>
            <HelpButton moduleTitle="Support Rules">
              <HelpSection title="What this page is for">
                <p>
                  A Support Rule fires when a message from an in-scope support team member, inside
                  an in-scope WhatsApp group, satisfies its trigger — a matching keyword, a reply
                  to a real customer message, or a mention of a customer. The first active rule
                  that applies wins — at most one Support Activity is recorded per message.
                </p>
              </HelpSection>
            </HelpButton>
            <Link href="/support-activity/rules/new">
              <Button>
                <Plus className="size-3.5" aria-hidden />
                Create Rule
              </Button>
            </Link>
          </>
        }
      />

      <SupportRulesTable rules={rows} />
    </div>
  );
}
