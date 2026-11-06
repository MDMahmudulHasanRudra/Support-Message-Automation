import type { Prisma } from "@prisma/client";
import {
  decideFollowUpAction,
  followUpAttentionCutoff,
  followUpBucket,
  followUpBucketRange,
  isConversationPriority,
  type ConversationPriorityValue,
  type ConversationRef,
  type FollowUpAction,
  type FollowUpBucket,
  type FollowUpEventKind,
  type FollowUpFields,
  type FollowUpStatusValue,
  type FollowUpView,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { hasPermission } from "@/server/permissions";
import type { Session } from "@/server/auth";

/**
 * Follow-ups (FOLLOW_UPS.md, feature FOLLOW_UPS): plain helpers. The Server Actions in
 * server/actions/followUps.ts check the permission and the feature first.
 *
 * Every query goes through the project-scoped client, so another project's follow-up, conversation,
 * client, person's Team or account is simply not found. Every change is a conditional update on the state
 * it read, with its FollowUpEvent in the same transaction: a double click, or two people at once, give one
 * change and one event, and the loser is told it changed meanwhile. Nothing here sends anything.
 */

export class FollowUpChangeError extends Error {}

const CHANGED = "This follow-up was changed by someone else meanwhile. Reload and try again.";

/** What a follow-up is about: a conversation (one of two shapes) and/or a client. */
export interface FollowUpLink {
  conversation: ConversationRef | null;
  clientId: string | null;
}

export interface FollowUpRow {
  id: string;
  title: string;
  note: string | null;
  dueAt: string;
  priority: ConversationPriorityValue;
  status: FollowUpStatusValue;
  bucket: FollowUpBucket;
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignedTeamId: string | null;
  assignedTeamName: string | null;
  createdByName: string | null;
  completedAt: string | null;
  completedByName: string | null;
  /** The conversation it is about, with where to open it. Null when it is about none (or it is hidden). */
  conversation: { kind: "whatsapp" | "channel"; label: string; href: string } | null;
  /** The client it is about — only for a viewer who may see clients. */
  client: { id: string; name: string; code: string } | null;
  /** Which reply key changing it needs: the conversation's module's, or either when it has none. */
  linkKind: "whatsapp" | "channel" | "none";
}

/** The short form the conversation side panel lists. */
export interface ConversationFollowUp {
  id: string;
  title: string;
  dueAt: string;
  priority: ConversationPriorityValue;
  bucket: FollowUpBucket;
  assigneeName: string | null;
  teamName: string | null;
}

const ROW_SELECT = {
  id: true,
  title: true,
  note: true,
  dueAt: true,
  priority: true,
  status: true,
  assignedUserId: true,
  assignedTeamId: true,
  accountId: true,
  chatId: true,
  channelConversationId: true,
  clientId: true,
  completedAt: true,
  assignedUser: { select: { name: true } },
  assignedTeam: { select: { name: true } },
  createdBy: { select: { name: true } },
  completedBy: { select: { name: true } },
} as const;

type RawRow = Prisma.FollowUpGetPayload<{ select: typeof ROW_SELECT }>;

/** The Teams a login belongs to here: through its roster member (InternalTeamMember.userId). */
export async function teamsOfUser(userId: string): Promise<string[]> {
  const members = await prisma.internalTeamMember.findMany({ where: { userId, status: "ACTIVE", teamId: { not: null } }, select: { teamId: true } });
  return [...new Set(members.map((m) => m.teamId!))];
}

/**
 * "Mine": open follow-ups assigned to me; or to one of my Teams with no person yet; or that I wrote for
 * myself (no person, no Team).
 */
export function mineWhere(userId: string, teamIds: readonly string[]): Prisma.FollowUpWhereInput {
  return {
    status: "OPEN",
    OR: [
      { assignedUserId: userId },
      ...(teamIds.length ? [{ assignedUserId: null, assignedTeamId: { in: [...teamIds] } }] : []),
      { assignedUserId: null, assignedTeamId: null, createdById: userId },
    ],
  };
}

export interface FollowUpFilters {
  /** A user id, "me", "none" (no person) or null (anyone). */
  assignee: string | null;
  /** A Team id, "none" or null. */
  team: string | null;
  priority: ConversationPriorityValue | null;
}

export function readFollowUpFilters(params: { assignee?: string | null; team?: string | null; priority?: string | null }): FollowUpFilters {
  const clean = (v: string | null | undefined) => (v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
  return {
    assignee: clean(params.assignee),
    team: clean(params.team),
    priority: isConversationPriority(params.priority) ? params.priority : null,
  };
}

function filterWhere(filters: FollowUpFilters, userId: string): Prisma.FollowUpWhereInput[] {
  const and: Prisma.FollowUpWhereInput[] = [];
  if (filters.assignee) and.push({ assignedUserId: filters.assignee === "none" ? null : filters.assignee === "me" ? userId : filters.assignee });
  if (filters.team) and.push({ assignedTeamId: filters.team === "none" ? null : filters.team });
  if (filters.priority) and.push({ priority: filters.priority });
  return and;
}

/** The `where` of one tab, with the filters on top. Pure apart from the Teams lookup for "Mine". */
export async function viewWhere(view: FollowUpView, filters: FollowUpFilters, userId: string, now: Date): Promise<Prisma.FollowUpWhereInput> {
  const and = filterWhere(filters, userId);
  switch (view) {
    case "MINE":
      and.push(mineWhere(userId, await teamsOfUser(userId)));
      break;
    case "TEAM":
      and.push({ status: "OPEN" });
      break;
    case "OVERDUE":
    case "DUE_TODAY":
    case "UPCOMING":
      and.push({ status: "OPEN", dueAt: followUpBucketRange(view, now) });
      break;
    case "DONE":
      and.push({ status: "DONE" });
      break;
    case "DISCARDED":
      and.push({ status: "DISCARDED" });
      break;
  }
  return { AND: and };
}

const PAGE_SIZE = 200;

export async function listFollowUps(
  session: Session,
  view: FollowUpView,
  filters: FollowUpFilters,
  now: Date,
): Promise<{ rows: FollowUpRow[]; truncated: boolean; counts: Record<FollowUpView, number> }> {
  const where = await viewWhere(view, filters, session.userId, now);
  const closed = view === "DONE" || view === "DISCARDED";
  const raw = await prisma.followUp.findMany({
    where,
    // Open work: soonest first (overdue on top). Closed lists: most recently closed first.
    orderBy: closed ? [{ completedAt: "desc" }, { id: "desc" }] : [{ dueAt: "asc" }, { id: "asc" }],
    take: PAGE_SIZE + 1,
    select: ROW_SELECT,
  });
  const views: FollowUpView[] = ["MINE", "TEAM", "OVERDUE", "DUE_TODAY", "UPCOMING", "DONE", "DISCARDED"];
  const countList = await Promise.all(views.map(async (v) => prisma.followUp.count({ where: await viewWhere(v, filters, session.userId, now) })));
  const counts = Object.fromEntries(views.map((v, i) => [v, countList[i]!])) as Record<FollowUpView, number>;
  return { rows: await toRows(session, raw.slice(0, PAGE_SIZE), now), truncated: raw.length > PAGE_SIZE, counts };
}

/** The reminder badge: my open follow-ups due before the next Dhaka midnight (overdue + due today). */
export async function countMyAttention(session: Session, now: Date): Promise<{ overdue: number; dueToday: number }> {
  const mine = mineWhere(session.userId, await teamsOfUser(session.userId));
  const [overdue, dueToday] = await Promise.all([
    prisma.followUp.count({ where: { AND: [mine, { dueAt: { lt: now } }] } }),
    prisma.followUp.count({ where: { AND: [mine, { dueAt: { gte: now, lt: followUpAttentionCutoff(now) } }] } }),
  ]);
  return { overdue, dueToday };
}

/** Open follow-ups about one conversation, soonest first — the side panel's list. */
export async function loadConversationFollowUps(ref: ConversationRef, now = new Date()): Promise<ConversationFollowUp[]> {
  const rows = await prisma.followUp.findMany({
    where: { status: "OPEN", ...(ref.kind === "whatsapp" ? { accountId: ref.accountId, chatId: ref.chatId } : { channelConversationId: ref.conversationId }) },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: 30,
    select: { id: true, title: true, dueAt: true, priority: true, status: true, assignedUser: { select: { name: true } }, assignedTeam: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    dueAt: r.dueAt.toISOString(),
    priority: r.priority,
    bucket: followUpBucket(r, now),
    assigneeName: r.assignedUser?.name ?? null,
    teamName: r.assignedTeam?.name ?? null,
  }));
}

/** Open follow-ups about one client, soonest first — the client profile's list. */
export async function loadClientFollowUps(clientId: string, now = new Date()): Promise<ConversationFollowUp[]> {
  const rows = await prisma.followUp.findMany({
    where: { status: "OPEN", clientId },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: 30,
    select: { id: true, title: true, dueAt: true, priority: true, status: true, assignedUser: { select: { name: true } }, assignedTeam: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    dueAt: r.dueAt.toISOString(),
    priority: r.priority,
    bucket: followUpBucket(r, now),
    assigneeName: r.assignedUser?.name ?? null,
    teamName: r.assignedTeam?.name ?? null,
  }));
}

export function linkKindOf(row: { accountId: string | null; channelConversationId: string | null }): "whatsapp" | "channel" | "none" {
  return row.accountId ? "whatsapp" : row.channelConversationId ? "channel" : "none";
}

async function toRows(session: Session, raw: RawRow[], now: Date): Promise<FollowUpRow[]> {
  if (raw.length === 0) return [];
  const disabled = await activeDisabledFeatures();
  const showClients = !disabled.has("CLIENT_CENTER") && (await hasPermission(session, "clients.view"));
  const groupChats = raw.filter((r) => r.accountId && r.chatId?.endsWith("@g.us"));
  const personalChats = raw.filter((r) => r.accountId && r.chatId && !r.chatId.endsWith("@g.us"));
  const channelIds = [...new Set(raw.flatMap((r) => (r.channelConversationId ? [r.channelConversationId] : [])))];
  const clientIds = [...new Set(raw.flatMap((r) => (r.clientId ? [r.clientId] : [])))];
  const [groups, personal, channels, clients] = await Promise.all([
    groupChats.length && !disabled.has("WHATSAPP_CHAT")
      ? prisma.whatsAppGroup.findMany({
          where: { OR: groupChats.map((r) => ({ accountId: r.accountId!, whatsappGroupId: r.chatId! })) },
          select: { id: true, accountId: true, whatsappGroupId: true, name: true },
        })
      : [],
    personalChats.length && !disabled.has("WHATSAPP_CHAT")
      ? Promise.all(
          personalChats.map((r) =>
            prisma.message.findFirst({
              where: { accountId: r.accountId!, chatId: r.chatId!, groupId: null, direction: "INCOMING", senderName: { not: null } },
              orderBy: { timestampWa: "desc" },
              select: { accountId: true, chatId: true, senderName: true },
            }),
          ),
        )
      : [],
    channelIds.length && !disabled.has("OMNICHANNEL")
      ? prisma.channelConversation.findMany({ where: { id: { in: channelIds } }, select: { id: true, type: true, title: true, customerName: true, customerUsername: true } })
      : [],
    clientIds.length && showClients ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, code: true } }) : [],
  ]);
  const groupBy = new Map(groups.map((g) => [`${g.accountId}|${g.whatsappGroupId}`, g]));
  const personalBy = new Map(personal.flatMap((m) => (m ? [[`${m.accountId}|${m.chatId}`, m.senderName] as const] : [])));
  const channelBy = new Map(channels.map((c) => [c.id, c]));
  const clientBy = new Map(clients.map((c) => [c.id, c]));

  return raw.map((r) => {
    let conversation: FollowUpRow["conversation"] = null;
    if (r.accountId && r.chatId && !disabled.has("WHATSAPP_CHAT")) {
      if (r.chatId.endsWith("@g.us")) {
        const g = groupBy.get(`${r.accountId}|${r.chatId}`);
        if (g) conversation = { kind: "whatsapp", label: g.name, href: `/chat/account/${r.accountId}/${g.id}` };
      } else {
        const name = personalBy.get(`${r.accountId}|${r.chatId}`);
        conversation = { kind: "whatsapp", label: name ? `${name} (personal chat)` : "Personal chat", href: `/chat/account/${r.accountId}/personal/${encodeURIComponent(r.chatId)}` };
      }
    } else if (r.channelConversationId) {
      const c = channelBy.get(r.channelConversationId);
      if (c) conversation = { kind: "channel", label: c.customerName ?? c.title ?? c.customerUsername ?? "Conversation", href: `/conversations/all/c/${c.id}` };
    }
    const client = r.clientId ? (clientBy.get(r.clientId) ?? null) : null;
    return {
      id: r.id,
      title: r.title,
      note: r.note,
      dueAt: r.dueAt.toISOString(),
      priority: r.priority,
      status: r.status,
      bucket: followUpBucket(r, now),
      assignedUserId: r.assignedUserId,
      assignedUserName: r.assignedUser?.name ?? null,
      assignedTeamId: r.assignedTeamId,
      assignedTeamName: r.assignedTeam?.name ?? null,
      createdByName: r.createdBy?.name ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      completedByName: r.completedBy?.name ?? null,
      conversation,
      client,
      linkKind: linkKindOf(r),
    };
  });
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────────────

