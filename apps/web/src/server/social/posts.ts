import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  decideSocialTransition,
  decideTargetAction,
  isSocialPlatform,
  isSocialPostStatus,
  isSocialTargetStatus,
  overallPostStatus,
  planPublishAccounts,
  platformHas,
  repeatTimes,
  socialApprovalMaterial,
  validateForPlatform,
  validateSchedule,
  validateSocialDraft,
  type SocialAction,
  type SocialMediaKind,
  type SocialPostStatus,
  type SocialPublishMode,
  type SocialRepeatEvery,
  type SocialTargetAction,
  type SocialTargetStatus,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { adapterFor } from "./adapters";
import { adapterAccount } from "./accounts";

/**
 * Social Studio posts (SOCIAL_STUDIO.md §Workflow): writing, review, approval, scheduling and the
 * per-account job actions. Everything runs inside a project through the scoped client; the rules are
 * packages/shared's (`decideSocialTransition`, `decideTargetAction`, `validateForPlatform`), applied here.
 *   - Every status change is a CONDITIONAL update on the status (and revision) it was decided from, so
 *     two people — or a person and the engine — can never both move one post or one job.
 *   - Scheduling only marks jobs DUE; the engine (engine.ts) publishes them when they are due.
 *   - Accounts and media are loaded through the scoped client: another project's id is simply not found.
 */

export class SocialRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialRefusal";
  }
}

type Tx = Prisma.TransactionClient;
const STALE = "Someone else changed this post meanwhile. Reload the page to see it.";

export function approvalHashOf(material: Parameters<typeof socialApprovalMaterial>[0]): string {
  return createHash("sha256").update(socialApprovalMaterial(material)).digest("hex");
}

interface MaterialPost {
  content: string;
  mediaIds: string[];
  targets: Array<{ accountId: string; contentOverride: string | null; settings: Prisma.JsonValue | null }>;
}

export function materialHash(post: MaterialPost): string {
  return approvalHashOf({
    content: post.content,
    accountIds: post.targets.map((t) => t.accountId),
    mediaIds: post.mediaIds,
    variants: Object.fromEntries(post.targets.map((t) => [t.accountId, t.contentOverride])),
    settings: Object.fromEntries(post.targets.map((t) => [t.accountId, t.settings ?? null])),
  });
}

export async function addPostEvent(tx: Tx | typeof prisma, postId: string, kind: string, actorUsername: string | null, detail?: Record<string, unknown>) {
  await tx.socialPostEvent.create({ data: { postId, kind, actorUsername, ...(detail ? { detail: detail as Prisma.InputJsonValue } : {}) } });
}

