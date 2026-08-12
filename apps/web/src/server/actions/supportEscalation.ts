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
