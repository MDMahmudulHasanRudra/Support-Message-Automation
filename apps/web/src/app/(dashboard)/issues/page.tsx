import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { IssuesTable, type IssueRow } from "./IssuesTable";

export default async function IssuesPage() {
  await requireSession();
  const issues = await prisma.supportIssue.findMany({
    orderBy: { createdAt: "desc" },
    include: { group: true, teamsChannel: true },
    take: 200,
  });

  const rows: IssueRow[] = issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    clientPhone: issue.clientPhone,
    groupName: issue.group.name,
    status: issue.status,
    teamsChannelName: issue.teamsChannel?.name ?? null,
    createdAtLabel: formatDateTime(issue.createdAt),
  }));

  return (
    <div>
      <PageHeader
        title="Issues"
        description="Links a customer's WhatsApp conversation to a developer's Teams thread — resolving the Teams thread can notify the customer automatically."
        actions={
          <>
            <HelpButton moduleTitle="Issues">
              <HelpSection title="What this page is for">
                <p>
                  Create an Issue when a customer conversation needs developer attention. Link it
                  to a Teams channel (and optionally an exact thread) — once a developer&apos;s
                  reply there matches an active Resolution Rule, the issue is marked resolved and
                  the customer can be notified automatically over WhatsApp.
                </p>
              </HelpSection>
            </HelpButton>
            <Link href="/issues/new">
              <Button>
                <Plus className="size-3.5" aria-hidden />
                Create Issue
              </Button>
            </Link>
          </>
        }
      />
      <IssuesTable issues={rows} />
    </div>
  );
}