/** Re-derives a scheduled post's status from its jobs (after any job changed). */
export async function settlePostStatus(tx: Tx | typeof prisma, postId: string): Promise<SocialPostStatus | null> {
  const post = await tx.socialPost.findFirst({ where: { id: postId }, select: { status: true, targets: { select: { status: true } } } });
  if (!post || !isSocialPostStatus(post.status)) return null;
  if (!["SCHEDULED", "PUBLISHED", "PARTIAL", "FAILED", "UNKNOWN", "CANCELLED"].includes(post.status)) return post.status;
  const next = overallPostStatus(post.targets.map((t) => (isSocialTargetStatus(t.status) ? t.status : "FAILED")));
  if (next !== post.status) {
    const moved = await tx.socialPost.updateMany({ where: { id: postId, status: post.status }, data: { status: next } });
    if (moved.count) await addPostEvent(tx, postId, "STATUS", null, { from: post.status, to: next });
  }
  return next;
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

export const SOCIAL_LIST_VIEWS = ["all", "drafts", "approvals", "scheduled", "published", "failed"] as const;
export type SocialListView = (typeof SOCIAL_LIST_VIEWS)[number];

const VIEW_STATUSES: Record<SocialListView, SocialPostStatus[] | null> = {
  all: null,
  drafts: ["DRAFT"],
  approvals: ["IN_REVIEW", "APPROVED"],
  scheduled: ["SCHEDULED"],
  published: ["PUBLISHED", "PARTIAL"],
  failed: ["FAILED", "UNKNOWN"],
};

export interface SocialPostSummary {
  id: string;
  title: string | null;
  excerpt: string;
  status: SocialPostStatus;
  when: string | null;
  timezone: string;
  campaign: { id: string; name: string; color: string | null } | null;
  accounts: Array<{ id: string; platform: string; name: string; status: string }>;
  aiAssisted: boolean;
  reviewerUsername: string | null;
  createdByUsername: string;
  updatedAt: string;
}

const SUMMARY_SELECT = {
  id: true,
  title: true,
  content: true,
  status: true,
  scheduledAt: true,
  timezone: true,
  aiAssisted: true,
  reviewerUsername: true,
  createdByUsername: true,
  updatedAt: true,
  campaign: { select: { id: true, name: true, color: true } },
  targets: { select: { status: true, publishedAt: true, account: { select: { id: true, platform: true, name: true } } } },
} satisfies Prisma.SocialPostSelect;

function summary(p: Prisma.SocialPostGetPayload<{ select: typeof SUMMARY_SELECT }>): SocialPostSummary {
  const published = p.targets.map((t) => t.publishedAt).filter((d): d is Date => Boolean(d)).sort((a, b) => a.getTime() - b.getTime())[0];
  return {
    id: p.id,
    title: p.title,
    excerpt: p.content.replace(/\s+/g, " ").trim().slice(0, 160),
    status: isSocialPostStatus(p.status) ? p.status : "DRAFT",
    when: (p.scheduledAt ?? published)?.toISOString() ?? null,
    timezone: p.timezone,
    campaign: p.campaign,
    accounts: p.targets.map((t) => ({ id: t.account.id, platform: t.account.platform, name: t.account.name, status: t.status })),
    aiAssisted: p.aiAssisted,
    reviewerUsername: p.reviewerUsername,
    createdByUsername: p.createdByUsername,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function listSocialPosts(filter: { view: SocialListView; q?: string; accountId?: string; campaignId?: string; take?: number }): Promise<SocialPostSummary[]> {
  const statuses = VIEW_STATUSES[filter.view];
  const q = filter.q?.trim();
  const rows = await prisma.socialPost.findMany({
    where: {
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { content: { contains: q, mode: "insensitive" } }] } : {}),
      ...(filter.accountId ? { targets: { some: { accountId: filter.accountId } } } : {}),
      ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    },
    orderBy: filter.view === "scheduled" ? [{ scheduledAt: "asc" }] : [{ updatedAt: "desc" }],
    take: Math.min(filter.take ?? 200, 1000),
    select: SUMMARY_SELECT,
  });
  return rows.map(summary);
}

/** Posts with a date (planned, scheduled or published) in the range, plus undated drafts when asked. */
export async function listCalendarPosts(filter: { from: Date; to: Date; accountId?: string; campaignId?: string; includeDrafts: boolean }): Promise<SocialPostSummary[]> {
  const rows = await prisma.socialPost.findMany({
    where: {
      ...(filter.accountId ? { targets: { some: { accountId: filter.accountId } } } : {}),
      ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
      ...(filter.includeDrafts ? {} : { status: { notIn: ["DRAFT", "CANCELLED"] } }),
      OR: [{ scheduledAt: { gte: filter.from, lt: filter.to } }, { scheduledAt: null, targets: { some: { publishedAt: { gte: filter.from, lt: filter.to } } } }],
    },
    orderBy: { scheduledAt: "asc" },
    take: 2000,
    select: SUMMARY_SELECT,
  });
  return rows.map(summary);
}

export async function socialStatusCounts(): Promise<Record<string, number>> {
  const grouped = await prisma.socialPost.groupBy({ by: ["status"], _count: { _all: true } });
  return Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
}

