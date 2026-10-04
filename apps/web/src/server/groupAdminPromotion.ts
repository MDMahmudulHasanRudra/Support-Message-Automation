import { ACTIVE_ADMIN_PROMOTION_JOB_STATUSES } from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * Reads for the WhatsApp Groups Admin Maker pages. Everything shown comes from the job rows the
 * worker writes, so a page opened later — after navigating away, a refresh, another browser — shows
 * exactly where the job is, never a reset.
 */

export interface AdminPromotionCounts {
  total: number;
  /** Groups with a result (everything but PENDING). */
  checked: number;
  promoted: number;
  alreadyAdmin: number;
  notMember: number;
  /** The account is not an admin there — skipped without being read. */
  skipped: number;
  cannotVerify: number;
  unavailable: number;
  failed: number;
  pending: number;
}

export interface AdminPromotionJobSummary {
  id: string;
  phoneNumber: string;
  status: string;
  statusReason: string | null;
  accountLabel: string;
  accountId: string;
  totalGroups: number;
  /** Groups the account administers; null until checking has finished. */
  adminGroups: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: string | null;
  counts: AdminPromotionCounts;
}

const emptyCounts = (total: number): AdminPromotionCounts => ({
  total,
  checked: 0,
  promoted: 0,
  alreadyAdmin: 0,
  notMember: 0,
  skipped: 0,
  cannotVerify: 0,
  unavailable: 0,
  failed: 0,
  pending: 0,
});

async function countsFor(jobIds: string[]): Promise<Map<string, Record<string, number>>> {
  if (jobIds.length === 0) return new Map();
  const rows = await prisma.groupAdminPromotionItem.groupBy({ by: ["jobId", "status"], where: { jobId: { in: jobIds } }, _count: { _all: true } });
  const out = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const byStatus = out.get(row.jobId) ?? {};
    byStatus[row.status] = row._count._all;
    out.set(row.jobId, byStatus);
  }
  return out;
}

function summarise(
  job: {
    id: string;
    phoneNumber: string;
    status: string;
    statusReason: string | null;
    accountId: string;
    totalGroups: number;
    adminGroups: number | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    account: { label: string };
    createdBy: { name: string } | null;
  },
  byStatus: Record<string, number> = {},
): AdminPromotionJobSummary {
  const n = (s: string) => byStatus[s] ?? 0;
  const counts = emptyCounts(job.totalGroups);
  counts.promoted = n("PROMOTED");
  counts.alreadyAdmin = n("ALREADY_ADMIN");
  counts.notMember = n("NOT_MEMBER");
  counts.skipped = n("NOT_ACCOUNT_ADMIN");
  counts.cannotVerify = n("CANNOT_VERIFY");
  counts.unavailable = n("GROUP_UNAVAILABLE");
  counts.failed = n("FAILED");
  counts.pending = n("PENDING");
  counts.checked = job.totalGroups - counts.pending;
  return {
    id: job.id,
    phoneNumber: job.phoneNumber,
    status: job.status,
    statusReason: job.statusReason,
    accountLabel: job.account.label,
    accountId: job.accountId,
    totalGroups: job.totalGroups,
    adminGroups: job.adminGroups,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdBy: job.createdBy?.name ?? null,
    counts,
  };
}

const JOB_SELECT = {
  id: true,
  phoneNumber: true,
  status: true,
  statusReason: true,
  accountId: true,
  totalGroups: true,
  adminGroups: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  account: { select: { label: true } },
  createdBy: { select: { name: true } },
} as const;

/** Every job still doing something in this project, oldest first. */
export async function getActiveAdminPromotionJobs(): Promise<AdminPromotionJobSummary[]> {
  const jobs = await prisma.groupAdminPromotionJob.findMany({
    where: { status: { in: [...ACTIVE_ADMIN_PROMOTION_JOB_STATUSES] } },
    orderBy: { createdAt: "asc" },
    select: JOB_SELECT,
  });
  const counts = await countsFor(jobs.map((j) => j.id));
  return jobs.map((j) => summarise(j, counts.get(j.id)));
}

/** The latest finished jobs, newest first — so a completed job's summary stays available. */
export async function getRecentAdminPromotionJobs(limit = 10): Promise<AdminPromotionJobSummary[]> {
  const jobs = await prisma.groupAdminPromotionJob.findMany({
    where: { status: { notIn: [...ACTIVE_ADMIN_PROMOTION_JOB_STATUSES] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: JOB_SELECT,
  });
  const counts = await countsFor(jobs.map((j) => j.id));
  return jobs.map((j) => summarise(j, counts.get(j.id)));
}

export async function getAdminPromotionJob(id: string) {
  const job = await prisma.groupAdminPromotionJob.findFirst({ where: { id }, select: JOB_SELECT });
  if (!job) return null;
  const [counts, items] = await Promise.all([
    countsFor([id]),
    prisma.groupAdminPromotionItem.findMany({
      where: { jobId: id },
      select: { id: true, groupNameSnapshot: true, status: true, reason: true, failureCode: true, processedAt: true, attemptCount: true, group: { select: { whatsappGroupId: true } } },
      // Results that need a look first, then the rest by name.
      orderBy: [{ processedAt: { sort: "desc", nulls: "last" } }, { groupNameSnapshot: "asc" }],
    }),
  ]);
  return { job: summarise(job, counts.get(id)), items };
}

/** The connected accounts an operator may start a job on, with their synchronized group counts. */
export async function getAdminMakerAccounts() {
  const accounts = await prisma.whatsAppAccount.findMany({
    select: { id: true, label: true, status: true, phoneNumber: true, _count: { select: { groups: { where: { isActive: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  return accounts.map((a) => ({ id: a.id, label: a.label, status: a.status, phoneNumber: a.phoneNumber, groupCount: a._count.groups }));
}
