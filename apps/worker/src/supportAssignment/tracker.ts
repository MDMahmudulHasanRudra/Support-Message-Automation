import type { Prisma } from "@prisma/client";
import { buildSupportAssignmentNotices, queueSupportAssignmentNotices } from "@support-automation/db";
import {
  decideReply,
  formatResponseTime,
  isOnlyIgnoredWords,
  qualifyCustomerMessage,
  QUALIFICATION_REASON_LABELS,
  type Qualification,
} from "@support-automation/shared";
import { prisma } from "../db.js";
import { currentProjectId } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import type { SupportResponseTrack } from "../supportResponse/tracker.js";

/**
 * Support Assignment, the pipeline half (SUPPORT_ASSIGNMENT.md). Runs right after the Support
 * response tracker, on every NEW message — live, caught up or recovered — and reads the tracker's
 * own decision, so a case and the wait it is built on can never disagree about who is a customer.
 *
 * - A customer message opens the group's case, or adds to it: qualified (support work) or IGNORED
 *   (an ignored sender, or nothing but ignored words). Ignored messages are counted, never dropped.
 * - A team member's message may complete the case (the assignee, after being assigned, with more
 *   than ignored words) or close it as answered by somebody else (`decideReply`).
 *
 * One CURRENT case per WhatsApp group — not per account's copy of it — decided under a per-group
 * advisory lock and enforced by a partial unique index, so two of our numbers in one group, or two
 * messages arriving together, never open two cases.
 *
 * Never throws, and never gates the pipeline: a failure is logged and the message carries on through
 * rules, AI and escalation exactly as before.
 */
export async function trackSupportAssignment(input: {
  track: SupportResponseTrack | null;
  messageId: string;
  groupId: string | null;
  whatsappGroupId: string;
  accountId: string;
  senderPhone: string;
  body: string;
  hasMedia: boolean;
  timestampWa: Date;
}): Promise<void> {
  const { track } = input;
  if (!track || !input.groupId) return;
  if (track.role !== "CUSTOMER" && !track.memberId) return;
  try {
    const settings = await prisma.supportAssignmentSettings.findUnique({ where: { id: "global" } });
    if (!settings?.enabled) return;
    if (!(await projectHasFeature("SUPPORT_ASSIGNMENT"))) return;

    if (track.role === "CUSTOMER") {
      if ((track.action === "OPEN" || track.action === "EXTEND") && track.episodeId) {
        const qualification = qualifyCustomerMessage(
          { body: input.body, hasMedia: input.hasMedia, senderPhone: input.senderPhone },
          settings,
        );
        await recordCustomerMessage({ ...input, groupId: input.groupId, episodeId: track.episodeId }, qualification);
      }
      return;
    }

    await recordTeamMessage({
      memberId: track.memberId!,
      messageId: input.messageId,
      whatsappGroupId: input.whatsappGroupId,
      at: input.timestampWa,
      onlyIgnoredWords: isOnlyIgnoredWords(input.body, settings.ignoredKeywords),
      answeredWait: track.action === "ANSWER",
      settings,
    });
  } catch (err) {
    console.error(`[support-assignment] could not process message ${input.messageId}; the message itself is stored`, err);
  }
}

