import { ArrowLeft, Star } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Button, Card, EmptyState, Field, HelpButton, HelpSection, Input, PageHeader, StatTile, Table, Td, Th } from "@/components/ui";
import { formatCsatPercent, formatDhakaDateKey, parseDhakaDayRangeFromInput, type CsatSummary } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { loadCsatReport, type CsatReportGroup } from "@/server/csat";
import { formatDateTime } from "@/lib/date";

/**
 * Reports → Customer Satisfaction (CSAT.md, feature CSAT_SURVEYS). The answers to "How did we do? 1–5" asked
 * after resolved conversations, for a range of Dhaka days: CSAT (4–5 of the answered), response rate and
 * average, per agent (who resolved it) and per channel, and every asked conversation. The Team Report's key
 * opens it, like every other report; a customer's comment is shown only to a viewer who may read messages.
 */

export const metadata = { title: "Customer Satisfaction (CSAT)" };

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;

function defaultRange(now: Date): { from: string; to: string } {
  return { from: formatDhakaDateKey(new Date(now.getTime() - 29 * DAY_MS)), to: formatDhakaDateKey(now) };
}

const average = (s: CsatSummary) => (s.average === null ? "—" : s.average.toFixed(2));

export default async function CsatReportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requireAccess("support_activity.view", "CSAT_SURVEYS");
  const params = await searchParams;
  const now = new Date();
  const fallback = defaultRange(now);
  let from = params.from ?? fallback.from;
  let to = params.to ?? fallback.to;
  let range = parseDhakaDayRangeFromInput(from, to);
  let note: string | null = null;
  if (!range || range.end.getTime() - range.start.getTime() > MAX_DAYS * DAY_MS) {
    note = range ? `A range is at most ${MAX_DAYS} days; showing the last 30 days.` : "Those dates could not be read; showing the last 30 days.";
    ({ from, to } = fallback);
    range = parseDhakaDayRangeFromInput(from, to)!;
  }
  const canReadMessages = await hasPermission(session, "messages.view");
  const report = await loadCsatReport(range, { canReadMessages });
  const s = report.summary;

  return (
    <div>
      <Link href="/reports" className="link mb-3 inline-flex items-center gap-1 text-[13px]">
        <ArrowLeft className="size-3.5" aria-hidden />
        All Reports
      </Link>
      <PageHeader
        title="Customer Satisfaction (CSAT)"
        description="How did we do? 1–5 — asked after a conversation is resolved, on the channels chosen under Settings → Satisfaction surveys."
        actions={
          <HelpButton moduleTitle="Customer Satisfaction">
            <HelpSection title="The figures">
              <p>
                <strong>CSAT</strong> is the share of answers that were 4 or 5. <strong>Response rate</strong> is answered surveys out of
                surveys asked. <strong>Average</strong> is the mean rating. A survey counts in the day it was asked (Dhaka time). Nothing
                answered is shown as “—”, never as zero.
              </p>
            </HelpSection>
            <HelpSection title="Agent and channel">
              <p>
                The agent is the person who resolved the conversation; the Team is the conversation&apos;s Team at that moment. A survey that
                was not asked (cooldown, outside the reply window, a team member, automation paused…) is listed under “Not asked” and never
                counts toward the rates.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <form method="get" className="mb-5 flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" name="from" defaultValue={from} />
        </Field>
        <Field label="To">
          <Input type="date" name="to" defaultValue={to} />
        </Field>
        <Button type="submit">Show</Button>
      </form>
      {note ? <p className="mb-4 text-[13px] text-[color:var(--color-warning)]">{note}</p> : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="CSAT" value={formatCsatPercent(s.csat)} hint={`${s.distribution[3] + s.distribution[4]} of ${s.answered} answers were 4 or 5`} tone="accent" />
        <StatTile label="Response rate" value={formatCsatPercent(s.responseRate)} hint={`${s.answered} answered of ${s.asked} asked`} />
        <StatTile label="Average rating" value={average(s)} hint="1 to 5" />
        <StatTile label="Not asked" value={String(report.skipped.reduce((n, r) => n + r.count, 0))} hint="Resolutions in the period with no survey sent" />
      </div>

      {s.asked === 0 ? (
        <Card>
          <EmptyState icon={<Star className="size-5" aria-hidden />}>
            No survey was asked in this period. Surveys are asked after a conversation is resolved, on the channels switched on under Settings → Satisfaction surveys.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <GroupTable title="By agent" groups={report.byAgent} noun="Agent" />
            <GroupTable title="By channel" groups={report.byChannel} noun="Channel" />
          </div>

          <h2 className="mb-2 text-sm font-semibold">Asked conversations</h2>
          {report.truncated ? <p className="mb-2 text-[12px] text-[color:var(--color-muted-foreground)]">The newest 500 are listed; the figures above count every one.</p> : null}
          <div className="mb-6">
            <Table>
              <thead>
                <tr>
                  <Th>Asked</Th>
                  <Th>Channel</Th>
                  <Th>Customer</Th>
                  <Th>Resolved by</Th>
                  <Th>Rating</Th>
                  {canReadMessages ? <Th>Comment</Th> : null}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap">{formatDateTime(new Date(r.sentAt))}</Td>
                    <Td>{r.channelLabel}</Td>
                    <Td>
                      <Link href={r.href} className="link">
                        {r.customer}
                      </Link>
                    </Td>
                    <Td>
                      {r.agentName}
                      {r.teamName ? <span className="block text-[11.5px] text-[color:var(--color-muted-foreground)]">{r.teamName}</span> : null}
                    </Td>
                    <Td className="whitespace-nowrap">{r.rating === null ? <span className="text-[color:var(--color-muted-foreground)]">No answer</span> : `${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)} ${r.rating}/5`}</Td>
                    {canReadMessages ? <Td className="max-w-80 break-words">{r.comment ?? ""}</Td> : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}

      {report.skipped.length ? (
        <>
          <h2 className="mb-2 text-sm font-semibold">Not asked</h2>
          <Table>
            <thead>
              <tr>
                <Th>Reason</Th>
                <Th>Resolutions</Th>
              </tr>
            </thead>
            <tbody>
              {report.skipped.map((r) => (
                <tr key={r.reason}>
                  <Td>{r.reason}</Td>
                  <Td>{r.count}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ) : null}
    </div>
  );
}

function GroupTable({ title, groups, noun }: { title: string; groups: CsatReportGroup[]; noun: string }) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      <Table>
        <thead>
          <tr>
            <Th>{noun}</Th>
            <Th>Asked</Th>
            <Th>Answered</Th>
            <Th>CSAT</Th>
            <Th>Average</Th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key || "none"}>
              <Td>{g.label}</Td>
              <Td>{g.summary.asked}</Td>
              <Td>
                {g.summary.answered} <span className="text-[11.5px] text-[color:var(--color-muted-foreground)]">({formatCsatPercent(g.summary.responseRate)})</span>
              </Td>
              <Td>{formatCsatPercent(g.summary.csat)}</Td>
              <Td>{average(g.summary)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
