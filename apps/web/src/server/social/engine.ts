import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  expiredLeaseOutcome,
  isSocialPlatform,
  matchRecentPublication,
  platformHas,
  SOCIAL_LEASE_MS,
  SOCIAL_MAX_ATTEMPTS,
  socialRetryDelayMs,
  validateForPlatform,
  type PublishOutcome,
  type SocialMediaKind,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { logSystemEvent } from "@/server/logSystemEvent";
import { adapterFor } from "./adapters";
import { SocialClaimLostError, type AdapterMedia } from "./adapters/types";
import { adapterAccount, markAccountNeedsReconnect } from "./accounts";
import { signedAssetUrl } from "./media";
import { addPostEvent, materialHash, settlePostStatus } from "./posts";

/**
 * The Social Studio publishing engine (SOCIAL_STUDIO.md §Engine). Durable jobs are SocialPostTarget rows;
 * the processor (socialProcessor.ts) calls these inside each project. The guarantees:
 *   - CLAIM: DUE → PUBLISHING by a conditional update with a fresh claim token and a lease, so two app
 *     instances can never both start one job;
 *   - ATTEMPT: every attempt is a SocialPublishAttempt row written before anything is sent;
 *   - FENCE: immediately before the request that makes the post public, `markSent` checks — in ONE
 *     transaction, on the job's row — that this run still holds the claim AND its lease has not run out,
 *     renews the lease, and stamps `requestSentAt`. A run that lost the job (lease ran out and it was
 *     re-queued, or a person moved it) gets `SocialClaimLostError` and sends nothing. Long waits renew
 *     the lease (`renewLease`), so a slow but healthy Instagram run keeps its job;
 *   - LEASE RECOVERY takes the job's row FIRST and only then reads `requestSentAt`. Because the stamp is
 *     committed together with the fence, the two can never both succeed: either the sender stamped first
 *     (the lease is renewed, recovery finds nothing expired — or, if it ran out later, the job becomes
 *     UNKNOWN, never re-queued), or recovery took it first (the sender's fence fails). A job is therefore
 *     re-queued only when no request of its claim can ever leave;
 *   - NEVER BLIND: a refusal that is safe to repeat (rate limit, never sent) waits and retries up to
 *     SOCIAL_MAX_ATTEMPTS, then dead-letters to FAILED; an answer not seen after the request left is
 *     UNKNOWN and is only settled by reconciliation (one matching publication on the account), by the
 *     late answer of the run that sent it, or by a person.
 * This is at-most-once SENDING per claim, not exactly-once delivery: Meta's publishing endpoints take no
 * idempotency key, so a request whose answer is lost stays UNKNOWN rather than being repeated.
 */

const PUBLISHABLE_POST_STATUSES = ["SCHEDULED"];

export type PublishResult = "PUBLISHED" | "FAILED" | "DEFERRED" | "UNKNOWN" | "SKIPPED";

/** Records an attempt's end once; an attempt lease recovery already closed keeps that record. */
async function finishAttempt(attemptId: string, outcome: string, message: string | null, externalId: string | null = null) {
  await prisma.socialPublishAttempt.updateMany({ where: { id: attemptId, finishedAt: null }, data: { finishedAt: new Date(), outcome, message: message?.slice(0, 500) ?? null, externalId } });
}