async function lockGroup(tx: Prisma.TransactionClient, whatsappGroupId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`support-assignment:${currentProjectId()}:${whatsappGroupId}`})::bigint)`;
}

async function recordCustomerMessage(
  input: { messageId: string; groupId: string; whatsappGroupId: string; accountId: string; timestampWa: Date; episodeId: string },
  q: Qualification,
): Promise<void> {
  const at = input.timestampWa;
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, input.whatsappGroupId);
    const current = await tx.supportAssignment.findFirst({
      where: { whatsappGroupId: input.whatsappGroupId, closedAt: null },
      select: { id: true, status: true, firstMessageAt: true },
    });

    if (!current) {
      // A message older than the group's last closed case was already part of that case's story
      // (it arrived late, after a reconnect): it opens nothing.
      const lastClosed = await tx.supportAssignment.findFirst({
        where: { whatsappGroupId: input.whatsappGroupId, closedAt: { not: null } },
        orderBy: { closedAt: "desc" },
        select: { closedAt: true },
      });
      if (lastClosed?.closedAt && at <= lastClosed.closedAt) return;

      const created = await tx.supportAssignment.create({
        data: {
          episodeId: input.episodeId,
          accountId: input.accountId,
          groupId: input.groupId,
          whatsappGroupId: input.whatsappGroupId,
          status: q.qualifies ? "UNASSIGNED" : "IGNORED",
          firstMessageId: q.qualifies ? input.messageId : null,
          firstMessageAt: q.qualifies ? at : null,
          ignoredMessageCount: q.qualifies ? 0 : 1,
        },
        select: { id: true },
      });
      await tx.supportAssignmentEvent.create({
        data: q.qualifies
          ? { assignmentId: created.id, type: "OPENED", at, detail: "A customer message nobody has answered yet." }
          : { assignmentId: created.id, type: "IGNORED", at, detail: QUALIFICATION_REASON_LABELS[q.reason!] },
      });
      return;
    }

    if (!q.qualifies) {
      await tx.supportAssignment.update({ where: { id: current.id }, data: { ignoredMessageCount: { increment: 1 } } });
      return;
    }
    if (current.status === "IGNORED") {
      await tx.supportAssignment.update({
        where: { id: current.id },
        data: { status: "UNASSIGNED", firstMessageId: input.messageId, firstMessageAt: at },
      });
      await tx.supportAssignmentEvent.create({
        data: { assignmentId: current.id, type: "QUALIFIED", at, detail: "The customer wrote something that is support work." },
      });
      return;
    }
    // Out of order (recovered after a gap): the earliest support message is the issue shown.
    if (!current.firstMessageAt || at < current.firstMessageAt) {
      await tx.supportAssignment.update({ where: { id: current.id }, data: { firstMessageId: input.messageId, firstMessageAt: at } });
    }
  });
}

async function recordTeamMessage(input: {
  memberId: string;
  messageId: string;
  whatsappGroupId: string;
  at: Date;
  onlyIgnoredWords: boolean;
  answeredWait: boolean;
  settings: Parameters<typeof buildSupportAssignmentNotices>[1]["settings"];
}): Promise<void> {
  const current = await prisma.supportAssignment.findFirst({
    where: { whatsappGroupId: input.whatsappGroupId, closedAt: null },
    select: { id: true, status: true, assignedMemberId: true, assignedAt: true, assignmentRound: true },
  });
  if (!current) return;

  const decision = decideReply({
    status: current.status,
    assignedMemberId: current.assignedMemberId,
    assignedAt: current.assignedAt?.getTime() ?? null,
    memberId: input.memberId,
    at: input.at.getTime(),
    onlyIgnoredWords: input.onlyIgnoredWords,
    answeredWait: input.answeredWait,
  });
  if (decision === "NONE") return;
  await applyReplyDecision(current, decision, input);
}

/**
 * Apply one reply decision to one case. Every transition is a conditional update on the state it
 * was decided from — so the SLA loop marking it overdue at the same moment, or a reassignment, wins
 * or loses cleanly instead of being overwritten — and the COMPLETED notifications are queued in the
 * same transaction.
 */
export async function applyReplyDecision(
  current: { id: string; status: string; assignedMemberId: string | null; assignedAt: Date | null; assignmentRound: number },
  decision: "COMPLETE" | "ANSWERED_BY_OTHER" | "CLOSE_IGNORED",
  input: { memberId: string; messageId: string | null; at: Date; settings: Parameters<typeof buildSupportAssignmentNotices>[1]["settings"] },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (decision === "CLOSE_IGNORED") {
      const closed = await tx.supportAssignment.updateMany({
        where: { id: current.id, status: "IGNORED", closedAt: null },
        data: { closedAt: input.at, closeReason: "The wait was answered; nothing in it was support work." },
      });
      return closed.count === 1;
    }

    if (decision === "COMPLETE") {
      const responseSeconds = Math.max(0, Math.round((input.at.getTime() - current.assignedAt!.getTime()) / 1000));
      const done = await tx.supportAssignment.updateMany({
        where: { id: current.id, status: { in: ["ASSIGNED", "OVERDUE"] }, assignmentRound: current.assignmentRound, closedAt: null },
        data: {
          status: "COMPLETED",
          completedAt: input.at,
          completionMessageId: input.messageId,
          responderMemberId: input.memberId,
          responseSeconds,
          nextEscalationAt: null,
          closedAt: input.at,
        },
      });
      if (done.count === 0) return false;
      await tx.supportAssignmentEvent.create({
        data: {
          assignmentId: current.id,
          type: "COMPLETED",
          at: input.at,
          memberId: input.memberId,
          detail: `Replied in the group ${formatResponseTime(responseSeconds)} after being assigned.`,
        },
      });
      await queueSupportAssignmentNotices(
        tx,
        await buildSupportAssignmentNotices(tx, { assignmentId: current.id, kind: "COMPLETED", settings: input.settings, now: new Date() }),
      );
      return true;
    }

    const answered = await tx.supportAssignment.updateMany({
      where: { id: current.id, status: { in: ["UNASSIGNED", "ASSIGNED", "OVERDUE"] }, assignmentRound: current.assignmentRound, closedAt: null },
      data: {
        status: "ANSWERED_BY_OTHER",
        completionMessageId: input.messageId,
        responderMemberId: input.memberId,
        nextEscalationAt: null,
        closedAt: input.at,
      },
    });
    if (answered.count === 0) return false;
    const responder = await tx.internalTeamMember.findUnique({ where: { id: input.memberId }, select: { name: true } });
    await tx.supportAssignmentEvent.create({
      data: {
        assignmentId: current.id,
        type: "ANSWERED_BY_OTHER",
        at: input.at,
        memberId: input.memberId,
        detail: current.assignedMemberId
          ? `${responder?.name ?? "Another team member"} answered the customer. Not credited to the assignee; no further alerts.`
          : `${responder?.name ?? "A team member"} answered the customer before anybody was assigned.`,
      },
    });
    return true;
  });
}
