import { trackTick } from "../lifecycle.js";
import { platformPrisma, prisma } from "../db.js";
import { accountInCurrentProject, withProject } from "../project/context.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import type { GroupParticipantAddItem } from "@prisma/client";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { normalizePhoneNumber } from "@support-automation/shared";
import { getAutomationSettings } from "../pipeline/settings.js";
import {
  countAddedLastMinute,
  markJobStartedIfNeeded,
  markJobStoppedByKillSwitch,
  maybeCompleteParticipantAddJob,
} from "./groupParticipantAddQueue.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";

/** Name this loop reports itself under in the per-loop liveness view. */
const LOOP_NAME = "group-participant-add";

const STUCK_PROCESSING_TIMEOUT_MS = 2 * 60_000;
/** How long to defer an item when its job's own per-minute cap is hit — not a failure, just a wait. */
const JOB_RATE_LIMIT_DEFER_MS = 15_000;
/** Fixed backoff before a retried add attempt — this job type has no retryIntervalsMs list like AutomationSettings. */
const RETRY_DELAY_MS = 60_000;

/** Crash recovery: items left in PROCESSING by a worker that died mid-add go back to PENDING. */
export async function recoverStuckParticipantAddItems(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_TIMEOUT_MS);
  // Install-wide on purpose: releases this worker's own stranded claims, status only.
  const result = await platformPrisma.groupParticipantAddItem.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: cutoff } },
    data: { status: "PENDING" },
  });
  return result.count;
}

/** Atomically claims exactly one due PENDING item, or null if none are ready. */
async function claimNextItem() {
  // One shared queue in one global order; the work itself runs in the claimed item's project.
  const candidate = await platformPrisma.groupParticipantAddItem.findFirst({
    where: { status: "PENDING", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await platformPrisma.groupParticipantAddItem.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING" },
  });
  if (claim.count === 0) return null; // lost the race (shouldn't happen with a single worker, but defensive)

  return platformPrisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: candidate.id } });
}

/**
 * Pre-add gate: the job may have been stopped (by a user or the kill
 * switch) after this item was scheduled, or the per-minute cap may
 * already be exhausted by other items added since this one was queued.
 */
async function handlePreAddChecks(item: GroupParticipantAddItem): Promise<"STOP_TICK" | "CONTINUE"> {
  const job = await prisma.groupParticipantAddJob.findUnique({
    where: { id: item.jobId },
    select: { status: true, maxPerMinute: true },
  });

  if (!job || job.status === "CANCELLED" || job.status === "STOPPED_KILL_SWITCH") {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "CANCELLED", failureReason: "The job was stopped before this group could be processed." },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return "STOP_TICK";
  }

  // Global, not this job's own count — see countAddedLastMinute for why the per-job version made
  // the size cap dangerous. The ceiling still comes off this job's snapshot, so a job queued under
  // an older, stricter setting keeps being paced by it.
  const addedLastMinute = await countAddedLastMinute();
  if (addedLastMinute >= job.maxPerMinute) {
    // Defer, not a failure: claimNextItem() already flipped this row to PROCESSING — release it
    // back to PENDING, otherwise it would sit unreclaimed until the stuck-PROCESSING crash-recovery timeout.
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "PENDING", scheduledAt: new Date(Date.now() + JOB_RATE_LIMIT_DEFER_MS) },
    });
    return "STOP_TICK";
  }

  return "CONTINUE";
}

/** Exported for direct testing — drains exactly one due item, or returns false if none are ready. */
export async function processOne(provider: WhatsAppProvider): Promise<boolean> {
  const item = await claimNextItem();
  if (!item) return false;
  await withProject(item.projectId, () => processClaimedItem(item, provider));
  return true;
}

/** How long to defer an item whose account isn't connected in this worker yet — not a failure, just a wait. */
const ACCOUNT_NOT_READY_DEFER_MS = 30_000;

/**
 * Multi-account entry point: claims exactly once, resolves which account's provider to use from
 * the item's parent job (GroupParticipantAddItem itself has no accountId column — only the job
 * does), then shares the exact same add logic via `processClaimedItem`.
 */
export async function processOneViaRegistry(registry: import("../provider/ProviderRegistry.js").ProviderRegistry): Promise<boolean> {
  const item = await claimNextItem();
  if (!item) return false;

  await withProject(item.projectId, async () => {
    const job = await prisma.groupParticipantAddJob.findUnique({ where: { id: item.jobId }, select: { accountId: true } });
    const provider = job ? registry.get(job.accountId) : undefined;
    if (!provider) {
      // Release back to PENDING rather than fail — no add attempt was made, so this must not count
      // against attemptCount/retry budget.
      await prisma.groupParticipantAddItem.update({
        where: { id: item.id },
        data: { status: "PENDING", scheduledAt: new Date(Date.now() + ACCOUNT_NOT_READY_DEFER_MS) },
      });
      return;
    }
    await processClaimedItem(item, provider);
  });
  return true;
}

