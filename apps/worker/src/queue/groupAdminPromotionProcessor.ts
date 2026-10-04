import type { GroupAdminPromotionItemStatus, GroupAdminPromotionJob, GroupAdminPromotionJobStatus } from "@prisma/client";
import {
  ADMIN_PROMOTION_DELAY_MAX_MS,
  ADMIN_PROMOTION_DELAY_MIN_MS,
  ADMIN_PROMOTION_MAX_ATTEMPTS,
  ADMIN_PROMOTION_REASONS,
  ADMIN_PROMOTION_RETRY_DELAY_MS,
  classifyPromotionFailure,
  decideAdminPromotion,
  randomDelayMs,
  targetParticipantId,
} from "@support-automation/shared";
import { trackTick } from "../lifecycle.js";
import { platformPrisma, prisma } from "../db.js";
import { accountInCurrentProject, OPERATING_PROJECT_STATUSES, withProject } from "../project/context.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";

/**
 * WhatsApp Groups Admin Maker (GROUP_ADMIN_MAKER.md): makes ONE existing member an admin in every
 * group where the job's account is itself an admin. It never adds anybody to a group.
 *
 * Built from the Add Number to Groups pieces rather than beside them: the same provider calls for a
 * group's members (`getGroupParticipants`) and for which groups this account administers
 * (`getAdminGroupIds`, one call for every group), the same project entry (`withProject` from the
 * row's own `projectId`), the same account-belongs-to-project refusal, the same kill switch, and the
 * same one-thing-per-tick overlap-guarded loop. What is new is only what promotion needs: reading one
 * group's admins (`getGroupAdminIds`) and promoting (`promoteGroupParticipant`).
 *
 * Every step is decided by the pure rules in packages/shared/src/groupAdminPromotion.ts, and the job
 * survives anything the browser does: its whole state is these two tables.
 *
 *   CHECKING  one call asks WhatsApp which groups this account administers; every other group is
 *             settled as NOT_ACCOUNT_ADMIN at once, without reading it — the feature must never
 *             attempt anything in a group where the account is not an admin.
 *   RUNNING   one group per tick: read its members and admins, decide, and promote only a member
 *             who is not already an admin, at least ADMIN_PROMOTION_DELAY_MIN_MS after the previous
 *             promotion on the same account (read back from the rows, so a restart keeps the pace).
 *
 * A group whose result is settled is never visited again, and a crash between promoting and
 * recording leaves the row PENDING: the next visit reads the admin list, finds the member already an
 * admin, and — because `attemptCount` is non-zero — records PROMOTED rather than re-promoting.
 */

const LOOP_NAME = "group-admin-promotion";

/** Anything with `get(accountId)` — the registry in production, a stub in the tests. */
export interface ProviderSource {
  get(accountId: string): WhatsAppProvider | undefined;
}

const NOT_CONNECTED_REASON =
  "The WhatsApp account was disconnected while this job was running. Nothing was lost: the groups not yet processed are waiting. Reconnect the account, then press Resume.";
const KILL_SWITCH_REASON =
  "Automation is turned off (Automation Control), so this job is paused. Turn automation back on, then press Resume.";

async function setJobStatus(jobId: string, status: GroupAdminPromotionJobStatus, statusReason: string | null, extra: Partial<GroupAdminPromotionJob> = {}) {
  await prisma.groupAdminPromotionJob.update({ where: { id: jobId }, data: { status, statusReason, ...extra } });
}

/**
 * Whether the job may act right now. Pauses it with the reason when it may not — a job whose account
 * dropped must say so, not wait silently or pretend to finish.
 */
async function readyToAct(job: GroupAdminPromotionJob, providers: ProviderSource): Promise<WhatsAppProvider | null> {
  if (!(await accountInCurrentProject(job.accountId))) {
    await setJobStatus(job.id, "FAILED", "This job's WhatsApp account belongs to another project, so nothing was done.", { completedAt: new Date() });
    await logSystemEvent("ERROR", "group-admin-promotion", "Refused an admin promotion job through an account outside its project", { jobId: job.id });
    return null;
  }
  const provider = providers.get(job.accountId);
  if (!provider || provider.getConnectionStatus() !== "CONNECTED") {
    await setJobStatus(job.id, "PAUSED_DISCONNECTED", NOT_CONNECTED_REASON, { pausedAt: new Date() });
    await logSystemEvent("WARN", "group-admin-promotion", "Admin Maker paused: the WhatsApp account is not connected", { jobId: job.id, accountId: job.accountId });
    return null;
  }
  if (!(await getAutomationSettings()).automationEnabled) {
    await setJobStatus(job.id, "STOPPED_KILL_SWITCH", KILL_SWITCH_REASON, { pausedAt: new Date() });
    return null;
  }
  return provider;
}

