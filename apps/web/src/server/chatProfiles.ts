import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { hasPermission } from "@/server/permissions";
import type { Session } from "@/server/auth";
import { messageKeySql } from "@/server/messageIdentity";
import {
  createSenderResolver,
  describeSenderId,
  isPersonKind,
  parseWhatsAppId,
  SENDER_MATCH_LABELS,
  type SenderMatchStatus,
  type WhatsAppIdKind,
} from "@support-automation/shared";

/**
 * What WhatsApp Chat's contact and group panels show (WHATSAPP_IDENTITY.md §7). Read only, from rows
 * this app already stores — nothing here asks the worker, and nothing is invented: a value WhatsApp
 * did not give us is shown as missing, never guessed.
 *
 * The page that calls these has already required `messages.view`. Roster details (a colleague's
 * stored number, department, Team) additionally need `whatsapp.view`, the Team Members page's own
 * key; linking a sender to a member needs `whatsapp.manage`.
 */

export interface RosterMatch {
  status: SenderMatchStatus;
  statusLabel: string;
  /** The credited member, when exactly one matched. */
  member: {
    id: string;
    name: string;
    designation: string;
    department: string | null;
    teamName: string | null;
    active: boolean;
    /** Only with `whatsapp.view`: the identifiers on their record. */
    phoneNumber: string | null;
    whatsappId: string | null;
  } | null;
  /** For CONFLICT / AMBIGUOUS: every member an identifier pointed at, by name. */
  candidates: Array<{ id: string; name: string }>;
}

export interface ContactProfile {
  /** The id as given in the URL, normalised: what the panel is about. */
  senderId: string;
  kind: WhatsAppIdKind | null;
  /** "+8801…" — only when the id IS a phone number. */
  phone: string | null;
  /** The WhatsApp id itself (a LID or the number's digits). */
  whatsappId: string | null;
  /** WhatsApp display names seen on this sender's messages, newest first. */
  names: string[];
  messageCount: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  /** One of this project's own WhatsApp numbers, seen from another of our numbers. */
  isOurNumber: boolean;
  roster: RosterMatch;
  /** Groups this sender has written in (stored messages), newest first. */
  groups: Array<{ whatsappGroupId: string; name: string; groupId: string | null; messages: number; lastAt: Date }>;
  /** This account's personal chat with them, when one exists. */
  personalChatId: string | null;
  canViewRoster: boolean;
  canLink: boolean;
  /** Active members with no WhatsApp ID recorded — who this sender could be linked to. */
  linkableMembers: Array<{ id: string; name: string; designation: string }>;
}

/**
 * A row whose sender is a PERSON: not one stored under a group's own id, which is what the provider
 * falls back to when WhatsApp names no author. Without this, such a row would be counted as — and
 * merged into — whoever's digits it shares.
 */
const PERSON_SENDER_SQL = Prisma.sql`(m."senderJid" IS NULL OR m."senderJid" NOT LIKE '%@g.us')`;

async function rosterAndPermissions(session: Session) {
  const [members, canViewRoster, canLink] = await Promise.all([
    prisma.internalTeamMember.findMany({
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        whatsappId: true,
        role: true,
        department: true,
        status: true,
        team: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    }),
    hasPermission(session, "whatsapp.view"),
    hasPermission(session, "whatsapp.manage"),
  ]);
  return { members, resolver: createSenderResolver(members), canViewRoster, canLink };
}

type Members = Awaited<ReturnType<typeof rosterAndPermissions>>["members"];

function rosterMatch(members: Members, status: SenderMatchStatus, memberId: string | null, candidateIds: string[], canViewRoster: boolean): RosterMatch {
  const byId = new Map(members.map((m) => [m.id, m]));
  const m = memberId ? byId.get(memberId) : undefined;
  return {
    status,
    statusLabel: SENDER_MATCH_LABELS[status],
    member: m
      ? {
          id: m.id,
          name: m.name,
          designation: m.role,
          department: m.department,
          teamName: m.team?.name ?? null,
          active: m.status === "ACTIVE",
          phoneNumber: canViewRoster ? m.phoneNumber : null,
          whatsappId: canViewRoster ? m.whatsappId : null,
        }
      : null,
    candidates: memberId ? [] : candidateIds.map((id) => ({ id, name: byId.get(id)?.name ?? "Unknown member" })),
  };
}

