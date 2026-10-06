import { formatResponseDuration, formatSlaCompliance, SUPPORT_ASSIGNMENT_STATUS_LABELS, SUPPORT_ASSIGNMENT_STATUSES } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Alert, Button, ButtonLink, Card, EmptyState, Field, FilterBar, HelpButton, HelpSection, Input, PageHeader, SectionHeader, Select, StatTile, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { requireAccess } from "@/server/authorize";
import { getAssignmentFilterOptions } from "@/server/supportAssignment";
import { loadSupportAssignmentReport, parseReportFilters, REPORT_PRESETS } from "@/server/supportAssignmentReport";
import { AssignmentBadge } from "../AssignmentBadge";

/** Rows of the case list drawn on the page; the export always carries every one. */
const CASES_ON_PAGE = 300;
const num = (n: number) => n.toLocaleString("en-US");

/**
 * Support Assignment → Report, also listed under Reports → All Reports (SUPPORT_ASSIGNMENT.md). One
 * page, reached two ways; the figures come from `computeSupportAssignmentReport`, which the exports
 * call too.
 */
export default async function SupportAssignmentReportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAccess("support_assignment.view");
  const params = await searchParams;
  const now = new Date();
  const filters = parseReportFilters(params, now);
  const [{ report, cases, memberNames, truncated }, options] = await Promise.all([loadSupportAssignmentReport(filters), getAssignmentFilterOptions()]);
  const s = report.summary;

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) query.set(k, v);
  const exportHref = (format: "xlsx" | "csv") => {
    const q = new URLSearchParams(query);
    q.set("format", format);
    return `/api/support-assignment/report/export?${q.toString()}`;
  };

  return (
    <div>
      <PageHeader
        title="Support Assignment Report"
        description={`Cases opened ${filters.rangeLabel} (Dhaka time): who was given which customer, and whether they answered in time.`}
        actions={
          <div className="flex gap-2">
            <ButtonLink href={exportHref("csv")}>CSV</ButtonLink>
            <ButtonLink href={exportHref("xlsx")}>Excel</ButtonLink>
            <HelpButton moduleTitle="Support Assignment Report">
              <HelpSection title="Which cases">
                <p>Cases that opened in the period — when the customer first wrote — and everything that happened to them since.</p>
              </HelpSection>
              <HelpSection title="SLA compliance">
                <p>
                  Completed by the assignee at or before the deadline, out of every assigned case whose outcome is known: completed
                  (on time or late), still overdue, or closed some other way after its deadline. A case not due yet, or answered by
                  somebody else before its deadline, is not counted either way.
                </p>
              </HelpSection>
              <HelpSection title="Per employee">
                <p>
                  Assigned counts every time a case was given to that person, including reassignments to them. Overdue counts the times
                  a case went overdue while it was theirs. Completed, pending and response time are the cases still theirs at the end.
                </p>
              </HelpSection>
            </HelpButton>
          </div>
        }
      />

      <form method="get">
        <FilterBar>
          <Field label="Period">
            <Select name="preset" defaultValue={filters.preset}>
              {REPORT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From (custom)">
            <Input name="from" type="date" defaultValue={filters.preset === "custom" ? filters.from : ""} />
          </Field>
          <Field label="To (custom)">
            <Input name="to" type="date" defaultValue={filters.preset === "custom" ? filters.to : ""} />
          </Field>
          <Field label="Employee">
            <Select name="memberId" defaultValue={filters.memberId}>
              <option value="">Everyone</option>
              {options.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Group">
            <Input name="group" defaultValue={filters.group} placeholder="Name contains" />
          </Field>
          <Field label="Status">
            <Select name="status" defaultValue={filters.status}>
              <option value="">Any</option>
              {SUPPORT_ASSIGNMENT_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {SUPPORT_ASSIGNMENT_STATUS_LABELS[st]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="SLA">
            <Select name="sla" defaultValue={filters.sla}>
              <option value="">Any</option>
              <option value="met">Met</option>
              <option value="missed">Missed</option>
            </Select>
          </Field>
          <div className="flex gap-2">
            <Button type="submit">Apply</Button>
            <ButtonLink href="/support-assignment/report">Reset</ButtonLink>
          </div>
        </FilterBar>
      </form>

      {filters.rangeCapped ? (
        <div className="mb-4">
          <Alert tone="info">A custom range is limited to 92 days; this report shows the first 92.</Alert>
        </div>
      ) : null}
      {truncated ? (
        <div className="mb-4">
          <Alert tone="warning">More than 20,000 cases opened in this period; only the first 20,000 are counted. Narrow the period for exact figures.</Alert>
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Support cases" value={num(s.total)} hint={`${num(s.ignored)} filtered out`} />
        <StatTile label="Unassigned" value={num(s.unassigned)} tone={s.unassigned ? "warning" : "neutral"} />
        <StatTile label="Assigned" value={num(s.assigned)} />
        <StatTile label="Completed" value={num(s.completed)} tone="success" hint={`${num(s.answeredByOther)} answered by someone else`} />
        <StatTile label="Pending" value={num(s.pending)} />
        <StatTile label="Overdue" value={num(s.overdue)} tone={s.overdue ? "danger" : "neutral"} />
        <StatTile label="Average response" value={s.avgResponseSeconds === null ? "—" : formatResponseDuration(s.avgResponseSeconds)} hint="Assigned → assignee's reply" />
        <StatTile label="SLA compliance" value={formatSlaCompliance(s.sla)} hint={s.sla.measured ? `${num(s.sla.met)} of ${num(s.sla.measured)} on time` : "Nothing measured yet"} />
        <StatTile label="Cancelled" value={num(s.cancelled)} />
        <StatTile label="Ignored / filtered" value={num(s.ignored)} hint="Only ignored words or senders" />
      </div>

      <Card className="mb-5">
        <SectionHeader title="Employee performance" description="Every person a case was given to in this period." />
        {report.employees.length === 0 ? (
          <EmptyState>No case was assigned in this period.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th>Assigned</Th>
                <Th>Completed</Th>
                <Th>Pending</Th>
                <Th>Overdue</Th>
                <Th>Answered by others</Th>
                <Th>Reassigned away</Th>
                <Th>Avg response</Th>
                <Th>SLA</Th>
              </tr>
            </thead>
            <tbody>
              {report.employees.map((e) => (
                <tr key={e.memberId}>
                  <Td className="font-medium">
                    <Link href={`/support-assignment/report?${new URLSearchParams({ ...Object.fromEntries(query), memberId: e.memberId }).toString()}`} className="hover:underline">
                      {memberNames.get(e.memberId) ?? "(removed member)"}
                    </Link>
                  </Td>
                  <Td className="tabular">{num(e.assigned)}</Td>
                  <Td className="tabular">{num(e.completed)}</Td>
                  <Td className="tabular">{num(e.pending)}</Td>
                  <Td className={`tabular ${e.overdue ? "text-[color:var(--color-danger-fg)]" : ""}`}>{num(e.overdue)}</Td>
                  <Td className="tabular">{num(e.answeredByOther)}</Td>
                  <Td className="tabular">{num(e.reassignedAway)}</Td>
                  <Td className="tabular">{e.avgResponseSeconds === null ? "—" : formatResponseDuration(e.avgResponseSeconds)}</Td>
                  <Td className="tabular">{formatSlaCompliance(e.sla)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mb-5">
        <SectionHeader title="Group performance" description="Support cases per WhatsApp group (per account), most first." />
        {report.groups.length === 0 ? (
          <EmptyState>No support case opened in this period.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Group</Th>
                <Th>Cases</Th>
                <Th>Completed</Th>
                <Th>Answered by others</Th>
                <Th>Still open</Th>
                <Th>Overdue</Th>
                <Th>Avg response</Th>
              </tr>
            </thead>
            <tbody>
              {report.groups.map((g) => (
                <tr key={g.groupId}>
                  <Td className="font-medium">{g.groupName}</Td>
                  <Td className="tabular">{num(g.cases)}</Td>
                  <Td className="tabular">{num(g.completed)}</Td>
                  <Td className="tabular">{num(g.answeredByOther)}</Td>
                  <Td className="tabular">{num(g.open)}</Td>
                  <Td className={`tabular ${g.overdue ? "text-[color:var(--color-danger-fg)]" : ""}`}>{num(g.overdue)}</Td>
                  <Td className="tabular">{g.avgResponseSeconds === null ? "—" : formatResponseDuration(g.avgResponseSeconds)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <SectionHeader
          title="Cases"
          description={cases.length > CASES_ON_PAGE ? `The first ${CASES_ON_PAGE} of ${num(cases.length)}; the export has every one.` : "Every case behind the figures above."}
        />
        {cases.length === 0 ? (
          <EmptyState>No case matches these filters.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Status</Th>
                <Th>Group</Th>
                <Th>Opened</Th>
                <Th>Assigned to</Th>
                <Th>Answered by</Th>
                <Th>Response</Th>
                <Th>SLA</Th>
              </tr>
            </thead>
            <tbody>
              {cases.slice(0, CASES_ON_PAGE).map((c) => (
                <tr key={c.id}>
                  <Td>
                    <AssignmentBadge status={c.status} />
                  </Td>
                  <Td>
                    <Link href={`/support-assignment/${c.id}`} className="font-medium hover:underline">
                      {c.groupName}
                    </Link>
                    <div className="max-w-[18rem] truncate text-[11px] text-[color:var(--color-muted-foreground)]">{c.message ?? ""}</div>
                  </Td>
                  <Td className="whitespace-nowrap text-[13px]">{formatDateTime(c.openedAt)}</Td>
                  <Td className="text-[13px]">{c.assignedTo ?? "—"}</Td>
                  <Td className="text-[13px]">{c.answeredBy ?? "—"}</Td>
                  <Td className="tabular text-[13px]">{c.responseSeconds === null ? "—" : formatResponseDuration(c.responseSeconds)}</Td>
                  <Td className="text-[13px]">{c.sla === "MET" ? "Met" : c.sla === "MISSED" ? <span className="text-[color:var(--color-danger-fg)]">Missed</span> : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
