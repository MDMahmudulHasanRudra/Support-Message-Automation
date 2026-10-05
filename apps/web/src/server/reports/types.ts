import type { ReportTableData } from "@/server/teamReportTables";

/**
 * What a report at /reports/<id> is, once built: summary tiles, an optional visual, tables, notes
 * and the formulas behind it. The page renders exactly this, and the export writes exactly this —
 * the same object from the same builder — so a file cannot disagree with the screen.
 */

export type ReportTone = "neutral" | "success" | "warning" | "danger" | "accent";

export interface ReportTile {
  label: string;
  value: string;
  hint?: string;
  tone?: ReportTone;
}

export interface ReportTable extends ReportTableData {
  title: string;
  description: string;
  noun: { singular: string; plural: string };
  /** Which export sheet it goes on: the main table is Detailed, the rest are Breakdown. */
  sheet: "Detailed" | "Breakdown";
}

export type ReportVisual =
  | { kind: "columns"; title: string; description: string; unit: string; data: Array<{ label: string; value: number }> }
  | { kind: "bars"; title: string; description: string; unit: string; items: Array<{ id: string; label: string; value: number }> }
  | { kind: "heatmap"; title: string; description: string; unit: string; grid: number[][] };

/** An extra filter a report adds to the common ones (a metric, a status, a threshold). */
export interface ReportSelect {
  name: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
}

export interface BuiltReport {
  id: string;
  title: string;
  question: string;
  tiles: ReportTile[];
  visuals: ReportVisual[];
  tables: ReportTable[];
  /** Plain sentences shown above the figures — data limits, applied defaults, honesty notes. */
  notes: Array<{ tone: "info" | "warning"; text: string }>;
  /** The formulas, in the page's words; also written into the export's Summary sheet. */
  formulas: Array<{ title: string; text: string }>;
  selects: ReportSelect[];
  /** Whether the "Break down by" filter means anything for this report. */
  usesGranularity: boolean;
  /** Shown instead of tables and visuals when the dataset is empty. */
  emptyMessage: string | null;
  /**
   * False for a report about something other than WhatsApp team members (the software users of the
   * User Activity report): the Team and member pickers and the "Showing" scope are hidden, since they
   * would filter nothing. Absent means true — every other report renders exactly as before.
   */
  usesMemberFilters?: boolean;
  /** Replaces the page Help's "where the numbers come from" text when the report reads other data. */
  sourceHelp?: string;
}