/**
 * Our own numbers, as stored sender ids: each account's digits, plus every id one of our accounts
 * SENT from (in a group that is usually its LID) — narrowed to one group's copies when given, since
 * the panels re-render on the chat's 4-second refresh and must not scan every outgoing message.
 */
async function ownSenderIds(projectId: string, whatsappGroupId: string | null, sender: string | null): Promise<Set<string>> {
  const [accounts, outgoing] = await Promise.all([
    prisma.whatsAppAccount.findMany({ select: { phoneNumber: true } }),
    whatsappGroupId
      ? prisma.$queryRaw<Array<{ sender: string }>>`
          SELECT DISTINCT m."senderPhone" AS sender FROM "Message" m
          JOIN "WhatsAppGroup" g ON g."id" = m."groupId" AND g."projectId" = ${projectId}
          WHERE m."projectId" = ${projectId} AND g."whatsappGroupId" = ${whatsappGroupId} AND m."direction" = 'OUTGOING'`
      : prisma.$queryRaw<Array<{ sender: string }>>`
          SELECT m."senderPhone" AS sender FROM "Message" m
          WHERE m."projectId" = ${projectId} AND m."senderPhone" = ${sender ?? ""} AND m."direction" = 'OUTGOING'
          LIMIT 1`,
  ]);
  const ids = new Set(outgoing.map((r) => r.sender));
  for (const a of accounts) if (a.phoneNumber) ids.add(a.phoneNumber.replace(/\D/g, ""));
  return ids;
}

export async function getContactProfile(session: Session, accountId: string, senderParam: string): Promise<ContactProfile | null> {
  const parsed = parseWhatsAppId(senderParam);
  if (!parsed || !isPersonKind(parsed.kind)) return null;
  const projectId = await activeProjectId();
  const user = parsed.user;

  const [stats, names, groupRows, roster, own] = await Promise.all([
    prisma.$queryRaw<Array<{ messages: bigint; first: Date | null; last: Date | null; jid: string | null }>>`
      SELECT COUNT(DISTINCT (m."chatId", ${messageKeySql()})) AS messages, MIN(m."timestampWa") AS first, MAX(m."timestampWa") AS last,
             MAX(m."senderJid") AS jid
      FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."senderPhone" = ${user} AND m."direction" = 'INCOMING' AND ${PERSON_SENDER_SQL}`,
    prisma.$queryRaw<Array<{ name: string }>>`
      SELECT m."senderName" AS name FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."senderPhone" = ${user} AND m."direction" = 'INCOMING' AND ${PERSON_SENDER_SQL}
        AND m."senderName" IS NOT NULL AND m."senderName" <> ''
      GROUP BY m."senderName" ORDER BY MAX(m."timestampWa") DESC LIMIT 5`,
    prisma.$queryRaw<Array<{ wgid: string; messages: bigint; last: Date }>>`
      SELECT g."whatsappGroupId" AS wgid, COUNT(DISTINCT ${messageKeySql()}) AS messages, MAX(m."timestampWa") AS last
      FROM "Message" m JOIN "WhatsAppGroup" g ON g."id" = m."groupId" AND g."projectId" = ${projectId}
      WHERE m."projectId" = ${projectId} AND m."senderPhone" = ${user} AND m."direction" = 'INCOMING' AND ${PERSON_SENDER_SQL}
      GROUP BY g."whatsappGroupId" ORDER BY MAX(m."timestampWa") DESC LIMIT 10`,
    rosterAndPermissions(session),
    ownSenderIds(projectId, null, user),
  ]);
  const row = stats[0];
  // The domain-carrying id is the better witness: the URL's, or one stored on their messages.
  const jid = parsed.kind === "UNKNOWN" ? (row?.jid ?? null) : senderParam;
  const described = describeSenderId(user, jid);
  const resolution = roster.resolver.resolve(user, jid);

  // Each group under THIS account's copy when it has one, so the link opens in the same inbox.
  const copies = groupRows.length
    ? await prisma.whatsAppGroup.findMany({
        where: { whatsappGroupId: { in: groupRows.map((g) => g.wgid) } },
        select: { id: true, name: true, accountId: true, whatsappGroupId: true },
      })
    : [];
  const groups = groupRows.map((g) => {
    const mine = copies.find((c) => c.whatsappGroupId === g.wgid && c.accountId === accountId);
    const any = mine ?? copies.find((c) => c.whatsappGroupId === g.wgid);
    return { whatsappGroupId: g.wgid, name: any?.name ?? g.wgid, groupId: mine?.id ?? null, messages: Number(g.messages), lastAt: g.last };
  });

  const personalCandidates = described.kind === "PHONE" ? [`${user}@c.us`] : described.kind === "LID" ? [`${user}@lid`] : [`${user}@c.us`, `${user}@lid`];
  const personal = await prisma.message.findFirst({
    where: { accountId, groupId: null, chatId: { in: personalCandidates } },
    select: { chatId: true },
  });

  const canLink = roster.canLink && resolution.status === "UNRESOLVED";
  return {
    senderId: jid ?? user,
    kind: described.kind,
    phone: described.phone,
    whatsappId: described.id,
    names: names.map((n) => n.name),
    messageCount: Number(row?.messages ?? 0),
    firstSeenAt: row?.first ?? null,
    lastSeenAt: row?.last ?? null,
    isOurNumber: own.has(user),
    roster: rosterMatch(roster.members, resolution.status, resolution.memberId, resolution.candidateIds, roster.canViewRoster),
    groups,
    personalChatId: personal?.chatId ?? null,
    canViewRoster: roster.canViewRoster,
    canLink,
    linkableMembers: canLink
      ? roster.members.filter((m) => m.status === "ACTIVE" && !m.whatsappId).map((m) => ({ id: m.id, name: m.name, designation: m.role }))
      : [],
  };
}

