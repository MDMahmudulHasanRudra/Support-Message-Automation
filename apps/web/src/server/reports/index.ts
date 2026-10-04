import { GENERIC_REPORT_IDS, reportCatalogueEntry, type DatePresetId, type PermissionKey } from "@support-automation/shared";
import { buildCalls, buildHeatmap } from "./activityReports";
import { loadReportContext, type ReportContext } from "./context";
import { buildGroupCoverage, buildGroupTrend, buildInactiveGroups } from "./groupReports";
import { buildDistribution, buildDutyWorkload, buildEmployeeGroups, buildWorkload } from "./memberReports";
import { buildMissedSupport, buildResponseSla } from "./responseReports";
import { teamReportQuery } from "@/server/teamReport";
import type { BuiltReport } from "./types";

/**
 * The reports at /reports/<id>: which builder makes each one and which EXISTING permission key opens
 * it. Every report needs the Team Report's key; Duty & Workload needs Duty History's, since it shows
 * the duty roster. No key was added for any of them.
 */

interface ReportDefinition {
  permission: PermissionKey;
  build: (ctx: ReportContext) => BuiltReport | Promise<BuiltReport>;
  /** The quick-period row, when the report needs its own; otherwise the standard one. */
  presets?: readonly DatePresetId[];
}

/** Inactive Groups asks "silent for how long?", which rolling windows answer directly. */
const INACTIVE_GROUP_PRESETS: readonly DatePresetId[] = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "last_60_days",
  "last_90_days",
  "this_month",
  "last_month",
];

const DEFINITIONS: Record<string, ReportDefinition> = {
  "inactive-groups": { permission: "support_activity.view", build: buildInactiveGroups, presets: INACTIVE_GROUP_PRESETS },
  "group-coverage": { permission: "support_activity.view", build: buildGroupCoverage },
  "group-trend": { permission: "support_activity.view", build: buildGroupTrend },
  "response-sla": { permission: "support_activity.view", build: buildResponseSla },
  missed: { permission: "support_activity.view", build: buildMissedSupport },
  workload: { permission: "support_activity.view", build: buildWorkload },
  distribution: { permission: "support_activity.view", build: buildDistribution },
  "employee-groups": { permission: "support_activity.view", build: buildEmployeeGroups },
  heatmap: { permission: "support_activity.view", build: buildHeatmap },
  calls: { permission: "support_activity.view", build: buildCalls },
  "duty-workload": { permission: "team_management.view", build: buildDutyWorkload },
};

export function reportDefinition(id: string): ReportDefinition | null {
  return GENERIC_REPORT_IDS.includes(id) ? (DEFINITIONS[id] ?? null) : null;
}

export function reportPermission(id: string): PermissionKey | null {
  return reportDefinition(id)?.permission ?? null;
}

export const REPORT_DEFINITION_IDS = Object.keys(DEFINITIONS);

/** Builds a report from URL params. The caller has already checked the permission. */
export async function buildReport(
  id: string,
  params: Record<string, string | undefined>,
  now: Date,
): Promise<{ report: BuiltReport; ctx: ReportContext }> {
  const definition = reportDefinition(id);
  if (!definition || !reportCatalogueEntry(id)) throw new Error(`Unknown report: ${id}`);
  const ctx = await loadReportContext(params, now);
  return { report: await definition.build(ctx), ctx };
}

export type { BuiltReport, ReportTable } from "./types";
export type { ReportContext } from "./context";

/** A report's own extra filters, carried through presets, links and exports. */
export const REPORT_EXTRA_PARAMS = ["status", "metric", "low"] as const;

/** The query string that reproduces this report: the common filters plus its own extra ones. */
export function reportQuery(ctx: ReportContext): string {
  const qs = new URLSearchParams(teamReportQuery(ctx.filters));
  for (const name of REPORT_EXTRA_PARAMS) {
    const value = ctx.params[name];
    if (value) qs.set(name, value);
  }
  return qs.toString();
}

export function reportExtras(ctx: ReportContext): Record<string, string | undefined> {
  return Object.fromEntries(REPORT_EXTRA_PARAMS.map((name) => [name, ctx.params[name]]));
}
