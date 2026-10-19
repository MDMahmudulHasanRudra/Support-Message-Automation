import { Prisma } from "@prisma/client";
import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { loadReportIdentity, messageKeySql, outboundByKeyJoin, preferSenderCopySql, storedCopiesSql } from "@/server/messageIdentity";
import { splitIntoStretches, type IntelActor } from "@support-automation/shared";

/**
 * Group messages for the person-measuring reports outside the Team Report — Team Performance,
 * availability, first response, the Overview charts — decided EXACTLY as the Team Report decides
 * them (report accuracy audit, 19 Oct 2026):
 *
 *  - one row per logical message, whichever of our numbers stored it (copies counted once);
 *  - who sent it through `ReportIdentity.classify` at read time: every member on the roster now,
 *    every stored copy as a witness, the member's "count their messages from" date, our own numbers'
 *    posts as the business's, and a dashboard reply credited to the member linked to that login.
 *
 * These reports used to read `SupportActivity` (recorded only while that setting is on, only for
 * messages a rule matched, once per account copy, against the roster at the moment the message
 * arrived) or the `isFromTeamMember` stamp (frozen at arrival). So adding a colleague, linking their
 * WhatsApp ID, or a second number in the group changed the Team Report and nothing else: the same
 * person showed different numbers on two pages for the same day.
 */

export interface AttributedMessage {
  /** The WhatsApp group — one key per real group, whichever account stored it. */
  groupKey: string;
  ts: number;
  kind: "CUSTOMER" | "MEMBER" | "BUSINESS";
  /** The member credited; null for a customer, the business, or a colleague nobody could identify. */
  memberId: string | null;
  actor: IntelActor;
}

export interface AttributedMessageQuery {
  start: Date;
  end: Date;
  /** Only groups switched to monitored (the waits reports' scope). */
  monitoredOnly?: boolean;
}

interface Row {
  wgid: string;
  ts: Date;
  storedAt: Date;
  direction: string;
  fromTeam: boolean;
  sender: string;
  senderJid: string | null;
  copies: string[] | null;
  obMatched: boolean | null;
  actionType: string | null;
  ruleId: string | null;
  createdById: string | null;
}

/** Every group message in [start, end), classified, oldest first (same-second ones as stored). */
export async function loadAttributedMessages(query: AttributedMessageQuery): Promise<AttributedMessage[]> {
  const projectId = await activeProjectId();
  const [identity, rows] = await Promise.all([
    loadReportIdentity(projectId),
    prisma.$queryRaw<Row[]>`
      SELECT DISTINCT ON (g."whatsappGroupId", ${messageKeySql()})
        g."whatsappGroupId" AS wgid, m."timestampWa" AS ts, m."createdAt" AS "storedAt", m."direction"::text AS direction,
        m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender, m."senderJid" AS "senderJid",
        ${storedCopiesSql(Prisma.sql`g."whatsappGroupId"`)} AS copies,
        o."obMatched" AS "obMatched", o."actionType"::text AS "actionType", o."ruleId" AS "ruleId", o."createdById" AS "createdById"
      FROM "Message" m
      JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
      ${outboundByKeyJoin(projectId, query.start, query.end)}
      WHERE m."projectId" = ${projectId}
        AND m."timestampWa" >= ${query.start} AND m."timestampWa" < ${query.end}
        AND m."direction" <> 'SYSTEM'
        ${query.monitoredOnly ? Prisma.sql`AND g."isMonitored" = true` : Prisma.empty}
      ORDER BY g."whatsappGroupId", ${messageKeySql()}, ${preferSenderCopySql()}, m."timestampWa", m."id"`,
  ]);
  return rows
    .sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.storedAt.getTime() - b.storedAt.getTime())
    .map((row) => {
      const ts = row.ts.getTime();
      const decided = identity.classify(row, ts);
      return { groupKey: row.wgid, ts, kind: decided.kind, memberId: decided.memberId, actor: decided.actor };
    });
}

// ---------------------------------------------------------------------------------------------
// Pure readings over attributed messages — unit-tested, and shared by every page that shows them.
// ---------------------------------------------------------------------------------------------

export interface MemberWorkload {
  memberId: string;
  groupsHandled: number;
  messageCount: number;
  /** Support time: one timeline per person across all groups, split by the idle gap and at Dhaka midnight. */
  activeSeconds: number;
  sessionCount: number;
  firstAt: number;
  lastAt: number;
}

/**
 * What each member did in [start, end): groups, messages, stretches and support time — the Team
 * Report's own support-time rule (`splitIntoStretches`), so the two pages can never disagree.
 */
export function computeMemberWorkloads(messages: readonly AttributedMessage[], start: number, end: number, idleGapMs: number): MemberWorkload[] {
  const byMember = new Map<string, { ts: number[]; groups: Set<string> }>();
  for (const message of messages) {
    if (message.kind !== "MEMBER" || !message.memberId || message.ts < start || message.ts >= end) continue;
    let acc = byMember.get(message.memberId);
    if (!acc) byMember.set(message.memberId, (acc = { ts: [], groups: new Set() }));
    acc.ts.push(message.ts);
    acc.groups.add(message.groupKey);
  }
  return [...byMember]
    .map(([memberId, acc]) => {
      const ts = acc.ts.sort((a, b) => a - b);
      const stretches = splitIntoStretches(ts, idleGapMs);
      return {
        memberId,
        groupsHandled: acc.groups.size,
        messageCount: ts.length,
        activeSeconds: stretches.reduce((sum, s) => sum + Math.round((s.end - s.start) / 1000), 0),
        sessionCount: stretches.length,
        firstAt: ts[0]!,
        lastAt: ts[ts.length - 1]!,
      };
    })
    .sort((a, b) => b.messageCount - a.messageCount || a.memberId.localeCompare(b.memberId));
}

export interface FirstResponseWait {
  groupKey: string;
  askedAt: number;
  /** Null when nobody answered within what was loaded. */
  repliedAt: number | null;
}

/**
 * Waits that START in [start, end) — a customer message whose previous message in that group was a
 * reply, or there was none — and the first reply after each. The Team Report's wait definition: a
 * reply is anything not a customer's (a member, a colleague nobody could identify, the business).
 */
export function computeFirstResponseWaits(messages: readonly AttributedMessage[], start: number, end: number): FirstResponseWait[] {
  const byGroup = new Map<string, AttributedMessage[]>();
  for (const message of messages) {
    const list = byGroup.get(message.groupKey);
    if (list) list.push(message);
    else byGroup.set(message.groupKey, [message]);
  }
  const waits: FirstResponseWait[] = [];
  for (const [groupKey, list] of byGroup) {
    let nextReply: number | null = null;
    const nextReplyAt: Array<number | null> = new Array(list.length);
    for (let i = list.length - 1; i >= 0; i--) {
      nextReplyAt[i] = nextReply;
      if (list[i]!.kind !== "CUSTOMER") nextReply = list[i]!.ts;
    }
    for (let i = 0; i < list.length; i++) {
      const message = list[i]!;
      if (message.kind !== "CUSTOMER" || message.ts < start || message.ts >= end) continue;
      if (i > 0 && list[i - 1]!.kind === "CUSTOMER") continue;
      waits.push({ groupKey, askedAt: message.ts, repliedAt: nextReplyAt[i]! });
    }
  }
  return waits.sort((a, b) => a.askedAt - b.askedAt);
}

/** Median of a list (the mean of the two middle values for an even count), or null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
