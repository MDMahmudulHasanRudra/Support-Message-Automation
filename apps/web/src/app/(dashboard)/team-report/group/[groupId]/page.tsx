import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MessageCircleMore } from "lucide-react";
import { prisma } from "@support-automation/db";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, SectionHeader, StatTile, Table, Td, Th } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { formatDurationShort } from "@/lib/duration";
import { loadTeamReport, memberLabel, parseTeamReportFilters, teamReportQuery } from "@/server/teamReport";

export const metadata = { title: "Team Report · Group" };

/** Beyond this the table is cut, with the full list still in the Excel export. */
const MAX_WAIT_ROWS = 500;

const when = (ms: number | null) =>
  ms === null
    ? "—"
    : new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Dhaka",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(ms));

const count = (n: number) => n.toLocaleString("en-US");
const duration = (seconds: number) => (seconds > 0 ? formatDurationShort(seconds) : "0m");

const STATUS: Record<string, { label: string; color: "green" | "yellow" | "red" | "gray" }> = {
  ON_TIME: { label: "Answered in time", color: "green" },
  RECALLED: { label: "Recall — answered late", color: "yellow" },
  MISSED: { label: "Missed — never answered", color: "red" },
  PENDING: { label: "Still within time", color: "gray" },
};

/**
 * One group, for the period and member chosen on the report — every customer wait behind its
 * Missed and Recall numbers, so a figure on the report can be checked row by row.
 */
export default async function TeamReportGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAccess("support_activity.view");
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const group = await prisma.whatsAppGroup.findUnique({
    where: { id: groupId },
    select: { id: true, name: true, whatsappGroupId: true, participantCount: true },
  });
  if (!group) notFound();

  const now = new Date();
  const { filters, range, result, memberNames, rules, teamName } = await loadTeamReport(
    parseTeamReportFilters(query, now),
    now,
    group.whatsappGroupId,
  );
  const row = result.groups.find((g) => g.groupKey === group.whatsappGroupId) ?? null;
  const backHref = `/team-report?${teamReportQuery(filters)}`;
  // One member, or a Team: whose replies and time the figures below are.
  const scopedName = filters.memberId ? memberLabel(filters.memberId, memberNames) : teamName;
  const waits = result.waits.slice(0, MAX_WAIT_ROWS);

  return (
    <div>
      <Link href={backHref} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to the report
      </Link>
      <PageHeader
        title={group.name}
        description={`${range.label}${scopedName ? ` · replies and time shown are ${scopedName}'s` : ""} · ${group.whatsappGroupId}`}
        actions={
          <ButtonLink href={`/chat/${group.id}`}>
            <MessageCircleMore className="size-3.5" aria-hidden />
            Open conversation
          </ButtonLink>
        }
      />

      {!row ? (
        <EmptyState>
          {scopedName ? `${scopedName} sent no messages in this group in ${range.label}.` : `No messages were stored for this group in ${range.label}.`}
        </EmptyState>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Messages" value={count(row.totalMessages)} hint={group.participantCount ? `${group.participantCount} participants` : undefined} />
            <StatTile label="Customer messages" value={count(row.customerMessages)} />
            <StatTile label="Team replies" value={count(row.memberReplies)} hint={row.businessReplies ? `+ ${count(row.businessReplies)} from the business number` : undefined} />
            <StatTile label="Support duration" value={duration(row.activeSeconds)} />
            <StatTile label="Customer waits" value={count(row.waits)} />
            <StatTile label="Missed" value={count(row.missed)} tone={row.missed > 0 ? "warning" : "neutral"} hint={`${count(row.unrecovered)} never answered`} />
            <StatTile label="Recall support" value={count(row.recalled)} tone="accent" />
            <StatTile label="First – last support" value={row.firstActivityAt ? when(row.firstActivityAt) : "—"} hint={row.lastActivityAt ? `until ${when(row.lastActivityAt)}` : undefined} />
          </div>

          <Card className="mb-5">
            <SectionHeader title="Who supported this group" description="Messages each team member sent here in the period." />
            {row.memberIds.length === 0 ? (
              <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No team member wrote in this group — any replies came from the business number.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {row.memberIds.map((id) => (
                  <Badge key={id} color="gray">
                    {memberLabel(id, memberNames)}
                  </Badge>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionHeader
              title={`Customer waits (${count(result.waits.length)})`}
              description={`Each row is one customer wait. Missed after ${rules.missedAfterMinutes} minutes unless the group's priority sets another time — the "Threshold" column shows which applied.`}
            />
            {waits.length === 0 ? (
              <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No customer message started a wait in this period.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Customer asked</Th>
                    <Th>Answered</Th>
                    <Th>Wait</Th>
                    <Th>Threshold</Th>
                    <Th>Answered by</Th>
                    <Th>Result</Th>
                  </tr>
                </thead>
                <tbody>
                  {waits.map((wait) => (
                    <tr key={wait.askedAt}>
                      <Td className="tabular">{when(wait.askedAt)}</Td>
                      <Td className="tabular">{when(wait.repliedAt)}</Td>
                      <Td className="tabular">{wait.waitSeconds === null ? "—" : duration(wait.waitSeconds)}</Td>
                      <Td className="tabular">{Math.round(wait.thresholdSeconds / 60)} min</Td>
                      <Td>{wait.repliedBy ? memberLabel(wait.repliedBy, memberNames) : "—"}</Td>
                      <Td>
                        <Badge color={STATUS[wait.status]!.color} dot>
                          {STATUS[wait.status]!.label}
                        </Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {result.waits.length > MAX_WAIT_ROWS ? (
              <p className="mt-3 text-[12px] text-[color:var(--color-muted-foreground)]">
                Showing the first {MAX_WAIT_ROWS} of {count(result.waits.length)} waits. The Excel export on the report lists every missed one.
              </p>
            ) : null}
          </Card>
        </>
      )}
    </div>
  );
}
