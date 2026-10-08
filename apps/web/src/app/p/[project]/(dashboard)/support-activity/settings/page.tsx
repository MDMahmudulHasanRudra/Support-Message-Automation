import { prisma } from "@/server/db";
import Link from "@/components/ProjectLink";

import { pageAccess } from "@/server/authorize";
import { ButtonLink, Card, HelpButton, HelpSection, PageHeader, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import { SupportActivitySettingsForm } from "./SupportActivitySettingsForm";
import { SupportTeamCard } from "./SupportTeamCard";
import { ReportingDataCard } from "./ReportingDataCard";

export default async function SupportActivitySettingsPage() {
  const { canManage } = await pageAccess("support_activity.view", "support_activity.manage");
  const settings = await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
  const teams = await prisma.team.findMany({
    // A Team already chosen stays listed even if it was disabled since, so saving never drops it unseen.
    where: { OR: [{ status: "ACTIVE" }, { id: { in: settings.responseTrackingTeamIds } }] },
    select: { id: true, name: true, _count: { select: { members: true } } },
    orderBy: { name: "asc" },
  });

  const [recentGaps, firstGap] = await Promise.all([
    prisma.collectionGap.findMany({
      orderBy: { startedAt: "desc" },
      take: 10,
      select: { id: true, cause: true, startedAt: true, endedAt: true, recoveryStatus: true, recoveredCount: true, account: { select: { label: true } } },
    }),
    prisma.collectionGap.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);

  return (
    <div>
      <PageHeader
        title="Support Activity Setup"
        description="Whether tracking runs, how it counts, and which messages count as support."
        actions={
          <HelpButton moduleTitle="Support Activity Settings">
            <HelpSection title="What this page is for">
              <p>
                The master enable switch and the global counting mode for Support Activity
                Tracking. To manage the actual detection logic, see{" "}
                <Link href="/support-activity/keywords" className="underline">
                  Keywords
                </Link>{" "}
                and{" "}
                <Link href="/support-activity/rules" className="underline">
                  Rules
                </Link>
                .
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      <SupportActivitySettingsForm settings={settings} />

      <SupportTeamCard
        teams={teams.map((t) => ({ id: t.id, name: t.name, memberCount: t._count.members }))}
        selectedIds={settings.responseTrackingTeamIds}
        canManage={canManage}
      />

      <ReportingDataCard
        verifiedFrom={settings.reportingVerifiedFrom?.getTime() ?? null}
        firstGapRecordedAt={firstGap?.createdAt.getTime() ?? null}
        gaps={recentGaps.map((g) => ({
          id: g.id,
          accountLabel: g.account.label,
          cause: g.cause,
          startedAt: g.startedAt.getTime(),
          endedAt: g.endedAt?.getTime() ?? null,
          recoveryStatus: g.recoveryStatus,
          recoveredCount: g.recoveredCount,
        }))}
        canManage={canManage}
      />

      {/* Rules and Keywords were two more nav entries for the same job as this page: deciding what
          counts. They keep their own routes — this is where you now find them. */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Card>
          <SectionHeader
            title="Rules"
            description="Which messages count as support — every message, a keyword, a reply to a customer, or an @mention."
          />
          <ButtonLink href="/support-activity/rules">Manage rules</ButtonLink>
        </Card>
        <Card>
          <SectionHeader
            title="Keywords"
            description="The words a keyword rule looks for, and which of them mark a conversation finished."
          />
          <ButtonLink href="/support-activity/keywords">Manage keywords</ButtonLink>
        </Card>
      </div>
    </div>
  );
}