export async function getSocialPost(id: string) {
  const post = await prisma.socialPost.findFirst({
    where: { id },
    include: {
      campaign: { select: { id: true, name: true, color: true } },
      targets: {
        orderBy: { createdAt: "asc" },
        include: {
          account: { select: { id: true, platform: true, name: true, username: true, status: true, enabled: true } },
          publishAttempts: { orderBy: { attemptNo: "desc" }, take: 10 },
        },
      },
      events: { orderBy: { createdAt: "desc" }, take: 200 },
    },
  });
  if (!post) return null;
  const assets = post.mediaIds.length
    ? await prisma.socialMediaAsset.findMany({ where: { id: { in: post.mediaIds } }, select: { id: true, name: true, kind: true, mimeType: true, sizeBytes: true, deletedAt: true } })
    : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const media = post.mediaIds.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const problems = platformProblems(post.content, post.targets.map((t) => ({ platform: t.account.platform, accountName: t.account.name, override: t.contentOverride })), media);
  return { post, media, approvalMatches: Boolean(post.approvalHash) && post.approvalHash === materialHash(post), problems };
}

function platformProblems(content: string, targets: Array<{ platform: string; accountName: string; override: string | null }>, media: Array<{ kind: string; mimeType: string; sizeBytes: number; deletedAt?: Date | null }>): string[] {
  const usable = media.filter((m) => !m.deletedAt).map((m) => ({ kind: (m.kind === "VIDEO" ? "VIDEO" : "IMAGE") as SocialMediaKind, mimeType: m.mimeType, sizeBytes: m.sizeBytes }));
  const out: string[] = [];
  if (usable.length !== media.length) out.push("A file attached to this post was deleted from the media library.");
  for (const t of targets) {
    if (!isSocialPlatform(t.platform)) continue;
    for (const p of validateForPlatform(t.platform, { text: t.override ?? content, media: usable })) out.push(`${t.accountName}: ${p}`);
  }
  return [...new Set(out)];
}

// ── Writing a draft ─────────────────────────────────────────────────────────────────────────────

export interface SocialDraftWrite {
  id?: string;
  revision?: number;
  title: string | null;
  content: string;
  accountIds: string[];
  mediaIds: string[];
  variants: Record<string, string | null>;
  settings: Record<string, Record<string, unknown> | null>;
  publishMode: SocialPublishMode;
  scheduledAt: Date | null;
  timezone: string;
  campaignId: string | null;
  aiAssisted: boolean;
}

/**
 * Creates or changes a draft. Every account, file and campaign must be THIS project's (loaded through
 * the scoped client), and any change to an existing post returns it to DRAFT with its approval cleared.
 */