export interface FollowUpOwner {
  assignedUserId: string | null;
  assignedTeamId: string | null;
}

interface Actor {
  userId: string;
  name: string;
}

function event(followUpId: string, projectId: string, actor: Actor, kind: FollowUpEventKind, fromValue: string | null, toValue: string | null) {
  return { projectId, followUpId, kind, fromValue, toValue, actorUserId: actor.userId, actorName: actor.name };
}

export async function createFollowUpRow(fields: FollowUpFields, owner: FollowUpOwner, link: FollowUpLink, actor: Actor): Promise<string> {
  const projectId = await activeProjectId();
  const conversation = link.conversation;
  return prisma.$transaction(async (tx) => {
    const row = await tx.followUp.create({
      data: {
        projectId,
        title: fields.title,
        note: fields.note,
        dueAt: fields.dueAt,
        priority: fields.priority,
        assignedUserId: owner.assignedUserId,
        assignedTeamId: owner.assignedTeamId,
        accountId: conversation?.kind === "whatsapp" ? conversation.accountId : null,
        chatId: conversation?.kind === "whatsapp" ? conversation.chatId : null,
        channelConversationId: conversation?.kind === "channel" ? conversation.conversationId : null,
        clientId: link.clientId,
        createdById: actor.userId,
      },
      select: { id: true },
    });
    await tx.followUpEvent.create({ data: event(row.id, projectId, actor, "CREATED", null, fields.dueAt.toISOString()) });
    return row.id;
  });
}