/** Finishes the job once no group is left to decide. */
async function completeIfDone(jobId: string): Promise<void> {
  const pending = await prisma.groupAdminPromotionItem.count({ where: { jobId, status: "PENDING" } });
  if (pending > 0) return;
  const finished = await prisma.groupAdminPromotionJob.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: { status: "COMPLETED", statusReason: null, completedAt: new Date() },
  });
  if (finished.count > 0) {
    const tally = await prisma.groupAdminPromotionItem.groupBy({ by: ["status"], where: { jobId }, _count: { _all: true } });
    await logSystemEvent("INFO", "group-admin-promotion", "Admin Maker completed", {
      jobId,
      results: Object.fromEntries(tally.map((t) => [t.status, t._count._all])),
    });
  }
}

/** CHECKING: one call for every group, then everything not administered is settled at once. */
async function checkJob(job: GroupAdminPromotionJob, providers: ProviderSource): Promise<void> {
  const provider = await readyToAct(job, providers);
  if (!provider) return;

  const adminGroupIds = await provider.getAdminGroupIds();
  if (adminGroupIds === null) {
    // Promoting without knowing whether this account may is the one thing this feature must never
    // do, so an unanswered question ends the job — it is not read as "admin of everything".
    await setJobStatus(
      job.id,
      "FAILED",
      "WhatsApp would not say which groups this account administers, so nothing was attempted. Check the account is connected, then start the job again.",
      { completedAt: new Date() },
    );
    await logSystemEvent("WARN", "group-admin-promotion", "Admin Maker could not read which groups the account administers", { jobId: job.id });
    return;
  }
  const administered = new Set(adminGroupIds);
  const items = await prisma.groupAdminPromotionItem.findMany({
    where: { jobId: job.id, status: "PENDING" },
    select: { id: true, group: { select: { whatsappGroupId: true, isActive: true } } },
  });
  const unavailable = items.filter((i) => !i.group.isActive).map((i) => i.id);
  const notAdmin = items.filter((i) => i.group.isActive && !administered.has(i.group.whatsappGroupId)).map((i) => i.id);
  const now = new Date();
  if (unavailable.length) {
    await prisma.groupAdminPromotionItem.updateMany({
      where: { id: { in: unavailable } },
      data: { status: "GROUP_UNAVAILABLE", reason: ADMIN_PROMOTION_REASONS.GROUP_UNAVAILABLE, processedAt: now },
    });
  }
  if (notAdmin.length) {
    await prisma.groupAdminPromotionItem.updateMany({
      where: { id: { in: notAdmin } },
      data: { status: "NOT_ACCOUNT_ADMIN", reason: ADMIN_PROMOTION_REASONS.NOT_ACCOUNT_ADMIN, processedAt: now },
    });
  }
  const adminGroups = items.length - unavailable.length - notAdmin.length;
  await setJobStatus(job.id, "RUNNING", null, { adminGroups, startedAt: job.startedAt ?? now });
  await completeIfDone(job.id);
}

async function settle(itemId: string, status: GroupAdminPromotionItemStatus, reason: string, failureCode: string | null = null) {
  await prisma.groupAdminPromotionItem.update({ where: { id: itemId }, data: { status, reason, failureCode, processedAt: new Date() } });
}

/** A failure that may pass: tried again later, up to the limit, then recorded as FAILED with WhatsApp's words. */
async function retryOrFail(item: { id: string; retryCount: number }, reason: string, failureCode: string | null) {
  if (item.retryCount + 1 < ADMIN_PROMOTION_MAX_ATTEMPTS) {
    await prisma.groupAdminPromotionItem.update({
      where: { id: item.id },
      data: { retryCount: { increment: 1 }, reason: `${reason} Will try again shortly.`, failureCode, scheduledAt: new Date(Date.now() + ADMIN_PROMOTION_RETRY_DELAY_MS) },
    });
    return;
  }
  await prisma.groupAdminPromotionItem.update({
    where: { id: item.id },
    data: { status: "FAILED", retryCount: { increment: 1 }, reason, failureCode, processedAt: new Date() },
  });
}

/** When the next promotion on this account may happen, from the rows themselves. */
async function nextPromotionAllowedAt(accountId: string): Promise<number> {
  const last = await prisma.groupAdminPromotionItem.findFirst({
    where: { job: { accountId }, lastAttemptAt: { not: null } },
    orderBy: { lastAttemptAt: "desc" },
    select: { lastAttemptAt: true },
  });
  return last?.lastAttemptAt ? last.lastAttemptAt.getTime() + ADMIN_PROMOTION_DELAY_MIN_MS : 0;
}

