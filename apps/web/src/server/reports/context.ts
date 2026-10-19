import { prisma } from "@/server/db";
import { loadDataHealth, type ReportDataHealth } from "@/server/dataHealth";
import {
  loadTeamReport,
  memberLabel,
  parseTeamReportFilters,
  resolveTeamReportRange,
  scopeLabel,
  type TeamReportData,
  type TeamReportFilters,
} from "@/server/teamReport";

/**
 * Everything a report at /reports/<id> starts from: the Team Report's own dataset for the URL's
 * filters (`loadTeamReport` — classified messages, waits, scope), plus the two group-level facts it
 * does not carry. Every report cuts this one dataset; none re-reads messages its own way, except the
 * three that need a column the dataset deliberately leaves out (a message's text, a group's last
 * message before the period, and the duty roster).
 */

export interface ReportFilterOptions {
  groups: Array<{ whatsappGroupId: string; name: string; isMonitored: boolean }>;
  accounts: Array<{ id: string; label: string; phoneNumber: string | null }>;
}

export interface ReportContext {
  params: Record<string, string | undefined>;
  now: Date;
  filters: TeamReportFilters;
  data: TeamReportData;
  rangeStart: number;
  rangeEnd: number;
  idleGapMs: number;
  /** "Support Team · All members" — the report's scope in words. */
  scopeText: string;
  /** Whether a Team or member filter is in effect. */
  scoped: boolean;
  /**
   * For group-oriented reports (REPORTS.md §3), with a Team or member chosen: a group with messages in
   * the period is in scope exactly when the Team Report's scoped group rows include it (an in-scope
   * member replied there, was its assignee when a customer asked, or answered a wait there late); a
   * group with no message in the period (Inactive Groups) when its assignee today is in scope.
   * Always true without one.
   */
  groupInScope: (groupKey: string, assignedMemberId: string | null) => boolean;
  /**
   * Whether a Missed (late or never answered) wait belongs to this report: always without a Team or
   * member chosen; with one, when the wait's assignee AT THE TIME (`chargedTo`) was in scope — the
   * Team Report's Missed rule. Answered-in-time and still-waiting waits are not charged to anybody.
   */
  missedInScope: (wait: { chargedTo: string | null; askedAt: number; status: string }) => boolean;
  groupName: (groupKey: string) => string;
  memberName: (memberId: string | null) => string;
  options: ReportFilterOptions;
  /** How far this period's figures can be trusted: verified-from and collection gaps. */
  dataHealth: ReportDataHealth;
}

/** The groups and accounts the filter pickers offer — active groups, one row per WhatsApp group. */
export async function loadReportFilterOptions(selectedGroupKeys: readonly string[] = []): Promise<ReportFilterOptions> {
  const [groupRows, accounts] = await Promise.all([
    prisma.whatsAppGroup.findMany({
      where: { OR: [{ isActive: true }, ...(selectedGroupKeys.length ? [{ whatsappGroupId: { in: [...selectedGroupKeys] } }] : [])] },
      select: { whatsappGroupId: true, name: true, isMonitored: true, account: { select: { isPrimary: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.whatsAppAccount.findMany({
      select: { id: true, label: true, phoneNumber: true },
      orderBy: [{ isPrimary: "desc" }, { label: "asc" }],
    }),
  ]);
  const groups = new Map<string, { whatsappGroupId: string; name: string; isMonitored: boolean }>();
  for (const row of groupRows) {
    const existing = groups.get(row.whatsappGroupId);
    if (!existing || row.account.isPrimary) {
      groups.set(row.whatsappGroupId, {
        whatsappGroupId: row.whatsappGroupId,
        name: row.name,
        isMonitored: row.isMonitored || (existing?.isMonitored ?? false),
      });
    } else if (row.isMonitored) existing.isMonitored = true;
  }
  return {
    groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
    accounts,
  };
}

export async function loadReportContext(params: Record<string, string | undefined>, now: Date): Promise<ReportContext> {
  const requested = parseTeamReportFilters(params, now);
  const requestedRange = resolveTeamReportRange(requested, now);
  const [data, options, dataHealth] = await Promise.all([
    // An export carries the page's moment: read only what was stored by then (exportStoredBy).
    loadTeamReport(requested, now, undefined, params.asof ? { storedBy: now } : {}),
    loadReportFilterOptions(requested.groupKeys),
    loadDataHealth({ periodStart: requestedRange.start.getTime(), periodEnd: requestedRange.end.getTime(), now, accountId: requested.accountId }),
  ]);
  const { filters, range, memberNames, teamName, teamMemberIds } = data;
  const memberName = (id: string | null) => memberLabel(id, memberNames);
  const scoped = Boolean(filters.teamId || filters.memberId);

  // Who counts as "in scope" for a group's assignee: anyone who was in the chosen Team at some point
  // of the period (the Team Report's own member list for that Team), narrowed to the chosen member.
  const assigneeInScope = (id: string | null) => {
    if (!id) return false;
    if (filters.memberId && id !== filters.memberId) return false;
    if (filters.teamId) return (teamMemberIds[filters.teamId] ?? []).includes(id);
    return true;
  };
  const reportGroups = new Set(scoped ? data.result.groups.map((g) => g.groupKey) : []);
  const groupInScope = (groupKey: string, assignedMemberId: string | null) =>
    !scoped || (data.groups.has(groupKey) ? reportGroups.has(groupKey) : assigneeInScope(assignedMemberId));
  const missedInScope = (wait: { chargedTo: string | null; askedAt: number; status: string }) =>
    !scoped ||
    (wait.status !== "RECALLED" && wait.status !== "MISSED") ||
    (wait.chargedTo !== null && data.scope !== null && data.scope(wait.chargedTo, wait.askedAt));

  const optionName = new Map(options.groups.map((g) => [g.whatsappGroupId, g.name]));
  return {
    params,
    now,
    filters,
    data,
    rangeStart: range.start.getTime(),
    rangeEnd: range.end.getTime(),
    idleGapMs: data.rules.idleGapMinutes * 60_000,
    scopeText: scopeLabel(teamName, filters.memberId ? memberName(filters.memberId) : null),
    scoped,
    groupInScope,
    missedInScope,
    groupName: (key) => data.groups.get(key)?.name ?? optionName.get(key) ?? key,
    memberName,
    options,
    dataHealth,
  };
}

/** The upper bound a "since" figure is measured to: the period's end, or now if it has not ended. */
export const measuredTo = (ctx: ReportContext) => Math.min(ctx.rangeEnd, ctx.now.getTime());