/**
 * Edits an OPEN follow-up. The update is conditional on the row still being exactly as read (status and
 * `updatedAt`), and the history says what moved: RESCHEDULED (due time), REASSIGNED (person or Team),
 * EDITED (title, note, priority). Nothing changed = nothing written.
 */
export async function editFollowUpRow(id: string, fields: FollowUpFields, owner: FollowUpOwner, actor: Actor): Promise<{ changed: boolean }> {
  const projectId = await activeProjectId();
  return prisma.$transaction(async (tx) => {
    const current = await tx.followUp.findFirst({
      where: { id },
      select: { status: true, updatedAt: true, title: true, note: true, dueAt: true, priority: true, assignedUserId: true, assignedTeamId: true },
    });
    if (!current) throw new FollowUpChangeError("That follow-up could not be found.");
    if (current.status !== "OPEN") throw new FollowUpChangeError("Only an open follow-up can be edited. Reopen it first.");
    const events: ReturnType<typeof event>[] = [];
    if (current.dueAt.getTime() !== fields.dueAt.getTime()) events.push(event(id, projectId, actor, "RESCHEDULED", current.dueAt.toISOString(), fields.dueAt.toISOString()));
    if (current.assignedUserId !== owner.assignedUserId || current.assignedTeamId !== owner.assignedTeamId) {
      events.push(event(id, projectId, actor, "REASSIGNED", ownerValue(current), ownerValue(owner)));
    }
    if (current.title !== fields.title || current.note !== fields.note || current.priority !== fields.priority) events.push(event(id, projectId, actor, "EDITED", null, null));
    if (events.length === 0) return { changed: false };
    const moved = await tx.followUp.updateMany({
      where: { id, status: "OPEN", updatedAt: current.updatedAt },
      data: { title: fields.title, note: fields.note, dueAt: fields.dueAt, priority: fields.priority, assignedUserId: owner.assignedUserId, assignedTeamId: owner.assignedTeamId },
    });
    if (moved.count === 0) throw new FollowUpChangeError(CHANGED);
    await tx.followUpEvent.createMany({ data: events });
    return { changed: true };
  });
}