/** RUNNING: one group. */
async function processItem(itemId: string, providers: ProviderSource): Promise<void> {
  const item = await prisma.groupAdminPromotionItem.findUnique({
    where: { id: itemId },
    include: { job: true, group: { select: { whatsappGroupId: true, isActive: true } } },
  });
  if (!item || item.status !== "PENDING" || item.job.status !== "RUNNING") return;
  const job = item.job;
  const provider = await readyToAct(job, providers);
  if (!provider) return;

  if (!item.group.isActive) {
    await settle(item.id, "GROUP_UNAVAILABLE", ADMIN_PROMOTION_REASONS.GROUP_UNAVAILABLE);
    return completeIfDone(job.id);
  }
  const chatId = item.group.whatsappGroupId;
  const participants = await provider.getGroupParticipants(chatId);
  const participantIds = participants.map((p) => p.rawId);
  const adminIds = participantIds.length ? await provider.getGroupAdminIds(chatId) : null;
  const verdict = decideAdminPromotion({ participantIds, adminIds, targetDigits: job.phoneNumber });

  if (verdict === "READ_FAILED") {
    if (provider.getConnectionStatus() !== "CONNECTED") {
      await setJobStatus(job.id, "PAUSED_DISCONNECTED", NOT_CONNECTED_REASON, { pausedAt: new Date() });
      return;
    }
    await retryOrFail(item, "Could not read this group's members and admins from WhatsApp.", null);
    return completeIfDone(job.id);
  }
  if (verdict === "NOT_MEMBER" || verdict === "CANNOT_VERIFY") {
    await settle(item.id, verdict, ADMIN_PROMOTION_REASONS[verdict]);
    return completeIfDone(job.id);
  }
  if (verdict === "ALREADY_ADMIN") {
    // Promoted on an earlier visit whose result was never recorded (a crash, a lost confirmation):
    // an admin now, because of this job.
    if (item.attemptCount > 0) await settle(item.id, "PROMOTED", ADMIN_PROMOTION_REASONS.PROMOTED);
    else await settle(item.id, "ALREADY_ADMIN", ADMIN_PROMOTION_REASONS.ALREADY_ADMIN);
    return completeIfDone(job.id);
  }

  // PROMOTE — paced per account, so hundreds of groups never fire at once.
  const allowedAt = await nextPromotionAllowedAt(job.accountId);
  if (Date.now() < allowedAt) {
    const jitter = randomDelayMs(0, ADMIN_PROMOTION_DELAY_MAX_MS - ADMIN_PROMOTION_DELAY_MIN_MS);
    await prisma.groupAdminPromotionItem.update({ where: { id: item.id }, data: { scheduledAt: new Date(allowedAt + jitter) } });
    return;
  }
  await prisma.groupAdminPromotionItem.update({
    where: { id: item.id },
    data: { attemptCount: { increment: 1 }, lastAttemptAt: new Date() },
  });
  const result = await provider.promoteGroupParticipant(chatId, targetParticipantId(participantIds, job.phoneNumber));

  if (result.success) {
    // Confirmed by reading the admin list back — never recorded as done on WhatsApp's word alone.
    const after = await provider.getGroupAdminIds(chatId);
    if (after && decideAdminPromotion({ participantIds, adminIds: after, targetDigits: job.phoneNumber }) === "ALREADY_ADMIN") {
      await settle(item.id, "PROMOTED", ADMIN_PROMOTION_REASONS.PROMOTED);
    } else {
      // The next visit re-reads before doing anything, so a promotion that did land is recorded
      // PROMOTED then, and one that did not is tried once more.
      await retryOrFail(item, "WhatsApp accepted the promotion, but the admin list did not show it when read back.", null);
    }
    return completeIfDone(job.id);
  }

  const code = result.error ?? null;
  const outcome = classifyPromotionFailure(code);
  if (outcome === "RETRY_OR_FAIL") {
    if (provider.getConnectionStatus() !== "CONNECTED") {
      await setJobStatus(job.id, "PAUSED_DISCONNECTED", NOT_CONNECTED_REASON, { pausedAt: new Date() });
      return;
    }
    await retryOrFail(item, `WhatsApp refused the promotion: ${code ?? "no reason given"}.`, code);
  } else {
    await settle(item.id, outcome, `${ADMIN_PROMOTION_REASONS[outcome]} (WhatsApp: ${code})`, code);
  }
  return completeIfDone(job.id);
}

/**
 * Does one thing — checks one job or decides one group — and reports whether there was anything to
 * do. Exported for the integration tests, which drive it directly.
 */
export async function processOneAdminPromotion(providers: ProviderSource): Promise<boolean> {
  const operating = { status: { in: [...OPERATING_PROJECT_STATUSES] } };
  // Across projects, oldest first; the work then runs inside the row's own project.
  const checking = await platformPrisma.groupAdminPromotionJob.findFirst({
    where: { status: "CHECKING", project: operating },
    orderBy: { createdAt: "asc" },
  });
  if (checking) {
    await withProject(checking.projectId, () => checkJob(checking, providers));
    return true;
  }
  const item = await platformPrisma.groupAdminPromotionItem.findFirst({
    where: { status: "PENDING", scheduledAt: { lte: new Date() }, job: { status: "RUNNING" }, project: operating },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
    select: { id: true, projectId: true },
  });
  if (!item) return false;
  await withProject(item.projectId, () => processItem(item.id, providers));
  return true;
}

/** The background loop. One thing per tick, never two at once (the overlap guard). */
export function startGroupAdminPromotionProcessor(providers: ProviderSource, intervalMs = 3000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void trackTick(async () => {
      try {
        await processOneAdminPromotion(providers);
      } catch (err) {
        console.error("[admin-promotion] tick failed", err);
      } finally {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      }
    });
  }, intervalMs);
}
