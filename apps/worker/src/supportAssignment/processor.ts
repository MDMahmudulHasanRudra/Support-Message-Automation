import { buildSupportAssignmentNotices, queueSupportAssignmentNotices } from "@support-automation/db";
import { decideReply, isOnlyIgnoredWords, SUPPORT_ASSIGNMENT_OVERDUE_GRACE_MS } from "@support-automation/shared";
import { prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { trackTick } from "../lifecycle.js";
import { forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import { applyReplyDecision } from "./tracker.js";

const LOOP_NAME = "support-assignment";
const BATCH = 50;
/** A reply that answered the wait gets this long to be handled by the pipeline before the loop does it. */
const RECONCILE_AFTER_MS = 2 * 60_000;

/**
 * Support Assignment, the background half (SUPPORT_ASSIGNMENT.md): deadlines and escalation never
 * depend on a browser being open.
 *
 * Every transition is a conditional update on the state it was decided from, inside the same
 * transaction as its history line and its notifications. A completion racing an overdue mark is
 * decided by the case row's lock — whichever commits first wins, the other matches nothing — so a
 * case completed in time never alerts, and a retry or restart never alerts twice (each notification
 * also carries a per-round dedup key).
 */
export function startSupportAssignmentProcessor(intervalMs = 15_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    void trackTick(() => runSupportAssignmentTick())
      .catch((err) => console.error("[support-assignment] unexpected error in the SLA loop", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

/** One pass over every operating project. Exported for tests. */
export async function runSupportAssignmentTick(now: Date = new Date()): Promise<void> {
  await forEachProject("support-assignment", async () => {
    const settings = await prisma.supportAssignmentSettings.findUnique({
      where: { id: "global" },
    });
    if (!settings?.enabled) return;
    if (!(await projectHasFeature("SUPPORT_ASSIGNMENT"))) return;
    await markOverdue(settings, now);
    if (settings.escalationEnabled) await escalateOverdue(settings, now);
    await reconcileAnsweredWaits(settings, now);
  });
}

type Settings = NonNullable<Awaited<ReturnType<typeof prisma.supportAssignmentSettings.findUnique>>>;

/** What the loop read about a case before deciding — possibly stale by the time it acts. */
export interface DueCaseSnapshot {
  id: string;
  assignmentRound: number;
  slaMinutes: number | null;
  assignedMemberId: string | null;
  assignedMember: { name: string } | null;
}

/** ASSIGNED past its deadline (plus a minute's grace for a reply still in transit) → OVERDUE. */
async function markOverdue(settings: Settings, now: Date): Promise<void> {
  const due = await prisma.supportAssignment.findMany({
    where: {
      status: "ASSIGNED",
      closedAt: null,
      dueAt: {
        lte: new Date(now.getTime() - SUPPORT_ASSIGNMENT_OVERDUE_GRACE_MS),
      },
    },
    orderBy: { dueAt: "asc" },
    take: BATCH,
    select: {
      id: true,
      assignmentRound: true,
      slaMinutes: true,
      assignedMemberId: true,
      assignedMember: { select: { name: true } },
    },
  });
  for (const row of due) await markOneOverdue(row, settings, now);
}

/**
 * Mark one case overdue, from a snapshot the loop read earlier. The update is guarded on the state
 * the snapshot saw, so a case completed or reassigned since then is left alone and alerts nobody.
 * Exported for tests: that race cannot be produced reliably any other way.
 */
export async function markOneOverdue(row: DueCaseSnapshot, settings: Settings, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const marked = await tx.supportAssignment.updateMany({
      where: {
        id: row.id,
        status: "ASSIGNED",
        assignmentRound: row.assignmentRound,
        closedAt: null,
      },
      data: {
        status: "OVERDUE",
        overdueAt: now,
        // Only when escalation is on now: switching it on later must not fire a burst of
        // escalations for cases that went overdue days ago.
        nextEscalationAt: settings.escalationEnabled ? new Date(now.getTime() + settings.escalationAfterMinutes * 60_000) : null,
      },
    });
    if (marked.count === 0) return false; // completed or reassigned in the meantime
    await tx.supportAssignmentEvent.create({
      data: {
        assignmentId: row.id,
        type: "OVERDUE",
        at: now,
        // The assignee at that moment: per-employee overdue counts read this, so a later
        // reassignment never moves an overdue onto the person who took the case over.
        memberId: row.assignedMemberId,
        detail: `No reply from ${row.assignedMember?.name ?? "the assignee"} within ${row.slaMinutes ?? settings.slaMinutes} minute(s).`,
      },
    });
    await queueSupportAssignmentNotices(
      tx,
      await buildSupportAssignmentNotices(tx, {
        assignmentId: row.id,
        kind: "OVERDUE",
        settings,
        now,
      }),
    );
    return true;
  });
}

/** OVERDUE past its escalation time → escalated once (per assignment round). */
async function escalateOverdue(settings: Settings, now: Date): Promise<void> {
  const due = await prisma.supportAssignment.findMany({
    where: {
      status: "OVERDUE",
      closedAt: null,
      escalationLevel: 0,
      nextEscalationAt: { lte: now },
    },
    orderBy: { nextEscalationAt: "asc" },
    take: BATCH,
    select: { id: true, assignmentRound: true, assignedMemberId: true },
  });
  for (const row of due) await escalateOne(row, settings, now);
}

/** Escalate one case from an earlier snapshot; guarded like `markOneOverdue`. Exported for tests. */
export async function escalateOne(
  row: { id: string; assignmentRound: number; assignedMemberId: string | null },
  settings: Settings,
  now: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const marked = await tx.supportAssignment.updateMany({
      where: {
        id: row.id,
        status: "OVERDUE",
        escalationLevel: 0,
        assignmentRound: row.assignmentRound,
        closedAt: null,
      },
      data: { escalationLevel: 1, nextEscalationAt: null },
    });
    if (marked.count === 0) return false;
    await tx.supportAssignmentEvent.create({
      data: {
        assignmentId: row.id,
        type: "ESCALATED",
        at: now,
        memberId: row.assignedMemberId,
        detail: `Still unanswered ${settings.escalationAfterMinutes} minute(s) after going overdue.`,
      },
    });
    await queueSupportAssignmentNotices(
      tx,
      await buildSupportAssignmentNotices(tx, {
        assignmentId: row.id,
        kind: "ESCALATED",
        settings,
        now,
      }),
    );
    return true;
  });
}

/**
 * The safety net for the pipeline hook: a case whose wait has been answered or cleared for a couple
 * of minutes but is still open (the hook failed, the worker restarted mid-message) is settled from
 * the episode's own record of who replied — through the same `decideReply` rules, so the outcome is
 * the one the hook would have reached. Skipped while the group row has a newer open wait: the case
 * then represents that customer, who is still waiting.
 */
async function reconcileAnsweredWaits(settings: Settings, now: Date): Promise<void> {
  const settled = new Date(now.getTime() - RECONCILE_AFTER_MS);
  const rows = await prisma.supportAssignment.findMany({
    where: {
      closedAt: null,
      episode: {
        status: { in: ["ANSWERED", "CLEARED"] },
        updatedAt: { lte: settled },
      },
    },
    orderBy: { updatedAt: "asc" },
    take: 200,
    select: {
      id: true,
      groupId: true,
      status: true,
      assignedMemberId: true,
      assignedAt: true,
      assignmentRound: true,
      episode: {
        select: {
          status: true,
          supportMemberId: true,
          supportRepliedAt: true,
          supportReplyMessageId: true,
          supportReplyMessage: { select: { body: true } },
        },
      },
    },
  });
  for (const row of rows) {
    const newerWait = await prisma.supportResponseEpisode.findFirst({
      where: { groupId: row.groupId, status: "UNANSWERED" },
      select: { id: true },
    });
    if (newerWait) continue;

    if (row.episode.status === "CLEARED") {
      await prisma.$transaction(async (tx) => {
        const cancelled = await tx.supportAssignment.updateMany({
          where: {
            id: row.id,
            closedAt: null,
            assignmentRound: row.assignmentRound,
          },
          data: {
            status: row.status === "IGNORED" ? "IGNORED" : "CANCELLED",
            nextEscalationAt: null,
            closedAt: now,
            closeReason: "The wait was cleared on Messages → Unanswered groups.",
          },
        });
        if (cancelled.count === 1 && row.status !== "IGNORED") {
          await tx.supportAssignmentEvent.create({
            data: {
              assignmentId: row.id,
              type: "CANCELLED",
              at: now,
              detail: "The wait was cleared on Messages → Unanswered groups.",
            },
          });
        }
      });
      continue;
    }

    const { supportMemberId, supportRepliedAt } = row.episode;
    if (!supportMemberId || !supportRepliedAt) continue;
    const decision = decideReply({
      status: row.status,
      assignedMemberId: row.assignedMemberId,
      assignedAt: row.assignedAt?.getTime() ?? null,
      memberId: supportMemberId,
      at: supportRepliedAt.getTime(),
      onlyIgnoredWords: isOnlyIgnoredWords(row.episode.supportReplyMessage?.body ?? "", settings.ignoredKeywords),
      answeredWait: true,
    });
    if (decision === "NONE") continue;
    await applyReplyDecision(row, decision, {
      memberId: supportMemberId,
      messageId: row.episode.supportReplyMessageId,
      at: supportRepliedAt,
      settings,
    });
  }
}
