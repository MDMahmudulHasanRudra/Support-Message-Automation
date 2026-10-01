import { DATE_PRESETS, datePresetParams } from "@support-automation/shared";
import { resolveTeamReportRange, teamReportQuery, type TeamReportFilters } from "@/server/teamReport";

export interface PresetLink {
  id: string;
  label: string;
  href: string;
  active: boolean;
}

/**
 * The quick-period links above a report's filters. Each is the same report with only the period
 * changed (every other filter, and the report's own extra ones in `keep`, carried through), and it is
 * lit when it resolves to exactly the period on screen — so a hand-picked "Monthly, September" lights
 * "Last month" in October, because that is what it is.
 */
export function presetLinks(
  basePath: string,
  filters: TeamReportFilters,
  now: Date,
  keep: Record<string, string | undefined> = {},
): PresetLink[] {
  const current = resolveTeamReportRange(filters, now);
  const extra = new URLSearchParams(
    Object.entries(keep).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""),
  ).toString();
  return DATE_PRESETS.map(({ id, label }) => {
    const p = datePresetParams(id, now);
    const next: TeamReportFilters = { ...filters, period: p.period, date: p.date ?? filters.date, from: p.from ?? filters.from, to: p.to ?? filters.to };
    const range = resolveTeamReportRange(next, now);
    return {
      id,
      label,
      href: `${basePath}?${teamReportQuery(next)}${extra ? `&${extra}` : ""}`,
      active: next.period === filters.period && range.start.getTime() === current.start.getTime() && range.end.getTime() === current.end.getTime(),
    };
  });
}
