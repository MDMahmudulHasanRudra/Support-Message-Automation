import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Alert, ButtonLink, Card, EmptyState, HelpButton, HelpSection, PageHeader, StatTile } from "@/components/ui";
import { BarList, ChartCard, ColumnChart, Heatmap } from "@/components/charts";
import { reportCatalogueEntry } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { buildReport, reportDefinition, reportExtras, reportQuery } from "@/server/reports";
import { presetLinks } from "@/server/reports/presets";
import { TeamReportFilters } from "../../team-report/TeamReportFilters";
import { ReportDataTable } from "../../team-report/ReportDataTable";

/**
 * Every report at /reports/<id> (REPORTS.md). One page renders whichever report the URL names: the
 * builder decides the figures, this only lays them out — tiles, any chart, tables, notes, and the
 * formulas in Help. Each report checks its own existing permission key; its route belongs to a
 * project feature, so a switched-off feature never reaches this far (the project layout stops it).
 */

const PERIOD_NAMES: Record<string, string> = { day: "Daily", week: "Weekly", month: "Monthly", custom: "Custom range" };

export async function generateMetadata({ params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  return { title: reportCatalogueEntry(report)?.label ?? "Report" };
}

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { report: id } = await params;
  const definition = reportDefinition(id);
  const entry = reportCatalogueEntry(id);
  if (!definition || !entry) notFound();
  await requireAccess(definition.permission);

  const now = new Date();
  const { report, ctx } = await buildReport(id, await searchParams, now);
  const { filters, range, members, teams, teamMemberIds, filterNote } = ctx.data;
  const query = reportQuery(ctx);
  const exportBase = `/api/reports/${id}`;

  return (
    <div>
      <Link href="/reports" className="link mb-3 inline-flex items-center gap-1 text-[13px]">
        <ArrowLeft className="size-3.5" aria-hidden />
        All reports
      </Link>
      <PageHeader
        title={report.title}
        description={`${report.question} ${ctx.scopeText} · ${range.label}.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink href={`${exportBase}/export?${query}&format=csv`}>
              <Download className="size-3.5" aria-hidden />
              CSV
            </ButtonLink>
            <ButtonLink href={`${exportBase}/export?${query}&format=xlsx`}>
              <Download className="size-3.5" aria-hidden />
              Excel
            </ButtonLink>
            <HelpButton moduleTitle={report.title}>
              {report.formulas.map((f) => (
                <HelpSection key={f.title} title={f.title}>
                  <p>{f.text}</p>
                </HelpSection>
              ))}
              <HelpSection title="Where the numbers come from">
                <p>
                  The same stored WhatsApp group messages, waits and support-time rules as the Team Report, for the same
                  filters — so a figure here is a Team Report figure cut another way. A message two of our numbers stored is
                  counted once. Days, weeks (Sunday start) and months are Asia/Dhaka.
                </p>
              </HelpSection>
              <HelpSection title="Team and member filters">
                <p>
                  In group reports, a chosen Team or member includes a group when its assigned team member is in scope, or
                  an in-scope member replied in it during the period. In member reports, a person&apos;s work counts while
                  they were in the chosen Team.
                </p>
              </HelpSection>
            </HelpButton>
          </div>
        }
      />

      <Card className="mb-5 p-4">
        <TeamReportFilters
          period={filters.period}
          date={filters.date}
          from={filters.from}
          to={filters.to}
          memberId={filters.memberId}
          teamId={filters.teamId}
          granularity={filters.granularity}
          members={members}
          teams={teams}
          teamMemberIds={teamMemberIds}
          presets={presetLinks(entry.href, filters, now, reportExtras(ctx))}
          groupOptions={ctx.options.groups}
          groupKeys={filters.groupKeys}
          accounts={ctx.options.accounts}
          accountId={filters.accountId}
          showGranularity={report.usesGranularity}
          selects={report.selects}
        />
      </Card>

      <p className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-[color:var(--color-muted-foreground)]">
        <span>
          Showing: <strong className="font-medium text-[color:var(--color-foreground)]">{ctx.scopeText}</strong>
        </span>
        <span>
          Period: <strong className="font-medium text-[color:var(--color-foreground)]">{PERIOD_NAMES[filters.period]} · {range.label}</strong>
        </span>
        {filters.groupKeys?.length ? (
          <span>
            Groups: <strong className="font-medium text-[color:var(--color-foreground)]">{filters.groupKeys.length}</strong>
          </span>
        ) : null}
        {filters.accountId ? (
          <span>
            Account:{" "}
            <strong className="font-medium text-[color:var(--color-foreground)]">
              {ctx.options.accounts.find((a) => a.id === filters.accountId)?.label ?? "Unknown account"}
            </strong>
          </span>
        ) : null}
      </p>

      {[...(filterNote ? [{ tone: "info" as const, text: filterNote }] : []), ...(range.note ? [{ tone: "warning" as const, text: range.note }] : []), ...report.notes].map((note) => (
        <div key={note.text} className="mb-4">
          <Alert tone={note.tone}>{note.text}</Alert>
        </div>
      ))}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {report.tiles.map((tile) => (
          <StatTile key={tile.label} label={tile.label} value={tile.value} hint={tile.hint} tone={tile.tone} />
        ))}
      </div>

      {report.emptyMessage ? (
        <EmptyState>{report.emptyMessage}</EmptyState>
      ) : (
        <>
          {report.visuals.length ? (
            <section className={`mb-5 grid grid-cols-1 gap-3.5 ${report.visuals.length > 1 ? "lg:grid-cols-2" : ""}`}>
              {report.visuals.map((visual) => (
                <ChartCard key={visual.title} title={visual.title} description={visual.description}>
                  {visual.kind === "columns" ? (
                    <ColumnChart
                      data={visual.data}
                      ariaLabel={`${visual.title} over the period`}
                      unitLabel={visual.unit}
                      labelEvery={Math.max(1, Math.ceil(visual.data.length / 10))}
                    />
                  ) : visual.kind === "bars" ? (
                    <BarList items={visual.items} unitLabel={visual.unit} emptyMessage="Nothing to show for these filters." />
                  ) : (
                    <Heatmap grid={visual.grid} unitLabel={visual.unit} ariaLabel={`${visual.title} by weekday and hour`} />
                  )}
                </ChartCard>
              ))}
            </section>
          ) : null}

          {report.tables.map((table) => (
            <Card key={table.id} className="mb-5">
              <ReportDataTable
                table={table}
                query={query}
                noun={table.noun}
                title={table.title}
                description={table.description}
                exportUrl={`${exportBase}/table-export`}
              />
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
