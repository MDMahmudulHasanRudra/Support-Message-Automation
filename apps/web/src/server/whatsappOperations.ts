import type { Prisma } from "@prisma/client";
import {
  isOperationCleared,
  sortOperations,
  summariseAddJob,
  summariseAdminJob,
  type WhatsAppOperation,
  type WhatsAppOperationKind,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { getActiveAdminPromotionJobs, getAdminPromotionJobsFinishedSince } from "@/server/groupAdminPromotion";

/**
 * Every long-running WhatsApp job in this project, in one shape (packages/shared whatsappOperations):
 * what the job indicator on every page and the module pages show. Read-only, and read entirely from
 * the job rows the worker writes — the scoped client keeps it to the active project, so another
 * project's jobs cannot appear whatever id anybody sends.
 */

/** Add Number to Groups jobs the worker (or a person) still has to move along. */
export const ACTIVE_ADD_JOB_STATUSES = ["CHECKING", "AWAITING_REVIEW", "QUEUED", "RUNNING"] as const;
const FINISHED_ADD_JOB_STATUSES = ["COMPLETED", "CANCELLED", "STOPPED_KILL_SWITCH"] as const;

/** How long a finished job stays in the indicator. Its own page keeps it for good. */
export const RECENT_OPERATION_HOURS = 12;
const RECENT_LIMIT = 5;

const ADD_JOB_SELECT = {
  id: true,
  status: true,
  phoneNumbers: true,
  queuedCount: true,
  createdAt: true,
  completedAt: true,
  cancelledAt: true,
  account: { select: { label: true, status: true } },
} as const;
type AddJobRow = Prisma.GroupParticipantAddJobGetPayload<{ select: typeof ADD_JOB_SELECT }>;

const CURRENT_SELECT = { phoneNumber: true, groupNameSnapshot: true, scheduledAt: true, status: true } as const;

async function summariseAddJobs(jobs: AddJobRow[], now: Date): Promise<WhatsAppOperation[]> {
  if (jobs.length === 0) return [];
  const grouped = await prisma.groupParticipantAddItem.groupBy({
    by: ["jobId", "status"],
    where: { jobId: { in: jobs.map((j) => j.id) } },
    _count: { _all: true },
  });
  const byJob = new Map<string, Record<string, number>>();
  for (const row of grouped) {
    const statuses = byJob.get(row.jobId) ?? {};
    statuses[row.status] = row._count._all;
    byJob.set(row.jobId, statuses);
  }

  // The pair in flight, or else the next one due — only for jobs actually adding.
  const current = new Map<string, { phoneNumber: string; groupName: string; processing: boolean; scheduledAt: Date }>();
  await Promise.all(
    jobs
      .filter((j) => j.status === "QUEUED" || j.status === "RUNNING")
      .map(async (job) => {
        const item =
          (await prisma.groupParticipantAddItem.findFirst({ where: { jobId: job.id, status: "PROCESSING" }, select: CURRENT_SELECT })) ??
          (await prisma.groupParticipantAddItem.findFirst({ where: { jobId: job.id, status: "PENDING" }, orderBy: { scheduledAt: "asc" }, select: CURRENT_SELECT }));
        if (item) {
          current.set(job.id, { phoneNumber: item.phoneNumber, groupName: item.groupNameSnapshot, processing: item.status === "PROCESSING", scheduledAt: item.scheduledAt });
        }
      }),
  );

  return jobs.map((job) =>
    summariseAddJob(
      {
        id: job.id,
        status: job.status,
        phoneNumbers: job.phoneNumbers,
        queuedCount: job.queuedCount,
        accountLabel: job.account.label,
        accountConnected: job.account.status === "CONNECTED",
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        cancelledAt: job.cancelledAt,
        byStatus: byJob.get(job.id) ?? {},
        current: current.get(job.id) ?? null,
      },
      now,
    ),
  );
}

async function listAddNumberOperations(now: Date): Promise<WhatsAppOperation[]> {
  const since = new Date(now.getTime() - RECENT_OPERATION_HOURS * 3_600_000);
  const [active, recent] = await Promise.all([
    prisma.groupParticipantAddJob.findMany({ where: { status: { in: [...ACTIVE_ADD_JOB_STATUSES] } }, orderBy: { createdAt: "asc" }, select: ADD_JOB_SELECT }),
    prisma.groupParticipantAddJob.findMany({
      where: { status: { in: [...FINISHED_ADD_JOB_STATUSES] }, OR: [{ completedAt: { gte: since } }, { cancelledAt: { gte: since } }] },
      orderBy: { createdAt: "desc" },
      take: RECENT_LIMIT,
      select: ADD_JOB_SELECT,
    }),
  ]);
  return summariseAddJobs([...active, ...recent], now);
}

async function listAdminMakerOperations(now: Date): Promise<WhatsAppOperation[]> {
  const since = new Date(now.getTime() - RECENT_OPERATION_HOURS * 3_600_000);
  const [active, recent] = await Promise.all([getActiveAdminPromotionJobs(), getAdminPromotionJobsFinishedSince(since, RECENT_LIMIT)]);
  return [...active.map((j) => ({ ...j, cancelledAt: null as Date | null })), ...recent].map((j) =>
    summariseAdminJob({
      id: j.id,
      status: j.status,
      statusReason: j.statusReason,
      phoneNumber: j.phoneNumber,
      accountLabel: j.accountLabel,
      totalGroups: j.totalGroups,
      adminGroups: j.adminGroups,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
      cancelledAt: j.cancelledAt,
      counts: j.counts,
    }),
  );
}

/**
 * Every operation of the given kind (or all kinds): running ones first, then those finished recently.
 *
 * With `viewerId`, the operations that person cleared from their tracker are left out — while they
 * are still in the state they were cleared in (`isOperationCleared`). This is the one place that
 * filter lives, so the job indicator and a module page's "Current operation" can never disagree, and
 * a refresh cannot bring a cleared operation back. Nothing about the job itself is touched.
 */
export async function listWhatsAppOperations(
  options: { kind?: WhatsAppOperationKind; now?: Date; viewerId?: string } = {},
): Promise<WhatsAppOperation[]> {
  const now = options.now ?? new Date();
  const [adds, admins, dismissals] = await Promise.all([
    options.kind && options.kind !== "ADD_NUMBER_TO_GROUPS" ? Promise.resolve([]) : listAddNumberOperations(now),
    options.kind && options.kind !== "ADMIN_MAKER" ? Promise.resolve([]) : listAdminMakerOperations(now),
    options.viewerId
      ? prisma.whatsAppOperationDismissal.findMany({ where: { userId: options.viewerId }, select: { kind: true, jobId: true, stateAtDismissal: true } })
      : Promise.resolve([]),
  ]);
  const cleared = new Map(dismissals.map((d) => [`${d.kind}:${d.jobId}`, d]));
  return sortOperations([...adds, ...admins].filter((op) => !isOperationCleared(op, cleared.get(`${op.kind}:${op.id}`))));
}
