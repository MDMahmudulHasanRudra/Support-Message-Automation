import { createHash } from "node:crypto";
import {
  identityForRoster,
  normalizePhoneNumber,
  parseStoredCopies,
  PREVIEW_DEFAULT_DAYS,
  PREVIEW_MAX_DAYS,
  PREVIEW_MAX_LOGICAL,
  previewDigestSource,
  whatsappIdKey,
  type IdentityPreviewResult,
  type PreviewMessage,
  type PreviewRosterEntry,
  type StoredCopyIdentity,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { isPersonalChatId } from "@/lib/chatConversationType";
import { loadOwnSenderIds, messageKeySql, outboundByKeyJoin } from "@/server/messageIdentity";
import { loadTeamReport, parseTeamReportFilters } from "@/server/teamReport";
import { loadPersonalReport } from "@/server/personalReport";

/**
 * The web side of the identity-change impact preview (04-identity-and-attribution-spec 4.2, 4.3).
 *
 * STRICTLY READ-ONLY: it reads Message / OutboundMessage / the roster through the project-scoped
 * client and writes nothing. It runs the same classifier the reports run (`identityForRoster` is
 * `createReportClassifier`), never a second rule, and never selects a message body.
 */

/** The id the preview gives a member who does not exist yet. */
export const PREVIEW_NEW_MEMBER_ID = "new-member";

export interface IdentityProposal {
  /** The member's phone number as it would be saved (country code applied). */
  phoneNumber: string;
  whatsappId: string | null;
  /** undefined = unchanged; null = every message counts. */
  attributeFrom?: Date | null;
}

/** The project's roster as the preview sees it: every member, deactivated ones included. */
export async function loadPreviewRoster(): Promise<PreviewRosterEntry[]> {
  const members = await prisma.internalTeamMember.findMany({
    select: { id: true, phoneNumber: true, whatsappId: true, attributeFrom: true, userId: true },
  });
  return members;
}

/** The roster as it would be after the change. `memberId` null adds a new member. */
export function applyProposal(roster: readonly PreviewRosterEntry[], memberId: string | null, proposal: IdentityProposal): PreviewRosterEntry[] {
  if (memberId === null) {
    return [
      ...roster,
      { id: PREVIEW_NEW_MEMBER_ID, phoneNumber: proposal.phoneNumber, whatsappId: proposal.whatsappId, attributeFrom: proposal.attributeFrom ?? null, userId: null },
    ];
  }
  return roster.map((m) =>
    m.id !== memberId
      ? m
      : {
          ...m,
          phoneNumber: proposal.phoneNumber,
          whatsappId: proposal.whatsappId,
          attributeFrom: proposal.attributeFrom === undefined ? m.attributeFrom : proposal.attributeFrom,
        },
  );
}

/** Every stored form of the identifiers the change touches: typed, digits, the id's comparison key. */
export function previewIdentifiers(before: readonly PreviewRosterEntry[], after: readonly PreviewRosterEntry[], memberId: string | null): string[] {
  const ids = new Set<string>();
  const add = (v: string | null | undefined) => {
    const value = String(v ?? "").trim();
    if (value) ids.add(value);
  };
  const forms = (m: PreviewRosterEntry | undefined) => {
    if (!m) return;
    add(m.phoneNumber);
    add(m.phoneNumber.replace(/\D/g, ""));
    add(normalizePhoneNumber(m.phoneNumber));
    add(m.whatsappId);
    add(whatsappIdKey(m.whatsappId));
  };
  forms(memberId ? before.find((m) => m.id === memberId) : undefined);
  forms(after.find((m) => m.id === (memberId ?? PREVIEW_NEW_MEMBER_ID)));
  return [...ids];
}

/** Clamp the requested look-back to what the preview may read. */
export function previewWindow(days: number | undefined, now: Date): { from: Date; to: Date } {
  const d = Math.min(PREVIEW_MAX_DAYS, Math.max(1, Math.floor(Number.isFinite(days) ? (days as number) : PREVIEW_DEFAULT_DAYS)));
  return { from: new Date(now.getTime() - d * 86_400_000), to: now };
}

interface HitRow {
  chat: string;
  ts: Date;
  k: string;
}

interface CopyRow {
  id: string;
  accountId: string;
  chat: string;
  wgid: string | null;
  ts: Date;
  k: string;
  direction: "INCOMING" | "OUTGOING" | "SYSTEM";
  sender: string;
  senderJid: string | null;
  fromTeam: boolean;
  wamid: string;
  obMatched: boolean | null;
  actionType: string | null;
  ruleId: string | null;
  createdById: string | null;
}

/**
 * The stored messages the identifiers touch in the window, every copy of each as a witness. Query 1 finds
 * the logical messages through the sender index; query 2 reads every copy of them. Both name the project.
 * `maxLogical` is a test seam; production uses `PREVIEW_MAX_LOGICAL`.
 */
export async function loadIdentityPreviewInput(input: {
  identifiers: string[];
  window: { from: Date; to: Date };
  maxLogical?: number;
}): Promise<{ messages: PreviewMessage[]; truncated: boolean; ownIds: Set<string> }> {
  const projectId = await activeProjectId();
  const cap = input.maxLogical ?? PREVIEW_MAX_LOGICAL;
  const ownIds = await loadOwnSenderIds(projectId);
  if (input.identifiers.length === 0) return { messages: [], truncated: false, ownIds };

  const hits = await prisma.$queryRaw<HitRow[]>`
    SELECT m."chatId" AS chat, min(m."timestampWa") AS ts, ${messageKeySql("m")} AS k
    FROM "Message" m
    WHERE m."projectId" = ${projectId}
      AND m."senderPhone" = ANY(${input.identifiers}::text[])
      AND m."timestampWa" >= ${input.window.from} AND m."timestampWa" < ${input.window.to}
      AND m."direction" <> 'SYSTEM'
    GROUP BY m."chatId", ${messageKeySql("m")}
    ORDER BY ts DESC
    LIMIT ${cap + 1}`;
  const truncated = hits.length > cap;
  const used = truncated ? hits.slice(0, cap) : hits;
  if (used.length === 0) return { messages: [], truncated: false, ownIds };

  const rows = await prisma.$queryRaw<CopyRow[]>`
    SELECT m."id", m."accountId", m."chatId" AS chat, g."whatsappGroupId" AS wgid, m."timestampWa" AS ts,
           h.k AS k, m."direction"::text AS direction, m."senderPhone" AS sender, m."senderJid",
           m."isFromTeamMember" AS "fromTeam", m."whatsappMessageId" AS wamid,
           o."obMatched", o."actionType"::text AS "actionType", o."ruleId", o."createdById"
    FROM unnest(${used.map((h) => h.chat)}::text[], ${used.map((h) => h.ts.toISOString())}::timestamp[], ${used.map((h) => h.k)}::text[]) AS h(chat, ts, k)
    JOIN "Message" m ON m."projectId" = ${projectId} AND m."chatId" = h.chat
      AND m."timestampWa" BETWEEN h.ts - interval '2 seconds' AND h.ts + interval '2 seconds'
      AND ${messageKeySql("m")} = h.k
    LEFT JOIN "WhatsAppGroup" g ON g."id" = m."groupId" AND g."projectId" = ${projectId}
    ${outboundByKeyJoin(projectId, input.window.from, input.window.to, "m")}`;

  // One logical message per group (a WhatsApp group id) or per personal chat of one account.
  const byMessage = new Map<string, { kind: "GROUP" | "PERSONAL"; key: string; k: string; rows: CopyRow[] }>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.direction === "SYSTEM" || seen.has(row.id)) continue;
    seen.add(row.id);
    const kind = row.wgid ? "GROUP" : isPersonalChatId(row.chat) ? "PERSONAL" : null;
    if (!kind) continue;
    const key = kind === "GROUP" ? row.wgid! : `${row.accountId}|${row.chat}`;
    const id = `${kind}|${key}|${row.k}`;
    const entry = byMessage.get(id) ?? { kind, key, k: row.k, rows: [] };
    entry.rows.push(row);
    byMessage.set(id, entry);
  }

  const rank = (r: CopyRow) => [r.direction === "OUTGOING" ? 0 : 1, r.wamid.startsWith("true_") ? 0 : 1, r.fromTeam ? 0 : 1] as const;
  const messages: PreviewMessage[] = [];
  for (const entry of byMessage.values()) {
    const sorted = [...entry.rows].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.id.localeCompare(b.id);
    });
    const kept = sorted[0]!;
    const incomingCopies: StoredCopyIdentity[] = parseStoredCopies(
      entry.rows.filter((r) => r.direction === "INCOMING").map((r) => [r.sender, r.senderJid ?? "", r.fromTeam ? "1" : "0"].join("\u001f")),
    );
    messages.push({
      logicalKey: entry.k,
      conversationKind: entry.kind,
      conversationKey: entry.key,
      ts: kept.ts.getTime(),
      storedCopies: entry.rows.length,
      keptCopy: {
        direction: kept.direction,
        sender: kept.sender,
        senderJid: kept.senderJid,
        fromTeam: kept.fromTeam,
        obMatched: Boolean(kept.obMatched),
        actionType: kept.actionType,
        ruleId: kept.ruleId,
        createdById: kept.createdById,
      },
      incomingCopies,
    });
  }
  messages.sort((a, b) => b.ts - a.ts || a.conversationKey.localeCompare(b.conversationKey) || a.logicalKey.localeCompare(b.logicalKey));
  return { messages, truncated, ownIds };
}