async function processClaimedItem(item: GroupParticipantAddItem, provider: WhatsAppProvider): Promise<void> {
  // The job's account must belong to the item's project (MULTI_PROJECT_PLAN.md Phase 3): failed and
  // logged otherwise, never added from another project's number. A job that no longer exists falls
  // through to the ordinary cancelled-job handling below.
  const owner = await prisma.groupParticipantAddJob.findUnique({ where: { id: item.jobId }, select: { accountId: true } });
  if (owner && !(await accountInCurrentProject(owner.accountId))) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "FAILED", failureReason: "The job's WhatsApp account belongs to a different project, so nothing was done." },
    });
    await logSystemEvent("ERROR", "queue", "Refused a group add through an account outside its project", {
      itemId: item.id,
      accountId: owner.accountId,
      itemProjectId: item.projectId,
    }).catch(() => undefined);
    return;
  }
  const settings = await getAutomationSettings();
  if (!settings.automationEnabled) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "CANCELLED", failureReason: "Automation was paused before this group could be processed." },
    });
    await markJobStoppedByKillSwitch(item.jobId);
    await maybeCompleteParticipantAddJob(item.jobId);
    return;
  }

  const gate = await handlePreAddChecks(item);
  if (gate === "STOP_TICK") return;

  await markJobStartedIfNeeded(item.jobId);

  const group = await prisma.whatsAppGroup.findUnique({ where: { id: item.groupId } });
  if (!group) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "FAILED", attemptCount: { increment: 1 }, failureReason: "Group no longer found.", processedAt: new Date() },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return;
  }

  // Never act blindly: a live, single-chat check right before adding, not just reliance on the
  // (possibly stale) synchronized WhatsAppGroup table used at job-creation time.
  const isMember = await provider.verifyGroupMembership(group.whatsappGroupId);
  if (!isMember) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "FAILED", attemptCount: { increment: 1 }, failureReason: "Membership could not be verified.", processedAt: new Date() },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return;
  }

  const job = await prisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: item.jobId } });

  // Already in the group? Nothing to do, and it matters that we look rather than just try: a
  // rejected add is a signal WhatsApp counts against the number, and re-running a roster across
  // groups it is partly already in would generate hundreds of them.
  //
  // Best effort by design. Participants now come back as opaque LIDs rather than phone numbers
  // for anyone WhatsApp has migrated, so a member whose id is a LID will not match and the add is
  // attempted anyway — which is the safe direction to be wrong in, since the attempt is what would
  // have happened before this check existed.
  if (await isAlreadyInGroup(provider, group.whatsappGroupId, item.phoneNumber)) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: {
        status: "SKIPPED_ALREADY_MEMBER",
        processedAt: new Date(),
        failureReason: null,
      },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return;
  }

  try {
    const result = await provider.addGroupParticipant(group.whatsappGroupId, item.phoneNumber);
    if (result.success) {
      await prisma.groupParticipantAddItem.update({
        where: { id: item.id },
        data: { status: "ADDED", attemptCount: { increment: 1 }, processedAt: new Date(), failureReason: null },
      });
      await maybeCompleteParticipantAddJob(item.jobId);
    } else {
      await handleAddFailure(item, job.retryMaxAttempts, result.error ?? "Unknown provider error");
    }
  } catch (err) {
    await handleAddFailure(item, job.retryMaxAttempts, (err as Error).message);
  }
  return;
}

/**
 * Whether this number is already a participant, compared on digits.
 *
 * Returns false on any doubt — an empty participant list (the provider is mid-reconnect, or the
 * read failed) must read as "unknown", never as "already in", or a transient blip would silently
 * skip every remaining group and report the job complete.
 */
async function isAlreadyInGroup(
  provider: WhatsAppProvider,
  whatsappGroupId: string,
  phoneNumber: string,
): Promise<boolean> {
  try {
    const participants = await provider.getGroupParticipants(whatsappGroupId);
    if (participants.length === 0) return false;
    const target = normalizePhoneNumber(phoneNumber);
    if (!target) return false;
    return participants.some((participant) => normalizePhoneNumber(participant.phoneNumber) === target);
  } catch {
    return false;
  }
}

/**
 * Turns WhatsApp's own status codes into something an operator can act on.
 *
 * `addParticipant` answers with a bare code — `INSUFFICIENT_PERMISSIONS`, `NOT_A_CONTACT` — and it
 * was being stored and displayed verbatim, unlike every other failure on this path ("Group no
 * longer found.", "Membership could not be verified."). A support lead reading
 * INSUFFICIENT_PERMISSIONS has no way to know the fix is to make this number a group admin first.
 *
 * The raw code is kept in parentheses: it is what appears in WhatsApp's own documentation and in
 * any issue report, and dropping it would trade one kind of unhelpfulness for another.
 */
