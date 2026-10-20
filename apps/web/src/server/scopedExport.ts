import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import {
  ADDITIVITY_LABELS,
  buildReportRunMetadata,
  computeReportingReliability,
  countOperatorReplies,
  dataQualityLines,
  emptyActorCounts,
  formatHoursMinutes,
  reliabilityLines,
  responseLines,
  runMetadataLines,
  sanitizeExcelCell,
  sanitizeExcelRow,
  type CombinedLine,
  type ReliabilityCounts,
  type ReportScope,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { loadDataHealth } from "@/server/dataHealth";
import { CONTEXT_MS, LOOKAHEAD_MS, memberLabel, scopeLabel, type TeamReportFilters } from "@/server/teamReport";
import type { PersonalReportData } from "@/server/personalReport";
import { buildPersonalBucketsTable, buildPersonalConversationsTable, buildPersonalMembersTable, type ReportTableData } from "@/server/teamReportTables";
import { loadPendingReattributions } from "@/server/unifiedReporting";

/**
 * The personal and combined exports of the Team Report (UNIFIED_REPORTING, WP6; 07 §4). The group
 * export keeps its own code in `api/team-report/export/route.ts` untouched; this file builds only what
 * is new — the personal sheets, the combined table and the personal CSV — from the SAME loaded data
 * the page rendered, so the file cannot disagree with the screen. Counts and conversation display
 * names only: no message text is ever written, and every text cell goes through `sanitizeExcelCell`
 * (a name starting with "=" must not become a formula).
 */

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** A download name safe on every filesystem, with the parts that are filled in. */
export const safeName = (text: string) => text.replace(/[^\p{L}\p{N} .–_-]+/gu, " ").replace(/\s+/g, " ").trim();

/** UTF-8 byte-order mark (Excel reads Bangla names right), header always, formula-safe cells. */
export function tableToCsv(table: ReportTableData): string {
  const escapeCell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : typeof value === "string" ? sanitizeExcelCell(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = table.columns.map((c) => c.label);
  return "﻿" + [header.map(escapeCell).join(","), ...table.rows.map((row) => row.cells.map(escapeCell).join(","))].join("\r\n");
}

/** The CombinedLine table, in the order 07 §4 fixes: Figure, Groups, Personal, Combined, How combined, Note. */
export function combinedTable(lines: readonly CombinedLine[]): ReportTableData {
  return {
    id: "combined",
    columns: [{ label: "Figure" }, { label: "Groups" }, { label: "Personal" }, { label: "Combined" }, { label: "How combined" }, { label: "Note" }],
    rows: lines.map((line) => ({
      key: line.label,
      cells: [line.label, line.group ?? "—", line.personal ?? "—", line.combined ?? "—", ADDITIVITY_LABELS[line.additivity], line.note],
      sort: [],
    })),
  };
}

export const tableToSheet = (table: ReportTableData, emptyNote = "") => {
  const header = table.columns.map((c) => c.label);
  const rows = table.rows.map((row) => row.cells.map((cell) => (typeof cell === "string" ? sanitizeExcelCell(cell) : cell)));
  const sheet = XLSX.utils.aoa_to_sheet(rows.length ? [header, ...rows] : [header, [emptyNote]]);
  sheet["!cols"] = header.map((label, i) => ({ wch: Math.min(48, Math.max(label.length, ...rows.map((r) => String(r[i] ?? "").length)) + 2) }));
  return sheet;
};

const iso = (ms: number | null) =>
  ms === null
    ? ""
    : new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(
        new Date(ms),
      );
const duration = (seconds: number | null) => (seconds === null ? "" : formatHoursMinutes(seconds));
const bucketSheetName = (granularity: string) => `Personal by ${granularity === "day" ? "day" : granularity === "week" ? "week" : "month"}`;

/** Two reliability counts added: what was read across groups and personal chats (combined run information). */
export function mergeReliabilityCounts(a: ReliabilityCounts, b: ReliabilityCounts): ReliabilityCounts {
  const byActor = emptyActorCounts();
  for (const key of Object.keys(byActor) as Array<keyof typeof byActor>) byActor[key] = a.byActor[key] + b.byActor[key];
  return {
    storedCopies: a.storedCopies + b.storedCopies,
    logicalMessages: a.logicalMessages + b.logicalMessages,
    byActor,
    attribution: {
      idAndPhone: a.attribution.idAndPhone + b.attribution.idAndPhone,
      idOnly: a.attribution.idOnly + b.attribution.idOnly,
      phoneOnly: a.attribution.phoneOnly + b.attribution.phoneOnly,
    },
    conflicting: a.conflicting + b.conflicting,
    unattributedSenders: a.unattributedSenders + b.unattributedSenders,
  };
}

/** The personal sheets: summary, conversations, the period's buckets and (unless one member is chosen) members. */
export function personalSheets(data: PersonalReportData, extra: { health: Awaited<ReturnType<typeof loadDataHealth>>; scopeText: string; accountLabel: string | null; now: Date }): Array<{ name: string; sheet: XLSX.WorkSheet }> {
  const { result, filters, range } = data;
  const s = result.summary;
  const memberName = filters.memberId ? memberLabel(filters.memberId, data.memberNames) : null;
  const summary = [
    { Metric: "Report", Value: `Personal chats · ${extra.scopeText} · ${range.label}` },
    { Metric: "Team", Value: data.teamName ?? "All teams" },
    { Metric: "Team member", Value: memberName ?? "All" },
    { Metric: "Breakdown", Value: filters.granularity },
    ...(extra.accountLabel ? [{ Metric: "WhatsApp account", Value: extra.accountLabel }] : []),
    { Metric: "Period start (Asia/Dhaka)", Value: iso(range.start.getTime()) },
    { Metric: "Period end (Asia/Dhaka, exclusive)", Value: iso(range.end.getTime()) },
    { Metric: "Computed as of", Value: iso(extra.now.getTime()) },
    { Metric: "Data health", Value: extra.health.label },
    { Metric: "Data health detail", Value: extra.health.headline },
    { Metric: "Conversations", Value: s.conversations },
    { Metric: "Conversations with a customer message", Value: s.customerConversations },
    { Metric: "New conversations (first stored in this period)", Value: s.newConversations },
    { Metric: "Customer messages", Value: s.customerMessages },
    { Metric: "Business replies", Value: s.businessReplies },
    { Metric: "Verified employee replies", Value: s.verifiedEmployeeReplies },
    { Metric: "  dashboard replies by an unlinked login", Value: s.unlinkedOperatorReplies },
    { Metric: "  AI replies", Value: s.automatedReplies.ai },
    { Metric: "  rule replies", Value: s.automatedReplies.rule },
    { Metric: "  sent from the business phone", Value: s.businessPhoneReplies },
    ...(s.broadcastMessages > 0 ? [{ Metric: "  broadcast messages", Value: s.broadcastMessages }] : []),
    { Metric: "Customer waits", Value: s.waits },
    { Metric: "Missed", Value: s.missed },
    { Metric: "Recall support", Value: s.recalled },
    { Metric: "Never answered", Value: s.unrecovered },
    { Metric: "Still inside the threshold", Value: s.pending },
    { Metric: "Conversations waiting now", Value: s.waitingConversations },
    { Metric: "Median first observed response", Value: duration(result.response.firstResponse.medianSeconds) },
    { Metric: "Median first human response", Value: duration(result.response.human.medianSeconds) },
    { Metric: "Chats left out: our own numbers", Value: s.excluded.ownNumber },
    { Metric: "Chats left out: with a team member", Value: s.excluded.internal },
    { Metric: "Rule: missed after (minutes)", Value: data.rules.missedAfterMinutes },
  ].map((row) => sanitizeExcelRow(row));
  const sheets: Array<{ name: string; sheet: XLSX.WorkSheet }> = [
    { name: "Personal summary", sheet: XLSX.utils.json_to_sheet(summary) },
    { name: "Personal conversations", sheet: tableToSheet(buildPersonalConversationsTable(data, { linkToChat: false }), "No personal chat had a message in this period.") },
    { name: bucketSheetName(filters.granularity), sheet: tableToSheet(buildPersonalBucketsTable(data), "") },
  ];
  if (!filters.memberId) sheets.push({ name: "Personal members", sheet: tableToSheet(buildPersonalMembersTable(data), "No dashboard reply was credited to a team member.") });
  return sheets;
}

/** Personal "Data quality" lines: how customers were answered, reliability and collection detail — as the page shows them. */
export async function personalQualityRows(data: PersonalReportData, health: Awaited<ReturnType<typeof loadDataHealth>>, now: Date, pendingReattributions: number) {
  const reliability = computeReportingReliability(data.reliabilityCounts, health, { start: data.range.start.getTime(), end: data.range.end.getTime(), now: now.getTime() });
  const lines = [...responseLines(data.result.response), ...reliabilityLines(reliability), ...dataQualityLines(data.dataQuality, "PERSONAL", pendingReattributions)];
  return { reliability, rows: lines.map((line) => sanitizeExcelRow({ Section: line.section, Measure: line.label, Value: line.value, Note: line.note })) };
}

export function runInformationRows(input: {
  scope: ReportScope;
  now: Date;
  storedBy: Date | undefined;
  filters: TeamReportFilters;
  range: { start: Date; end: Date; label: string };
  teamName: string | null;
  memberName: string | null;
  accountLabel: string | null;
  health: Awaited<ReturnType<typeof loadDataHealth>>;
  reliability: Parameters<typeof buildReportRunMetadata>[0]["reliability"];
  operatorMessages: Parameters<typeof countOperatorReplies>[0];
  pendingReattributions: number;
  replyAttributionVersion?: string | null;
}) {
  const { filters, range } = input;
  return runMetadataLines(
    buildReportRunMetadata({
      scope: input.scope,
      generatedAt: input.now.getTime(),
      storedBy: input.storedBy?.getTime() ?? null,
      period: {
        start: range.start.getTime(),
        end: range.end.getTime(),
        label: range.label,
        contextMs: CONTEXT_MS,
        lookaheadMs: LOOKAHEAD_MS,
        name: { day: "Daily", week: "Weekly", month: "Monthly", custom: "Custom range" }[filters.period],
      },
      filters: {
        team: input.teamName,
        member: input.memberName,
        groupCount: filters.groupKeys?.length ?? 0,
        account: input.accountLabel,
        granularity: filters.granularity,
      },
      health: input.health,
      reliability: input.reliability,
      operatorReplies: countOperatorReplies(input.operatorMessages, range.end.getTime()),
      pendingReattributions: input.pendingReattributions,
      replyAttributionVersion: input.replyAttributionVersion ?? null,
    }),
  ).map((line) => sanitizeExcelRow({ Item: line.label, Value: line.value, Note: line.note }));
}

/** The Account label for the run information, or null when no account is chosen. */
export async function accountLabelOf(accountId: string | null | undefined): Promise<string | null> {
  if (!accountId) return null;
  return (await prisma.whatsAppAccount.findFirst({ where: { id: accountId }, select: { label: true } }))?.label ?? accountId;
}

/**
 * The whole personal-scope export (CSV: the conversations table; Excel: the personal sheets, data quality
 * and run information — the group sheets are NOT written). Called by the export route for `scope=personal`
 * after the scope was resolved against the viewer's permission.
 */
export async function personalExport(input: {
  data: PersonalReportData;
  format: "csv" | "xlsx";
  now: Date;
  storedBy: Date | undefined;
}): Promise<NextResponse> {
  const { data, format, now, storedBy } = input;
  const { filters, range } = data;
  const memberName = filters.memberId ? memberLabel(filters.memberId, data.memberNames) : null;
  const scopeText = scopeLabel(data.teamName, memberName);
  const slug = [data.teamName, memberName, range.label].filter(Boolean).map((part) => safeName(part!)).join(" - ");

  if (format === "csv") {
    return new NextResponse(tableToCsv(buildPersonalConversationsTable(data, { linkToChat: false })), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition(`Team Report personal chats - ${slug}.csv`) },
    });
  }

  const [health, accountLabel, pending] = await Promise.all([
    loadDataHealth({ periodStart: range.start.getTime(), periodEnd: range.end.getTime(), now, accountId: filters.accountId }),
    accountLabelOf(filters.accountId),
    loadPendingReattributions(),
  ]);
  const quality = await personalQualityRows(data, health, now, pending);
  const workbook = XLSX.utils.book_new();
  for (const { name, sheet } of personalSheets(data, { health, scopeText, accountLabel, now })) XLSX.utils.book_append_sheet(workbook, sheet, name);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(quality.rows), "Data quality");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(
      runInformationRows({
        scope: "personal",
        now,
        storedBy,
        filters,
        range,
        teamName: data.teamName,
        memberName,
        accountLabel,
        health,
        reliability: quality.reliability,
        operatorMessages: data.messages,
        pendingReattributions: pending,
      }),
    ),
    "Run information",
  );
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`Team Report - ${slug} - personal.xlsx`),
    },
  });
}

/** The file-name suffix of a non-group scope, so a downloaded personal or combined report cannot be mistaken for the group one. */
export const SCOPE_FILE_SUFFIX: Record<ReportScope, string> = { group: "", personal: " - personal", combined: " - groups and personal" };

