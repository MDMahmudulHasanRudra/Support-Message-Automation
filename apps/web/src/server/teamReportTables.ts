import { formatDurationShort } from "@/lib/duration";
import { conversationPath } from "@/lib/chatConversationType";
import { bucketLabel, memberLabel, teamReportQuery, type TeamReportData } from "@/server/teamReport";
import type { PersonalReportData } from "@/server/personalReport";

/**
 * The Team Report's three selectable tables — Team members, By day and Groups — as plain data: columns plus
 * rows of cell values. The page renders exactly these rows and the table export writes exactly these
 * rows, so a downloaded file has the same columns, names, order and values as the table it came from.
 *
 * A cell is what the table shows. Counts stay numbers (Excel can sum them); durations and date ranges
 * are the text on screen ("3d 15h", "7 Sept, 19:23 – 27 Sept, 19:08"). Sorting uses `sort`, the raw
 * value behind each cell, so "3d 15h" sorts as a duration rather than as text.
 */

export type TeamReportTableId = "members" | "days" | "groups";
export type CellValue = string | number;

export interface ReportTableColumn {
  label: string;
  numeric?: boolean;
  /** Shown in the quieter text colour (date ranges), as the original tables did. */
  muted?: boolean;
  /** Explains the column on hover / focus of its header. Presentation only; never exported. */
  hint?: string;
}

/** The Support Overtime column's explanation, shared by every table that shows it. */
export const OVERTIME_COLUMN_HINT = "Support time beyond the person's regular duty, worked out per day and added up. Only overtime is shown.";

export interface ReportTableRow {
  key: string;
  cells: CellValue[];
  /** One sortable value per cell. */
  sort: Array<string | number>;
  /** Where the first cell links to, if anywhere. */
  href?: string | null;
  /** A row that is not a person (Unassigned groups), shown quieter. */
  muted?: boolean;
  /**
   * Small secondary text shown under a cell on screen (a group's WhatsApp id, "+3 business"). Part
   * of the cell's presentation, not a column, so it is not exported as one.
   */
  sub?: Array<string | null>;
}

export interface ReportTableData {
  /** Which table: a TeamReportTableId on the Team Report, a report's own table id elsewhere. */
  id: string;
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

export const formatDuration = (seconds: number) => formatDurationShort(seconds);

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
      { label: "Support Overtime", hint: OVERTIME_COLUMN_HINT },
      { label: "First – last", muted: true },
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
          formatDuration(row.overtimeSeconds),
          row.firstAt ? `${formatWhen(row.firstAt)} – ${formatWhen(row.lastAt)}` : "—",
        ],
        sort: [
          name.toLowerCase(),
          row.groups,
          row.messages,
          row.customerMessages,
          row.missed,
          row.recalled,
          row.overtimeSeconds,
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
      { label: "Replies (incl. business)", numeric: true, hint: "Team members' replies plus the business number's" },
      { label: "Customer msgs", numeric: true },
      { label: "Missed", numeric: true },
      { label: "Recall", numeric: true },
      { label: "Support Overtime", hint: OVERTIME_COLUMN_HINT },
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
        formatDuration(b.overtimeSeconds),
      ],
      // The bucket key (2026-09-01) sorts chronologically, which the label ("1 Sept") would not.
      sort: [b.key, b.groups, b.memberMessages + b.businessReplies, b.customerMessages, b.missed, b.recalled, b.overtimeSeconds],
    })),
  };
}

export function buildGroupsTable(data: TeamReportData): ReportTableData {
  const { result, groups, memberNames } = data;
  const query = teamReportQuery(data.filters);
  return {
    id: "groups",
    columns: [
      { label: "Group" },
      { label: "Assigned now" },
      { label: "Messages", numeric: true },
      { label: "Customer", numeric: true },
      { label: "Replies", numeric: true },
      { label: "Missed", numeric: true },
      { label: "Recall", numeric: true },
      { label: "First – last support", muted: true },
      {
        label: "Support time",
        hint: "Time team members spent in this group, measured on its own. Overtime belongs to a person's day, not a group.",
      },
    ],
    rows: result.groups.map((row) => {
      const meta = groups.get(row.groupKey);
      const name = meta?.name ?? row.groupKey;
      const assigned = meta?.assignedMemberId ? memberLabel(meta.assignedMemberId, memberNames) : "—";
      return {
        key: row.groupKey,
        cells: [
          name,
          assigned,
          row.totalMessages,
          row.customerMessages,
          row.memberReplies,
          row.missed,
          row.recalled,
          row.firstActivityAt ? `${formatWhen(row.firstActivityAt)} – ${formatWhen(row.lastActivityAt)}` : "—",
          formatDuration(row.activeSeconds),
        ],
        sort: [
          name.toLowerCase(),
          assigned === "—" ? "~" : assigned.toLowerCase(),
          row.totalMessages,
          row.customerMessages,
          row.memberReplies,
          row.missed,
          row.recalled,
          row.firstActivityAt ?? 0,
          row.activeSeconds,
        ],
        // The page's own moment travels with the link, so the group opens with the figures it was listed with.
        href: meta ? `/team-report/group/${meta.id}?${query}&asof=${data.computedAt}` : null,
        sub: [row.groupKey, null, null, null, row.businessReplies > 0 ? `+${row.businessReplies.toLocaleString("en-US")} business` : null],
      };
    }),
  };
}

export function buildReportTable(id: TeamReportTableId, data: TeamReportData): ReportTableData {
  if (id === "members") return buildMembersTable(data);
  if (id === "days") return buildBucketsTable(data);
  return buildGroupsTable(data);
}