/** "user:<id>|team:<id>" — what REASSIGNED records (ids, never names: names are resolved when shown). */
function ownerValue(o: FollowUpOwner): string | null {
  if (!o.assignedUserId && !o.assignedTeamId) return null;
  return [o.assignedUserId ? `user:${o.assignedUserId}` : null, o.assignedTeamId ? `team:${o.assignedTeamId}` : null].filter(Boolean).join("|");
}

/** Done / discard / reopen: a conditional update on the status read, with its event. */
export async function changeFollowUpStatus(id: string, action: FollowUpAction, actor: Actor): Promise<FollowUpStatusValue> {
  const projectId = await activeProjectId();
  return prisma.$transaction(async (tx) => {
    const current = await tx.followUp.findFirst({ where: { id }, select: { status: true } });
    if (!current) throw new FollowUpChangeError("That follow-up could not be found.");
    const decision = decideFollowUpAction(current.status, action);
    if (!decision) {
      throw new FollowUpChangeError(
        action === "REOPEN" ? "This follow-up is already open." : current.status === "DONE" ? "This follow-up is already done." : "This follow-up is already closed.",
      );
    }
    const closing = decision.to !== "OPEN";
    const now = new Date();
    const moved = await tx.followUp.updateMany({
      where: { id, status: current.status },
      data: { status: decision.to, completedAt: closing ? now : null, completedById: closing ? actor.userId : null },
    });
    if (moved.count === 0) throw new FollowUpChangeError(CHANGED);
    await tx.followUpEvent.create({ data: event(id, projectId, actor, decision.event, current.status, decision.to) });
    return decision.to;
  });
}