export interface GroupPerson {
  senderId: string;
  name: string | null;
  kind: WhatsAppIdKind | null;
  phone: string | null;
  messages: number;
  lastAt: Date;
  isOurNumber: boolean;
  memberName: string | null;
  status: SenderMatchStatus;
}

export interface LiveMember {
  rawId: string;
  name: string | null;
  kind: WhatsAppIdKind | null;
  phone: string | null;
  isSelf: boolean;
  memberName: string | null;
  status: SenderMatchStatus;
}

export interface GroupProfile {
  group: {
    id: string;
    name: string;
    whatsappGroupId: string;
    accountLabel: string;
    isActive: boolean;
    isMonitored: boolean;
    aiAutomationEnabled: boolean;
    testModeEnabled: boolean;
    participantCount: number | null;
    assignedMemberName: string | null;
    createdAt: Date;
    lastSyncedAt: Date | null;
  };
  /** Everyone with a stored message in this group (any of our accounts' copies), newest first. */
  seen: GroupPerson[];
  seenTruncated: boolean;
  /** The last member list read from WhatsApp, if anyone asked for one. */
  live:
    | { state: "NONE" }
    | { state: "PENDING"; requestedAt: Date }
    | { state: "FAILED"; error: string; at: Date }
    | { state: "READY"; readAt: Date; members: LiveMember[] };
  canRequestLive: boolean;
}

const SEEN_LIMIT = 200;

