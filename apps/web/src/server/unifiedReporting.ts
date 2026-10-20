import { Prisma } from "@prisma/client";
import {
  LATE_ARRIVAL_MINUTES,
  parseReportScope,
  resolveReportScope,
  type DataQualityCounts,
  type ReportScope,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { PERSONAL_CHAT_SQL } from "@/server/chatInbox";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { hasPermission } from "@/server/permissions";
import type { Session } from "@/server/auth";
import type { TeamReportFilters } from "@/server/teamReport";

/** Unified messaging reports (UNIFIED_REPORTING): off = the Team Report exactly as before. */
export async function isUnifiedReportingEnabled(): Promise<boolean> {
  return !(await activeDisabledFeatures()).has("UNIFIED_REPORTING");
}

/**
 * The scope the page (and the exports) actually apply. Personal and combined need
 * `messages.view` on top of the report's own key; without it, or with the feature off, the
 * request falls back to group (silently when the feature is off).
 */
export async function resolvePageScope(
  params: Record<string, string | undefined>,
  session: Session,
): Promise<{ scope: ReportScope; note: string | null; enabled: boolean; canViewPersonal: boolean }> {
  const enabled = await isUnifiedReportingEnabled();
  const canViewPersonal = enabled ? await hasPermission(session, "messages.view") : false;
  const resolved = resolveReportScope({ requested: parseReportScope(params.scope), featureEnabled: enabled, canViewPersonal });
  return { ...resolved, enabled, canViewPersonal };
}

/**
 * What the period's stored rows say about how they arrived (counts only, never a text): recovered
 * after a pause, loaded from history on request, deleted for everyone, and the kinds of row no figure
 * counts. Read-only, beside the report and never a part of a figure. Every query names the project.
 *
 * GROUP reads the rows of WhatsApp groups (the Team Report's own set); PERSONAL reads the project's
 * rows with no group — personal chats are counted, status/newsletter/orphaned-group chats are the
 * "not a conversation" exclusion. The own-number and internal-chat exclusions are decided from
 * classification, not SQL, so they are left 0 here for the personal loader to fill.
 */
export async function loadDataQualityCounts(input: {
  kind: "GROUP" | "PERSONAL";
  start: Date;
  end: Date;
  /** An export's stored-by bound (the page's moment): only rows stored by then, with the loader's own 5 s grace. */
  storedBy?: Date;
  accountId?: string | null;
  /** GROUP only: restrict to these WhatsApp group ids. */
  groupKeys?: string[];
}): Promise<DataQualityCounts> {
  const projectId = await activeProjectId();
  const storedBy = input.storedBy ? new Date(input.storedBy.getTime() + 5_000) : new Date("9999-12-31T00:00:00Z");
  const accountFilter = input.accountId ? Prisma.sql`AND m."accountId" = ${input.accountId}` : Prisma.empty;
  const late = Prisma.sql`m."loadedFromHistoryAt" IS NULL AND m."createdAt" > m."timestampWa" + make_interval(mins => ${LATE_ARRIVAL_MINUTES}::int)`;
  type Row = { stored: number; system: number; history: number; late: number; revoked: number; nonConversation: number };
  const rows =
    input.kind === "GROUP"
      ? await prisma.$queryRaw<Row[]>`
          SELECT
            count(*) FILTER (WHERE m."direction" <> 'SYSTEM')::int AS stored,
            count(*) FILTER (WHERE m."direction" = 'SYSTEM')::int AS system,
            count(*) FILTER (WHERE m."loadedFromHistoryAt" IS NOT NULL)::int AS history,
            count(*) FILTER (WHERE ${late})::int AS late,
            count(*) FILTER (WHERE m."revokedAt" IS NOT NULL)::int AS revoked,
            0::int AS "nonConversation"
          FROM "Message" m
          JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
          WHERE m."projectId" = ${projectId}
            AND m."timestampWa" >= ${input.start} AND m."timestampWa" < ${input.end}
            AND m."createdAt" <= ${storedBy}
            ${input.groupKeys?.length ? Prisma.sql`AND g."whatsappGroupId" IN (${Prisma.join(input.groupKeys)})` : Prisma.empty}
            ${accountFilter}`
      : await prisma.$queryRaw<Row[]>`
          SELECT
            count(*) FILTER (WHERE ${PERSONAL_CHAT_SQL} AND m."direction" <> 'SYSTEM')::int AS stored,
            count(*) FILTER (WHERE ${PERSONAL_CHAT_SQL} AND m."direction" = 'SYSTEM')::int AS system,
            count(*) FILTER (WHERE ${PERSONAL_CHAT_SQL} AND m."loadedFromHistoryAt" IS NOT NULL)::int AS history,
            count(*) FILTER (WHERE ${PERSONAL_CHAT_SQL} AND ${late})::int AS late,
            count(*) FILTER (WHERE ${PERSONAL_CHAT_SQL} AND m."revokedAt" IS NOT NULL)::int AS revoked,
            count(*) FILTER (WHERE NOT (${PERSONAL_CHAT_SQL}))::int AS "nonConversation"
          FROM "Message" m
          WHERE m."projectId" = ${projectId} AND m."groupId" IS NULL
            AND m."timestampWa" >= ${input.start} AND m."timestampWa" < ${input.end}
            AND m."createdAt" <= ${storedBy}
            ${accountFilter}`;
  const row = rows[0];
  return {
    storedCopies: row?.stored ?? 0,
    excludedSystem: row?.system ?? 0,
    excludedNonConversation: row?.nonConversation ?? 0,
    excludedOwnNumberChats: 0,
    excludedInternalChats: 0,
    lateArriving: row?.late ?? 0,
    loadedFromHistory: row?.history ?? 0,
    revoked: row?.revoked ?? 0,
  };
}

/** Roster changes whose effect on stored history (the staff stamp, Activity Feed, Duty History) is still queued or running. */
export async function loadPendingReattributions(): Promise<number> {
  return prisma.identityReattribution.count({ where: { status: { in: ["PENDING", "RUNNING"] } } });
}

/**
 * The filters with the scope that was actually applied (`resolvePageScope`): a request for personal
 * with the feature off, or without the permission, becomes group and carries no `scope` key at all, so
 * every link and export built from it is the one the group report always produced.
 */
export function withReportScope(filters: TeamReportFilters, scope: ReportScope): TeamReportFilters {
  const next: TeamReportFilters = { ...filters, scope };
  if (scope === "group") delete next.scope;
  return next;
}
