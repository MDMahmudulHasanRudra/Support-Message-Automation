"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

export interface CloseSupportSessionResult {
  ok: boolean;
  /** True when the session was already COMPLETED (by the automatic keyword path or a concurrent
   *  manual close) by the time this ran — a normal, expected outcome, not an error. */
  alreadyClosed?: boolean;
}

/**
 * Admin-facing manual close for a support session that never received a completion keyword (e.g.
 * a team member forgot to send "done"). Attribution deliberately never invents a fake
 * InternalTeamMember: this app's admin login (User) and the WhatsApp support roster
 * (InternalTeamMember) are two unrelated identities with no reliable mapping between them, so
 * completedByTeamMemberId stays null and completedByUserId records the admin instead — mirroring
 * SupportEscalationCase.resolvedById's existing "which logged-in admin did this" pattern.
 *
 * Safety: the update is conditional on status still being OPEN (same claim-style guard
 * sessionTracker.ts uses for the automatic close path) — if the completion keyword or another
 * admin already closed it first, this is a no-op that reports `alreadyClosed: true` rather than
 * overwriting the already-completed session or throwing.
 */
export async function closeSupportSessionManually(sessionId: string): Promise<CloseSupportSessionResult> {
  const session = await requireSession();

  const openSession = await prisma.supportSession.findUnique({ where: { id: sessionId } });
  if (!openSession || openSession.status !== "OPEN") {
    return { ok: false, alreadyClosed: true };
  }

  const now = new Date();
  const durationSeconds = Math.max(0, Math.round((now.getTime() - openSession.startedAt.getTime()) / 1000));

  const result = await prisma.supportSession.updateMany({
    where: { id: sessionId, status: "OPEN" },
    data: {
      status: "COMPLETED",
      openGroupId: null,
      completedAt: now,
      completedByTeamMemberId: null,
      completedByUserId: session.userId,
      durationSeconds,
    },
  });

  if (result.count === 0) {
    // Lost the race to the automatic completion-keyword path or a concurrent manual close.
    return { ok: false, alreadyClosed: true };
  }

  revalidatePath("/support-activity/reports");
  revalidatePath("/support-activity");
  revalidatePath("/support-activity/team");
  return { ok: true };
}
