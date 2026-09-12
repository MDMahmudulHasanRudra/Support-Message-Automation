import { prisma } from "@support-automation/db";
import { getDhakaDayRange, normalizePhoneNumber, toDhakaDateOnly } from "@support-automation/shared";
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

/**
 * Every form this person's `senderPhone` could have been stored in.
 *
 * `resolveActiveTeamMember` matches a sender by `whatsappId` EXACTLY first and then by
 * digits-normalised `phoneNumber`, so the recompute has to look for the same set or it would find
 * a different pile of messages than the one that triggered it. A LID-only member has the same
 * value in both columns, which the `Set` collapses.
 */
function senderIdentifiers(member: { phoneNumber: string; whatsappId: string | null }): string[] {
  const candidates = [member.whatsappId, member.phoneNumber, normalizePhoneNumber(member.phoneNumber)];
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

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
  timestampWa: Date;
}): Promise<void> {
  // Cheap filters first, costing zero queries on the overwhelming majority of messages — the same
  // ordering the support-activity detector uses and for the same reason.
  if (!input.groupId) return; // a 1:1 chat is not group work
  if (!input.isFromTeamMember) return; // a customer

  const member = await resolveActiveTeamMember(input.senderPhone);
  if (!member) return; // no longer on the roster, or deactivated

  const full = await prisma.internalTeamMember.findUnique({
    where: { id: member.id },
    select: { phoneNumber: true, whatsappId: true },
  });
  if (!full) return;

  const identifiers = senderIdentifiers(full);
  if (identifiers.length === 0) return;

  const activityDate = toDhakaDateOnly(input.timestampWa);
  const { start, end } = getDhakaDayRange(input.timestampWa);

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

    const totals = await tx.$queryRaw<Array<{ groupId: string; accountId: string; messages: bigint; firstAt: Date; lastAt: Date }>>`
      SELECT
        m."groupId"          AS "groupId",
        m."accountId"        AS "accountId",
        COUNT(*)             AS "messages",
        MIN(m."timestampWa") AS "firstAt",
        MAX(m."timestampWa") AS "lastAt"
      FROM "Message" m
      WHERE m."senderPhone" = ANY(${identifiers})
        -- INCOMING only. An executive typing from the business phone produces an OUTGOING row
        -- carrying the ACCOUNT's number, not theirs, so it cannot be attributed to a person at all
        -- — and counting it would credit whoever happens to be on the roster with the AI's replies.
        AND m."direction" = 'INCOMING'
        AND m."groupId" IS NOT NULL
        AND m."timestampWa" >= ${start}
        AND m."timestampWa" < ${end}
      GROUP BY m."groupId", m."accountId"
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
      // The message that triggered this is not in the window — a clock skew, or a replay of
      // something since deleted. Writing a zero-message "worked" row would be a claim about
      // somebody's day that nothing supports.
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

    for (const group of groups) {
      await tx.teamAttendanceGroup.upsert({
        where: { attendanceDayId_groupId: { attendanceDayId: day.id, groupId: group.groupId } },
        create: {
          attendanceDayId: day.id,
          groupId: group.groupId,
          accountId: group.accountId,
          messageCount: group.messages,
          firstAt: group.firstAt,
          lastAt: group.lastAt,
        },
        update: {
          accountId: group.accountId,
          messageCount: group.messages,
          firstAt: group.firstAt,
          lastAt: group.lastAt,
        },
      });
    }

    // A group can only ever leave this set if its messages were deleted, which the recompute would
    // otherwise leave behind as a phantom. Cheap, and it keeps uniqueGroupCount honest against the
    // rows that actually explain it.
    await tx.teamAttendanceGroup.deleteMany({
      where: { attendanceDayId: day.id, groupId: { notIn: groups.map((group) => group.groupId) } },
    });
  });
}
