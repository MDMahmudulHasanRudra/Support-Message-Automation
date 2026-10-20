import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { loadOwnSenderIds } from "@/server/messageIdentity";
import {
  createSenderResolver,
  describeSenderId,
  hasNoRealWhatsAppId,
  isOwnSender,
  normalizePhoneNumber,
  suggestMemberForSender,
  type SuggestableMember,
} from "@support-automation/shared";

/**
 * Team Members → Identity check (report accuracy audit, 19 Oct 2026): the roster problems that make
 * reports wrong without any error, found from the messages themselves.
 *
 *  - A member whose number is one of OUR WhatsApp accounts: everything that number sends is the
 *    business's own message, so it is never credited to them.
 *  - Active members with no message matched in the last 30 days: usually a number entered wrongly,
 *    or a colleague WhatsApp shows only by their private WhatsApp ID, which nobody has linked yet.
 *  - Senders nobody on the roster matches who wrote in several different groups: very likely a
 *    colleague missing from the roster, whose every message is counted as a customer's.
 *  - Re-attributions still being applied after a recent roster change.
 *
 * Counts and identifiers only — never message text.
 */

export const IDENTITY_HEALTH_WINDOW_DAYS = 30;
/** Writing in this many different groups is what makes an unknown sender look like staff. */
export const LIKELY_STAFF_MIN_GROUPS = 3;

/**
 * "Probably <member>" beside an unknown sender (WP11): a SUGGESTION from the two names, display only. `linkable`
 * is whether Link would be accepted (an active member with no real WhatsApp ID of their own); otherwise the
 * page points at their edit page instead.
 */
export interface SenderSuggestion {
  kind: "ONE" | "SEVERAL";
  members: Array<{ id: string; name: string; linkable: boolean }>;
}

export interface LinkableMember {
  id: string;
  name: string;
  designation: string;
}

export interface UnknownFrequentSender {
  /** The sender id as stored. */
  sender: string;
  /** "+8801…" for a phone-number id, null for a private WhatsApp ID (never shown as a number). */
  phone: string | null;
  whatsappId: string | null;
  name: string | null;
  groups: number;
  messages: number;
  lastAt: Date;
  /** From the sender's WhatsApp name and the roster's names; null = no single member or several (see `suggestion.kind`). */
  suggestion: SenderSuggestion | null;
}

export interface RosterIdentityHealth {
  ownNumberMembers: Array<{ id: string; name: string }>;
  quietMembers: Array<{ id: string; name: string }>;
  unknownFrequentSenders: UnknownFrequentSender[];
  pendingReattributions: number;
  /** Active members Link may name: no real WhatsApp ID of their own (the rule `linkWhatsAppSender` enforces). */
  linkableMembers: LinkableMember[];
}

