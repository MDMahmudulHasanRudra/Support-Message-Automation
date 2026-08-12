import { prisma } from "@support-automation/db";
import type { EscalationStatus, Prisma, SupportEscalationCase, SupportPriority } from "@prisma/client";
import { buildWhatsAppContactId, normalizePhoneNumber } from "@support-automation/shared";
import { getAutomationSettings } from "../pipeline/settings.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { formatEscalationAlert } from "./formatEscalationMessage.js";

/** Case is actively being monitored/escalated — excludes terminal states and PAUSED (paused cases are never auto-claimed). */
const ACTIVE_STATUSES: EscalationStatus[] = [
  "NEW",
  "MONITORING",
  "WAITING_FOR_HUMAN",
  "SECOND_ALERT",
  "MEMBER_ESCALATED",
  "ADMIN_ESCALATED",
  "FOLLOW_UP",
];

const TERMINAL_STATUSES: EscalationStatus[] = ["HUMAN_REPLIED", "RESOLVED", "CANCELLED"];

/** Claim lease — pushes nextCheckAt forward while a tick works on this case, so a crash mid-tick self-heals within this window instead of needing a separate stuck-row sweep. */
const CLAIM_LEASE_MS = 60_000;
/** Once maxEscalations is reached, stop reclaiming this case for a long time rather than looping forever with nothing to do — manual controls (escalate/reset) can still act on it. */
const EXHAUSTED_DEFER_MS = 24 * 60 * 60_000;

const PRIORITY_POLICY_DEFAULTS: Record<SupportPriority, Omit<Prisma.SupportPriorityPolicyCreateInput, "priority">> = {
  P1: { firstAlertMinutes: 0, secondAlertMinutes: 5, memberEscalationMinutes: 10, adminEscalationMinutes: 15, followUpIntervalMinutes: 15, maxEscalations: 10 },
  P2: { firstAlertMinutes: 5, secondAlertMinutes: 10, memberEscalationMinutes: 20, adminEscalationMinutes: 30, followUpIntervalMinutes: 30, maxEscalations: 6 },
  P3: { firstAlertMinutes: 15, secondAlertMinutes: 30, memberEscalationMinutes: 60, adminEscalationMinutes: 120, followUpIntervalMinutes: 120, maxEscalations: 3 },
};

/** Lazily seeds all three policy rows on first use, same "upsert on read" pattern as every other settings model in this app. */
export async function getSupportPriorityPolicies(): Promise<Record<SupportPriority, Prisma.SupportPriorityPolicyGetPayload<{}>>> {
  const priorities: SupportPriority[] = ["P1", "P2", "P3"];
  const rows = await Promise.all(
    priorities.map((priority) =>
      prisma.supportPriorityPolicy.upsert({
        where: { priority },
        update: {},
        create: { priority, ...PRIORITY_POLICY_DEFAULTS[priority] },
      }),
    ),
  );
  return Object.fromEntries(rows.map((r) => [r.priority, r])) as Record<SupportPriority, (typeof rows)[number]>;
}

export async function getSupportEscalationSettings() {
  return prisma.supportEscalationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
}

/**
 * Opens a new case for this chat, or — if one is already open — just bumps
 * lastCustomerMessageAt without resetting the escalation clock (spec's
 * Condition C: another customer message while waiting continues the
 * existing policy, it doesn't restart it).
 */
export async function openOrContinueCase(params: {
  accountId: string;
  groupId: string;
  chatId: string;
  clientPhone: string;
  priority: SupportPriority;
  assignedTeamMemberId: string | null;
  triggerMessageId: string;
  timestampWa: Date;
}): Promise<void> {
  const existing = await prisma.supportEscalationCase.findFirst({
    where: { chatId: params.chatId, status: { in: ACTIVE_STATUSES } },
  });
  if (existing) {
    await prisma.supportEscalationCase.update({
      where: { id: existing.id },
      data: { lastCustomerMessageAt: params.timestampWa },
    });
    return;
  }

  const policies = await getSupportPriorityPolicies();
  const policy = policies[params.priority];

  await prisma.supportEscalationCase.create({
    data: {
      accountId: params.accountId,
      groupId: params.groupId,
      chatId: params.chatId,
      clientPhone: params.clientPhone,
      priority: params.priority,
      status: "NEW",
      triggerMessageId: params.triggerMessageId,
      lastCustomerMessageAt: params.timestampWa,
      assignedTeamMemberId: params.assignedTeamMemberId,
      firstAlertMinutes: policy.firstAlertMinutes,
      secondAlertMinutes: policy.secondAlertMinutes,
      memberEscalationMinutes: policy.memberEscalationMinutes,
      adminEscalationMinutes: policy.adminEscalationMinutes,
      followUpIntervalMinutes: policy.followUpIntervalMinutes,
      maxEscalations: policy.maxEscalations,
      nextCheckAt: addMinutes(new Date(), policy.firstAlertMinutes),
    },
  });
}