export async function saveSocialDraft(input: SocialDraftWrite, username: string, within?: Tx): Promise<{ id: string; warnings: string[] }> {
  if (within && input.id) throw new Error("saveSocialDraft: only a new draft can be made inside another transaction.");
  const db = within ?? prisma;
  const problems = validateSocialDraft({ content: input.content, accountIds: input.accountIds, mediaIds: input.mediaIds, variants: input.variants, settings: input.settings });
  if (problems.length) throw new SocialRefusal(problems.map((p) => p.message).join(" "));
  const accounts = await db.socialAccount.findMany({ where: { id: { in: input.accountIds } }, select: { id: true, platform: true, status: true, enabled: true, name: true } });
  const plan = planPublishAccounts(input.accountIds, accounts);
  if (!plan.ok) throw new SocialRefusal(plan.reason);
  const mediaIds = [...new Set(input.mediaIds)];
  const media = mediaIds.length ? await db.socialMediaAsset.findMany({ where: { id: { in: mediaIds }, deletedAt: null }, select: { id: true, kind: true, mimeType: true, sizeBytes: true } }) : [];
  if (media.length !== mediaIds.length) throw new SocialRefusal("A chosen file is not in this project's media library.");
  if (input.campaignId && !(await db.socialCampaign.findFirst({ where: { id: input.campaignId }, select: { id: true } }))) throw new SocialRefusal("That campaign does not exist in this project.");
  const accountIds = plan.accounts.map((a) => a.id);
  const byId = new Map(media.map((m) => [m.id, m]));
  const warnings = platformProblems(
    input.content,
    accounts.filter((a) => accountIds.includes(a.id)).map((a) => ({ platform: a.platform, accountName: a.name, override: input.variants[a.id] ?? null })),
    mediaIds.map((id) => byId.get(id)!),
  );
  const title = input.title?.trim().slice(0, 120) || null;
  const targetData = (accountId: string) => ({
    contentOverride: input.variants[accountId]?.trim() ? input.variants[accountId]! : null,
    settings: input.settings[accountId] ? (input.settings[accountId] as Prisma.InputJsonValue) : Prisma.DbNull,
  });

  if (!input.id) {
    // Inside the caller's transaction when given one (an RSS item and its draft commit together).
    const create = async (tx: Tx) => {
      const post = await tx.socialPost.create({
        data: {
          title,
          content: input.content,
          mediaIds,
          publishMode: input.publishMode,
          scheduledAt: input.scheduledAt,
          timezone: input.timezone,
          campaignId: input.campaignId,
          aiAssisted: input.aiAssisted,
          createdByUsername: username,
        },
        select: { id: true },
      });
      for (const accountId of accountIds) await tx.socialPostTarget.create({ data: { postId: post.id, accountId, ...targetData(accountId) } });
      await addPostEvent(tx, post.id, "CREATED", username, { accounts: accountIds.length, media: mediaIds.length, aiAssisted: input.aiAssisted });
      return post;
    };
    const created = within ? await create(within) : await prisma.$transaction(create);
    return { id: created.id, warnings };
  }

  const existing = await prisma.socialPost.findFirst({ where: { id: input.id }, select: { id: true, status: true, revision: true, aiAssisted: true } });
  if (!existing || !isSocialPostStatus(existing.status)) throw new SocialRefusal("That post no longer exists.");
  const decision = decideSocialTransition("EDIT", { status: existing.status, approvalMatches: false });
  if (!decision.ok) throw new SocialRefusal(decision.reason);
  if (input.revision !== undefined && input.revision !== existing.revision) throw new SocialRefusal(STALE);
  await prisma.$transaction(async (tx) => {
    const moved = await tx.socialPost.updateMany({
      where: { id: existing.id, revision: existing.revision, status: existing.status },
      data: {
        title,
        content: input.content,
        mediaIds,
        publishMode: input.publishMode,
        scheduledAt: input.scheduledAt,
        timezone: input.timezone,
        campaignId: input.campaignId,
        aiAssisted: existing.aiAssisted || input.aiAssisted,
        status: "DRAFT",
        approvalHash: null,
        approvedAt: null,
        approvedByUsername: null,
        submittedAt: null,
        submittedByUsername: null,
        lastError: null,
        updatedByUsername: username,
        revision: { increment: 1 },
      },
    });
    if (moved.count === 0) throw new SocialRefusal(STALE);
    const old = await tx.socialPostTarget.findMany({ where: { postId: existing.id }, select: { id: true, accountId: true } });
    const keep = new Set(accountIds);
    const removed = old.filter((t) => !keep.has(t.accountId));
    if (removed.length) await tx.socialPostTarget.deleteMany({ where: { id: { in: removed.map((t) => t.id) } } });
    for (const accountId of accountIds) {
      await tx.socialPostTarget.upsert({
        where: { postId_accountId: { postId: existing.id, accountId } },
        create: { postId: existing.id, accountId, ...targetData(accountId) },
        update: { ...targetData(accountId), status: "PENDING", dueAt: null, nextAttemptAt: null, claimToken: null, leaseExpiresAt: null, externalId: null, externalContainerIds: [], permalink: null, error: null, publishedAt: null },
      });
    }
    await addPostEvent(tx, existing.id, "EDITED", username, { from: existing.status, removedAccounts: removed.length });
  });
  return { id: existing.id, warnings };
}

