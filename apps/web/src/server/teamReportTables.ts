import { formatDurationShort } from "@/lib/duration";
import { bucketLabel, memberLabel, teamReportQuery, type TeamReportData } from "@/server/teamReport";

/**
 * The Team Report's two selectable tables — Team members and By day — as plain data: columns plus
 * rows of cell values. The page renders exactly these rows and the table export writes exactly these
 * rows, so a downloaded file has the same columns, names, order and values as the table it came from.
 *
 * A cell is what the table shows. Counts stay numbers (Excel can sum them); durations and date ranges
 * are the text on screen ("3d 15h", "7 Sept, 19:23 – 27 Sept, 19:08"). Sorting uses `sort`, the raw
 * value behind each cell, so "3d 15h" sorts as a duration rather than as text.
 */

export type TeamReportTableId = "members" | "days";
export type CellValue = string | number;

export interface ReportTableColumn {
  label: string;
  numeric?: boolean;
}

export interface ReportTableRow {
  key: string;
  cells: CellValue[];
  /** One sortable value per cell. */
  sort: Array<string | number>;
  /** Where the first cell links to, if anywhere. */
  href?: string | null;
  /** A row that is not a person (Unassigned groups), shown quieter. */
  muted?: boolean;
}

export interface ReportTableData {
  id: TeamReportTableId;
  columns: ReportTableColumn[];
  rows: ReportTableRow[];
}

export const formatWhen = (ms: number | null) =>
  ms === null
    ? "—"
    : new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Dhaka",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(ms));

export const formatDuration = (seconds: number) => (seconds > 0 ? formatDurationShort(seconds) : "0m");

export function buildMembersTable(data: TeamReportData): ReportTableData {
  const { filters, result, memberNames } = data;
  return {
    id: "members",
    columns: [
      { label: "Team member" },
      { label: "Groups", numeric: true },
      { label: "Replies", numeric: true },
      { label: "Customer msgs", numeric: true },
      { label: "Missed", numeric: true },
      { label: "Recall", numeric: true },
      { label: "Support time" },
      { label: "First – last" },
    ],
    rows: result.members.map((row) => {
      const unassigned = row.memberId === "UNASSIGNED";
      const name = unassigned ? "Unassigned groups" : memberLabel(row.memberId, memberNames);
      return {
        key: row.memberId,
        cells: [
          name,
          row.groups,
          row.messages,
          row.customerMessages,
          row.missed,
          row.recalled,
          formatDuration(row.activeSeconds),
          row.firstAt ? `${formatWhen(row.firstAt)} – ${formatWhen(row.lastAt)}` : "—",
        ],
        sort: [
          name.toLowerCase(),
          row.groups,
          row.messages,
          row.customerMessages,
          row.missed,
          row.recalled,
          row.activeSeconds,
          row.firstAt ?? 0,
        ],
        href: unassigned ? null : `/team-report?${teamReportQuery(filters, { memberId: row.memberId })}`,
        muted: unassigned,
      };
    }),
  };
}

export function bucketColumnLabel(granularity: string): string {
  return granularity === "day" ? "Date" : granularity === "week" ? "Week" : "Month";
}

export function buildBucketsTable(data: TeamReportData): ReportTableData {
  const { filters, result } = data;
  return {
    id: "days",
    columns: [
      { label: bucketColumnLabel(filters.granularity) },
      { label: "Groups", numeric: true },
      { label: "Team replies", numeric: true },
      { label: "Customer msgs", numeric: true },
      { label: "Missed", numeric: true },
      { label: "Recall", numeric: true },
      { label: "Support time" },
    ],
    rows: result.buckets.map((b) => ({
      key: b.key,
      cells: [
        bucketLabel(b.key, filters.granularity),
        b.groups,
        b.memberMessages + b.businessReplies,
        b.customerMessages,
        b.missed,
        b.recalled,
        formatDuration(b.activeSeconds),
      ],
      // The bucket key (2026-09-01) sorts chronologically, which the label ("1 Sept") would not.
      sort: [b.key, b.groups, b.memberMessages + b.businessReplies, b.customerMessages, b.missed, b.recalled, b.activeSeconds],
    })),
  };
}

export function buildReportTable(id: TeamReportTableId, data: TeamReportData): ReportTableData {
  return id === "members" ? buildMembersTable(data) : buildBucketsTable(data);
}
