import { prisma } from "@support-automation/db";
import type { SupportActivityDetectionResult } from "./detector.js";

/**
 * Opens or closes a group's SupportSession in response to one already-recorded SupportActivity —
 * called by processIncomingMessage.ts right after detectSupportActivity() returns a non-null
 * result, never a second/parallel detection pass. Group-level scope by explicit requirement: one
 * OPEN session per WhatsAppGroup at a time, regardless of which team member's activity opens or
 * closes it. There is deliberately no automatic timeout/inactivity closure anywhere in this file —
 * a session with no completion-keyword activity stays OPEN until either a completion keyword
 * arrives or an admin manually closes it (apps/web/src/server/actions/supportSessions.ts).
 */
export async function updateSupportSessionForActivity(result: SupportActivityDetectionResult): Promise<void> {
  if (result.marksCompletion) {
    await closeOpenSession(result);
  } else {
    await openSessionIfNeeded(result);
  }
}

async function openSessionIfNeeded(result: SupportActivityDetectionResult): Promise<void> {
  const existing = await prisma.supportSession.findUnique({ where: { openGroupId: result.groupId } });
  if (existing) return; // an open session already covers this group; this activity just accumulates against it

  try {
    await prisma.supportSession.create({
      data: {
        accountId: result.accountId,
        groupId: result.groupId,
        status: "OPEN",
        openGroupId: result.groupId,
        startedAt: result.occurredAt,
        startedByTeamMemberId: result.teamMemberId,
        firstActivityId: result.activityId,
      },
    });
  } catch (err: any) {
    // openGroupId's unique constraint tripped — another concurrent message in this same group won
    // the race to open a session first (message events are handled fire-and-forget per event, not
    // strictly serially, so this is a real race, not a theoretical one). Safe lost-race no-op.
    if (err?.code !== "P2002") throw err;
  }
}

async function closeOpenSession(result: SupportActivityDetectionResult): Promise<void> {
  const openSession = await prisma.supportSession.findUnique({ where: { openGroupId: result.groupId } });
  // A completion keyword with no open session for this group is a deliberate no-op: the
  // SupportActivity row itself is already recorded normally by detector.ts; nothing to close here.
  if (!openSession) return;

  const durationSeconds = Math.max(
    0,
    Math.round((result.occurredAt.getTime() - openSession.startedAt.getTime()) / 1000),
  );

  // Claim-style guard, same shape as escalationQueue.ts's claim pattern: include the expected
  // current state in the `where` and treat a zero-row update as "lost the race" rather than
  // blindly overwriting — guards against two completion-keyword messages for the same group
  // racing each other, or racing an admin's manual close (see supportSessions.ts).
  await prisma.supportSession.updateMany({
    where: { id: openSession.id, status: "OPEN" },
    data: {
      status: "COMPLETED",
      openGroupId: null,
      completedAt: result.occurredAt,
      completedByTeamMemberId: result.teamMemberId,
      completionActivityId: result.activityId,
      durationSeconds,
    },
  });
}