/** The moment a real human support reply is detected for an open case, escalation stops for good. */
export async function markHumanReplied(chatId: string): Promise<void> {
  const claim = await prisma.supportEscalationCase.updateMany({
    where: { chatId, status: { in: ACTIVE_STATUSES } },
    data: { status: "HUMAN_REPLIED", humanRepliedAt: new Date() },
  });
  if (claim.count === 0) return;

  const caseRow = await prisma.supportEscalationCase.findFirst({
    where: { chatId, status: "HUMAN_REPLIED" },
    orderBy: { updatedAt: "desc" },
  });
  if (!caseRow) return;
  await prisma.supportEscalationEvent.create({
    data: {
      caseId: caseRow.id,
      level: caseRow.escalationLevel,
      eventType: "HUMAN_REPLIED",
      recipientType: "SYSTEM",
      recipientKey: "SYSTEM",
      recipientLabel: "Human reply detected",
    },
  });
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/** Atomically claims exactly one due case, or null if none are ready. Uses a claim-lease on nextCheckAt rather than a transient status, since `status` carries real business meaning here. */
async function claimNextDueCase(): Promise<SupportEscalationCase | null> {
  const candidate = await prisma.supportEscalationCase.findFirst({
    where: { status: { in: ACTIVE_STATUSES }, nextCheckAt: { lte: new Date() } },
    orderBy: { nextCheckAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await prisma.supportEscalationCase.updateMany({
    where: { id: candidate.id, nextCheckAt: candidate.nextCheckAt },
    data: { nextCheckAt: new Date(Date.now() + CLAIM_LEASE_MS) },
  });
  if (claim.count === 0) return null; // lost the race

  return prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: candidate.id } });
}

/**
 * Tries to record that (level, eventType, recipientKey) fired for this case, and — only if that
 * succeeds — creates the Notification alongside it in the same transaction. A unique-constraint
 * failure means this exact tier+recipient was already handled (by a previous crashed tick, a
 * concurrent worker, anything) — treated as "already done," never as an error to retry.
 */
async function fireEscalationEvent(params: {
  caseRow: SupportEscalationCase;
  level: number;
  eventType: Parameters<typeof prisma.supportEscalationEvent.create>[0]["data"]["eventType"];
  recipientType: "GROUP" | "MEMBER" | "ADMIN" | "SYSTEM";
  recipientKey: string;
  recipientLabel: string;
  destination: string;
  body: string;
}): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      const event = await tx.supportEscalationEvent.create({
        data: {
          caseId: params.caseRow.id,
          level: params.level,
          eventType: params.eventType,
          recipientType: params.recipientType,
          recipientKey: params.recipientKey,
          recipientLabel: params.recipientLabel,
        },
      });
      const notification = await tx.notification.create({
        data: {
          type: "WHATSAPP",
          destination: params.destination,
          relatedMessageId: params.caseRow.triggerMessageId,
          payload: { escalationCaseId: params.caseRow.id, body: params.body },
        },
      });
      await tx.supportEscalationEvent.update({ where: { id: event.id }, data: { notificationId: notification.id } });
    });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return false; // already fired — not an error
    throw err;
  }
}

async function fireGroupTier(
  caseRow: SupportEscalationCase,
  level: number,
  eventType: "FIRST_NOTIFICATION" | "SECOND_NOTIFICATION",
): Promise<void> {
  const settings = await getAutomationSettings();
  if (settings.whatsappNotificationGroupIds.length === 0) {
    await logSystemEvent("WARN", "support-escalation", "No WhatsApp notification groups configured — tier skipped", {
      caseId: caseRow.id,
      eventType,
    });
    return;
  }
  const body = await formatEscalationAlert({ caseRow, eventType });
  for (const groupId of settings.whatsappNotificationGroupIds) {
    await fireEscalationEvent({
      caseRow,
      level,
      eventType,
      recipientType: "GROUP",
      recipientKey: groupId,
      recipientLabel: groupId,
      destination: groupId,
      body,
    });
  }
}

async function fireMemberTier(caseRow: SupportEscalationCase, level: number): Promise<void> {
  if (!caseRow.assignedTeamMemberId) {
    await logSystemEvent("INFO", "support-escalation", "No assigned team member — member tier skipped", {
      caseId: caseRow.id,
    });
    return;
  }
  const member = await prisma.internalTeamMember.findUnique({ where: { id: caseRow.assignedTeamMemberId } });
  if (!member || member.status !== "ACTIVE") {
    await logSystemEvent("WARN", "support-escalation", "Assigned team member missing/inactive — member tier skipped", {
      caseId: caseRow.id,
    });
    return;
  }
  const memberDigits = normalizePhoneNumber(member.phoneNumber);
  if (!memberDigits) {
    await logSystemEvent("WARN", "support-escalation", "Assigned team member has an unusable phone number — member tier skipped", {
      caseId: caseRow.id,
      teamMemberId: member.id,
    });
    return;
  }
  const body = await formatEscalationAlert({ caseRow, eventType: "MEMBER_NOTIFICATION", recipientName: member.name });
  await fireEscalationEvent({
    caseRow,
    level,
    eventType: "MEMBER_NOTIFICATION",
    recipientType: "MEMBER",
    recipientKey: member.id,
    recipientLabel: member.name,
    destination: buildWhatsAppContactId(memberDigits),
    body,
  });
}

