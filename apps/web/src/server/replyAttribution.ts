import { computeReplyAttribution, type ReplyAttributionResult } from "@support-automation/shared";
import { LOOKAHEAD_MS, type TeamReportData } from "@/server/teamReport";

/**
 * Customer-specific reply attribution for a loaded Team Report (UNIFIED_REPORTING, WP7): the evidence the
 * loader collected (`withReplyEvidence`) through the pure `computeReplyAttribution`. It covers the groups the
 * report is answerable for — the same set the response measures use — and, with `detailGroupKey`, fills the
 * per-ask list of that one group. Null when the report was loaded without evidence (the feature is off).
 */
export function customerSpecificReplies(report: TeamReportData, opts: { detailGroupKey?: string } = {}): ReplyAttributionResult | null {
  if (!report.replyEvidence) return null;
  const reportGroups = new Set(report.result.groups.map((g) => g.groupKey));
  // The drill-down loaded one group on purpose; every other view reads the groups it reports on.
  const evidence = opts.detailGroupKey ? report.replyEvidence : report.replyEvidence.filter((m) => reportGroups.has(m.groupKey));
  return computeReplyAttribution(evidence, {
    rangeStart: report.range.start.getTime(),
    rangeEnd: report.range.end.getTime(),
    measuredTo: Math.min(report.computedAt, report.range.end.getTime() + LOOKAHEAD_MS),
    thresholdMs: (groupKey, at) => report.missedAfterMs(groupKey, at),
    ...(opts.detailGroupKey ? { detailGroupKey: opts.detailGroupKey } : {}),
  });
}
