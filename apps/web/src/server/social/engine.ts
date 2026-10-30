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
import type { AdapterMedia } from "./adapters/types";
import { adapterAccount, markAccountNeedsReconnect } from "./accounts";
import { signedAssetUrl } from "./media";
import { addPostEvent, materialHash, settlePostStatus } from "./posts";

/**
 * The Social Studio publishing engine (SOCIAL_STUDIO.md §Engine). Durable jobs are SocialPostTarget rows;
 * the processor (socialProcessor.ts) calls these inside each project. The guarantees:
 *   - CLAIM: DUE → PUBLISHING by a conditional update with a fresh claim token and a lease, so two app
 *     instances can never both publish one job;
 *   - ATTEMPT: every attempt is a SocialPublishAttempt row written before anything is sent; the adapter
 *     stamps `requestSentAt` immediately before the request that makes the post public;
 *   - NEVER BLIND: a refusal that is safe to repeat (rate limit, never sent) waits and retries up to
 *     SOCIAL_MAX_ATTEMPTS, then dead-letters to FAILED; an answer not seen after the request left is
 *     UNKNOWN and is only settled by reconciliation (one matching publication on the account) or a person;
 *   - LEASE: a job whose process died is re-queued only when its attempt never sent the request,
 *     otherwise it becomes UNKNOWN.
 */

const PUBLISHABLE_POST_STATUSES = ["SCHEDULED"];

export type PublishResult = "PUBLISHED" | "FAILED" | "DEFERRED" | "UNKNOWN" | "SKIPPED";

async function finishAttempt(attemptId: string, outcome: string, message: string | null, externalId: string | null = null) {
  await prisma.socialPublishAttempt.update({ where: { id: attemptId }, data: { finishedAt: new Date(), outcome, message: message?.slice(0, 500) ?? null, externalId } });
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

  const settle = async (data: Prisma.SocialPostTargetUpdateManyMutationInput, kind: string, detail: Record<string, unknown>) => {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.socialPostTarget.updateMany({ where: mine, data: { ...data, claimToken: null, leaseExpiresAt: null, lastCheckedAt: new Date() } });
      if (moved.count) {
        await addPostEvent(tx, target.postId, kind, null, { account: target.account.name, ...detail });
        await settlePostStatus(tx, target.postId);
      }
    });
  };
  const failNow = async (message: string): Promise<PublishResult> => {
    await finishAttempt(attempt.id, "REFUSED", message);
    await settle({ status: "FAILED", error: message.slice(0, 500), nextAttemptAt: null }, "FAILED", { error: message.slice(0, 300) });
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
    outcome = await adapter.publish(
      { account: account.account, text, media, settings: (target.settings as Record<string, unknown> | null) ?? {}, containerIds: target.externalContainerIds },
      {
        fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        markSent: async () => {
          sent = true;
          await prisma.socialPublishAttempt.update({ where: { id: attempt.id }, data: { requestSentAt: new Date() } });
        },
        saveContainers: async (ids) => {
          await prisma.socialPostTarget.updateMany({ where: mine, data: { externalContainerIds: ids } });
        },
      },
    );
  } catch (err) {
    // A failure in this process around the request: unknown once it may have left.
    outcome = sent ? { kind: "UNKNOWN", message: "The app hit an error while publishing; the outcome is unknown." } : { kind: "RETRY_LATER", rateLimited: false, message: `The app hit an error before publishing (${(err as Error).name}).` };
  }

  switch (outcome.kind) {
    case "PUBLISHED":
      await finishAttempt(attempt.id, "PUBLISHED", null, outcome.externalId);
      await settle({ status: "PUBLISHED", externalId: outcome.externalId, permalink: outcome.permalink, publishedAt: new Date(), error: null, nextAttemptAt: null, externalContainerIds: [] }, "PUBLISHED", { externalId: outcome.externalId });
      return "PUBLISHED";
    case "REFUSED":
      return failNow(outcome.message);
    case "AUTH":
      await markAccountNeedsReconnect(target.accountId, outcome.message);
      return failNow(outcome.message);
    case "RETRY_LATER": {
      if (target.attempts >= SOCIAL_MAX_ATTEMPTS) return failNow(`${outcome.message} Gave up after ${SOCIAL_MAX_ATTEMPTS} attempts.`);
      const next = new Date(Date.now() + socialRetryDelayMs(target.attempts, outcome.rateLimited));
      await finishAttempt(attempt.id, "RETRY_LATER", outcome.message);
      await settle({ status: "DUE", nextAttemptAt: next, error: outcome.message.slice(0, 500) }, "DEFERRED", { error: outcome.message.slice(0, 300), next: next.toISOString() });
      return "DEFERRED";
    }
    case "UNKNOWN":
      await finishAttempt(attempt.id, "UNKNOWN", outcome.message);
      await settle({ status: "UNKNOWN", error: outcome.message.slice(0, 500), nextAttemptAt: null }, "UNKNOWN", { error: outcome.message.slice(0, 300) });
      await logSystemEvent("WARN", "social", `A social post's outcome on ${target.account.name} is unknown`, { postId: target.postId });
      return "UNKNOWN";
  }
}

