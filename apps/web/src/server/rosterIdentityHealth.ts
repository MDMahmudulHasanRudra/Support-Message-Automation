import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { loadOwnSenderIds } from "@/server/messageIdentity";
import { createSenderResolver, describeSenderId, isOwnSender, normalizePhoneNumber } from "@support-automation/shared";

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
}

export interface RosterIdentityHealth {
  ownNumberMembers: Array<{ id: string; name: string }>;
  quietMembers: Array<{ id: string; name: string }>;
  unknownFrequentSenders: UnknownFrequentSender[];
  pendingReattributions: number;
}

export async function getRosterIdentityHealth(now: Date = new Date()): Promise<RosterIdentityHealth> {
  const projectId = await activeProjectId();
  const since = new Date(now.getTime() - IDENTITY_HEALTH_WINDOW_DAYS * 86_400_000);
  const [members, accounts, ownIds, senders, pendingReattributions] = await Promise.all([
    prisma.internalTeamMember.findMany({ select: { id: true, name: true, phoneNumber: true, whatsappId: true, status: true } }),
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
  for (const row of senders) {
    const decided = resolver.resolve(row.sender, row.jid);
    if (decided.memberId) seen.add(decided.memberId);
    for (const id of decided.candidateIds) seen.add(id);
    if (decided.isRosterMember || decided.status === "NOT_A_PERSON") continue;
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
    });
  }
  unknownFrequentSenders.sort((a, b) => b.groups - a.groups || b.messages - a.messages);

  const quietMembers = members.filter((m) => m.status === "ACTIVE" && !seen.has(m.id)).map((m) => ({ id: m.id, name: m.name }));
  return { ownNumberMembers, quietMembers, unknownFrequentSenders: unknownFrequentSenders.slice(0, 20), pendingReattributions };
}