export interface FollowUpHistoryEntry {
  id: string;
  kind: string;
  from: string | null;
  to: string | null;
  actorName: string | null;
  at: string;
}

export async function loadFollowUpHistory(id: string): Promise<FollowUpHistoryEntry[]> {
  const rows = await prisma.followUpEvent.findMany({
    where: { followUpId: id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, kind: true, fromValue: true, toValue: true, actorName: true, createdAt: true },
  });
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "REASSIGNED") continue;
    for (const v of [r.fromValue, r.toValue]) for (const part of v?.split("|") ?? []) ids.add(part);
  }
  const userIds = [...ids].filter((p) => p.startsWith("user:")).map((p) => p.slice(5));
  const teamIds = [...ids].filter((p) => p.startsWith("team:")).map((p) => p.slice(5));
  const [users, teams] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    teamIds.length ? prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } }) : [],
  ]);
  const names = new Map<string, string>([...users.map((u) => [`user:${u.id}`, u.name] as const), ...teams.map((t) => [`team:${t.id}`, `${t.name} (Team)`] as const)]);
  const describe = (kind: string, v: string | null) => {
    if (v === null) return kind === "REASSIGNED" ? "nobody" : null;
    if (kind === "REASSIGNED") return v.split("|").map((p) => names.get(p) ?? "someone no longer here").join(", ");
    return v;
  };
  return rows.map((r) => ({ id: r.id, kind: r.kind, from: describe(r.kind, r.fromValue), to: describe(r.kind, r.toValue), actorName: r.actorName, at: r.createdAt.toISOString() }));
}
