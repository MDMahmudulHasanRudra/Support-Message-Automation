import { projectHasFeature } from "../project/features.js";
import { currentProjectId } from "../project/context.js";
import { prisma } from "../db.js";
import { createSenderResolver, getDhakaDayRange, toDhakaDateOnly } from "@support-automation/shared";
import { resolveActiveTeamMember } from "../pipeline/teamFilter.js";

/**
 * Records that a team member demonstrated work activity on a local calendar day.
 *
 * The business rule: a genuine message from an active team member in ANY group is evidence that
 * person worked that Dhaka calendar day. EVIDENCE, not a verdict — this writes what was observed
 * and never decides on its own that somebody was present or absent. Whether a given day reads as
 * duty, off-day duty or "no activity yet" is derived later by joining this against the roster and
 * approved leave; see `teamManagementReports.ts`.
 *
 * Deliberately reads `Message`, not `SupportActivity`. `SupportActivitySettings.enabled` defaults
 * to false and its detector returns early when off, so anything built on that table is empty on a
 * fresh install and would silently empty if tracking were ever switched off. An attendance record
 * that quietly stops recording is worse than one that never started. `getGroupsAwaitingReply`
 * already reads `Message` directly for exactly this reason.
 *
 * Not gated behind a settings flag, unlike most optional features here. The evidence is one row per
 * member per day, it costs one indexed aggregate on messages a team member sends, and it is only
 * useful if it was already being collected by the time somebody opens the module. A gate would
 * guarantee the roster's first week is blank.
 */

interface GroupTotals {
  groupId: string;
  accountId: string;
  messages: number;
  firstAt: Date;
  lastAt: Date;
}

/**
 * Never throws. Attaches to the message pipeline as a fire-and-forget side effect, exactly like the
 * escalation and support-activity hooks beside it: a failure here must never break the processing
 * of a customer's message.
 */
export async function recordTeamAttendance(input: {
  groupId: string | null;
  isFromTeamMember: boolean;
  senderPhone: string;
  /** The sender with its WhatsApp domain (`Message.senderJid`), when known. */
  senderJid?: string | null;
  timestampWa: Date;
}): Promise<void> {
  // Cheap filters first, costing zero queries on the overwhelming majority of messages — the same
  // ordering the support-activity detector uses and for the same reason.
  if (!input.groupId) return; // a 1:1 chat is not group work
  if (!input.isFromTeamMember) return; // a customer
  if (!(await projectHasFeature("TEAM_MANAGEMENT"))) return; // not entitled (MULTI_PROJECT_PLAN.md §9)

  const member = await resolveActiveTeamMember(input.senderPhone, input.senderJid);
  if (!member) return; // no longer on the roster, deactivated, or an identity conflict nobody can be credited with

  await recomputeAttendanceDay(member.id, input.timestampWa);
}

/**
 * A reply a dashboard user sent from the inbox (MANUAL_REPLY) is that person's work too: credited to
 * the team member linked to that login (Team Members → login link), exactly as the Team Report
 * credits it (report accuracy audit, 19 Oct 2026). Without this, somebody who worked a whole shift
 * in WhatsApp Chat showed "No activity" on Duty History.
 *
 * Called from both ends of the send — when the queue records the WhatsApp id it was sent under, and
 * when WhatsApp echoes it back — because either can happen first; the recompute counts what is
 * there each time, so whichever runs last sees both. Never throws.
 */
export async function recordOperatorAttendance(input: { providerMessageId: string | null; timestampWa: Date }): Promise<void> {
  try {
    if (!input.providerMessageId) return;
    if (!(await projectHasFeature("TEAM_MANAGEMENT"))) return;
    const sent = await prisma.outboundMessage.findFirst({
      where: { providerMessageId: input.providerMessageId, actionType: "MANUAL_REPLY", createdById: { not: null } },
      select: { createdById: true },
    });
    if (!sent?.createdById) return;
    const member = await prisma.internalTeamMember.findFirst({ where: { userId: sent.createdById, status: "ACTIVE" }, select: { id: true } });
    if (!member) return;
    await recomputeAttendanceDay(member.id, input.timestampWa);
  } catch (err) {
    console.error("[attendance] could not record a dashboard reply's attendance; the message itself is stored", err);
  }
}

/**
 * Recomputes one member-day of attendance from the messages themselves (see `recordTeamAttendance`).
 * Exported for the re-attribution job, which recomputes the days an identity change touched.
 */
