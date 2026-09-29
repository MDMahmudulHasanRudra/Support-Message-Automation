import { trackTick } from "../lifecycle.js";
import { platformPrisma, prisma } from "../db.js";
import { accountInCurrentProject, withProject } from "../project/context.js";
import { normalizePhoneNumber } from "@support-automation/shared";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import {
  MEMBERSHIP_VERDICT_REASON,
  decideMembership,
  readGroupRoster,
  type GroupRoster,
  type MembershipVerdict,
} from "./groupParticipantMembership.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";

const LOOP_NAME = "group-participant-check";

/** Items left CHECKING by a worker that died mid-read go back to PENDING_CHECK. */
const STUCK_CHECKING_TIMEOUT_MS = 2 * 60_000;

/**
 * Reads a whole job's rosters in one tick, rather than one pair per tick like the add loop.
 *
 * The two loops are paced by opposite considerations. An add is a write WhatsApp punishes in
 * volume, so it is deliberately slow — 3 a minute by default. A roster READ is an ordinary lookup
 * with no such cost, and the work collapses: 10 numbers across 3 groups is 3 roster reads, not 30.
 * Pacing the check like the add would leave an operator staring at a progress bar for twenty
 * minutes to be told something the session already knew.
 *
 * The cap bounds one tick, not the job — a job with more groups than this simply takes another
 * tick, which is exactly what the loop is for.
 */
const MAX_GROUPS_PER_TICK = 25;

export async function recoverStuckParticipantChecks(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_CHECKING_TIMEOUT_MS);
  // Install-wide on purpose: releases this worker's own stranded claims, status only.
  const result = await platformPrisma.groupParticipantAddItem.updateMany({
    where: { status: "CHECKING", updatedAt: { lt: cutoff } },
    data: { status: "PENDING_CHECK" },
  });
  return result.count;
}

/** The oldest job with checking still to do. One job at a time keeps its roster reads together. */
async function claimNextCheckingJob() {
  // Across projects, oldest first; the job is then worked inside its own project.
  return platformPrisma.groupParticipantAddJob.findFirst({
    where: { status: "CHECKING" },
    orderBy: { createdAt: "asc" },
    select: { id: true, accountId: true, projectId: true },
  });
}

const VERDICT_TO_STATUS: Record<MembershipVerdict, string> = {
  ALREADY_MEMBER: "ALREADY_MEMBER",
  READY: "READY",
  CANNOT_VERIFY: "CANNOT_VERIFY",
  INVALID_NUMBER: "INVALID_NUMBER",
  NOT_ON_WHATSAPP: "NOT_ON_WHATSAPP",
  NO_PERMISSION: "NO_PERMISSION",
  GROUP_UNAVAILABLE: "GROUP_UNAVAILABLE",
  CHECK_FAILED: "CHECK_FAILED",
};

/**
 * Checks every outstanding pair in one job.
 *
 * Exported for the integration tests, which drive it directly rather than through the interval —
 * the same shape `processOne` uses in the add processor.
 */
export async function checkOneJob(provider: WhatsAppProvider, jobId: string): Promise<number> {
  // Runs inside the job's own project, taken from the job row itself.
  const owner = await platformPrisma.groupParticipantAddJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  if (!owner) return 0;
  return withProject(owner.projectId, () => checkOneJobInProject(provider, jobId));
}