/** One due job: claimed, checked again, published through its adapter, and settled. */
export async function publishTarget(targetId: string, now = new Date()): Promise<PublishResult> {
  const claimToken = randomBytes(12).toString("hex");
  const claimed = await prisma.socialPostTarget.updateMany({
    where: { id: targetId, status: "DUE", dueAt: { lte: now }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    data: { status: "PUBLISHING", claimToken, leaseExpiresAt: new Date(now.getTime() + SOCIAL_LEASE_MS), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return "SKIPPED";

  const target = await prisma.socialPostTarget.findFirst({
    where: { id: targetId },
    include: { post: { include: { targets: { select: { accountId: true, contentOverride: true, settings: true } } } }, account: { select: { id: true, platform: true, name: true } } },
  });
  if (!target) return "SKIPPED";
  const attempt = await prisma.socialPublishAttempt.create({ data: { targetId, attemptNo: target.attempts, claimToken, startedAt: now }, select: { id: true } });
  const mine = { id: targetId, status: "PUBLISHING", claimToken };

  /** Holds the job for another lease — only while this run's claim AND lease are both still valid. */
  const holdClaim = async (tx: Prisma.TransactionClient | typeof prisma) => {
    const held = await tx.socialPostTarget.updateMany({ where: { ...mine, leaseExpiresAt: { gt: new Date() } }, data: { leaseExpiresAt: new Date(Date.now() + SOCIAL_LEASE_MS) } });
    if (held.count === 0) throw new SocialClaimLostError();
  };

  /** Settles the job only while this run still holds it. False when it no longer does. */
  const settle = async (data: Prisma.SocialPostTargetUpdateManyMutationInput, kind: string, detail: Record<string, unknown>): Promise<boolean> =>
    prisma.$transaction(async (tx) => {
      const moved = await tx.socialPostTarget.updateMany({ where: mine, data: { ...data, claimToken: null, leaseExpiresAt: null, lastCheckedAt: new Date() } });
      if (moved.count) {
        await addPostEvent(tx, target.postId, kind, null, { account: target.account.name, ...detail });
        await settlePostStatus(tx, target.postId);
      }
      return moved.count > 0;
    });
  const failNow = async (message: string): Promise<PublishResult> => {
    await finishAttempt(attempt.id, "REFUSED", message);
    if (!(await settle({ status: "FAILED", error: message.slice(0, 500), nextAttemptAt: null }, "FAILED", { error: message.slice(0, 300) }))) return "SKIPPED";
    await logSystemEvent("WARN", "social", `Social post could not be published to ${target.account.name}`, { postId: target.postId, error: message.slice(0, 300) });
    return "FAILED";
  };

  // Checked again at the moment of publishing: the post must still be scheduled and exactly as approved.
  if (!PUBLISHABLE_POST_STATUSES.includes(target.post.status)) return failNow("The post is no longer scheduled.");
  if (!target.post.approvalHash || target.post.approvalHash !== materialHash(target.post)) return failNow("The post changed after it was approved, so it was not published.");
  const adapter = adapterFor(target.account.platform);
  if (!adapter || !isSocialPlatform(target.account.platform)) return failNow("Publishing to this platform is not available.");
  const account = await adapterAccount(target.accountId);
  if (!account.ok) return failNow(`${account.reason} Reconnect it under Social Studio → Accounts, then retry.`);

  const assets = target.post.mediaIds.length ? await prisma.socialMediaAsset.findMany({ where: { id: { in: target.post.mediaIds }, deletedAt: null } }) : [];
  if (assets.length !== new Set(target.post.mediaIds).size) return failNow("A file attached to the post is no longer in the media library.");
  const byId = new Map(assets.map((a) => [a.id, a]));
  const media: AdapterMedia[] = [];
  for (const id of target.post.mediaIds) {
    const a = byId.get(id)!;
    const signed = signedAssetUrl(a.id, now);
    if (!signed.ok) return failNow(signed.reason);
    media.push({ kind: (a.kind === "VIDEO" ? "VIDEO" : "IMAGE") as SocialMediaKind, mimeType: a.mimeType, sizeBytes: a.sizeBytes, url: signed.url });
  }
  const text = target.contentOverride ?? target.post.content;
  const problems = validateForPlatform(target.account.platform, { text, media });
  if (problems.length) return failNow(problems.join(" "));

  let sent = false;
  let outcome: PublishOutcome;
  try {
    await holdClaim(prisma); // setup above may have been slow; never start the platform calls on a lost job
    outcome = await adapter.publish(
      { account: account.account, text, media, settings: (target.settings as Record<string, unknown> | null) ?? {}, containerIds: target.externalContainerIds },
      {
        fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        // The fence: the claim check, the lease renewal and the durable stamp commit together, or not at all.
        markSent: async () => {
          await prisma.$transaction(async (tx) => {
            await holdClaim(tx);
            await tx.socialPublishAttempt.update({ where: { id: attempt.id }, data: { requestSentAt: new Date() } });
          });
          sent = true;
        },
        renewLease: () => holdClaim(prisma),
        saveContainers: async (ids) => {
          const saved = await prisma.socialPostTarget.updateMany({ where: { ...mine, leaseExpiresAt: { gt: new Date() } }, data: { externalContainerIds: ids, leaseExpiresAt: new Date(Date.now() + SOCIAL_LEASE_MS) } });
          if (saved.count === 0) throw new SocialClaimLostError();
        },
      },
    );
  } catch (err) {
    if (err instanceof SocialClaimLostError && !sent) {
      // Another run (or a person) has the job now; this run sent nothing and changes nothing.
      await finishAttempt(attempt.id, "CLAIM_LOST", err.message);
      return "SKIPPED";
    }
    // A failure in this process around the request: unknown once it may have left.
    outcome = sent ? { kind: "UNKNOWN", message: "The app hit an error while publishing; the outcome is unknown." } : { kind: "RETRY_LATER", rateLimited: false, message: `The app hit an error before publishing (${(err as Error).name}).` };
  }

  switch (outcome.kind) {
    case "PUBLISHED": {
      await finishAttempt(attempt.id, "PUBLISHED", null, outcome.externalId);
      const data: Prisma.SocialPostTargetUpdateManyMutationInput = { status: "PUBLISHED", externalId: outcome.externalId, permalink: outcome.permalink, publishedAt: new Date(), error: null, nextAttemptAt: null, externalContainerIds: [] };
      if (await settle(data, "PUBLISHED", { externalId: outcome.externalId })) return "PUBLISHED";
      return (await settleLatePublication(targetId, attempt.id, outcome.externalId, outcome.permalink)) ? "PUBLISHED" : "SKIPPED";
    }
    case "REFUSED":
      return failNow(outcome.message);
    case "AUTH":
      await markAccountNeedsReconnect(target.accountId, outcome.message);
      return failNow(outcome.message);
    case "RETRY_LATER": {
      if (target.attempts >= SOCIAL_MAX_ATTEMPTS) return failNow(`${outcome.message} Gave up after ${SOCIAL_MAX_ATTEMPTS} attempts.`);
      const next = new Date(Date.now() + socialRetryDelayMs(target.attempts, outcome.rateLimited));
      await finishAttempt(attempt.id, "RETRY_LATER", outcome.message);
      if (!(await settle({ status: "DUE", nextAttemptAt: next, error: outcome.message.slice(0, 500) }, "DEFERRED", { error: outcome.message.slice(0, 300), next: next.toISOString() }))) return "SKIPPED";
      return "DEFERRED";
    }
    case "UNKNOWN":
      await finishAttempt(attempt.id, "UNKNOWN", outcome.message);
      // Not held any more (the lease ran out after the request left): recovery already made it UNKNOWN.
      if (!(await settle({ status: "UNKNOWN", error: outcome.message.slice(0, 500), nextAttemptAt: null }, "UNKNOWN", { error: outcome.message.slice(0, 300) }))) return "UNKNOWN";
      await logSystemEvent("WARN", "social", `A social post's outcome on ${target.account.name} is unknown`, { postId: target.postId });
      return "UNKNOWN";
  }
}

/**
 * The platform's answer arrived after this run had already lost the job — its lease ran out while the
 * request was in flight, so recovery made it UNKNOWN. The answer is the best evidence there is: it settles
 * the job PUBLISHED, but only while the job is still UNKNOWN and no later attempt has started.
 */
async function settleLatePublication(targetId: string, attemptId: string, externalId: string, permalink: string | null): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const latest = await tx.socialPublishAttempt.findFirst({ where: { targetId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true } });
    if (latest?.id !== attemptId) return false;
    const target = await tx.socialPostTarget.findFirst({ where: { id: targetId }, select: { postId: true, account: { select: { name: true } } } });
    const moved = await tx.socialPostTarget.updateMany({
      where: { id: targetId, status: "UNKNOWN" },
      data: { status: "PUBLISHED", externalId, permalink, publishedAt: new Date(), error: null, nextAttemptAt: null, externalContainerIds: [], lastCheckedAt: new Date() },
    });
    if (!moved.count || !target) return false;
    await tx.socialPublishAttempt.update({ where: { id: attemptId }, data: { outcome: "PUBLISHED", externalId, message: "The platform answered after this run's lease ran out." } });
    await addPostEvent(tx, target.postId, "PUBLISHED", null, { account: target.account.name, externalId, late: true });
    await settlePostStatus(tx, target.postId);
    return true;
  });
}

/**
 * A job whose lease ran out: re-queued if its attempt never sent the request, otherwise UNKNOWN. The job's
 * row is taken FIRST (conditional on the same claim and on the lease still being expired), and the
 * attempt is read only after that: a run stamping `requestSentAt` does so in the same transaction as its
 * own claim check, so it either committed before this (and is seen) or will find its claim gone.
 */
export async function recoverExpiredLease(targetId: string, now = new Date()): Promise<"REQUEUED" | "UNKNOWN" | "SKIPPED"> {
  const target = await prisma.socialPostTarget.findFirst({ where: { id: targetId, status: "PUBLISHING", leaseExpiresAt: { lt: now } }, select: { id: true, postId: true, claimToken: true } });
  if (!target?.claimToken) return "SKIPPED";
  const claimToken = target.claimToken;
  return prisma.$transaction(async (tx) => {
    const taken = await tx.socialPostTarget.updateMany({ where: { id: targetId, status: "PUBLISHING", claimToken, leaseExpiresAt: { lt: now } }, data: { claimToken: null, leaseExpiresAt: null } });
    if (taken.count === 0) return "SKIPPED" as const;
    const attempt = await tx.socialPublishAttempt.findFirst({ where: { targetId, claimToken }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true, requestSentAt: true } });
    const decision = expiredLeaseOutcome(attempt?.requestSentAt ?? null);
    await tx.socialPostTarget.updateMany({
      where: { id: targetId, status: "PUBLISHING", claimToken: null },
      data: decision === "REQUEUE" ? { status: "DUE", nextAttemptAt: now } : { status: "UNKNOWN", error: "The app stopped while publishing; the outcome is unknown and is being looked for." },
    });
    if (attempt) await tx.socialPublishAttempt.updateMany({ where: { id: attempt.id, finishedAt: null }, data: { finishedAt: now, outcome: decision === "REQUEUE" ? "REQUEUED" : "UNKNOWN", message: "The lease ran out." } });
    await addPostEvent(tx, target.postId, decision === "REQUEUE" ? "REQUEUED" : "UNKNOWN", null, { reason: "lease expired" });
    await settlePostStatus(tx, target.postId);
    return decision === "REQUEUE" ? ("REQUEUED" as const) : ("UNKNOWN" as const);
  });
}

