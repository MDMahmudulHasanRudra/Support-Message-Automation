import { ArrowLeft, Download } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Alert, Button, ButtonLink, Card, FilterBar, HelpButton, HelpSection, Input, PageHeader, SectionHeader } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { loadSheetReport, parseSheetReportFilters, PERIOD_LABELS, REPORT_PERIODS, type SheetReportFilters } from "@/server/google/reports";
import { employeeDaysTable, employeeSheetsTable, employeesTable, sheetMembersTable, sheetsTable, type ReportDrill } from "@/server/google/reportTables";
import { ReportTableView } from "./ReportTableView";
import { ViewChip } from "../ViewChip";

export const metadata = { title: "Spreadsheet Work Reports" };

type View = "employees" | "sheets";

/**
 * Google Sheets → Reports (GOOGLE_SHEETS.md §7, Phases 9–10): the employee report and the sheet report,
 * from one loader and one model, with the same tables in the Excel and CSV exports.
 */
export default async function SheetReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await pageAccess("google_sheets.report", "google_sheets.report", "GOOGLE_SHEETS");
  const params = await searchParams;
  const view: View = params.view === "sheets" ? "sheets" : "employees";
  const filters = parseSheetReportFilters(params);
  // A drill-down narrows the evidence to the one person or the one sheet.
  const scoped: SheetReportFilters = view === "employees" ? { ...filters, spreadsheetId: null } : { ...filters, userId: null };
  const data = await loadSheetReport(scoped);

  const query = (next: Partial<Record<"view" | "period" | "from" | "to" | "user" | "sheet" | "monitored", string>>) => {
    const merged: Record<string, string> = {
      view,
      period: filters.period,
      from: filters.from ?? "",
      to: filters.to ?? "",
      user: view === "employees" ? (filters.userId ?? "") : "",
      sheet: view === "sheets" ? (filters.spreadsheetId ?? "") : "",
      monitored: filters.monitoredOnly ? "1" : "",
      ...next,
    };
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (!value) continue;
      if (key === "view" && value === "employees") continue;
      if (key === "period" && value === "7d") continue;
      if ((key === "from" || key === "to") && merged.period !== "custom") continue;
      qs.set(key, value);
    }
    return qs.toString();
  };
  const href = (next: Parameters<typeof query>[0]) => {
    const q = query(next);
    return `/google-sheets/reports${q ? `?${q}` : ""}`;
  };
  const drillHref = (drill: ReportDrill) => (drill.view === "employees" ? href({ view: "employees", user: drill.user, sheet: "" }) : href({ view: "sheets", sheet: drill.sheet, user: "" }));
  const exportHref = (format: "xlsx" | "csv") => `/api/google-sheets/report-export?${query({})}&format=${format}`;

  const person = view === "employees" && filters.userId ? data.people.get(filters.userId) : null;
  const sheet = view === "sheets" && filters.spreadsheetId ? data.sheetInfo.get(filters.spreadsheetId) : null;

  return (
    <div>
      <PageHeader
        title="Spreadsheet work reports"
        description="Work time, viewing time and changes per employee and per spreadsheet — measured from real interaction in the app, with changes made in Google counted beside them."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink href={exportHref("xlsx")} variant="secondary" size="md">
              <Download className="size-3.5" aria-hidden />
              Excel
            </ButtonLink>
            <ButtonLink href={exportHref("csv")} variant="secondary" size="md">
              <Download className="size-3.5" aria-hidden />
              CSV
            </ButtonLink>
            <HelpButton moduleTitle="Spreadsheet work reports">
              <HelpSection title="Work time">
                <p>
                  Built only from moments somebody actually interacted with an open spreadsheet in the app while able to change it: typing, saving. Two such moments
                  closer than the project&apos;s pause threshold ({data.inactivityMinutes} min) count the time between them; a longer gap is a pause. An open tab nobody
                  touches counts nothing.
                </p>
              </HelpSection>
              <HelpSection title="Viewing time">
                <p>Time present and interacting — scrolling, reading, searching — without working. A monitor&apos;s time is always viewing.</p>
              </HelpSection>
              <HelpSection title="Several spreadsheets at once">
                <p>
                  A person&apos;s time is the union of their stretches across every spreadsheet, so two spreadsheets open together is one person working once. A
                  spreadsheet&apos;s total is the sum of its people&apos;s time on it: three people working an hour together is three hours on that spreadsheet.
                </p>
              </HelpSection>
              <HelpSection title="Edits in Google">
                <p>
                  Changes made in Google directly, read from Google&apos;s record for monitored spreadsheets. Counts only — Google never says how long, so they never add
                  time. Credited to a person only through the Google account they linked as their own; the rest is unattributed.
                </p>
              </HelpSection>
            </HelpButton>
          </div>
        }
      />

      <FilterBar>
        <div className="flex flex-wrap gap-1.5">
          <ViewChip href={href({ view: "employees", sheet: "" })} active={view === "employees"} label="By employee" />
          <ViewChip href={href({ view: "sheets", user: "" })} active={view === "sheets"} label="By spreadsheet" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {REPORT_PERIODS.filter((p) => p !== "custom").map((p) => (
            <ViewChip key={p} href={href({ period: p })} active={filters.period === p} label={PERIOD_LABELS[p]} />
          ))}
        </div>
        <ViewChip href={href({ monitored: filters.monitoredOnly ? "" : "1" })} active={filters.monitoredOnly} label="Monitored spreadsheets only" />
        <form className="flex flex-wrap items-end gap-2" action="">
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="period" value="custom" />
          {filters.userId && view === "employees" ? <input type="hidden" name="user" value={filters.userId} /> : null}
          {filters.spreadsheetId && view === "sheets" ? <input type="hidden" name="sheet" value={filters.spreadsheetId} /> : null}
          {filters.monitoredOnly ? <input type="hidden" name="monitored" value="1" /> : null}
          <label className="text-[12px] text-[color:var(--color-muted-foreground)]">
            From
            <Input type="date" name="from" defaultValue={filters.from ?? ""} className="mt-0.5 h-8 w-40" />
          </label>
          <label className="text-[12px] text-[color:var(--color-muted-foreground)]">
            To
            <Input type="date" name="to" defaultValue={filters.to ?? ""} className="mt-0.5 h-8 w-40" />
          </label>
          <Button type="submit" size="sm" variant={filters.period === "custom" ? "primary" : "secondary"}>
            Custom range
          </Button>
        </form>
      </FilterBar>

      <p className="mb-4 text-[13px] text-[color:var(--color-muted-foreground)]">
        <strong className="text-[color:var(--color-foreground)]">{data.range.label}</strong> · Dhaka days · a pause starts after {data.inactivityMinutes} minutes without interaction
      </p>
      {data.range.note ? (
        <div className="mb-4">
          <Alert tone="info" title={data.range.note} />
        </div>
      ) : null}

      {view === "employees" && filters.userId ? (
        <>
          <Link href={href({ user: "" })} className="mb-3 inline-flex items-center gap-1 text-[13px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
            <ArrowLeft className="size-3.5" aria-hidden />
            Every employee
          </Link>
          <Card className="mb-6">
            <SectionHeader title={person?.name ?? "Unknown login"} description={person?.teamMemberName ? `Team member: ${person.teamMemberName}` : "Not linked to a team member."} />
            <ReportTableView table={employeesTable(data)} drillHref={null} empty="No work or viewing recorded for this person in the period." />
          </Card>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Card>
              <SectionHeader title="Day by day" />
              <ReportTableView table={employeeDaysTable(data, filters.userId)} drillHref={null} empty="No time recorded." />
            </Card>
            <Card>
              <SectionHeader title="Spreadsheet by spreadsheet" />
              <ReportTableView table={employeeSheetsTable(data, filters.userId)} drillHref={drillHref} empty="Nothing recorded." />
            </Card>
          </div>
        </>
      ) : view === "sheets" && filters.spreadsheetId ? (
        <>
          <Link href={href({ sheet: "" })} className="mb-3 inline-flex items-center gap-1 text-[13px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
            <ArrowLeft className="size-3.5" aria-hidden />
            Every spreadsheet
          </Link>
          <Card>
            <SectionHeader
              title={sheet?.name ?? "Spreadsheet"}
              description="Each member's own time on this spreadsheet. Unattributed edits were made in Google by somebody the app cannot name."
            />
            <Link href={`/google-sheets/${filters.spreadsheetId}`} className="mb-3 inline-block text-[13px] font-medium text-[color:var(--color-accent)] hover:underline">
              Open the spreadsheet →
            </Link>
            <ReportTableView table={sheetMembersTable(data, filters.spreadsheetId)} drillHref={drillHref} empty="Nobody worked on or viewed this spreadsheet in the app in the period." />
          </Card>
        </>
      ) : view === "employees" ? (
        <Card>
          <ReportTableView table={employeesTable(data)} drillHref={drillHref} empty="No work or viewing recorded in the period." />
        </Card>
      ) : (
        <Card>
          <ReportTableView table={sheetsTable(data)} drillHref={drillHref} empty="No spreadsheet was worked on or viewed in the period." />
        </Card>
      )}
    </div>
  );
}
