import { combineReportSummaries, type CombinedLine } from "@support-automation/shared";
import { loadPersonalReport, type PersonalReportData } from "@/server/personalReport";
import { loadTeamReport, type TeamReportData, type TeamReportFilters } from "@/server/teamReport";

/**
 * Groups and personal chats side by side (UNIFIED_REPORTING `scope=combined`, 05 §4). The two reports
 * are loaded independently — the group one with exactly the SQL and filters it has always had — and
 * only then set beside each other by `combineReportSummaries`, so a combined run can never change a
 * group figure: the `group` half is byte-for-byte what `scope=group` returns.
 */
export interface CombinedReportData {
  group: TeamReportData;
  personal: PersonalReportData;
  lines: CombinedLine[];
}

export async function loadCombinedReport(filters: TeamReportFilters, now: Date, options: { storedBy?: Date } = {}): Promise<CombinedReportData> {
  const [group, personal] = await Promise.all([
    loadTeamReport(filters, now, undefined, { ...options, keepHumanWaits: true }),
    loadPersonalReport(filters, now, options),
  ]);
  return { group, personal, lines: combinedLines(group, personal) };
}

/** The combined table for two already-loaded halves (also used by tests). */
export function combinedLines(group: TeamReportData, personal: PersonalReportData): CombinedLine[] {
  // The waits behind `group.response`: only the groups the report is answerable for (computeResponseMetrics' own filter).
  const reportGroups = new Set(group.result.groups.map((g) => g.groupKey));
  return combineReportSummaries({
    group: {
      summary: group.result.summary,
      response: group.response,
      waits: group.result.waits.filter((w) => reportGroups.has(w.groupKey)),
      humanWaits: group.humanWaitList ?? [],
      groupsWithMessages: group.result.groups.length,
    },
    personal: personal.result,
  });
}