// ── Post actions ────────────────────────────────────────────────────────────────────────────────

export interface SocialActionExtra {
  revision?: number;
  note?: string;
  reviewerUsername?: string | null;
  publishMode?: SocialPublishMode;
  scheduledAt?: Date | null;
  /** SCHEDULE only: also schedule copies of the approved post this many times at this interval. */
  repeat?: { every: SocialRepeatEvery; times: number } | null;
}

export async function applySocialAction(id: string, action: SocialAction, username: string, extra: SocialActionExtra = {}, now = new Date()): Promise<{ message: string; id?: string }> {
  const loaded = await getSocialPost(id);
  if (!loaded) throw new SocialRefusal("That post no longer exists.");
  const { post, approvalMatches, problems } = loaded;
  if (!isSocialPostStatus(post.status)) throw new SocialRefusal("This post can no longer be changed.");
  const status: SocialPostStatus = post.status;
  if (extra.revision !== undefined && extra.revision !== post.revision) throw new SocialRefusal(STALE);
  const startedTargets = post.targets.filter((t) => t.status !== "DUE" && t.status !== "PENDING" && t.status !== "CANCELLED").length;
  const decision = decideSocialTransition(action, { status, approvalMatches, startedTargets });
  if (!decision.ok) throw new SocialRefusal(decision.reason);

  const move = async (data: Prisma.SocialPostUpdateManyMutationInput, kind: string, detail?: Record<string, unknown>, more?: (tx: Tx) => Promise<void>) => {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.socialPost.updateMany({ where: { id, status, revision: post.revision }, data: { ...data, revision: { increment: 1 } } });
      if (moved.count === 0) throw new SocialRefusal(STALE);
      if (more) await more(tx);
      await addPostEvent(tx, id, kind, username, { from: status, to: data.status ?? status, ...(detail ?? {}) });
    });
  };

  switch (action) {
    case "SUBMIT": {
      const reviewer = extra.reviewerUsername?.trim().slice(0, 100) || null;
      await move({ status: "IN_REVIEW", submittedAt: now, submittedByUsername: username, reviewNote: null, reviewerUsername: reviewer }, "SUBMITTED", reviewer ? { reviewer } : undefined);
      return { message: reviewer ? `Sent to ${reviewer} for approval.` : "Sent for approval." };
    }
    case "APPROVE":
      if (problems.length) throw new SocialRefusal(`It cannot be approved yet: ${problems.join(" ")}`);
      await move(
        { status: "APPROVED", approvalHash: materialHash(post), approvedAt: now, approvedByUsername: username, reviewNote: extra.note?.trim().slice(0, 500) || null },
        "APPROVED",
        post.submittedByUsername === username || post.createdByUsername === username ? { ownPost: true } : undefined,
      );
      return { message: "Approved. Someone with publishing rights can now schedule it." };
    case "REJECT": {
      const note = extra.note?.trim();
      if (!note) throw new SocialRefusal("Say what needs to change.");
      await move({ status: "DRAFT", reviewNote: note.slice(0, 500), submittedAt: null, submittedByUsername: null }, "REJECTED", { note: note.slice(0, 500) });
      return { message: "Sent back to the writer with your note." };
    }
    case "SCHEDULE": {
      const mode: SocialPublishMode = extra.publishMode ?? (post.publishMode === "NOW" ? "NOW" : "SCHEDULE");
      const when = mode === "NOW" ? now : (extra.scheduledAt ?? post.scheduledAt);
      const timing = validateSchedule(mode, when, now);
      if (!timing.ok) throw new SocialRefusal(timing.reason);
      if (problems.length) throw new SocialRefusal(problems.join(" "));
      const plan = planPublishAccounts(
        post.targets.map((t) => t.accountId),
        post.targets.map((t) => ({ id: t.account.id, platform: t.account.platform, status: t.account.status, enabled: t.account.enabled })),
      );
      if (!plan.ok) throw new SocialRefusal(plan.reason);
      for (const t of post.targets) if (!adapterFor(t.account.platform)) throw new SocialRefusal(`${t.account.name}: publishing to this platform is not available.`);
      // Repeats: each later occurrence is its own scheduled post with the SAME approved material (so the
      // approval covers it), visible on the calendar and cancellable on its own.
      const repeats = mode === "SCHEDULE" && when && extra.repeat ? repeatTimes(when, post.timezone, extra.repeat.every, extra.repeat.times) : [];
      await move({ status: "SCHEDULED", publishMode: mode, scheduledAt: when, scheduledAtRequest: now, scheduledByUsername: username, lastError: null }, "SCHEDULED", { mode, at: when?.toISOString() ?? null, repeats: repeats.length }, async (tx) => {
        await tx.socialPostTarget.updateMany({
          where: { postId: id },
          data: { status: "DUE", dueAt: when, nextAttemptAt: null, attempts: 0, claimToken: null, leaseExpiresAt: null, externalId: null, externalContainerIds: [], permalink: null, error: null, publishedAt: null },
        });
        for (const [i, at] of repeats.entries()) {
          const copy = await tx.socialPost.create({
            data: {
              title: post.title ? `${post.title} (${i + 2})`.slice(0, 120) : null,
              content: post.content,
              mediaIds: post.mediaIds,
              status: "SCHEDULED",
              publishMode: "SCHEDULE",
              scheduledAt: at,
              timezone: post.timezone,
              campaignId: post.campaignId,
              aiAssisted: post.aiAssisted,
              createdByUsername: username,
              submittedAt: post.submittedAt,
              submittedByUsername: post.submittedByUsername,
              approvalHash: post.approvalHash,
              approvedAt: post.approvedAt,
              approvedByUsername: post.approvedByUsername,
              scheduledAtRequest: now,
              scheduledByUsername: username,
              duplicatedFromId: post.id,
            },
            select: { id: true },
          });
          for (const t of post.targets) {
            await tx.socialPostTarget.create({ data: { postId: copy.id, accountId: t.accountId, contentOverride: t.contentOverride, settings: t.settings ?? Prisma.DbNull, status: "DUE", dueAt: at } });
          }
          await addPostEvent(tx, copy.id, "SCHEDULED", username, { repeatOf: post.id, occurrence: i + 2, at: at.toISOString() });
        }
      });
      return { message: mode === "NOW" ? "Publishing now." : repeats.length ? `Scheduled, and ${repeats.length} repeat(s) after it.` : "Scheduled." };
    }
    case "CANCEL": {
      await prisma.$transaction(async (tx) => {
        const moved = await tx.socialPost.updateMany({ where: { id, status, revision: post.revision }, data: { revision: { increment: 1 } } });
        if (moved.count === 0) throw new SocialRefusal(STALE);
        await tx.socialPostTarget.updateMany({ where: { postId: id, status: { in: ["DUE", "PENDING"] } }, data: { status: "CANCELLED", nextAttemptAt: null } });
        if (status === "APPROVED" || status === "IN_REVIEW") await tx.socialPost.updateMany({ where: { id }, data: { status: "CANCELLED" } });
        else await settlePostStatus(tx, id);
        await addPostEvent(tx, id, "CANCELLED", username, { from: status, alreadyStarted: startedTargets });
      });
      return { message: startedTargets ? "Cancelled what had not started; the accounts already publishing or published are not affected." : "Cancelled." };
    }
    case "DELETE": {
      const removed = await prisma.socialPost.deleteMany({ where: { id, status, revision: post.revision } });
      if (removed.count === 0) throw new SocialRefusal(STALE);
      return { message: "Deleted." };
    }
    case "DUPLICATE": {
      const copy = await prisma.$transaction(async (tx) => {
        const created = await tx.socialPost.create({
          data: {
            title: post.title ? `${post.title} (copy)`.slice(0, 120) : null,
            content: post.content,
            mediaIds: post.mediaIds,
            publishMode: "SCHEDULE",
            timezone: post.timezone,
            campaignId: post.campaignId,
            aiAssisted: post.aiAssisted,
            createdByUsername: username,
            duplicatedFromId: post.id,
          },
          select: { id: true },
        });
        for (const t of post.targets) {
          if (t.account.status === "REMOVED") continue;
          await tx.socialPostTarget.create({ data: { postId: created.id, accountId: t.accountId, contentOverride: t.contentOverride, settings: t.settings ?? Prisma.DbNull } });
        }
        await addPostEvent(tx, created.id, "DUPLICATED", username, { from: post.id });
        return created;
      });
      return { message: "Copied as a new draft.", id: copy.id };
    }
    case "EDIT":
      throw new SocialRefusal("Edit the post with its form.");
  }
}