/**
 * Looks for an UNKNOWN job's publication on its account: the account's posts around the time the
 * request left, with the same text. Exactly one is a match and settles it PUBLISHED; none or several
 * leave it UNKNOWN with a note for a person. Reading has no side effect on the platform.
 */
export async function reconcileUnknownTarget(targetId: string, now = new Date()): Promise<"MATCHED" | "UNMATCHED" | "SKIPPED"> {
  const target = await prisma.socialPostTarget.findFirst({
    where: { id: targetId, status: "UNKNOWN" },
    include: { post: { select: { content: true } }, account: { select: { platform: true, name: true } }, publishAttempts: { orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 1 } },
  });
  if (!target) return "SKIPPED";
  const adapter = adapterFor(target.account.platform);
  if (!adapter || !platformHas(target.account.platform, "RECONCILE")) {
    await prisma.socialPostTarget.update({ where: { id: targetId }, data: { lastCheckedAt: now } });
    return "UNMATCHED";
  }
  // The newest attempt by time: attempt numbers start again after a person sends a job again.
  const requestedAt = target.publishAttempts[0]?.requestSentAt ?? target.publishAttempts[0]?.startedAt ?? target.updatedAt;
  const account = await adapterAccount(target.accountId);
  if (!account.ok) {
    await prisma.socialPostTarget.update({ where: { id: targetId }, data: { lastCheckedAt: now, error: `Could not check: ${account.reason}` } });
    return "UNMATCHED";
  }
  let recent;
  try {
    recent = await adapter.findRecent(account.account, new Date(requestedAt.getTime() - 5 * 60_000), { fetch });
  } catch (err) {
    await prisma.socialPostTarget.update({ where: { id: targetId }, data: { lastCheckedAt: now, error: `Could not check the account: ${(err as Error).message}`.slice(0, 500) } });
    return "UNMATCHED";
  }
  const linked = new Set(
    (await prisma.socialPostTarget.findMany({ where: { accountId: target.accountId, externalId: { in: recent.map((r) => r.externalId) } }, select: { externalId: true } })).map((r) => r.externalId!),
  );
  const match = matchRecentPublication({ text: target.contentOverride ?? target.post.content, requestedAt }, recent, linked);
  if (match.kind !== "MATCH") {
    const note =
      match.kind === "SEVERAL"
        ? `${match.count} posts on the account look like this one. Check the account, then mark it published or send it again.`
        : "No matching post was found on the account. If you checked and it is not there, send it again; if it is there, mark it published.";
    await prisma.socialPostTarget.update({ where: { id: targetId }, data: { lastCheckedAt: now, error: note } });
    return "UNMATCHED";
  }
  await prisma.$transaction(async (tx) => {
    const moved = await tx.socialPostTarget.updateMany({
      where: { id: targetId, status: "UNKNOWN" },
      data: { status: "PUBLISHED", externalId: match.publication.externalId, permalink: match.publication.permalink, publishedAt: match.publication.createdAt, error: null, lastCheckedAt: now },
    });
    if (!moved.count) return;
    await addPostEvent(tx, target.postId, "MATCHED", null, { account: target.account.name, externalId: match.publication.externalId });
    await settlePostStatus(tx, target.postId);
  });
  return "MATCHED";
}

/** Reads the platform's own counts for a publication (only where the adapter supports it). */
export async function refreshTargetMetrics(targetId: string, now = new Date()): Promise<boolean> {
  const target = await prisma.socialPostTarget.findFirst({ where: { id: targetId, status: "PUBLISHED" }, select: { id: true, externalId: true, accountId: true, account: { select: { platform: true } } } });
  if (!target?.externalId) return false;
  const adapter = adapterFor(target.account.platform);
  if (!adapter?.metrics || !platformHas(target.account.platform, "POST_METRICS")) return false;
  const account = await adapterAccount(target.accountId);
  if (!account.ok) return false;
  const metrics = await adapter.metrics(account.account, target.externalId, { fetch }).catch(() => null);
  await prisma.socialPostTarget.update({ where: { id: targetId }, data: { metricsAt: now, ...(metrics ? { metrics: metrics as unknown as Prisma.InputJsonValue } : {}) } });
  return Boolean(metrics);
}
