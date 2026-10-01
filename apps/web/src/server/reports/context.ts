import { prisma } from "@/server/db";
import {
  loadTeamReport,
  memberLabel,
  parseTeamReportFilters,
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
   * For group-oriented reports (REPORTS.md §3): with a Team or member chosen, a group is in scope when
   * its assigned team member is in that scope during the period, or an in-scope member replied in it.
   * Always true without one.
   */
  groupInScope: (groupKey: string, assignedMemberId: string | null) => boolean;
  groupName: (groupKey: string) => string;
  memberName: (memberId: string | null) => string;
  options: ReportFilterOptions;
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
  const [data, options] = await Promise.all([loadTeamReport(requested, now), loadReportFilterOptions(requested.groupKeys)]);
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
  const repliedInScope = new Set(scoped ? data.result.groups.map((g) => g.groupKey) : []);
  const groupInScope = (groupKey: string, assignedMemberId: string | null) =>
    !scoped || assigneeInScope(assignedMemberId) || repliedInScope.has(groupKey);

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
    groupName: (key) => data.groups.get(key)?.name ?? optionName.get(key) ?? key,
    memberName,
    options,
  };
}

/** The upper bound a "since" figure is measured to: the period's end, or now if it has not ended. */
export const measuredTo = (ctx: ReportContext) => Math.min(ctx.rangeEnd, ctx.now.getTime());
