import { Prisma } from "@prisma/client";
import {
  channelStatusOf,
  channelStorageOf,
  decideTransition,
  DEFAULT_LIFECYCLE_POLICY,
  whatsAppConversationType,
  type ConversationRef,
  type ConversationStatus,
  type LifecyclePolicy,
  type LifecycleRequest,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";

/**
 * Unified Inbox V3 — conversation lifecycle for the dashboard (packages/shared conversationLifecycle.ts,
 * feature UNIFIED_INBOX_V3). Plain helpers; the Server Actions in server/actions/inboxLifecycle.ts check the
 * permission and the feature first.
 *
 * A WhatsApp conversation's state lives in `WhatsAppConversationState`, created the first time somebody acts
 * on the chat (no row = OPEN, unassigned). A channel conversation's lives on `ChannelConversation` (CLOSED =
 * RESOLVED). Every change is a conditional update on the state it read, with its `ConversationEvent` in the
 * same transaction: a double click, two agents at once, or the worker reopening it meanwhile give one change
 * and one event, and the loser is told the conversation changed. Every query goes through the project-scoped
 * client, so another project's conversation is simply not found.
 */

export interface ConversationLifecycleView {
  status: ConversationStatus;
  snoozedUntil: Date | null;
  statusChangedAt: Date | null;
  assignedUserId: string | null;
  assignedTeamId: string | null;
  resolutionNote: string | null;
}

export class LifecycleChangeError extends Error {}

const DEFAULT_VIEW: ConversationLifecycleView = { status: "OPEN", snoozedUntil: null, statusChangedAt: null, assignedUserId: null, assignedTeamId: null, resolutionNote: null };

export async function loadLifecycle(ref: ConversationRef): Promise<ConversationLifecycleView> {
  if (ref.kind === "whatsapp") {
    const row = await prisma.whatsAppConversationState.findFirst({
      where: { accountId: ref.accountId, chatId: ref.chatId },
      select: { status: true, snoozedUntil: true, statusChangedAt: true, assignedUserId: true, assignedTeamId: true, resolutionNote: true },
    });
    return row ?? DEFAULT_VIEW;
  }
  const c = await prisma.channelConversation.findFirst({
    where: { id: ref.conversationId },
    select: { status: true, snoozedUntil: true, statusChangedAt: true, assignedUserId: true, assignedTeamId: true },
  });
  if (!c) return DEFAULT_VIEW;
  return { status: channelStatusOf(c.status), snoozedUntil: c.snoozedUntil, statusChangedAt: c.statusChangedAt, assignedUserId: c.assignedUserId, assignedTeamId: c.assignedTeamId, resolutionNote: null };
}

export async function loadLifecyclePolicy(): Promise<LifecyclePolicy> {
  const row = await prisma.inboxLifecycleSettings.findFirst({ select: { reopenResolvedOnCustomerMessage: true, reopenSnoozedOnCustomerMessage: true } });
  return row ?? DEFAULT_LIFECYCLE_POLICY;
}

export async function saveLifecyclePolicy(policy: LifecyclePolicy, actorId: string): Promise<void> {
  const projectId = await activeProjectId();
  await prisma.inboxLifecycleSettings.upsert({
    where: { projectId },
    create: { projectId, ...policy, updatedById: actorId },
    update: { ...policy, updatedById: actorId },
  });
}

const isUnique = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
const CHANGED = "This conversation changed meanwhile. Reload to see where it is now.";

/** Moves a conversation's status, as a person asked. Throws LifecycleChangeError with the sentence to show. */
export async function changeConversationStatus(ref: ConversationRef, request: LifecycleRequest, actorId: string, note: string | null = null, now = new Date()): Promise<ConversationStatus> {
  const projectId = await activeProjectId();
  const current = await loadLifecycle(ref);
  const decision = decideTransition(current.status, request, now);
  if (!decision.ok) throw new LifecycleChangeError(decision.reason);
  const resolving = decision.to === "RESOLVED";
  const context: Prisma.InputJsonValue | undefined = decision.snoozedUntil ? { snoozedUntil: decision.snoozedUntil.toISOString() } : resolving && note ? { hasNote: true } : undefined;

  if (ref.kind === "whatsapp") {
    const type = whatsAppConversationType(ref.chatId);
    if (!type) throw new LifecycleChangeError("That conversation could not be found.");
    const data = {
      status: decision.to,
      snoozedUntil: decision.snoozedUntil,
      statusChangedAt: now,
      resolvedAt: resolving ? now : null,
      resolvedById: resolving ? actorId : null,
      resolutionNote: resolving ? note : null,
    };
    await prisma.$transaction(async (tx) => {
      const existing = await tx.whatsAppConversationState.findFirst({ where: { accountId: ref.accountId, chatId: ref.chatId }, select: { id: true, status: true } });
      if (existing) {
        if (existing.status !== current.status) throw new LifecycleChangeError(CHANGED);
        const moved = await tx.whatsAppConversationState.updateMany({ where: { id: existing.id, status: current.status }, data });
        if (moved.count === 0) throw new LifecycleChangeError(CHANGED);
      } else {
        try {
          await tx.whatsAppConversationState.create({ data: { projectId, accountId: ref.accountId, chatId: ref.chatId, conversationType: type, ...data } });
        } catch (err) {
          if (isUnique(err)) throw new LifecycleChangeError(CHANGED);
          throw err;
        }
      }
      await tx.conversationEvent.create({
        data: { projectId, accountId: ref.accountId, chatId: ref.chatId, kind: decision.event, fromValue: current.status, toValue: decision.to, actorId, context },
      });
    });
    return decision.to;
  }

  await prisma.$transaction(async (tx) => {
    const moved = await tx.channelConversation.updateMany({
      where: { id: ref.conversationId, status: channelStorageOf(current.status) },
      data: {
        status: channelStorageOf(decision.to),
        snoozedUntil: decision.snoozedUntil,
        statusChangedAt: now,
        closedAt: resolving ? now : null,
        resolvedById: resolving ? actorId : null,
      },
    });
    if (moved.count === 0) throw new LifecycleChangeError(CHANGED);
    await tx.conversationEvent.create({
      data: { projectId, channelConversationId: ref.conversationId, kind: decision.event, fromValue: current.status, toValue: decision.to, actorId, context },
    });
  });
  return decision.to;
}

/**
 * Assigns a WhatsApp conversation to a person and/or a Team (channel conversations keep their existing
 * assign functions). `undefined` leaves that side as it is; `null` clears it. Records ASSIGNEE / TEAM events
 * for what actually changed. The caller has already checked the person and the Team belong to this project.
 */
export async function assignWhatsAppConversation(
  ref: Extract<ConversationRef, { kind: "whatsapp" }>,
  change: { userId?: string | null; teamId?: string | null },
  actorId: string,
): Promise<void> {
  const projectId = await activeProjectId();
  const type = whatsAppConversationType(ref.chatId);
  if (!type) throw new LifecycleChangeError("That conversation could not be found.");
  await prisma.$transaction(async (tx) => {
    const existing = await tx.whatsAppConversationState.findFirst({
      where: { accountId: ref.accountId, chatId: ref.chatId },
      select: { id: true, assignedUserId: true, assignedTeamId: true },
    });
    const before = { userId: existing?.assignedUserId ?? null, teamId: existing?.assignedTeamId ?? null };
    const after = { userId: change.userId === undefined ? before.userId : change.userId, teamId: change.teamId === undefined ? before.teamId : change.teamId };
    if (before.userId === after.userId && before.teamId === after.teamId) return;
    if (existing) {
      const moved = await tx.whatsAppConversationState.updateMany({
        where: { id: existing.id, assignedUserId: before.userId, assignedTeamId: before.teamId },
        data: { assignedUserId: after.userId, assignedTeamId: after.teamId },
      });
      if (moved.count === 0) throw new LifecycleChangeError(CHANGED);
    } else {
      try {
        await tx.whatsAppConversationState.create({
          data: { projectId, accountId: ref.accountId, chatId: ref.chatId, conversationType: type, assignedUserId: after.userId, assignedTeamId: after.teamId },
        });
      } catch (err) {
        if (isUnique(err)) throw new LifecycleChangeError(CHANGED);
        throw err;
      }
    }
    const base = { projectId, accountId: ref.accountId, chatId: ref.chatId, actorId };
    if (before.userId !== after.userId) await tx.conversationEvent.create({ data: { ...base, kind: "ASSIGNEE", fromValue: before.userId, toValue: after.userId } });
    if (before.teamId !== after.teamId) await tx.conversationEvent.create({ data: { ...base, kind: "TEAM", fromValue: before.teamId, toValue: after.teamId } });
  });
}

export interface LifecycleEventView {
  id: string;
  kind: string;
  fromValue: string | null;
  toValue: string | null;
  context: unknown;
  actorName: string | null;
  createdAt: Date;
}

/** The newest history of one conversation (both the older STATUS/ASSIGNEE/TEAM rows and the V3 kinds). */
export async function loadConversationEvents(ref: ConversationRef, take = 30): Promise<LifecycleEventView[]> {
  const rows = await prisma.conversationEvent.findMany({
    where: ref.kind === "whatsapp" ? { accountId: ref.accountId, chatId: ref.chatId } : { channelConversationId: ref.conversationId },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, kind: true, fromValue: true, toValue: true, context: true, createdAt: true, actor: { select: { name: true } } },
  });
  return rows.map((r) => ({ id: r.id, kind: r.kind, fromValue: r.fromValue, toValue: r.toValue, context: r.context, actorName: r.actor?.name ?? null, createdAt: r.createdAt }));
}
