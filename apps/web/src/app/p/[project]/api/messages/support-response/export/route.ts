import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { excelDhakaSerial, formatResponseDuration, sanitizeExcelCell, SUPPORT_EPISODE_STATUS_LABELS } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import {
  parseResponseFilters,
  parseUnansweredFilters,
  responsesForExport,
  SUPPORT_RESPONSE_MAX_SELECTION,
  unansweredForExport,
} from "@/server/supportResponse";

/**
 * Excel / CSV export for Messages → Unanswered Groups and Response Time (SUPPORT_RESPONSE.md).
 *
 * POST, because a selection of a thousand ids does not fit a URL. The browser sends the tab's
 * filters and either the selected ids or nothing (= every row matching the filters); the rows are
 * read here, through the project-scoped client and the same `where` the page used, so a file can
 * never hold a row the person could not see on the page. Nothing is held in the browser.
 *
 * Dates are written as real Excel date-times (Dhaka wall clock), durations both as text and as
 * seconds, so the file sorts and sums.
 */

type Cell = string | number | null;
interface Column {
  label: string;
  /** "date" cells get a date format; everything else is a plain value. */
  kind?: "date";
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const date = (d: Date | null): Cell => (d ? excelDhakaSerial(d) : null);
const textCell = (s: string | null | undefined): Cell => (s ? sanitizeExcelCell(s) : null);

const UNANSWERED_COLUMNS: Column[] = [
  { label: "Account" },
  { label: "Group Name" },
  { label: "Group ID" },
  { label: "First Unanswered Message Time", kind: "date" },
  { label: "Latest Unanswered Message Time", kind: "date" },
  { label: "Waiting Duration" },
  { label: "Waiting (seconds)" },
  { label: "Unanswered Message Count" },
  { label: "Latest Sender" },
  { label: "Latest Message" },
  { label: "Status" },
  { label: "Cleared At", kind: "date" },
  { label: "Cleared By" },
  { label: "Clear Reason" },
  { label: "Episode ID" },
];

const RESPONSE_COLUMNS: Column[] = [
  { label: "Account" },
  { label: "Group Name" },
  { label: "Group ID" },
  { label: "First Incoming Message Time", kind: "date" },
  { label: "Support Reply Time", kind: "date" },
  { label: "Response Duration" },
  { label: "Response (seconds)" },
  { label: "Response (minutes)" },
  { label: "Support Team Member" },
  { label: "Support Member ID" },
  { label: "Support Team" },
  { label: "Support Reply Message" },
  { label: "Incoming Message Count" },
  { label: "WhatsApp Account" },
  { label: "Response Episode ID" },
  { label: "Created At", kind: "date" },
];

function toCsv(columns: Column[], rows: Cell[][]): string {
  const render = (value: Cell, column: Column) => {
    if (value === null) return "";
    if (column.kind === "date" && typeof value === "number") {
      // Back from the serial to a Dhaka wall-clock text for CSV.
      return new Date((value - 25_569) * 86_400_000 - 6 * 3_600_000).toLocaleString("en-GB", { timeZone: "Asia/Dhaka" });
    }
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return "﻿" + [columns.map((c) => c.label).join(","), ...rows.map((row) => row.map((v, i) => render(v, columns[i]!)).join(","))].join("\r\n");
}

function toXlsx(sheetName: string, columns: Column[], rows: Cell[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([columns.map((c) => c.label), ...rows]);
  columns.forEach((column, c) => {
    if (column.kind !== "date") return;
    for (let r = 1; r <= rows.length; r++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === "number") cell.z = "yyyy-mm-dd hh:mm:ss";
    }
  });
  sheet["!cols"] = columns.map((c) => ({ wch: Math.min(48, Math.max(12, c.label.length + 2)) }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Refused out loud rather than cut short: a file that silently stops at row 5,000 reads as complete. */
function tooMany(): NextResponse {
  return new NextResponse(
    `More than ${SUPPORT_RESPONSE_MAX_SELECTION.toLocaleString("en-US")} rows match. Narrow the filters (a date range, an account) and export in parts.`,
    { status: 413 },
  );
}

export async function POST(request: NextRequest) {
  await requireAccess("messages.view");
  let body: { tab?: unknown; ids?: unknown; query?: unknown; format?: unknown };
  try {
    body = await request.json();
  } catch {
    return new NextResponse("The export request was not readable.", { status: 400 });
  }
  const tab = body.tab === "response-time" ? "response-time" : body.tab === "unanswered" ? "unanswered" : null;
  if (!tab) return new NextResponse("Unknown tab.", { status: 400 });
  const format = body.format === "csv" ? "csv" : "xlsx";
  const query = (body.query && typeof body.query === "object" ? body.query : {}) as Record<string, string>;
  let ids: string[] | null = null;
  if (Array.isArray(body.ids)) {
    if (body.ids.length > SUPPORT_RESPONSE_MAX_SELECTION) {
      return new NextResponse(`That is ${body.ids.length.toLocaleString("en-US")} rows; one export takes at most ${SUPPORT_RESPONSE_MAX_SELECTION.toLocaleString("en-US")}. Narrow the filters.`, { status: 413 });
    }
    ids = body.ids.filter((id): id is string => typeof id === "string");
    if (ids.length === 0) return new NextResponse("No rows were chosen to export.", { status: 400 });
  }

  const now = new Date();
  let columns: Column[];
  let rows: Cell[][];
  let title: string;
  if (tab === "unanswered") {
    const filters = parseUnansweredFilters(query);
    const data = await unansweredForExport(filters, ids, now);
    if (data.length > SUPPORT_RESPONSE_MAX_SELECTION) return tooMany();
    columns = UNANSWERED_COLUMNS;
    title = filters.status === "CLEARED" ? "Cleared Groups" : "Unanswered Groups";
    rows = data.map((r) => {
      const waited = Math.max(0, Math.round(((r.status === "CLEARED" && r.clearedAt ? r.clearedAt : now).getTime() - r.firstIncomingAt.getTime()) / 1000));
      return [
        textCell(r.accountLabel),
        textCell(r.groupName),
        textCell(r.whatsappGroupId),
        date(r.firstIncomingAt),
        date(r.latestIncomingAt),
        formatResponseDuration(waited),
        waited,
        r.messageCount,
        textCell(r.latestSender),
        textCell(r.latestMessage),
        SUPPORT_EPISODE_STATUS_LABELS[r.status],
        date(r.clearedAt),
        textCell(r.clearedBy),
        textCell(r.clearReason),
        r.id,
      ];
    });
  } else {
    const filters = parseResponseFilters(query);
    const data = await responsesForExport(filters, ids);
    if (data.length > SUPPORT_RESPONSE_MAX_SELECTION) return tooMany();
    columns = RESPONSE_COLUMNS;
    title = "Response Time";
    rows = data.map((r) => [
      textCell(r.accountLabel),
      textCell(r.groupName),
      textCell(r.whatsappGroupId),
      date(r.firstIncomingAt),
      date(r.supportRepliedAt),
      formatResponseDuration(r.responseSeconds),
      r.responseSeconds,
      Math.round((r.responseSeconds / 60) * 10) / 10,
      textCell(r.memberName),
      r.memberId,
      textCell(r.teamName),
      textCell(r.replyText),
      r.messageCount,
      textCell(r.accountLabel),
      r.id,
      date(r.createdAt),
    ]);
  }

  // Date and time (Dhaka), so two exports in a day do not overwrite each other in Downloads.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}${parts.minute}${parts.second}`;
  const name = `${title} ${stamp}${ids ? " - selected" : ""}.${format}`;
  if (format === "csv") {
    return new NextResponse(toCsv(columns, rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition(name), "Cache-Control": "no-store" },
    });
  }
  return new NextResponse(new Uint8Array(toXlsx(title, columns, rows)), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(name),
      "Cache-Control": "no-store",
    },
  });
}
