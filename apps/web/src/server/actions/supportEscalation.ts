"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { SupportPriority } from "@prisma/client";
import { requireSession } from "@/server/auth";

export interface PolicyFormState {
  error?: string;
  success?: boolean;
}

export async function updatePriorityPolicy(
  priority: SupportPriority,
  _prevState: PolicyFormState,
  formData: FormData,
): Promise<PolicyFormState> {
  await requireSession();

  const int = (key: string) => {
    const raw = Number(formData.get(key));
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : 0;
  };

  await prisma.supportPriorityPolicy.upsert({
    where: { priority },
    update: {
      firstAlertMinutes: int("firstAlertMinutes"),
      secondAlertMinutes: int("secondAlertMinutes"),
      memberEscalationMinutes: int("memberEscalationMinutes"),
      adminEscalationMinutes: int("adminEscalationMinutes"),
      followUpIntervalMinutes: int("followUpIntervalMinutes"),
      maxEscalations: Math.max(1, int("maxEscalations")),
    },
    create: {
      priority,
      firstAlertMinutes: int("firstAlertMinutes"),
      secondAlertMinutes: int("secondAlertMinutes"),
      memberEscalationMinutes: int("memberEscalationMinutes"),
      adminEscalationMinutes: int("adminEscalationMinutes"),
      followUpIntervalMinutes: int("followUpIntervalMinutes"),
      maxEscalations: Math.max(1, int("maxEscalations")),
    },
  });

  revalidatePath("/support-escalation/policies");
  return { success: true };
}

export async function updateEscalationSettings(
  _prevState: PolicyFormState,
  formData: FormData,
): Promise<PolicyFormState> {
  await requireSession();
  const escalationAdminId = String(formData.get("escalationAdminId") ?? "").trim() || null;
  const enabled = formData.get("enabled") === "on";

  await prisma.supportEscalationSettings.upsert({
    where: { id: "global" },
    update: { enabled, escalationAdminId },
    create: { id: "global", enabled, escalationAdminId },
  });

  revalidatePath("/support-escalation/policies");
  return { success: true };
}

/** Still-pending checks stop; a check already in flight (within its claim lease) finishes naturally. */
export async function pauseCase(caseId: string): Promise<void> {
  await requireSession();
  const caseRow = await prisma.supportEscalationCase.findUnique({ where: { id: caseId } });
  if (!caseRow || ["HUMAN_REPLIED", "RESOLVED", "CANCELLED", "PAUSED"].includes(caseRow.status)) return;

  await prisma.$transaction([
    prisma.supportEscalationCase.update({ where: { id: caseId }, data: { pausedAt: new Date() } }),
    prisma.supportEscalationEvent.create({
      data: {
        caseId,
        level: caseRow.escalationLevel,
        eventType: "PAUSED",
        recipientType: "SYSTEM",
        recipientKey: "SYSTEM",
        recipientLabel: "Paused by admin",
      },
    }),
  ]);
  // Separate from the transaction: status needs the PRE-pause value preserved for resume, but
  // Prisma doesn't let one statement both read-and-write the status into a second column here,
  // so this is a plain follow-up update.
  await prisma.supportEscalationCase.update({ where: { id: caseId }, data: { status: "PAUSED" } });

  revalidatePath(`/support-escalation/cases/${caseId}`);
  revalidatePath("/support-escalation");
}