async function checkOneJobInProject(provider: WhatsAppProvider, jobId: string): Promise<number> {
  const pending = await prisma.groupParticipantAddItem.findMany({
    where: { jobId, status: "PENDING_CHECK" },
    include: { group: { select: { whatsappGroupId: true, isActive: true } } },
    orderBy: { groupId: "asc" },
  });
  if (pending.length === 0) {
    await settleJobAfterCheck(jobId);
    return 0;
  }

  // Claimed up front so a second worker — or this one after a restart mid-tick — cannot read the
  // same rosters again. Recovery puts anything left CHECKING back.
  await prisma.groupParticipantAddItem.updateMany({
    where: { id: { in: pending.map((item) => item.id) } },
    data: { status: "CHECKING" },
  });

  /**
   * Asked once for the whole job, not once per group: `iAmAdmin()` answers for every group at
   * once. Null means the provider could not say, which must stay distinct from "not an admin" —
   * see decideMembership, which deliberately does not block on an unknown.
   */
  let adminGroupIds: string[] | null = null;
  try {
    adminGroupIds = await provider.getAdminGroupIds();
  } catch {
    adminGroupIds = null;
  }
  const adminSet = adminGroupIds ? new Set(adminGroupIds) : null;

  const groupIds = [...new Set(pending.map((item) => item.groupId))].slice(0, MAX_GROUPS_PER_TICK);
  const rosterByGroupId = new Map<string, GroupRoster | null>();
  const availabilityByGroupId = new Map<string, boolean>();
  const adminByGroupId = new Map<string, boolean | null>();

  for (const groupId of groupIds) {
    const sample = pending.find((item) => item.groupId === groupId)!;
    const available = sample.group.isActive;
    availabilityByGroupId.set(groupId, available);
    adminByGroupId.set(groupId, adminSet ? adminSet.has(sample.group.whatsappGroupId) : null);
    rosterByGroupId.set(
      groupId,
      available ? await readGroupRoster(provider, sample.group.whatsappGroupId) : null,
    );
  }

  /**
   * One lookup per distinct NUMBER, not per pair — the answer cannot differ between groups, and
   * `checkNumberStatus` is a network call. Only consulted for numbers no roster matched, since a
   * roster hit already settles the question with better evidence.
   */
  const existsByNumber = new Map<string, boolean | null>();
  const needsNumberCheck = new Set<string>();
  for (const item of pending) {
    if (!groupIds.includes(item.groupId)) continue;
    const digits = normalizePhoneNumber(item.phoneNumber);
    if (!digits) continue;
    const roster = rosterByGroupId.get(item.groupId);
    if (roster && roster.phoneDigits.has(digits)) continue;
    needsNumberCheck.add(digits);
  }
  for (const digits of needsNumberCheck) {
    try {
      const result = await provider.checkNumberOnWhatsApp(digits);
      existsByNumber.set(digits, result.ok ? result.exists : null);
    } catch {
      existsByNumber.set(digits, null);
    }
  }

  let checked = 0;
  for (const item of pending) {
    if (!groupIds.includes(item.groupId)) {
      // Deferred to the next tick — put it back rather than leaving it claimed.
      await prisma.groupParticipantAddItem.update({
        where: { id: item.id },
        data: { status: "PENDING_CHECK" },
      });
      continue;
    }

    const digits = normalizePhoneNumber(item.phoneNumber);
    const verdict = decideMembership({
      phoneNumber: item.phoneNumber,
      roster: rosterByGroupId.get(item.groupId) ?? null,
      isAdminOfGroup: adminByGroupId.get(item.groupId) ?? null,
      existsOnWhatsApp: digits ? (existsByNumber.get(digits) ?? null) : null,
      groupAvailable: availabilityByGroupId.get(item.groupId) ?? false,
    });

    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: {
        status: VERDICT_TO_STATUS[verdict] as never,
        failureReason: MEMBERSHIP_VERDICT_REASON[verdict],
        // What we matched on, when we matched on anything. Absent for every other verdict, which
        // is itself the record that nothing was established.
        whatsappId: verdict === "ALREADY_MEMBER" && digits ? `${digits}@c.us` : null,
        checkedAt: new Date(),
      },
    });
    checked += 1;
  }

  await settleJobAfterCheck(jobId);
  return checked;
}

/**
 * Moves the job on once nothing is left to check.
 *
 * AWAITING_REVIEW rather than straight to queued, always — including when nothing came back
 * eligible. A job whose every pair is ALREADY_MEMBER is a useful answer an operator asked for, and
 * auto-completing it would throw that answer away before it was read.
 */
async function settleJobAfterCheck(jobId: string): Promise<void> {
  const remaining = await prisma.groupParticipantAddItem.count({
    where: { jobId, status: { in: ["PENDING_CHECK", "CHECKING"] } },
  });
  if (remaining > 0) return;

  await prisma.groupParticipantAddJob.updateMany({
    where: { id: jobId, status: "CHECKING" },
    data: { status: "AWAITING_REVIEW" },
  });
}

async function checkTick(registry: ProviderRegistry): Promise<void> {
  const job = await claimNextCheckingJob();
  if (!job) return;

  const provider = registry.get(job.accountId);
  if (!provider) return; // account not connected yet; the next tick will find it

  // The roster is read through the job's own account, which must belong to the job's project.
  const sameProject = await withProject(job.projectId, () => accountInCurrentProject(job.accountId));
  if (!sameProject) {
    console.error(`[participant-check] job ${job.id}: its account belongs to another project; not checked`);
    return;
  }
  await checkOneJob(provider, job.id);
}

/**
 * Drains the membership-check phase.
 *
 * Deliberately a SEPARATE loop from the add processor rather than a branch inside it: the two are
 * paced by opposite constraints (a read costs nothing, an add is rate-limited to single digits per
 * minute), and sharing one loop would drag the check down to the add's pace for no reason.
 */
export function startGroupParticipantCheckProcessor(
  registry: ProviderRegistry,
  intervalMs = 3000,
): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void trackTick(async () => {
      try {
        await checkTick(registry);
      } catch (err) {
        console.error("[participant-check] tick failed", err);
      } finally {
        running = false;
        // Stamped when the tick FINISHES — the only moment that proves the loop is not wedged.
        recordLoopTick(LOOP_NAME, intervalMs);
      }
    });
  }, intervalMs);
}