export async function recomputeAttendanceDay(memberId: string, when: Date): Promise<void> {
  // Every stored form of this person's sender id — read through the same rule that resolves them
  // (WHATSAPP_IDENTITY.md), so the recompute looks for the same pile of messages that triggered it.
  // An identifier this member SHARES with another active member is left out: their messages are
  // credited to nobody, so counting them here would credit them to this person.
  const roster = await prisma.internalTeamMember.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, phoneNumber: true, whatsappId: true, attributeFrom: true, userId: true },
  });
  const member = roster.find((m) => m.id === memberId);
  if (!member) return;
  const identifiers = createSenderResolver(roster).identifiersFor(member.id);

  const activityDate = toDhakaDateOnly(when);
  const { start: dayStart, end } = getDhakaDayRange(when);
  // Before the member's "count their messages from" date their number was a customer's: those
  // messages are not their work (the Team Report's rule).
  // (A date after the whole day leaves nothing to count, which withdraws any row written before it.)
  const start = member.attributeFrom && member.attributeFrom > dayStart ? member.attributeFrom : dayStart;

  /**
   * One transaction, holding a lock nobody outside the database can bypass.
   *
   * Recomputing rather than incrementing is what makes a replayed message, a worker retry or a
   * reconnect harmless — they all converge on the same answer. That is true SEQUENTIALLY. It is
   * not true concurrently: two messages arriving at once give two recomputes, and A reading nine
   * while B reads ten and writes ten, then A writing its stale nine, is a lost update that leaves
   * the count quietly wrong with nothing to show for it.
   *
   * `pg_advisory_xact_lock` serialises the read and the write for one member-day. It is held in
   * POSTGRES, not in worker memory: two worker processes share no memory to lock in, and the whole
   * point is that this stays correct across them. Transaction-scoped, so it is released on commit
   * or rollback without any unlock call to forget.
   */
  await prisma.$transaction(async (tx) => {
    const lockKey = `team-attendance:${member.id}:${activityDate.toISOString().slice(0, 10)}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

    const projectId = currentProjectId();
    const totals = await tx.$queryRaw<Array<{ groupId: string; accountId: string; messages: bigint; firstAt: Date; lastAt: Date }>>`
      WITH mine AS (
        -- Their own messages. INCOMING only: an executive typing from the business phone produces an
        -- OUTGOING row carrying the ACCOUNT's number, not theirs, so it cannot be attributed to a
        -- person — and counting it would credit whoever is on the roster with the AI's replies.
        SELECT m."groupId", m."accountId", m."chatId", m."whatsappMessageId", m."timestampWa"
        FROM "Message" m
        WHERE m."projectId" = ${projectId}
          -- Raw SQL is not scoped by the client, so the project is stated here: the same person can
          -- be on two projects' rosters, and one project's attendance must never count the other's.
          AND m."senderPhone" = ANY(${identifiers})
          AND m."direction" = 'INCOMING'
          AND m."groupId" IS NOT NULL
          AND m."timestampWa" >= ${start}
          AND m."timestampWa" < ${end}
        UNION ALL
        -- Replies they sent from the dashboard inbox, through the login linked to them: the echo of a
        -- MANUAL_REPLY that login queued.
        SELECT m."groupId", m."accountId", m."chatId", m."whatsappMessageId", m."timestampWa"
        FROM "Message" m
        JOIN "OutboundMessage" o ON o."providerMessageId" = m."whatsappMessageId" AND o."projectId" = ${projectId}
        WHERE m."projectId" = ${projectId}
          AND ${member.userId ?? ""} <> ''
          AND o."createdById" = ${member.userId ?? ""}
          AND o."actionType" = 'MANUAL_REPLY'
          AND m."direction" = 'OUTGOING'
          AND m."groupId" IS NOT NULL
          AND m."timestampWa" >= ${start}
          AND m."timestampWa" < ${end}
      ),
      logical AS (
        -- One row per logical message per WhatsApp group: each of our numbers in a group stores its own
        -- copy, and counting copies doubled the messages and the groups of anybody in a group two of
        -- our numbers share (report accuracy audit, 19 Oct 2026). The group row kept is the lowest id,
        -- so the same WhatsApp group is always recorded under the same row.
        SELECT DISTINCT ON (g."whatsappGroupId", (CASE WHEN x."whatsappMessageId" ~ '^(true|false)_[^_]*@[^_]*_[^_]+'
                                                  THEN split_part(x."whatsappMessageId", '_', 3) ELSE x."whatsappMessageId" END))
          g."whatsappGroupId" AS wgid, x."groupId", x."accountId", x."timestampWa"
        FROM mine x
        JOIN "WhatsAppGroup" g ON g."id" = x."groupId"
        ORDER BY g."whatsappGroupId", (CASE WHEN x."whatsappMessageId" ~ '^(true|false)_[^_]*@[^_]*_[^_]+'
                                       THEN split_part(x."whatsappMessageId", '_', 3) ELSE x."whatsappMessageId" END), x."groupId"
      )
      SELECT
        MIN(l."groupId")                                     AS "groupId",
        (array_agg(l."accountId" ORDER BY l."groupId"))[1]   AS "accountId",
        COUNT(*)                                             AS "messages",
        MIN(l."timestampWa")                                 AS "firstAt",
        MAX(l."timestampWa")                                 AS "lastAt"
      FROM logical l
      GROUP BY l.wgid
    `;

    // Deliberately NOT filtered on `Message.isFromTeamMember`. That column is stamped at insert
    // time, so it is false for everything somebody sent before they were added to the roster —
    // filtering on it would mean adding a colleague at noon silently discarded their morning.
    // `senderPhone` is the identity, and the member was already resolved as ACTIVE above.

    const groups: GroupTotals[] = totals.map((row) => ({
      groupId: row.groupId,
      accountId: row.accountId,
      messages: Number(row.messages),
      firstAt: row.firstAt,
      lastAt: row.lastAt,
    }));

    if (groups.length === 0) {
      // Nothing of theirs in this day (a clock skew, a replay of something since deleted, or an
      // identity change that moved these messages to somebody else or before their "count from"
      // date). Writing a zero-message "worked" row would be a claim nothing supports; a row already
      // written from evidence that no longer holds is withdrawn — kept, at zero, only when a manager
      // has recorded an override on it, which is not evidence and must survive.
      const existing = await tx.teamAttendanceDay.findUnique({
        where: { teamMemberId_activityDate: { teamMemberId: member.id, activityDate } },
        select: { id: true, override: true },
      });
      if (!existing) return;
      await tx.teamAttendanceGroup.deleteMany({ where: { attendanceDayId: existing.id } });
      if (existing.override) {
        await tx.teamAttendanceDay.update({
          where: { id: existing.id },
          data: { messageCount: 0, uniqueGroupCount: 0, firstActivityAt: null, lastActivityAt: null },
        });
      } else {
        await tx.teamAttendanceDay.delete({ where: { id: existing.id } });
      }
      return;
    }

    const messageCount = groups.reduce((sum, group) => sum + group.messages, 0);
    const firstActivityAt = groups.reduce((min, g) => (g.firstAt < min ? g.firstAt : min), groups[0]!.firstAt);
    const lastActivityAt = groups.reduce((max, g) => (g.lastAt > max ? g.lastAt : max), groups[0]!.lastAt);

    const day = await tx.teamAttendanceDay.upsert({
      where: { teamMemberId_activityDate: { teamMemberId: member.id, activityDate } },
      create: {
        teamMemberId: member.id,
        activityDate,
        messageCount,
        uniqueGroupCount: groups.length,
        firstActivityAt,
        lastActivityAt,
      },
      // The override columns are pointedly absent: a manager's correction is not evidence and must
      // survive every later message that day.
      update: {
        messageCount,
        uniqueGroupCount: groups.length,
        firstActivityAt,
        lastActivityAt,
      },
      select: { id: true },
    });

    // Write only what actually changed.
    //
    // This was an upsert per group, awaited in sequence, INSIDE the transaction holding the
    // advisory lock — so an executive working forty groups paid forty round trips on every single
    // message they sent, and the count grew through the day. Quadratic in a person's own
    // productivity, and close enough to Prisma's 5s interactive-transaction timeout on a busy
    // afternoon that the whole recompute would start rolling back.
    //
    // The recompute produces the same rows as last time for every group except the one this
    // message arrived in, which is almost always exactly one. Reading the current rows first turns
    // "forty writes" into "one", and on a tick where nothing moved, into none — and it shortens
    // the window the lock is held for, which is what everything else waiting on this member-day
    // is blocked by.
    const current = await tx.teamAttendanceGroup.findMany({
      where: { attendanceDayId: day.id },
      select: { groupId: true, accountId: true, messageCount: true, firstAt: true, lastAt: true },
    });
    const currentByGroup = new Map(current.map((row) => [row.groupId, row]));

    const missing = groups.filter((group) => !currentByGroup.has(group.groupId));
    const changed = groups.filter((group) => {
      const existing = currentByGroup.get(group.groupId);
      if (!existing) return false;
      return (
        existing.accountId !== group.accountId ||
        existing.messageCount !== group.messages ||
        existing.firstAt.getTime() !== group.firstAt.getTime() ||
        existing.lastAt.getTime() !== group.lastAt.getTime()
      );
    });

    if (missing.length > 0) {
      await tx.teamAttendanceGroup.createMany({
        data: missing.map((group) => ({
          attendanceDayId: day.id,
          groupId: group.groupId,
          accountId: group.accountId,
          messageCount: group.messages,
          firstAt: group.firstAt,
          lastAt: group.lastAt,
        })),
        // The advisory lock already serialises this member-day, so a duplicate should be
        // impossible — but the primary key stays the real authority, not this reasoning.
        skipDuplicates: true,
      });
    }

    for (const group of changed) {
      await tx.teamAttendanceGroup.update({
        where: { attendanceDayId_groupId: { attendanceDayId: day.id, groupId: group.groupId } },
        data: {
          accountId: group.accountId,
          messageCount: group.messages,
          firstAt: group.firstAt,
          lastAt: group.lastAt,
        },
      });
    }

    // A group can only ever leave this set if its messages were deleted, which the recompute would
    // otherwise leave behind as a phantom. Skipped entirely when nothing could have left, which is
    // every ordinary message — it keeps uniqueGroupCount honest without a write to prove it.
    const stale = current.filter((row) => !groups.some((group) => group.groupId === row.groupId));
    if (stale.length > 0) {
      await tx.teamAttendanceGroup.deleteMany({
        where: { attendanceDayId: day.id, groupId: { in: stale.map((row) => row.groupId) } },
      });
    }
  });
}
