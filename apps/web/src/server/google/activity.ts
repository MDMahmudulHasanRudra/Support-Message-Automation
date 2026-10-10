import type { Prisma } from "@prisma/client";
import {
  actionKind,
  SHEET_ACTION_LABELS,
  unattributedReasonLabel,
  type SheetActionType,
  type SheetActivityKind,
  type SheetActivitySource,
  type SheetAttribution,
  type SheetMemberRole,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { resolveSheetActor } from "@/server/google/members";

/**
 * The activity log (GOOGLE_SHEETS.md §6, Phase 6). Application rows are written here, one per thing
 * done in the app, credited to the signed-in person — never to the Google account whose access
 * carried the call. Who they were (team member, sheet role) is resolved at that moment and stored on
 * the row. External rows are the worker's (Phase 8).
 *
 * Nothing written here holds a cell value or a search term.
 */

export interface AppActivityInput {
  spreadsheetId: string;
  actionType: SheetActionType;
  userId: string;
  googleAccountId: string | null;
  sessionId?: string | null;
  tab?: { sheetId: number; title: string } | null;
  range?: string | null;
  itemCount?: number | null;
  detail?: string | null;
  at?: Date;
}

/** Record one thing done in the app. Never throws: a failed log line must not fail the work it describes. */
export async function recordAppActivity(input: AppActivityInput): Promise<string | null> {
  try {
    const at = input.at ?? new Date();
    const actor = await resolveSheetActor(input.spreadsheetId, input.userId, at);
    const row = await prisma.googleSheetActivity.create({
      data: {
        spreadsheetId: input.spreadsheetId,
        kind: actionKind(input.actionType),
        source: "APPLICATION",
        actionType: input.actionType,
        attribution: "APPLICATION",
        tabId: input.tab?.sheetId ?? null,
        tabTitle: input.tab?.title ?? null,
        range: input.range ?? null,
        itemCount: input.itemCount ?? null,
        detail: input.detail ?? null,
        userId: input.userId,
        teamMemberId: actor?.teamMemberId ?? null,
        memberRole: actor?.role ?? null,
        googleAccountId: input.googleAccountId,
        sessionId: input.sessionId ?? null,
        occurredAt: at,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    console.error("[google-sheets] could not record an activity", err);
    return null;
  }
}

export interface ActivityFilter {
  spreadsheetId?: string;
  userId?: string;
  kind?: SheetActivityKind;
  source?: SheetActivitySource;
  from?: Date;
  to?: Date;
}

export interface ActivityRow {
  id: string;
  occurredAt: Date;
  spreadsheetId: string;
  spreadsheetName: string;
  kind: SheetActivityKind;
  source: SheetActivitySource;
  actionType: SheetActionType;
  actionLabel: string;
  attribution: SheetAttribution;
  /** Who is credited, or why nobody is. */
  who: { userId: string; name: string; teamMemberName: string | null; role: SheetMemberRole | null } | null;
  unattributedReason: string | null;
  tabTitle: string | null;
  range: string | null;
  itemCount: number | null;
  detail: string | null;
  /** The connected Google account that carried (or read) it. */
  viaEmail: string | null;
}

function whereFor(filter: ActivityFilter): Prisma.GoogleSheetActivityWhereInput {
  return {
    ...(filter.spreadsheetId ? { spreadsheetId: filter.spreadsheetId } : {}),
    ...(filter.userId ? { userId: filter.userId } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.source ? { source: filter.source } : {}),
    ...(filter.from || filter.to ? { occurredAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) } } : {}),
  };
}

/** A page of the log, newest first, with the total for the pager. */
export async function listActivity(filter: ActivityFilter, page = 1, pageSize = 100): Promise<{ rows: ActivityRow[]; total: number }> {
  const where = whereFor(filter);
  const [total, rows] = await Promise.all([
    prisma.googleSheetActivity.count({ where }),
    prisma.googleSheetActivity.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (Math.max(1, page) - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        occurredAt: true,
        spreadsheetId: true,
        kind: true,
        source: true,
        actionType: true,
        attribution: true,
        unattributedReason: true,
        tabTitle: true,
        range: true,
        itemCount: true,
        detail: true,
        memberRole: true,
        userId: true,
        spreadsheet: { select: { name: true } },
        user: { select: { name: true } },
        teamMember: { select: { name: true } },
        googleAccount: { select: { email: true } },
      },
    }),
  ]);
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt,
      spreadsheetId: r.spreadsheetId,
      spreadsheetName: r.spreadsheet.name,
      kind: r.kind,
      source: r.source,
      actionType: r.actionType,
      actionLabel: SHEET_ACTION_LABELS[r.actionType],
      attribution: r.attribution,
      who: r.userId && r.user ? { userId: r.userId, name: r.user.name, teamMemberName: r.teamMember?.name ?? null, role: r.memberRole } : null,
      unattributedReason: r.attribution === "UNATTRIBUTED" ? unattributedReasonLabel(r.unattributedReason) : null,
      tabTitle: r.tabTitle,
      range: r.range,
      itemCount: r.itemCount,
      detail: r.detail,
      viaEmail: r.googleAccount?.email ?? null,
    })),
  };
}