export async function getGroupProfile(session: Session, groupId: string): Promise<GroupProfile | null> {
  const group = await prisma.whatsAppGroup.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      whatsappGroupId: true,
      isActive: true,
      isMonitored: true,
      aiAutomationEnabled: true,
      testModeEnabled: true,
      participantCount: true,
      createdAt: true,
      lastSyncedAt: true,
      account: { select: { label: true } },
      assignedTeamMember: { select: { name: true } },
    },
  });
  if (!group) return null;
  const projectId = await activeProjectId();

  const [seenRows, roster, own, command] = await Promise.all([
    // One row per sender over every copy of this group, each message counted once (the logical key).
    prisma.$queryRaw<Array<{ sender: string; jid: string | null; name: string | null; messages: bigint; last: Date }>>`
      SELECT m."senderPhone" AS sender, MAX(m."senderJid") AS jid,
             (ARRAY_AGG(m."senderName" ORDER BY m."timestampWa" DESC) FILTER (WHERE m."senderName" IS NOT NULL AND m."senderName" <> ''))[1] AS name,
             COUNT(DISTINCT ${messageKeySql()}) AS messages, MAX(m."timestampWa") AS last
      FROM "Message" m JOIN "WhatsAppGroup" g ON g."id" = m."groupId" AND g."projectId" = ${projectId}
      WHERE m."projectId" = ${projectId} AND g."whatsappGroupId" = ${group.whatsappGroupId} AND m."direction" = 'INCOMING'
        AND ${PERSON_SENDER_SQL}
      GROUP BY m."senderPhone" ORDER BY MAX(m."timestampWa") DESC LIMIT ${SEEN_LIMIT + 1}`,
    rosterAndPermissions(session),
    ownSenderIds(projectId, group.whatsappGroupId, null),
    prisma.workerCommand.findFirst({
      where: { type: "GET_GROUP_PARTICIPANTS", payload: { path: ["groupId"], equals: group.id } },
      orderBy: { createdAt: "desc" },
      select: { status: true, createdAt: true, processedAt: true, result: true },
    }),
  ]);
  const nameOf = new Map(roster.members.map((m) => [m.id, m.name]));
  const groupUser = parseWhatsAppId(group.whatsappGroupId)?.user;

  const seen = seenRows
    .slice(0, SEEN_LIMIT)
    // A sender equal to the group's own id is a message WhatsApp named no author for — not a person.
    .filter((r) => r.sender !== groupUser)
    .map((r): GroupPerson => {
      const described = describeSenderId(r.sender, r.jid);
      const res = roster.resolver.resolve(r.sender, r.jid);
      return {
        senderId: r.jid ?? r.sender,
        name: r.name,
        kind: described.kind,
        phone: described.phone,
        messages: Number(r.messages),
        lastAt: r.last,
        isOurNumber: own.has(r.sender),
        memberName: res.memberId ? (nameOf.get(res.memberId) ?? null) : null,
        status: res.status,
      };
    });

  let live: GroupProfile["live"] = { state: "NONE" };
  if (command) {
    if (command.status === "PENDING" || command.status === "PROCESSING") live = { state: "PENDING", requestedAt: command.createdAt };
    else if (command.status === "FAILED") {
      live = {
        state: "FAILED",
        at: command.processedAt ?? command.createdAt,
        error: (command.result as { error?: string } | null)?.error ?? "The worker could not read this group's members.",
      };
    } else {
      const raw = (command.result as { participants?: Array<{ rawId?: string; phoneNumber?: string; name?: string | null; isSelf?: boolean }> } | null)
        ?.participants;
      if (Array.isArray(raw)) {
        live = {
          state: "READY",
          readAt: command.processedAt ?? command.createdAt,
          members: raw.map((p) => {
            const rawId = String(p.rawId ?? p.phoneNumber ?? "");
            const described = describeSenderId(p.phoneNumber, rawId);
            const res = roster.resolver.resolve(p.phoneNumber, rawId);
            return {
              rawId,
              name: p.name ?? null,
              kind: described.kind,
              phone: described.phone,
              isSelf: Boolean(p.isSelf),
              memberName: res.memberId ? (nameOf.get(res.memberId) ?? null) : null,
              status: res.status,
            };
          }),
        };
      }
    }
  }

  return {
    group: {
      id: group.id,
      name: group.name,
      whatsappGroupId: group.whatsappGroupId,
      accountLabel: group.account.label,
      isActive: group.isActive,
      isMonitored: group.isMonitored,
      aiAutomationEnabled: group.aiAutomationEnabled,
      testModeEnabled: group.testModeEnabled,
      participantCount: group.participantCount,
      assignedMemberName: group.assignedTeamMember?.name ?? null,
      createdAt: group.createdAt,
      lastSyncedAt: group.lastSyncedAt,
    },
    seen,
    seenTruncated: seenRows.length > SEEN_LIMIT,
    live,
    canRequestLive: roster.canLink,
  };
}
