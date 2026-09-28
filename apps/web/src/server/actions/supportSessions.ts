"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";

import { checkPermission } from "@/server/authorize";

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
  const granted = await checkPermission("support_activity.manage");
  if ("denied" in granted) return { ok: false };
  const session = granted.session;

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

  revalidatePath(await projectPath("/support-activity/reports"));
  revalidatePath(await projectPath("/support-activity"));
  revalidatePath(await projectPath("/support-activity/team"));
  return { ok: true };
}

export interface BulkCloseSupportSessionsResult {
  requested: number;
  closed: number;
  /** Already COMPLETED by the time this ran — the automatic keyword path, or included twice. */
  alreadyClosed: number;
  notFound: number;
  error?: string;
}

/**
 * The same manual close as `closeSupportSessionManually`, applied to a batch — Reports' Support
 * Sessions table can show dozens of stale OPEN sessions at once (a team member who never sent the
 * completion keyword), and closing each with its own confirm dialog does not scale.
 *
 * Deliberately N individual claim-style updates rather than one `updateMany`: each session needs
 * its OWN `durationSeconds` computed from its own `startedAt`, which `updateMany` cannot express
 * per-row. Every write still keeps the single-close guard (`status: "OPEN"` in the `where`), so a
 * session the automatic keyword path completes mid-batch is reported as already-closed rather than
 * overwritten — same safety property as the one-at-a-time button, just looped.
 */
export async function closeSupportSessionsBulk(sessionIds: string[]): Promise<BulkCloseSupportSessionsResult> {
  const granted = await checkPermission("support_activity.manage");
  if ("denied" in granted) return { requested: sessionIds.length, closed: 0, alreadyClosed: 0, notFound: 0, error: granted.denied };
  const session = granted.session;

  const dedupedIds = [...new Set(sessionIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (dedupedIds.length === 0) {
    return { requested: 0, closed: 0, alreadyClosed: 0, notFound: 0, error: "No sessions selected." };
  }

  const existing = await prisma.supportSession.findMany({
    where: { id: { in: dedupedIds } },
    select: { id: true, status: true, startedAt: true },
  });
  const existingById = new Map(existing.map((s) => [s.id, s]));
  const notFound = dedupedIds.filter((id) => !existingById.has(id)).length;

  let closed = 0;
  let alreadyClosed = 0;
  const now = new Date();

  for (const id of dedupedIds) {
    const openSession = existingById.get(id);
    if (!openSession) continue;
    if (openSession.status !== "OPEN") {
      alreadyClosed += 1;
      continue;
    }

    const durationSeconds = Math.max(0, Math.round((now.getTime() - openSession.startedAt.getTime()) / 1000));
    const result = await prisma.supportSession.updateMany({
      where: { id, status: "OPEN" },
      data: {
        status: "COMPLETED",
        openGroupId: null,
        completedAt: now,
        completedByTeamMemberId: null,
        completedByUserId: session.userId,
        durationSeconds,
      },
    });

    if (result.count > 0) closed += 1;
    else alreadyClosed += 1; // lost the race to the automatic completion-keyword path
  }

  if (closed > 0) {
    revalidatePath(await projectPath("/support-activity/reports"));
    revalidatePath(await projectPath("/support-activity"));
    revalidatePath(await projectPath("/support-activity/team"));
  }

  return { requested: dedupedIds.length, closed, alreadyClosed, notFound };
}
