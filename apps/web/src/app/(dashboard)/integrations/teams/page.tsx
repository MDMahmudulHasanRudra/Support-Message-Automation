/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { isTeamsClientConfigured } from "@support-automation/teams-client";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import { Alert, ButtonLink, Card, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { TeamsConnectionCard } from "./TeamsConnectionCard";

export default async function TeamsIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<{ connectError?: string; cancelled?: string; justConnected?: string }>;
}) {
  await requireSession();
  const { connectError, cancelled, justConnected } = await searchParams;
  const account = await prisma.teamsAccount.findUnique({ where: { id: "global" } });

  const [openIssueCount, resolvedTodayCount, teamsCount, channelsCount, messagesCount] = await Promise.all([
    prisma.supportIssue.count({ where: { status: { notIn: ["RESOLVED", "CLOSED"] } } }),
    prisma.supportIssue.count({
      where: { status: "RESOLVED", resolvedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
    }),
    prisma.teamsTeam.count(),
    prisma.teamsChannel.count(),
    prisma.teamsMessage.count(),
  ]);

  return (
    <div>
      <PageHeader
        title="Microsoft Teams Integration"
        description="Links developer conversations in Microsoft Teams to open customer WhatsApp conversations — a resolution keyword in a linked thread notifies the customer automatically."
        actions={
          <HelpButton moduleTitle="Teams Integration">
            <HelpSection title="What this does">
              <p>
                Connect one Microsoft account, link a Teams channel/thread to an Issue, and when a
                developer's reply matches an active Resolution Rule, the customer gets a WhatsApp
                message through the existing outbound queue — no manual follow-up needed.
              </p>
            </HelpSection>
            <HelpSection title="What it doesn't do yet">
              <p>
                Sync is polling-based (a few minutes, not real-time), and full session/duration
                analytics (call-time tracking) are a deferred later phase — see PROJECT_REFERENCE.md.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {connectError ? (
        <div className="mb-6">
          <Alert tone={cancelled ? "info" : "danger"}>{connectError}</Alert>
        </div>
      ) : null}
      {justConnected ? (
        <div className="mb-6">
          <Alert tone="success">
            ✓ Microsoft Teams connected. We&apos;re discovering your Teams and channels now — this page
            will update automatically.
          </Alert>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TeamsConnectionCard
          info={{
            configured: isTeamsClientConfigured(),
            status: account?.status ?? "DISCONNECTED",
            email: account?.email ?? null,
            displayName: account?.displayName ?? null,
            lastSyncAt: account?.lastSyncAt ? formatDateTime(account.lastSyncAt) : null,
            lastSyncError: account?.lastSyncError ?? null,
            teamsCount,
            channelsCount,
            messagesCount,
          }}
        />

        <Card>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[color:var(--color-muted-foreground)]">Open Issues</span>
              <span className="text-lg font-semibold tabular-nums">{openIssueCount}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-[color:var(--color-muted-foreground)]">Resolved Today</span>
              <span className="text-lg font-semibold tabular-nums">{resolvedTodayCount}</span>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <ButtonLink href="/issues" variant="secondary" size="sm">
                View Issues
              </ButtonLink>
              <ButtonLink href="/integrations/teams/rules" variant="secondary" size="sm">
                Resolution Rules
              </ButtonLink>
              <ButtonLink href="/integrations/teams/keywords" variant="secondary" size="sm">
                Resolution Keywords
              </ButtonLink>
              <Link href="/integrations/teams/settings" className="link text-xs">
                Settings
              </Link>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