export async function getRosterIdentityHealth(now: Date = new Date()): Promise<RosterIdentityHealth> {
  const projectId = await activeProjectId();
  const since = new Date(now.getTime() - IDENTITY_HEALTH_WINDOW_DAYS * 86_400_000);
  const [members, accounts, ownIds, senders, pendingReattributions] = await Promise.all([
    prisma.internalTeamMember.findMany({ select: { id: true, name: true, phoneNumber: true, whatsappId: true, status: true, role: true } }),
    prisma.whatsAppAccount.findMany({ select: { phoneNumber: true } }),
    loadOwnSenderIds(projectId),
    prisma.$queryRaw<Array<{ sender: string; jid: string | null; name: string | null; groups: number; messages: number; lastAt: Date }>>`
      SELECT m."senderPhone" AS sender, max(m."senderJid") AS jid, max(m."senderName") AS name,
             COUNT(DISTINCT g."whatsappGroupId")::int AS groups, COUNT(*)::int AS messages, MAX(m."timestampWa") AS "lastAt"
      FROM "Message" m
      JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
      WHERE m."projectId" = ${projectId} AND m."direction" = 'INCOMING' AND m."timestampWa" >= ${since}
      GROUP BY m."senderPhone"`,
    prisma.identityReattribution.count({ where: { status: { in: ["PENDING", "RUNNING"] } } }),
  ]);

  const resolver = createSenderResolver(members);
  const accountDigits = new Set(accounts.map((a) => normalizePhoneNumber(a.phoneNumber ?? "")).filter((d): d is string => Boolean(d)));
  const ownNumberMembers = members
    .filter((m) => {
      const digits = normalizePhoneNumber(m.phoneNumber);
      return digits !== null && accountDigits.has(digits);
    })
    .map((m) => ({ id: m.id, name: m.name }));

  const seen = new Set<string>();
  const unknownFrequentSenders: UnknownFrequentSender[] = [];
  // Every sender is resolved first, so "matched a message in the window" is known for every member before any
  // suggestion is made.
  const unknownRows: typeof senders = [];
  for (const row of senders) {
    const decided = resolver.resolve(row.sender, row.jid);
    if (decided.memberId) seen.add(decided.memberId);
    for (const id of decided.candidateIds) seen.add(id);
    if (!(decided.isRosterMember || decided.status === "NOT_A_PERSON")) unknownRows.push(row);
  }
  const activeMembers = members.filter((m) => m.status === "ACTIVE");
  const suggestable: SuggestableMember[] = activeMembers.map((m) => ({
    id: m.id,
    name: m.name,
    phoneNumber: m.phoneNumber,
    whatsappId: m.whatsappId,
    matchedRecently: seen.has(m.id),
  }));
  const linkable = new Set(activeMembers.filter(hasNoRealWhatsAppId).map((m) => m.id));
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  for (const row of unknownRows) {
    if (row.groups < LIKELY_STAFF_MIN_GROUPS || isOwnSender(ownIds, row.sender, row.jid)) continue;
    const described = describeSenderId(row.sender, row.jid);
    unknownFrequentSenders.push({
      sender: row.sender,
      phone: described.phone,
      whatsappId: described.kind === "PHONE" ? null : described.id,
      name: row.name,
      groups: row.groups,
      messages: row.messages,
      lastAt: row.lastAt,
      suggestion: suggestionFor(suggestMemberForSender(row.name, suggestable), nameOf, linkable),
    });
  }
  unknownFrequentSenders.sort((a, b) => b.groups - a.groups || b.messages - a.messages);

  const quietMembers = members.filter((m) => m.status === "ACTIVE" && !seen.has(m.id)).map((m) => ({ id: m.id, name: m.name }));
  const linkableMembers = activeMembers.filter((m) => linkable.has(m.id)).map((m) => ({ id: m.id, name: m.name, designation: m.role }));
  return { ownNumberMembers, quietMembers, unknownFrequentSenders: unknownFrequentSenders.slice(0, 20), pendingReattributions, linkableMembers };
}

function suggestionFor(
  found: ReturnType<typeof suggestMemberForSender>,
  names: Map<string, string>,
  linkable: Set<string>,
): SenderSuggestion | null {
  if (found.kind === "NONE") return null;
  const ids = found.kind === "ONE" ? [found.memberId] : found.memberIds;
  return { kind: found.kind, members: ids.map((id) => ({ id, name: names.get(id) ?? "A team member", linkable: linkable.has(id) })) };
}

/** Where a member's earlier history stands after they were added or their identifiers changed. */
export interface MemberHistorySync {
  state: "SYNCING" | "DONE" | "FAILED";
  /** Their group messages found and now counted (DONE only). */
  messages: number | null;
  groups: number | null;
  firstAt: string | null;
}

/**
 * The newest re-attribution naming each member (reattribution.ts in the worker): "syncing" while it
 * runs, then what it found — so whoever added a colleague who was already answering customers sees
 * that their earlier work was collected into the reports.
 */
export async function getMemberHistorySync(): Promise<Map<string, MemberHistorySync>> {
  const rows = await prisma.identityReattribution.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { memberIds: true, status: true, result: true },
  });
  const out = new Map<string, MemberHistorySync>();
  for (const row of rows) {
    const found = (row.result as { members?: Record<string, { messages: number; groups: number; firstAt: string | null }> } | null)?.members ?? {};
    for (const id of row.memberIds) {
      if (out.has(id)) continue;
      const state = row.status === "DONE" ? "DONE" : row.status === "FAILED" ? "FAILED" : "SYNCING";
      out.set(id, { state, messages: found[id]?.messages ?? null, groups: found[id]?.groups ?? null, firstAt: found[id]?.firstAt ?? null });
    }
  }
  return out;
}