/** SHA-256 of the canonical (sorted-key) JSON of what the user saw. */
export function previewDigest(preview: IdentityPreviewResult): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : value;
  return createHash("sha256").update(JSON.stringify(canonical(previewDigestSource(preview)))).digest("hex");
}

export interface IdentityKpiDelta {
  /** The most recent impacted month (YYYY-MM). */
  month: string;
  groupsConsidered: number;
  group: Array<{
    field: "customerMessages" | "memberReplies" | "businessReplies" | "waits" | "missed" | "recalled" | "unrecovered" | "unattributedStaffReplies" | "overtimeSeconds";
    before: number;
    after: number;
  }>;
  /** Null when personal conversations are hidden from this viewer (or none were affected). */
  personal: Array<{ field: "customerMessages" | "verifiedEmployeeReplies" | "waits" | "firstHumanAnsweredVerified"; before: number; after: number }> | null;
  byMember: Array<{ memberId: string; repliesBefore: number; repliesAfter: number; missedBefore: number; missedAfter: number }>;
}

/**
 * The same month's report twice, the roster before and after, for the affected groups only: an
 * ESTIMATE, always labelled so. Null when nothing changed. Read-only (the loaders only read).
 */
export async function estimateIdentityKpiDeltas(input: {
  preview: IdentityPreviewResult;
  rosterBefore: readonly PreviewRosterEntry[];
  rosterAfter: readonly PreviewRosterEntry[];
  now: Date;
  showPersonal: boolean;
}): Promise<IdentityKpiDelta | null> {
  const { preview } = input;
  const { month, groupKeys, personalAccountIds } = preview.kpiScope;
  if (preview.affected.logicalMessages === 0 || !month) return null;
  const projectId = await activeProjectId();
  const ownIds = await loadOwnSenderIds(projectId);
  const before = identityForRoster(input.rosterBefore, ownIds);
  const after = identityForRoster(input.rosterAfter, ownIds);
  const monthFilters = parseTeamReportFilters({ period: "month", date: `${month}-01` }, input.now);

  const groupField = ["customerMessages", "memberReplies", "businessReplies", "waits", "missed", "recalled", "unrecovered", "unattributedStaffReplies", "overtimeSeconds"] as const;
  let group: IdentityKpiDelta["group"] = groupField.map((field) => ({ field, before: 0, after: 0 }));
  const memberRows = new Map<string, { repliesBefore: number; repliesAfter: number; missedBefore: number; missedAfter: number }>();
  if (groupKeys.length > 0) {
    const filters = { ...monthFilters, groupKeys };
    const [b, a] = await Promise.all([
      loadTeamReport(filters, input.now, undefined, { identity: before }),
      loadTeamReport(filters, input.now, undefined, { identity: after }),
    ]);
    group = groupField.map((field) => ({ field, before: b.result.summary[field], after: a.result.summary[field] }));
    for (const row of b.result.members) {
      const entry = memberRows.get(row.memberId) ?? { repliesBefore: 0, repliesAfter: 0, missedBefore: 0, missedAfter: 0 };
      entry.repliesBefore = row.messages;
      entry.missedBefore = row.missed;
      memberRows.set(row.memberId, entry);
    }
    for (const row of a.result.members) {
      const entry = memberRows.get(row.memberId) ?? { repliesBefore: 0, repliesAfter: 0, missedBefore: 0, missedAfter: 0 };
      entry.repliesAfter = row.messages;
      entry.missedAfter = row.missed;
      memberRows.set(row.memberId, entry);
    }
  }

  let personal: IdentityKpiDelta["personal"] = null;
  if (input.showPersonal && personalAccountIds.length > 0) {
    const filters = { ...monthFilters, scope: "personal" as const, accountId: personalAccountIds.length === 1 ? personalAccountIds[0]! : null };
    const [b, a] = await Promise.all([
      loadPersonalReport(filters, input.now, { identity: before }),
      loadPersonalReport(filters, input.now, { identity: after }),
    ]);
    personal = [
      { field: "customerMessages", before: b.result.summary.customerMessages, after: a.result.summary.customerMessages },
      { field: "verifiedEmployeeReplies", before: b.result.summary.verifiedEmployeeReplies, after: a.result.summary.verifiedEmployeeReplies },
      { field: "waits", before: b.result.summary.waits, after: a.result.summary.waits },
      { field: "firstHumanAnsweredVerified", before: b.result.employeeAnsweredHumanWaits, after: a.result.employeeAnsweredHumanWaits },
    ];
  }

  return {
    month,
    groupsConsidered: groupKeys.length,
    group,
    personal,
    byMember: [...memberRows.entries()]
      .map(([memberId, v]) => ({ memberId, ...v }))
      .filter((r) => r.repliesBefore !== r.repliesAfter || r.missedBefore !== r.missedAfter)
      .sort((x, y) => x.memberId.localeCompare(y.memberId)),
  };
}