export function describeAddFailure(code: string): string {
  const explanations: Record<string, string> = {
    INSUFFICIENT_PERMISSIONS:
      "This number is not an admin of that group, so WhatsApp will not let it add anyone. Make it a group admin and retry.",
    NOT_A_CONTACT:
      "WhatsApp would not add this person automatically — their privacy settings require an invite link instead.",
    GROUP_DOES_NOT_EXIST: "That group no longer exists on WhatsApp.",
    NOT_A_GROUP_CHAT: "That conversation is not a group, so nobody can be added to it.",
    // The four below arrive as numeric statuses inside a thrown AddParticipantError and were
    // previously flattened into "Unable to add some participants" — indistinguishable from each
    // other and from a generic failure, which is why none of them had wording until now.
    ALREADY_IN_GROUP: "They were already in the group, so nothing was added.",
    PRIVACY_SETTINGS:
      "Their privacy settings do not allow this account to add them to groups. Send them an invite link instead.",
    RECENTLY_LEFT:
      "They left this group recently, and WhatsApp blocks re-adding somebody for a while afterwards. Try again later, or send an invite link.",
    GROUP_FULL: "That group has reached WhatsApp's participant limit, so nobody else can be added.",
  };
  const explanation = explanations[code.trim().toUpperCase()];
  return explanation ? `${explanation} (${code.trim()})` : code;
}

async function handleAddFailure(
  item: GroupParticipantAddItem,
  retryMaxAttempts: number,
  rawFailure: string,
): Promise<void> {
  const failureCode = rawFailure.trim().toUpperCase();
  const failureReason = describeAddFailure(rawFailure);

  /**
   * WhatsApp's own 409 is the authoritative answer, and it is not a failure.
   *
   * The pre-check catches most of these before an add is spent, but it cannot catch everything:
   * somebody can join between the check and their turn in a queue paced at three a minute, and a
   * roster identifying people by LID cannot be matched at all. When that happens WhatsApp says
   * ALREADY_IN_GROUP, which means the desired end state holds — recording it as FAILED would put
   * a red row in front of an operator for an outcome that is entirely correct, and a retry would
   * then spend another add to be told the same thing.
   *
   * This is also what makes the whole feature idempotent: submit the same job twice and the second
   * run settles as skips rather than duplicate adds.
   */
  if (failureCode === "ALREADY_IN_GROUP") {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: {
        status: "SKIPPED_ALREADY_MEMBER",
        attemptCount: item.attemptCount + 1,
        processedAt: new Date(),
        failureCode,
        failureReason: "Already in the group by the time this ran — nothing was added.",
      },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return;
  }

  const attemptCount = item.attemptCount + 1;
  if (attemptCount >= retryMaxAttempts) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      // The machine-readable code beside the prose, so "how many adds did privacy settings block
      // this week" is answerable without parsing a sentence written for a person.
      data: { status: "FAILED", attemptCount, failureReason, failureCode, processedAt: new Date() },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return;
  }
  await prisma.groupParticipantAddItem.update({
    where: { id: item.id },
    data: {
      status: "PENDING",
      attemptCount,
      failureReason,
      failureCode,
      scheduledAt: new Date(Date.now() + RETRY_DELAY_MS),
    },
  });
}

/**
 * Starts the periodic drain loop. Processes at most one item per tick —
 * same overlap-guarded setInterval pattern as startOutboundQueueProcessor
 * (ENGINEERING_STANDARDS.md §9/§15 "no concurrent duplicate workers").
 */
export function startGroupParticipantAddProcessor(
  registry: import("../provider/ProviderRegistry.js").ProviderRegistry,
  intervalMs = 2000,
): NodeJS.Timeout {
  // Declared before the first tick, so a loop that dies on its very first run shows as
  // "never ticked" rather than not appearing in the liveness view at all.
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    // Wrapped so shutdown can wait for a claim already in flight and refuse to start a new one.
    // Without it, SIGTERM during this tick killed the process mid-work and left the claimed row
    // PROCESSING until the next boot requeued and re-ran it — see lifecycle.ts.
    void trackTick(() => processOneViaRegistry(registry))
      .catch((err) => {
        console.error("[queue] unexpected error processing group-participant-add item", err);
      })
      .finally(() => {
        processing = false;
        // Stamped when the tick FINISHES, which is the only moment that proves the loop is not
        // wedged — a guard that never clears is exactly how one of these dies silently.
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
