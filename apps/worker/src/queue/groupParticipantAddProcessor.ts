import { trackTick } from "../lifecycle.js";
import { prisma } from "@support-automation/db";
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

const STUCK_PROCESSING_TIMEOUT_MS = 2 * 60_000;
/** How long to defer an item when its job's own per-minute cap is hit — not a failure, just a wait. */
const JOB_RATE_LIMIT_DEFER_MS = 15_000;
/** Fixed backoff before a retried add attempt — this job type has no retryIntervalsMs list like AutomationSettings. */
const RETRY_DELAY_MS = 60_000;

/** Crash recovery: items left in PROCESSING by a worker that died mid-add go back to PENDING. */
export async function recoverStuckParticipantAddItems(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_TIMEOUT_MS);
  const result = await prisma.groupParticipantAddItem.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: cutoff } },
    data: { status: "PENDING" },
  });
  return result.count;
}

/** Atomically claims exactly one due PENDING item, or null if none are ready. */
async function claimNextItem() {
  const candidate = await prisma.groupParticipantAddItem.findFirst({
    where: { status: "PENDING", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await prisma.groupParticipantAddItem.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING" },
  });
  if (claim.count === 0) return null; // lost the race (shouldn't happen with a single worker, but defensive)

  return prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: candidate.id } });
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
  await processClaimedItem(item, provider);
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

  const job = await prisma.groupParticipantAddJob.findUnique({ where: { id: item.jobId }, select: { accountId: true } });
  const provider = job ? registry.get(job.accountId) : undefined;
  if (!provider) {
    // Release back to PENDING rather than fail — no add attempt was made, so this must not count
    // against attemptCount/retry budget.
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "PENDING", scheduledAt: new Date(Date.now() + ACCOUNT_NOT_READY_DEFER_MS) },
    });
    return true;
  }

  await processClaimedItem(item, provider);
  return true;
}

async function processClaimedItem(item: GroupParticipantAddItem, provider: WhatsAppProvider): Promise<void> {
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
  };
  const explanation = explanations[code.trim().toUpperCase()];
  return explanation ? `${explanation} (${code.trim()})` : code;
}

async function handleAddFailure(
  item: GroupParticipantAddItem,
  retryMaxAttempts: number,
  rawFailure: string,
): Promise<void> {
  const failureReason = describeAddFailure(rawFailure);
  const attemptCount = item.attemptCount + 1;
  if (attemptCount >= retryMaxAttempts) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "FAILED", attemptCount, failureReason, processedAt: new Date() },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return;
  }
  await prisma.groupParticipantAddItem.update({
    where: { id: item.id },
    data: { status: "PENDING", attemptCount, failureReason, scheduledAt: new Date(Date.now() + RETRY_DELAY_MS) },
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
      });
  }, intervalMs);
}
