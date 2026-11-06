import { NextResponse, type NextRequest } from "next/server";
import { formatDhakaDateKey, parseDhakaDayRangeFromInput, sanitizeExcelCell } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { loadCsatReport } from "@/server/csat";
import { hasPermission } from "@/server/permissions";

/**
 * CSV export of Reports → Customer Satisfaction (CSAT.md): every survey asked in the period, from the same
 * loader as the page. The same gate as the page, and a customer's comment only for a viewer who may read
 * messages. A customer's words are sanitised, because this file opens in a spreadsheet.
 */

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const MAX_ROWS = 100_000;

const cell = (value: string | number | null): string => {
  if (value === null) return "";
  const text = typeof value === "number" ? String(value) : sanitizeExcelCell(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const dhakaTime = (iso: string) => new Date(new Date(iso).getTime() + 6 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");

export async function GET(request: NextRequest) {
  const session = await requireAccess("support_activity.view", "CSAT_SURVEYS");
  const now = new Date();
  const from = request.nextUrl.searchParams.get("from") ?? formatDhakaDateKey(new Date(now.getTime() - 29 * DAY_MS));
  const to = request.nextUrl.searchParams.get("to") ?? formatDhakaDateKey(now);
  const range = parseDhakaDayRangeFromInput(from, to);
  if (!range || range.end.getTime() - range.start.getTime() > MAX_DAYS * DAY_MS) {
    return NextResponse.json({ error: `Choose a valid range of at most ${MAX_DAYS} days.` }, { status: 400 });
  }
  const canReadMessages = await hasPermission(session, "messages.view");
  const report = await loadCsatReport(range, { canReadMessages, listLimit: MAX_ROWS });
  const header = ["Asked (Dhaka)", "Channel", "Customer", "Resolved by", "Team", "Rating", "Comment"];
  const rows = report.rows.map((r) => [dhakaTime(r.sentAt), r.channelLabel, r.customer, r.agentName, r.teamName, r.rating, r.comment].map(cell).join(","));
  // The byte-order mark makes a spreadsheet read Bangla as UTF-8.
  const csv = "﻿" + [header.join(","), ...rows].join("\r\n");
  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="csat-${from}_${to}.csv"` },
  });
}
