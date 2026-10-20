import { Alert, Card } from "@/components/ui";
import { MIN_CLOSED_WAITS_FOR_MEDIAN, type EmployeeAnalytics } from "@support-automation/shared";
import { bucketLabel, memberLabel, teamReportQuery, type TeamReportData } from "@/server/teamReport";
import type { ReportTableData } from "@/server/teamReportTables";
import Link from "@/components/ProjectLink";
import { ReportDataTable } from "./ReportDataTable";

/**
 * Employee ranking, daily engagement and period comparison (UNIFIED_REPORTING, WP10). Rendered only with the
 * feature on; every figure is derived from the report's own dataset (server/employeePerformance.ts), so nothing
 * here can disagree with the Team members table above it.
 */

const oneDecimal = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US");

export function EmployeePerformance({
  report,
  analytics,
  query,
  ranking,
  comparison,
}: {
  report: TeamReportData;
  analytics: EmployeeAnalytics;
  query: string;
  /** Null when one member is chosen: a ranking of one person says nothing. */
  ranking: ReportTableData | null;
  comparison: { table: ReportTableData | null; label: string; note: string | null; partial: boolean } | null;
}) {
  return (
    <>
      {ranking ? (
        <Card className="mb-5">
          <ReportDataTable
            table={ranking}
            query={query}
            noun={{ singular: "team member", plural: "team members" }}
            title="Ranking by measure"
            description={`Each measure is ranked on its own — there is no overall score. Top 3 and the 3 furthest behind are tinted. A person with fewer than ${analytics.minActiveDays} active day${analytics.minActiveDays === 1 ? "" : "s"} in the period, or fewer than ${MIN_CLOSED_WAITS_FOR_MEDIAN} closed waits for the response time, shows "Not enough data" on that measure and is not ranked last. Active days is the sample itself, so it is ranked for anybody who worked. Ties share a rank.`}
          />
        </Card>
      ) : null}

      <Card className="mb-5">
        <DailyEngagementGrid report={report} analytics={analytics} />
      </Card>

      {comparison ? (
        <Card className="mb-5">
          {comparison.table ? (
            <ReportDataTable
              table={comparison.table}
              query={query}
              noun={{ singular: "team member", plural: "team members" }}
              title="Compared with the previous period"
              description={`Before: ${comparison.label} (${comparison.partial ? "this period is still running, so the same number of days just before it" : "the period of equal length just before this one"}). Same filters, same rules. Tinted change = better (fewer for Missed) or worse. A person with no activity in a period has 0 in it.`}
            />
          ) : (
            <Alert tone="info">{comparison.note ?? "There is nothing to compare."}</Alert>
          )}
        </Card>
      ) : null}
    </>
  );
}

function DailyEngagementGrid({ report, analytics }: { report: TeamReportData; analytics: EmployeeAnalytics }) {
  const { daily, days } = analytics;
  const activeDays = daily.dayTotals.filter((n) => n > 0).length;
  const head = "border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3 py-2 text-xs font-medium whitespace-nowrap text-[color:var(--color-muted-foreground)]";
  const cell = "border-b border-[var(--color-border)] px-3 py-2 text-right tabular whitespace-nowrap";
  return (
    <div>
      <h2 className="text-sm font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">Daily engagement</h2>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
        Distinct groups each person engaged on each Asia/Dhaka day. &ldquo;Distinct groups&rdquo; counts a group once however many
        days it was worked; &ldquo;Sum of days&rdquo; adds the days up, so the same group on three days counts three times. The
        bottom row is the distinct groups anyone in scope engaged that day. Minimum for the rankings: {analytics.minActiveDays} active day{analytics.minActiveDays === 1 ? "" : "s"}.
      </p>
      {daily.members.length === 0 ? (
        <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No team member message in this period.</p>
      ) : (
        <div className="max-w-full overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="daily-engagement-grid">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={`${head} sticky left-0 z-[var(--z-sticky)] text-left`}>Team member</th>
                <th className={`${head} text-right`} title="Distinct groups over the whole period: a group worked on three days counts once.">
                  Distinct groups
                </th>
                <th className={`${head} text-right`} title="The daily counts added up: a group worked on three days counts three times.">
                  Sum of days
                </th>
                <th className={`${head} text-right`}>Active days</th>
                <th className={`${head} text-right`} title="Sum of days divided by active days.">
                  Avg / active day
                </th>
                {days.map((day) => (
                  <th key={day} className={`${head} text-right`}>
                    {bucketLabel(day, "day")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {daily.members.map((m) => (
                <tr key={m.memberId}>
                  <td className="sticky left-0 z-[var(--z-sticky)] border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 whitespace-nowrap">
                    <Link className="link" href={`/team-report?${teamReportQuery(report.filters, { memberId: m.memberId })}`}>
                      {memberLabel(m.memberId, report.memberNames)}
                    </Link>
                  </td>
                  <td className={`${cell} font-medium`}>{m.distinctGroups.toLocaleString("en-US")}</td>
                  <td className={cell}>{m.sumOfDays.toLocaleString("en-US")}</td>
                  <td className={cell}>{m.activeDays.toLocaleString("en-US")}</td>
                  <td className={cell}>{m.avgPerActiveDay === null ? "—" : oneDecimal(m.avgPerActiveDay)}</td>
                  {m.perDay.map((n, i) => (
                    <td key={days[i]} className={`${cell} ${n === 0 ? "text-[color:var(--color-subtle-foreground)]" : ""}`}>
                      {n === 0 ? "·" : n}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium">
                <td className="sticky left-0 z-[var(--z-sticky)] bg-[var(--color-surface-sunken)] px-3 py-2 whitespace-nowrap">All in scope</td>
                <td className="bg-[var(--color-surface-sunken)] px-3 py-2 text-right tabular">{daily.distinctOverall.toLocaleString("en-US")}</td>
                <td className="bg-[var(--color-surface-sunken)] px-3 py-2 text-right tabular">{daily.sumOfDayTotals.toLocaleString("en-US")}</td>
                <td className="bg-[var(--color-surface-sunken)] px-3 py-2 text-right tabular">{activeDays.toLocaleString("en-US")}</td>
                <td className="bg-[var(--color-surface-sunken)] px-3 py-2 text-right tabular">
                  {activeDays > 0 ? oneDecimal(daily.sumOfDayTotals / activeDays) : "—"}
                </td>
                {daily.dayTotals.map((n, i) => (
                  <td key={days[i]} className="bg-[var(--color-surface-sunken)] px-3 py-2 text-right tabular">
                    {n === 0 ? "·" : n}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