/** Moves a scheduled post that has not started on any account to a new time (calendar drag, or the form). */
export async function rescheduleSocialPost(id: string, at: Date, username: string, now = new Date()): Promise<void> {
  const post = await prisma.socialPost.findFirst({ where: { id }, select: { status: true, revision: true, scheduledAt: true, targets: { select: { status: true } } } });
  if (!post) throw new SocialRefusal("That post no longer exists.");
  if (post.status !== "SCHEDULED" || !post.targets.every((t) => t.status === "DUE" || t.status === "CANCELLED")) throw new SocialRefusal("Only a scheduled post that has not started publishing can be moved.");
  const timing = validateSchedule("SCHEDULE", at, now);
  if (!timing.ok) throw new SocialRefusal(timing.reason);
  await prisma.$transaction(async (tx) => {
    const moved = await tx.socialPost.updateMany({ where: { id, status: "SCHEDULED", revision: post.revision }, data: { scheduledAt: at, publishMode: "SCHEDULE", revision: { increment: 1 } } });
    if (moved.count === 0) throw new SocialRefusal(STALE);
    // Moving the waiting jobs locks their rows, so a publisher's claim either committed before this (and
    // is seen just below) or waits and then finds the job no longer due. A job that started publishing
    // in between refuses the whole move: one account must not post at the old time while the calendar
    // shows the new one.
    const targets = await tx.socialPostTarget.updateMany({ where: { postId: id, status: "DUE" }, data: { dueAt: at, nextAttemptAt: null } });
    const started = await tx.socialPostTarget.count({ where: { postId: id, status: { notIn: ["DUE", "CANCELLED"] } } });
    if (started > 0) throw new SocialRefusal("It started publishing on an account just now, so it was not moved.");
    await addPostEvent(tx, id, "RESCHEDULED", username, { from: post.scheduledAt?.toISOString() ?? null, to: at.toISOString(), accounts: targets.count });
  });
}