/** A job whose lease ran out: re-queued if its attempt never sent the request, otherwise UNKNOWN. */
export async function recoverExpiredLease(targetId: string, now = new Date()): Promise<"REQUEUED" | "UNKNOWN" | "SKIPPED"> {
  const target = await prisma.socialPostTarget.findFirst({ where: { id: targetId, status: "PUBLISHING", leaseExpiresAt: { lt: now } }, select: { id: true, postId: true, claimToken: true } });
  if (!target) return "SKIPPED";
  const attempt = await prisma.socialPublishAttempt.findFirst({ where: { targetId, claimToken: target.claimToken ?? "" }, orderBy: { attemptNo: "desc" }, select: { id: true, requestSentAt: true } });
  const decision = expiredLeaseOutcome(attempt?.requestSentAt ?? null);
  await prisma.$transaction(async (tx) => {
    const moved = await tx.socialPostTarget.updateMany({
      where: { id: targetId, status: "PUBLISHING", claimToken: target.claimToken },
      data:
        decision === "REQUEUE"
          ? { status: "DUE", claimToken: null, leaseExpiresAt: null, nextAttemptAt: now }
          : { status: "UNKNOWN", claimToken: null, leaseExpiresAt: null, error: "The app stopped while publishing; the outcome is unknown and is being looked for." },
    });
    if (!moved.count) return;
    if (attempt) await tx.socialPublishAttempt.update({ where: { id: attempt.id }, data: { finishedAt: now, outcome: decision === "REQUEUE" ? "REQUEUED" : "UNKNOWN", message: "The lease ran out." } });
    await addPostEvent(tx, target.postId, decision === "REQUEUE" ? "REQUEUED" : "UNKNOWN", null, { reason: "lease expired" });
    await settlePostStatus(tx, target.postId);
  });
  return decision === "REQUEUE" ? "REQUEUED" : "UNKNOWN";
}

/**
 * Looks for an UNKNOWN job's publication on its account: the account's posts around the time the
 * request left, with the same text. Exactly one is a match and settles it PUBLISHED; none or several
 * leave it UNKNOWN with a note for a person. Reading has no side effect on the platform.
 */
export async function reconcileUnknownTarget(targetId: string, now = new Date()): Promise<"MATCHED" | "UNMATCHED" | "SKIPPED"> {
  const target = await prisma.socialPostTarget.findFirst({
    where: { id: targetId, status: "UNKNOWN" },
    include: { post: { select: { content: true } }, account: { select: { platform: true, name: true } }, publishAttempts: { orderBy: { attemptNo: "desc" }, take: 1 } },
  });
  if (!target) return "SKIPPED";
  const adapter = adapterFor(target.account.platform);
  if (!adapter || !platformHas(target.account.platform, "RECONCILE")) {
    await prisma.socialPostTarget.update({ where: { id: targetId }, data: { lastCheckedAt: now } });
    return "UNMATCHED";
  }
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