/** Resumes a paused case right where it left off — status reverts to whatever it was before pausing, due immediately. */
export async function resumeCase(caseId: string): Promise<void> {
  await requireSession();
  const caseRow = await prisma.supportEscalationCase.findUnique({ where: { id: caseId } });
  if (!caseRow || caseRow.status !== "PAUSED") return;

  const events = await prisma.supportEscalationEvent.findMany({
    where: { caseId },
    orderBy: { createdAt: "desc" },
  });
  // Whatever tier last fired tells us which "waiting" status to resume into; none fired yet -> still NEW.
  const lastFired = events.find((e) => e.eventType !== "PAUSED" && e.eventType !== "RESUMED");
  const resumeStatus =
    lastFired?.eventType === "FIRST_NOTIFICATION"
      ? "WAITING_FOR_HUMAN"
      : lastFired?.eventType === "SECOND_NOTIFICATION"
        ? "SECOND_ALERT"
        : lastFired?.eventType === "MEMBER_NOTIFICATION"
          ? "MEMBER_ESCALATED"
          : lastFired?.eventType === "ADMIN_NOTIFICATION" || lastFired?.eventType === "FOLLOW_UP"
            ? "FOLLOW_UP"
            : "NEW";

  await prisma.$transaction([
    prisma.supportEscalationCase.update({
      where: { id: caseId },
      data: { status: resumeStatus, pausedAt: null, nextCheckAt: new Date() },
    }),
    prisma.supportEscalationEvent.create({
      data: {
        caseId,
        level: caseRow.escalationLevel,
        eventType: "RESUMED",
        recipientType: "SYSTEM",
        recipientKey: "SYSTEM",
        recipientLabel: "Resumed by admin",
      },
    }),
  ]);

  revalidatePath(`/support-escalation/cases/${caseId}`);
  revalidatePath("/support-escalation");
}

/** Forces the next tier to fire on the very next worker tick, skipping the rest of the current wait. */
export async function escalateNow(caseId: string): Promise<void> {
  await requireSession();
  const caseRow = await prisma.supportEscalationCase.findUnique({ where: { id: caseId } });
  if (!caseRow || ["HUMAN_REPLIED", "RESOLVED", "CANCELLED", "PAUSED"].includes(caseRow.status)) return;

  await prisma.$transaction([
    prisma.supportEscalationCase.update({ where: { id: caseId }, data: { nextCheckAt: new Date() } }),
    prisma.supportEscalationEvent.create({
      data: {
        caseId,
        level: caseRow.escalationLevel,
        eventType: "MANUAL_ESCALATE",
        recipientType: "SYSTEM",
        recipientKey: "SYSTEM",
        recipientLabel: "Escalated immediately by admin",
      },
    }),
  ]);

  revalidatePath(`/support-escalation/cases/${caseId}`);
  revalidatePath("/support-escalation");
}

export async function reassignCase(caseId: string, teamMemberId: string | null): Promise<void> {
  await requireSession();
  const caseRow = await prisma.supportEscalationCase.findUnique({ where: { id: caseId } });
  if (!caseRow) return;

  const member = teamMemberId ? await prisma.internalTeamMember.findUnique({ where: { id: teamMemberId } }) : null;

  await prisma.$transaction([
    prisma.supportEscalationCase.update({ where: { id: caseId }, data: { assignedTeamMemberId: teamMemberId } }),
    prisma.supportEscalationEvent.create({
      data: {
        caseId,
        level: caseRow.escalationLevel,
        eventType: "REASSIGNED",
        recipientType: "SYSTEM",
        recipientKey: "SYSTEM",
        recipientLabel: member ? `Reassigned to ${member.name}` : "Assignment cleared",
      },
    }),
  ]);

  revalidatePath(`/support-escalation/cases/${caseId}`);
}

/**
 * A ceiling on one bulk escalation action. Each case is its own transaction (see below), so this
 * bounds a sequential run as much as it bounds the write — and the active queue itself caps at 200.
 */
const MAX_BULK_CASE_IDS = 200;

const TERMINAL_STATUSES = ["HUMAN_REPLIED", "RESOLVED", "CANCELLED"];

export interface BulkCaseResult {
  changed: number;
  /** Selected but already finished — resolved, cancelled, or a human replied while the page sat open. */
  alreadyClosed: number;
  notFound: number;
  error?: string;
}

/**
 * Clears several cases at once — the action this queue was missing.
 *
 * Thirty stale P3 cases meant thirty navigations into thirty detail pages, on the one screen an
 * operator opens under time pressure. Worse, the page's own 200-case notice tells you to "resolve
 * some of these to see the rest" while offering no way to do it.
 *
 * Each case is handled INDIVIDUALLY rather than by one `updateMany`, and that is the load-bearing
 * detail: every close writes a `SupportEscalationEvent` beside the status change, in the same
 * transaction, and a batch update would silently skip the audit trail for all of them — leaving
 * thirty cases that closed with no record of who closed them or why. Closing is also guarded per
 * case, so a case a human answered while the page sat open is left alone rather than overwritten.
 */
