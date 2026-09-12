import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { hasPermission, requirePermission } from "@/server/permissions";
import { formatDhakaDateKey, parseDhakaDayFromInput, toDhakaDateOnly } from "@/lib/supportActivityPeriod";
import { formatDate } from "@/lib/date";
import {
  getCoverageForDate,
  getReplacementCandidates,
  getRosterForDate,
  getWeeklySchedule,
} from "@/server/teamManagementReports";
import { Alert, Card, EmptyState, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { DateJump } from "./DateJump";
import { RosterDay } from "./RosterDay";
import { WeeklyGrid } from "./WeeklyGrid";

/**
 * The roster: a date's actual assignments, and the recurring pattern they are filled from.
 *
 * Both on one page because they are constantly read against each other — "she is normally on
 * Morning, why is she on Late on Thursday" is the question this page exists to answer, and it needs
 * both halves visible.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const session = await requireSession();
  await requirePermission(session, "team_management.view");
  const canManage = await hasPermission(session, "team_management.manage");

  const params = await searchParams;
  const parsed = parseDhakaDayFromInput(params.date);
  const when = parsed ? parsed.start : new Date();
  const date = formatDhakaDateKey(when);

  const [roster, coverage, candidates, weekly, allTemplates, recentChanges] = await Promise.all([
    getRosterForDate(when),
    getCoverageForDate(when),
    getReplacementCandidates(when),
    getWeeklySchedule(),
    // Active shifts PLUS any disabled one still referenced by this date's roster or the weekly
    // pattern. Listing only the active ones looked tidier and quietly corrupted data: a `<select>`
    // whose stored value matches no option falls back to its FIRST option, so a person on a
    // since-disabled shift rendered as "No shift" — and saving that form, even to correct the
    // reason, wrote the blank back and erased the shift they were actually on.
    prisma.shiftTemplate.findMany({
      orderBy: [{ position: "asc" }, { name: "asc" }],
      select: { id: true, name: true, isActive: true },
    }),
    prisma.dutyAssignmentChange.findMany({
      where: { dutyDate: toDhakaDateOnly(when) },
      include: { teamMember: { select: { name: true } }, changedBy: { select: { name: true, username: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  // A disabled shift is offered only where it is already in use, and labelled so nobody picks it
  // thinking it is current. `setDutyAssignment` is the real gate — it refuses a disabled template
  // unless that assignment already carried it.
  const referenced = new Set<string>([
    ...roster.map((row) => row.shiftTemplateId).filter((id): id is string => Boolean(id)),
    ...weekly.flatMap((row) => row.days.map((day) => day.shiftTemplateId)).filter((id): id is string => Boolean(id)),
  ]);
  const templates = allTemplates
    .filter((template) => template.isActive || referenced.has(template.id))
    .map((template) => ({
      id: template.id,
      name: template.isActive ? template.name : `${template.name} (disabled)`,
    }));

  return (
    <div>
      <PageHeader
        title="Roster"
        description="What each person is doing on a given date, and the weekly pattern it is filled from. A date's assignment always wins over the pattern."
        actions={<DateJump date={date} />}
      />

      <SectionHeader title={formatDate(when)} description="This date's assignments. Changing them never alters the weekly pattern." />

      {templates.length === 0 ? (
        <Alert tone="warning">
          No active shifts yet.{" "}
          <Link href="/team-management/shifts" className="underline">
            Create the shifts your team works
          </Link>{" "}
          before building a roster.
        </Alert>
      ) : roster.length === 0 ? (
        <EmptyState>No active team members.</EmptyState>
      ) : canManage ? (
        <RosterDay date={date} roster={roster} coverage={coverage} candidates={candidates} templates={templates} />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Team member</Th>
                <Th>Scheduled</Th>
                <Th>Messages</Th>
              </tr>
            </thead>
            <tbody>
              {roster.map((row) => (
                <tr key={row.teamMemberId}>
                  <Td className="font-medium">{row.name}</Td>
                  <Td>{row.shiftName ?? (row.status?.toLowerCase().replace("_", " ") ?? "not set")}</Td>
                  <Td className="tabular-nums">{row.messageCount || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {recentChanges.length > 0 ? (
        <div className="mt-10">
          <SectionHeader
            title="Changes to this date"
            description="Kept forever. A shift change and the cover arranged for it share one entry because they were one decision."
          />
          <Card>
            <Table>
              <thead>
                <tr>
                  <Th>Team member</Th>
                  <Th>From</Th>
                  <Th>To</Th>
                  <Th>Reason</Th>
                  <Th>By</Th>
                </tr>
              </thead>
              <tbody>
                {recentChanges.map((row) => (
                  <tr key={row.id}>
                    <Td className="font-medium">{row.teamMember.name}</Td>
                    <Td className="text-[color:var(--color-muted-foreground)]">
                      {row.previousShiftName ?? row.previousStatus?.toLowerCase().replace("_", " ") ?? "nothing"}
                    </Td>
                    <Td>{row.newShiftName ?? row.newStatus.toLowerCase().replace("_", " ")}</Td>
                    <Td className="text-[color:var(--color-muted-foreground)]">{row.reason ?? "—"}</Td>
                    <Td className="text-[color:var(--color-muted-foreground)]">
                      {row.changedBy?.name ?? row.changedBy?.username ?? "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      ) : null}

      <div className="mt-10">
        <SectionHeader
          title="Weekly pattern"
          description="The starting point for future dates. “Not set” and “Off” are different answers — one means nobody has decided, the other means somebody decided they are off."
        />
        {canManage ? (
          <WeeklyGrid rows={weekly} templates={templates} />
        ) : (
          <Alert tone="info">You can view the roster but not change it.</Alert>
        )}
      </div>
    </div>
  );
}