async function fireAdminTier(
  caseRow: SupportEscalationCase,
  level: number,
  eventType: "ADMIN_NOTIFICATION" | "FOLLOW_UP",
): Promise<void> {
  const escalationSettings = await getSupportEscalationSettings();
  if (!escalationSettings.escalationAdminId) {
    await logSystemEvent("WARN", "support-escalation", "No escalation admin configured — admin tier skipped", {
      caseId: caseRow.id,
      eventType,
    });
    return;
  }
  const admin = await prisma.internalTeamMember.findUnique({ where: { id: escalationSettings.escalationAdminId } });
  if (!admin || admin.status !== "ACTIVE") {
    await logSystemEvent("WARN", "support-escalation", "Escalation admin missing/inactive — admin tier skipped", {
      caseId: caseRow.id,
    });
    return;
  }
  const adminDigits = normalizePhoneNumber(admin.phoneNumber);
  if (!adminDigits) {
    await logSystemEvent("WARN", "support-escalation", "Escalation admin has an unusable phone number — admin tier skipped", {
      caseId: caseRow.id,
    });
    return;
  }
  const body = await formatEscalationAlert({ caseRow, eventType, recipientName: admin.name });
  await fireEscalationEvent({
    caseRow,
    level,
    eventType,
    recipientType: "ADMIN",
    recipientKey: admin.id,
    recipientLabel: admin.name,
    destination: buildWhatsAppContactId(adminDigits),
    body,
  });
}

/** Exported for direct testing — advances exactly one due case by one tier, or returns false if none are ready. */
export async function processOneCase(): Promise<boolean> {
  const caseRow = await claimNextDueCase();
  if (!caseRow) return false;

  const settings = await getSupportEscalationSettings();
  if (!settings.enabled) {
    // Feature-wide pause: defer, don't cancel — resuming the switch should pick up right where it left off.
    await prisma.supportEscalationCase.update({
      where: { id: caseRow.id },
      data: { nextCheckAt: new Date(Date.now() + EXHAUSTED_DEFER_MS) },
    });
    return true;
  }

  if (caseRow.escalationLevel >= caseRow.maxEscalations) {
    await prisma.supportEscalationCase.update({
      where: { id: caseRow.id },
      data: { nextCheckAt: new Date(Date.now() + EXHAUSTED_DEFER_MS) },
    });
    return true;
  }

  switch (caseRow.status) {
    case "NEW":
    case "MONITORING":
      await fireGroupTier(caseRow, 0, "FIRST_NOTIFICATION");
      await prisma.supportEscalationCase.update({
        where: { id: caseRow.id },
        data: { status: "WAITING_FOR_HUMAN", escalationLevel: 1, nextCheckAt: addMinutes(new Date(), caseRow.secondAlertMinutes) },
      });
      break;

    case "WAITING_FOR_HUMAN":
      await fireGroupTier(caseRow, 1, "SECOND_NOTIFICATION");
      await prisma.supportEscalationCase.update({
        where: { id: caseRow.id },
        data: { status: "SECOND_ALERT", escalationLevel: 2, nextCheckAt: addMinutes(new Date(), caseRow.memberEscalationMinutes) },
      });
      break;

    case "SECOND_ALERT":
      await fireMemberTier(caseRow, 2);
      await prisma.supportEscalationCase.update({
        where: { id: caseRow.id },
        data: { status: "MEMBER_ESCALATED", escalationLevel: 3, nextCheckAt: addMinutes(new Date(), caseRow.adminEscalationMinutes) },
      });
      break;

    case "MEMBER_ESCALATED":
      await fireAdminTier(caseRow, 3, "ADMIN_NOTIFICATION");
      await prisma.supportEscalationCase.update({
        where: { id: caseRow.id },
        data: { status: "ADMIN_ESCALATED", escalationLevel: 4, nextCheckAt: addMinutes(new Date(), caseRow.followUpIntervalMinutes) },
      });
      break;

    case "ADMIN_ESCALATED":
    case "FOLLOW_UP":
      await fireAdminTier(caseRow, caseRow.escalationLevel, "FOLLOW_UP");
      await prisma.supportEscalationCase.update({
        where: { id: caseRow.id },
        data: {
          status: "FOLLOW_UP",
          escalationLevel: caseRow.escalationLevel + 1,
          nextCheckAt: addMinutes(new Date(), caseRow.followUpIntervalMinutes),
        },
      });
      break;

    default:
      // Terminal/paused states are excluded from ACTIVE_STATUSES and should never be claimed —
      // defensive no-op if one somehow was.
      break;
  }
  return true;
}

export { ACTIVE_STATUSES, TERMINAL_STATUSES };