async function runBulkCaseAction(
  ids: string[],
  apply: (caseId: string) => Promise<void>,
): Promise<BulkCaseResult> {
  await requireSession();

  const unique = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  if (unique.length === 0) return { changed: 0, alreadyClosed: 0, notFound: 0, error: "Select at least one case first." };
  if (unique.length > MAX_BULK_CASE_IDS) {
    return {
      changed: 0,
      alreadyClosed: 0,
      notFound: 0,
      error: `That is ${unique.length} cases at once, over the limit of ${MAX_BULK_CASE_IDS}. Narrow the filters and run it again.`,
    };
  }

  const existing = await prisma.supportEscalationCase.findMany({
    where: { id: { in: unique } },
    select: { id: true, status: true },
  });
  const notFound = unique.length - existing.length;
  const actionable = existing.filter((row) => !TERMINAL_STATUSES.includes(row.status));

  // Sequential, not Promise.all: each one is its own transaction, and firing two hundred at once
  // would take two hundred connections out of a bounded pool the worker is also drawing from.
  for (const row of actionable) {
    await apply(row.id);
  }

  revalidatePath("/support-escalation");
  return { changed: actionable.length, alreadyClosed: existing.length - actionable.length, notFound };
}

/** Marks several cases resolved, each with its own audit event. */
export async function bulkResolveCases(ids: string[]): Promise<BulkCaseResult> {
  return runBulkCaseAction(ids, markResolved);
}

/** Stops escalation on several cases without claiming anybody replied. */
export async function bulkStopEscalation(ids: string[]): Promise<BulkCaseResult> {
  return runBulkCaseAction(ids, stopEscalation);
}

/** Stops escalation without claiming a human replied — distinct from resolve/human-reply, same spirit as GroupBroadcastJob's cancel. */
export async function stopEscalation(caseId: string): Promise<void> {
  await requireSession();
  const caseRow = await prisma.supportEscalationCase.findUnique({ where: { id: caseId } });
  if (!caseRow || ["HUMAN_REPLIED", "RESOLVED", "CANCELLED"].includes(caseRow.status)) return;

  await prisma.supportEscalationCase.update({ where: { id: caseId }, data: { status: "CANCELLED" } });
  revalidatePath(`/support-escalation/cases/${caseId}`);
  revalidatePath("/support-escalation");
}

/** Clears escalation progress back to the start without discarding history — same idea as retrying a failed job. */
export async function resetEscalation(caseId: string): Promise<void> {
  await requireSession();
  const caseRow = await prisma.supportEscalationCase.findUnique({ where: { id: caseId } });
  if (!caseRow) return;

  await prisma.$transaction([
    prisma.supportEscalationCase.update({
      where: { id: caseId },
      data: { status: "NEW", escalationLevel: 0, nextCheckAt: new Date(), humanRepliedAt: null, resolvedAt: null, resolvedById: null },
    }),
    prisma.supportEscalationEvent.create({
      data: {
        caseId,
        level: 0,
        eventType: "RESET",
        recipientType: "SYSTEM",
        recipientKey: "SYSTEM",
        recipientLabel: "Reset by admin",
      },
    }),
  ]);

  revalidatePath(`/support-escalation/cases/${caseId}`);
  revalidatePath("/support-escalation");
}

export async function markResolved(caseId: string): Promise<void> {
  const session = await requireSession();
  const caseRow = await prisma.supportEscalationCase.findUnique({ where: { id: caseId } });
  if (!caseRow || ["RESOLVED", "CANCELLED"].includes(caseRow.status)) return;

  await prisma.$transaction([
    prisma.supportEscalationCase.update({
      where: { id: caseId },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: session.userId },
    }),
    prisma.supportEscalationEvent.create({
      data: {
        caseId,
        level: caseRow.escalationLevel,
        eventType: "RESOLVED",
        recipientType: "SYSTEM",
        recipientKey: "SYSTEM",
        recipientLabel: "Marked resolved by admin",
      },
    }),
  ]);

  revalidatePath(`/support-escalation/cases/${caseId}`);
  revalidatePath("/support-escalation");
}