// ── Job (target) actions ────────────────────────────────────────────────────────────────────────

export async function applyTargetAction(
  targetId: string,
  action: SocialTargetAction | "DELETE_PUBLICATION",
  username: string,
  extra: { confirmedNotPublished?: boolean; permalink?: string | null; note?: string } = {},
  now = new Date(),
): Promise<{ message: string }> {
  const target = await prisma.socialPostTarget.findFirst({
    where: { id: targetId },
    include: { post: { include: { targets: { select: { accountId: true, contentOverride: true, settings: true } } } }, account: { select: { platform: true, name: true } } },
  });
  if (!target || !isSocialTargetStatus(target.status)) throw new SocialRefusal("That publication no longer exists.");
  const status: SocialTargetStatus = target.status;
  const approvalMatches = Boolean(target.post.approvalHash) && target.post.approvalHash === materialHash(target.post);

  if (action === "DELETE_PUBLICATION") {
    if (status !== "PUBLISHED" || !target.externalId) throw new SocialRefusal("Only a published post can be deleted from the platform.");
    const adapter = adapterFor(target.account.platform);
    if (!adapter?.deletePublication || !platformHas(target.account.platform, "DELETE")) throw new SocialRefusal(`${target.account.name}: the platform's API does not allow deleting a post.`);
    const account = await adapterAccount(target.accountId);
    if (!account.ok) throw new SocialRefusal(account.reason);
    const result = await adapter.deletePublication(account.account, target.externalId, { fetch });
    if (!result.ok) throw new SocialRefusal(result.message);
    await prisma.$transaction(async (tx) => {
      await tx.socialPostTarget.updateMany({ where: { id: targetId, status: "PUBLISHED" }, data: { status: "CANCELLED", error: `Deleted from the platform by ${username}.`, permalink: null } });
      await addPostEvent(tx, target.postId, "DELETED_FROM_PLATFORM", username, { account: target.account.name, externalId: target.externalId });
      await settlePostStatus(tx, target.postId);
    });
    return { message: "Deleted from the platform." };
  }

  const decision = decideTargetAction(action, { status, approvalMatches, confirmedNotPublished: extra.confirmedNotPublished });
  if (!decision.ok) throw new SocialRefusal(decision.reason);
  const data: Prisma.SocialPostTargetUpdateManyMutationInput = { status: decision.next };
  if (decision.next === "DUE") Object.assign(data, { dueAt: now, nextAttemptAt: null, claimToken: null, leaseExpiresAt: null, error: null, attempts: 0 });
  if (action === "MARK_PUBLISHED") {
    const link = extra.permalink?.trim();
    Object.assign(data, { publishedAt: now, error: null, ...(link && /^https:\/\//.test(link) ? { permalink: link.slice(0, 1000) } : {}) });
  }
  if (action === "MARK_FAILED") Object.assign(data, { error: `Marked as not published by ${username}.` });
  await prisma.$transaction(async (tx) => {
    const moved = await tx.socialPostTarget.updateMany({ where: { id: targetId, status }, data });
    if (moved.count === 0) throw new SocialRefusal(STALE);
    if (decision.next === "DUE" && target.post.status !== "SCHEDULED") {
      await tx.socialPost.updateMany({ where: { id: target.postId, status: target.post.status }, data: { status: "SCHEDULED" } });
    }
    await addPostEvent(tx, target.postId, action === "RETRY" ? "RETRY" : action === "SEND_AGAIN" ? "SEND_AGAIN" : action === "CANCEL" ? "CANCELLED" : "MARKED", username, {
      account: target.account.name,
      to: decision.next,
      ...(action === "SEND_AGAIN" ? { confirmedNotPublishedBy: username } : {}),
    });
    await settlePostStatus(tx, target.postId);
  });
  const messages: Record<SocialTargetAction, string> = {
    RETRY: "It will be tried again in a moment.",
    SEND_AGAIN: "It will be sent again in a moment.",
    MARK_PUBLISHED: "Recorded as published.",
    MARK_FAILED: "Recorded as not published.",
    CANCEL: "Cancelled for this account.",
  };
  return { message: messages[action] };
}

// ── Collaboration ───────────────────────────────────────────────────────────────────────────────

/** An internal comment on a post (never published). Kept in the post's append-only history. */
export async function addSocialComment(postId: string, text: string, username: string): Promise<void> {
  const body = text.trim();
  if (!body) throw new SocialRefusal("Write a comment first.");
  if (body.length > 2000) throw new SocialRefusal("Comments can be at most 2,000 characters.");
  const post = await prisma.socialPost.findFirst({ where: { id: postId }, select: { id: true } });
  if (!post) throw new SocialRefusal("That post no longer exists.");
  const mentions = [...new Set([...body.matchAll(/@([A-Za-z0-9_.-]{2,40})/g)].map((m) => m[1]!))].slice(0, 10);
  await addPostEvent(prisma, postId, "COMMENT", username, { text: body, ...(mentions.length ? { mentions } : {}) });
}
