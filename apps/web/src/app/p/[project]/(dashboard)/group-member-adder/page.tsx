/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */

import { prisma } from "@/server/db";
import { requireAccess } from "@/server/authorize";
import { activeProjectSlug } from "@/server/projectContext";
import Link from "@/components/ProjectLink";
import { Badge, Card, HelpButton, HelpSection, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { hasReachablePhoneNumber, summariseAddJob } from "@support-automation/shared";
import { listWhatsAppOperations } from "@/server/whatsappOperations";
import { CurrentOperations } from "@/components/whatsappOperations/CurrentOperations";
import { OPERATION_STATE_COLOR } from "@/components/whatsappOperations/OperationSummary";
import {
  GroupParticipantAddWizard,
  type AdderAccount,
  type AdderTeamMember,
} from "./GroupParticipantAddWizard";

export default async function GroupParticipantAdderPage() {
  await requireAccess("bulk_messaging.manage");

  const [accounts, settings, automationSettings, roster, savedGroupSets, operations, recentJobs, projectSlug] = await Promise.all([
    prisma.whatsAppAccount.findMany({
      where: { status: "CONNECTED" },
      include: {
        groups: {
          where: { isActive: true },
          orderBy: { name: "asc" },
          include: { chatCategory: { select: { id: true, name: true, color: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.groupParticipantAddSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.internalTeamMember.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, phoneNumber: true, whatsappId: true, role: true },
      orderBy: { name: "asc" },
    }),
    prisma.savedGroupSet.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, groupIds: true } }),
    // Running jobs come first on this page, read from the database on every visit — so coming back
    // after Reports, a refresh or another browser shows the job where it is now.
    listWhatsAppOperations({ kind: "ADD_NUMBER_TO_GROUPS" }),
    prisma.groupParticipantAddJob.findMany({
      where: { status: { in: ["COMPLETED", "CANCELLED", "STOPPED_KILL_SWITCH"] } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        phoneNumbers: true,
        queuedCount: true,
        createdAt: true,
        completedAt: true,
        cancelledAt: true,
        account: { select: { label: true } },
      },
    }),
    activeProjectSlug(),
  ]);
  const recentCounts = await prisma.groupParticipantAddItem.groupBy({
    by: ["jobId", "status"],
    where: { jobId: { in: recentJobs.map((j) => j.id) } },
    _count: { _all: true },
  });
  const recent = recentJobs.map((job) => {
    const byStatus: Record<string, number> = {};
    for (const row of recentCounts) if (row.jobId === job.id) byStatus[row.status] = row._count._all;
    return summariseAddJob(
      { ...job, accountLabel: job.account.label, accountConnected: true, byStatus, current: null },
      new Date(),
    );
  });

  // Anyone mapped from message history has a WhatsApp id where their number should be, and WhatsApp
  // cannot add a participant by that — the add would fail for every group in the job. Left out of
  // the picker entirely rather than offered and then failing hundreds of times; Team Members is
  // where that gets fixed, and it already flags them.
  const teamMembers: AdderTeamMember[] = roster
    .filter(hasReachablePhoneNumber)
    .map((member) => ({
      id: member.id,
      name: member.name,
      phoneNumber: member.phoneNumber,
      role: member.role,
    }));

  const wizardAccounts: AdderAccount[] = accounts.map((a) => ({
    id: a.id,
    label: a.label,
    status: a.status,
    groups: a.groups.map((g) => ({
      id: g.id,
      name: g.name,
      isMonitored: g.isMonitored,
      // The chat inbox's categories and pins, reused rather than given a second parallel taxonomy.
      categoryId: g.chatCategoryId,
      categoryName: g.chatCategory?.name ?? null,
      categoryColor: g.chatCategory?.color ?? null,
      isPinned: g.chatPinnedAt !== null,
    })),
  }));

  const savedSets = savedGroupSets.map((set) => ({
    id: set.id,
    name: set.name,
    // The saved size, not the resolvable one — resolving every set on page load would be a query
    // per set for a number that only matters once somebody loads one.
    count: set.groupIds.length,
  }));

  return (
    <div>
      <PageHeader
        title="Add Number to Groups"
        description="Add one or more people to many WhatsApp groups at once. Queue it and leave — it works through the list on its own, paced to keep the account safe."
        actions={
          <HelpButton moduleTitle="Add Number to Groups">
            <HelpSection title="What this does">
              <p>
                Adds people as participants to many WhatsApp groups at once — a new teammate across
                every support group, or your whole roster across a set of new ones. Pick team members
                from the list, type other numbers, or both; everyone chosen is added to every group
                you select.
              </p>
              <p>
                Anyone already in a group is skipped without an add being attempted, so re-running
                the same roster over a wider set of groups is safe and only does the new work.
              </p>
            </HelpSection>
            <HelpSection title="Queue it once and leave it">
              <p>
                One job covers every number against every group, so five people across five hundred
                groups is 2,500 adds — the wizard shows the count and a time estimate before you
                confirm. It runs in the background at a fixed pace, survives a restart, and needs
                nobody watching. A large job is not slower per add; it simply has more to do.
              </p>
              <p>
                Go anywhere else in the dashboard, refresh, or close the browser: the job keeps going.
                The <strong>WhatsApp operations</strong> button in the bottom-right corner of every page
                shows its progress, and this page shows it at the top when you come back. Starting the
                same numbers on the same groups again while a job is still working on them opens that
                job instead of starting a second one.
              </p>
              <p>
                If the account disconnects, nothing is lost and nothing is marked failed: the job waits,
                and carries on from where it was once the account is connected again.
              </p>
            </HelpSection>
            <HelpSection title="Why this is paced more conservatively than Group Message Sender">
              <p>
                WhatsApp treats bulk "add participant" actions as a stronger ban signal than bulk
                messaging, so this is deliberately slower: a 10–30 second gap between adds (vs. 5–15s
                for messages) and 3 per minute (vs. 6). That per-minute cap applies across every
                running job, not to each one separately — which is what makes a large job safe, and
                what makes splitting one into several pointless.
              </p>
              <p>
                Change any of it on <strong>Add-to-Groups Limits</strong>.
              </p>
            </HelpSection>
            <HelpSection title="Before every add">
              <p>
                The worker double-checks live that the account is still actually a member of the target
                group before attempting to add — it never relies blindly on possibly-stale synced data.
              </p>
              <p>
                Team members whose stored number is really a WhatsApp id are left out of the picker
                entirely: WhatsApp cannot add a participant by that, so offering them would fail for
                every group in the job. Fix those on Internal Team Members, where they are flagged.
              </p>
            </HelpSection>
            <HelpSection title="If automation is paused">
              <p>
                You can still prepare and queue a job — nothing is actually added until the kill switch is
                turned back on. If it's paused mid-job, still-pending groups are cancelled; numbers already
                added stay added.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <CurrentOperations kind="ADD_NUMBER_TO_GROUPS" projectSlug={projectSlug ?? ""} initial={operations} />
      <GroupParticipantAddWizard
        accounts={wizardAccounts}
        teamMembers={teamMembers}
        maxPerJob={settings.maxPerJob}
        maxPerMinute={settings.maxPerMinute}
        automationEnabled={automationSettings.automationEnabled}
        savedSets={savedSets}
      />

      {/* A finished job's result stays here — and on its own page — rather than vanishing. */}
      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-foreground)]">Recent jobs</h2>
        {recent.length === 0 ? (
          <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No finished jobs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Numbers</Th>
                  <Th>Account</Th>
                  <Th>Status</Th>
                  {recent[0]!.counts.map((c) => (
                    <Th key={c.label}>{c.label}</Th>
                  ))}
                  <Th>Finished</Th>
                </tr>
              </thead>
              <tbody>
                {recent.map((op) => (
                  <tr key={op.id}>
                    <Td>
                      <Link className="link tabular" href={op.href}>
                        {op.target}
                      </Link>
                    </Td>
                    <Td>{op.accountLabel}</Td>
                    <Td>
                      <Badge color={OPERATION_STATE_COLOR[op.state]}>{op.stateLabel}</Badge>
                    </Td>
                    {op.counts.map((c) => (
                      <Td key={c.label}>{c.value.toLocaleString("en-US")}</Td>
                    ))}
                    <Td>{op.finishedAt ? formatDateTime(new Date(op.finishedAt)) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