// ---------------------------------------------------------------------------------------------
// Personal chats (UNIFIED_REPORTING, WP6): the same table shape for the three personal tables, built from
// `PersonalReportData`. Counts only and conversation display names — never a message text.
// ---------------------------------------------------------------------------------------------

/** What a chat id is, for a column: a phone number WhatsApp shows, or an id that hides it (a LID). */
export function personalChatTypeLabel(chatId: string): "Phone" | "Hidden number" {
  return chatId.endsWith("@c.us") ? "Phone" : "Hidden number";
}

const NO_TIME = "—";

export function buildPersonalConversationsTable(data: PersonalReportData, opts: { linkToChat: boolean }): ReportTableData {
  return {
    id: "personal-conversations",
    columns: [
      { label: "Conversation" },
      { label: "Account" },
      { label: "Chat type" },
      { label: "Customer msgs", numeric: true },
      { label: "Business replies", numeric: true },
      { label: "Verified employee replies", numeric: true, hint: "Dashboard replies by a login linked to a team member. The only personal figure credited to a person." },
      { label: "Automated replies", numeric: true },
      { label: "Waits", numeric: true },
      { label: "Missed", numeric: true },
      { label: "Recall", numeric: true },
      { label: "Never answered", numeric: true },
      { label: "Median first response" },
      { label: "Waiting now" },
      { label: "First message", muted: true },
      { label: "Last message", muted: true },
    ],
    rows: data.result.conversations.map((row) => {
      const name = data.conversationNames.get(row.conversationKey) ?? row.chatId;
      const account = data.accountLabels.get(row.accountId) ?? "Unknown account";
      const median = row.firstObservedMedianSeconds === null ? NO_TIME : formatDuration(row.firstObservedMedianSeconds);
      const type = personalChatTypeLabel(row.chatId);
      return {
        key: row.conversationKey,
        cells: [
          name,
          account,
          type,
          row.customerMessages,
          row.businessReplies,
          row.verifiedEmployeeReplies,
          row.automatedReplies,
          row.waits,
          row.missed,
          row.recalled,
          row.unrecovered,
          median,
          row.waiting ? "Yes" : "No",
          formatWhen(row.firstAt),
          formatWhen(row.lastAt),
        ],
        sort: [
          name.toLowerCase(),
          account.toLowerCase(),
          type,
          row.customerMessages,
          row.businessReplies,
          row.verifiedEmployeeReplies,
          row.automatedReplies,
          row.waits,
          row.missed,
          row.recalled,
          row.unrecovered,
          row.firstObservedMedianSeconds ?? -1,
          row.waiting ? 1 : 0,
          row.firstAt ?? 0,
          row.lastAt ?? 0,
        ],
        href: opts.linkToChat ? conversationPath(row.accountId, { id: "", kind: "PERSONAL", chatId: row.chatId }) : null,
      };
    }),
  };
}

export function buildPersonalBucketsTable(data: PersonalReportData): ReportTableData {
  const { filters, result } = data;
  return {
    id: "personal-days",
    columns: [
      { label: bucketColumnLabel(filters.granularity) },
      { label: "Customer msgs", numeric: true },
      { label: "Business replies", numeric: true },
      { label: "Verified employee replies", numeric: true },
      { label: "Waits", numeric: true },
      { label: "Missed", numeric: true },
      { label: "Recall", numeric: true },
    ],
    rows: result.buckets.map((b) => ({
      key: b.key,
      cells: [bucketLabel(b.key, filters.granularity), b.customerMessages, b.businessReplies, b.verifiedEmployeeReplies, b.waits, b.missed, b.recalled],
      sort: [b.key, b.customerMessages, b.businessReplies, b.verifiedEmployeeReplies, b.waits, b.missed, b.recalled],
    })),
  };
}

export function buildPersonalMembersTable(data: PersonalReportData): ReportTableData {
  const { filters, result, memberNames } = data;
  return {
    id: "personal-members",
    columns: [
      { label: "Team member" },
      { label: "Verified replies", numeric: true },
      { label: "Conversations", numeric: true },
      { label: "First human responses", numeric: true, hint: "Waits whose first human reply was this person's dashboard reply." },
      { label: "Median first human response" },
    ],
    rows: result.members.map((row) => {
      const name = memberLabel(row.memberId, memberNames);
      return {
        key: row.memberId,
        cells: [name, row.verifiedReplies, row.conversations, row.humanWaitsAnswered, row.medianSeconds === null ? NO_TIME : formatDuration(row.medianSeconds)],
        sort: [name.toLowerCase(), row.verifiedReplies, row.conversations, row.humanWaitsAnswered, row.medianSeconds ?? -1],
        href: `/team-report?${teamReportQuery(filters, { memberId: row.memberId })}`,
      };
    }),
  };
}

export const PERSONAL_TABLE_IDS = ["personal-conversations", "personal-days", "personal-members"] as const;
export type PersonalTableId = (typeof PERSONAL_TABLE_IDS)[number];

export function isPersonalTableId(value: unknown): value is PersonalTableId {
  return typeof value === "string" && (PERSONAL_TABLE_IDS as readonly string[]).includes(value);
}

/** The personal tables by id; the three legacy ids stay on `buildReportTable` and its signature. */
export function buildPersonalReportTable(id: PersonalTableId, data: PersonalReportData, opts: { linkToChat: boolean }): ReportTableData {
  if (id === "personal-conversations") return buildPersonalConversationsTable(data, opts);
  if (id === "personal-days") return buildPersonalBucketsTable(data);
  return buildPersonalMembersTable(data);
}
