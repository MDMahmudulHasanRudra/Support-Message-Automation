import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  CONVERSATION_PRIORITY_LABEL,
  DEFAULT_TICKET_CATEGORIES,
  DEFAULT_TICKET_TARGETS,
  decideTicketMove,
  formatDhakaDateTimeInput,
  formatTicketNumber,
  isConversationPriority,
  isTicketStatus,
  parseTicketNumber,
  TICKET_ACTIVE_STATUSES,
  TICKET_FINISHED_STATUSES,
  TICKET_STATUS_LABEL,
  TICKET_VIEWS,
  ticketClock,
  ticketDueFrom,
  type ConversationPriorityValue,
  type ConversationRef,
  type TicketClockTone,
  type TicketEventKind,
  type TicketFields,
  type TicketStatusValue,
  type TicketTargets,
  type TicketView,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { resolveConversationLinks, teamsOfUser, linkKindOf } from "@/server/followUps";
import type { Session } from "@/server/auth";

/**
 * Support tickets (TICKETS.md, feature TICKETS): plain helpers. The Server Actions in server/actions/tickets.ts check
 * the permission and the feature first.
 *
 * Every query goes through the project-scoped client, so another project's ticket, conversation, client, person's Team
 * or account is simply not found. Every change is a conditional update on what it read, with its TicketEvent in the same
 * transaction: a double click, or two people at once, give one change and one event, and the loser is told. Nothing
 * here sends anything.
 */

export class TicketChangeError extends Error {}

const CHANGED = "This ticket was changed by someone else meanwhile. Reload and try again.";

const ROW_SELECT = {
  id: true,
  number: true,
  subject: true,
  status: true,
  priority: true,
  category: true,
  dueAt: true,
  resolvedAt: true,
  updatedAt: true,
  createdAt: true,
  assignedUserId: true,
  assignedTeamId: true,
  accountId: true,
  chatId: true,
  channelConversationId: true,
  clientId: true,
  assignedUser: { select: { name: true } },
  assignedTeam: { select: { name: true } },
} satisfies Prisma.TicketSelect;

type RawRow = Prisma.TicketGetPayload<{ select: typeof ROW_SELECT }>;

export interface TicketRow {
  id: string;
  number: number;
  label: string;
  subject: string;
  status: TicketStatusValue;
  priority: ConversationPriorityValue;
  category: string | null;
  dueAt: string | null;
  clock: { tone: TicketClockTone; text: string };
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignedTeamId: string | null;
  assignedTeamName: string | null;
  conversation: { kind: "whatsapp" | "channel"; label: string; href: string } | null;
  client: { id: string; name: string; code: string } | null;
  linkKind: "whatsapp" | "channel" | "none";
  updatedAt: string;
}

/** The short form the conversation panel and the client profile list. */
export interface TicketSummary {
  id: string;
  number: number;
  label: string;
  subject: string;
  status: TicketStatusValue;
  priority: ConversationPriorityValue;
  clock: { tone: TicketClockTone; text: string };
  assigneeName: string | null;
}

export interface TicketConfig extends TicketTargets {
  categories: string[];
}

export async function loadTicketConfig(): Promise<TicketConfig> {
  const row = await prisma.ticketSettings.findFirst({ select: { urgentHours: true, highHours: true, normalHours: true, lowHours: true, categories: true } });
  return row ?? { ...DEFAULT_TICKET_TARGETS, categories: DEFAULT_TICKET_CATEGORIES };
}

export async function saveTicketConfig(targets: TicketTargets, categories: string[]): Promise<void> {
  const projectId = await activeProjectId();
  await prisma.ticketSettings.upsert({ where: { projectId }, create: { projectId, ...targets, categories }, update: { ...targets, categories } });
}

// ── Reading ──────────────────────────────

export interface TicketFilters {
  assignee: string | null;
  team: string | null;
  priority: ConversationPriorityValue | null;
  status: TicketStatusValue | null;
  q: string;
}

export function readTicketFilters(params: Record<string, string | undefined>): TicketFilters {
  const clean = (v: string | undefined) => (v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
  return {
    assignee: clean(params.assignee),
    team: clean(params.team),
    priority: isConversationPriority(params.priority) ? params.priority : null,
    status: isTicketStatus(params.status) ? params.status : null,
    q: (params.q ?? "").trim().slice(0, 100),
  };
}

function filterWhere(filters: TicketFilters, userId: string): Prisma.TicketWhereInput[] {
  const and: Prisma.TicketWhereInput[] = [];
  if (filters.assignee) and.push({ assignedUserId: filters.assignee === "none" ? null : filters.assignee === "me" ? userId : filters.assignee });
  if (filters.team) and.push({ assignedTeamId: filters.team === "none" ? null : filters.team });
  if (filters.priority) and.push({ priority: filters.priority });
  if (filters.status) and.push({ status: filters.status });
  if (filters.q) {
    const number = parseTicketNumber(filters.q);
    and.push({ OR: [...(number !== null ? [{ number }] : []), { subject: { contains: filters.q, mode: "insensitive" as const } }] });
  }
  return and;
}

/** "Mine": what is given to me, to one of my Teams with no person yet, or what I wrote for nobody in particular. */
function mineWhere(userId: string, teamIds: readonly string[]): Prisma.TicketWhereInput {
  return {
    status: { in: [...TICKET_ACTIVE_STATUSES] },
    OR: [
      { assignedUserId: userId },
      ...(teamIds.length ? [{ assignedUserId: null, assignedTeamId: { in: [...teamIds] } }] : []),
      { assignedUserId: null, assignedTeamId: null, createdById: userId },
    ],
  };
}

function viewWhere(view: TicketView, filters: TicketFilters, userId: string, teamIds: readonly string[], now: Date): Prisma.TicketWhereInput {
  const and = filterWhere(filters, userId);
  switch (view) {
    case "MINE":
      and.push(mineWhere(userId, teamIds));
      break;
    case "UNASSIGNED":
      and.push({ status: { in: [...TICKET_ACTIVE_STATUSES] }, assignedUserId: null });
      break;
    case "ACTIVE":
      and.push({ status: { in: [...TICKET_ACTIVE_STATUSES] } });
      break;
    case "WAITING":
      and.push({ status: "WAITING_CUSTOMER" });
      break;
    case "OVERDUE":
      // A ticket waiting on the customer has its clock stopped, so it is never overdue.
      and.push({ status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: now } });
      break;
    case "RESOLVED":
      and.push({ status: { in: [...TICKET_FINISHED_STATUSES] } });
      break;
  }
  return { AND: and };
}

const PAGE_SIZE = 200;

export async function listTickets(
  session: Session,
  view: TicketView,
  filters: TicketFilters,
  now: Date,
): Promise<{ rows: TicketRow[]; truncated: boolean; counts: Record<TicketView, number> }> {
  const teamIds = await teamsOfUser(session.userId);
  const raw = await prisma.ticket.findMany({
    where: viewWhere(view, filters, session.userId, teamIds, now),
    orderBy: view === "RESOLVED" ? [{ resolvedAt: "desc" }, { id: "desc" }] : [{ dueAt: { sort: "asc", nulls: "last" } }, { number: "asc" }],
    take: PAGE_SIZE + 1,
    select: ROW_SELECT,
  });
  const countList = await Promise.all(TICKET_VIEWS.map((v) => prisma.ticket.count({ where: viewWhere(v, filters, session.userId, teamIds, now) })));
  const counts = Object.fromEntries(TICKET_VIEWS.map((v, i) => [v, countList[i]!])) as Record<TicketView, number>;
  return { rows: await toRows(session, raw.slice(0, PAGE_SIZE), now), truncated: raw.length > PAGE_SIZE, counts };
}

async function toRows(session: Session, raw: RawRow[], now: Date): Promise<TicketRow[]> {
  const linksOf = await resolveConversationLinks(session, raw);
  return raw.map((r) => {
    const status = r.status as TicketStatusValue;
    const { conversation, client } = linksOf(r);
    const clock = ticketClock({ status, dueAt: r.dueAt, resolvedAt: r.resolvedAt }, now);
    return {
      id: r.id,
      number: r.number,
      label: formatTicketNumber(r.number),
      subject: r.subject,
      status,
      priority: r.priority,
      category: r.category,
      dueAt: r.dueAt?.toISOString() ?? null,
      clock: { tone: clock.tone, text: clock.text },
      assignedUserId: r.assignedUserId,
      assignedUserName: r.assignedUser?.name ?? null,
      assignedTeamId: r.assignedTeamId,
      assignedTeamName: r.assignedTeam?.name ?? null,
      conversation,
      client,
      linkKind: linkKindOf(r),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

export interface TicketEventView {
  id: string;
  kind: string;
  fromValue: string | null;
  toValue: string | null;
  body: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface TicketDetail extends TicketRow {
  description: string | null;
  dueInput: string;
  createdByName: string | null;
  createdAt: string;
  events: TicketEventView[];
  chatId: string | null;
}

export async function loadTicketDetail(session: Session, id: string, now: Date): Promise<TicketDetail | null> {
  const ticket = await prisma.ticket.findFirst({
    where: { id },
    select: { ...ROW_SELECT, description: true, createdBy: { select: { name: true } }, events: { orderBy: { createdAt: "desc" }, take: 300 } },
  });
  if (!ticket) return null;
  const [row] = await toRows(session, [ticket], now);
  return {
    ...row!,
    description: ticket.description,
    dueInput: ticket.dueAt ? formatDhakaDateTimeInput(ticket.dueAt) : "",
    createdByName: ticket.createdBy?.name ?? null,
    createdAt: ticket.createdAt.toISOString(),
    chatId: ticket.chatId,
    events: ticket.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      fromValue: e.fromValue,
      toValue: e.toValue,
      body: e.body,
      actorName: e.actorName,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

const SUMMARY_SELECT = {
  id: true,
  number: true,
  subject: true,
  status: true,
  priority: true,
  dueAt: true,
  resolvedAt: true,
  assignedUser: { select: { name: true } },
} satisfies Prisma.TicketSelect;

function toSummary(r: Prisma.TicketGetPayload<{ select: typeof SUMMARY_SELECT }>, now: Date): TicketSummary {
  const status = r.status as TicketStatusValue;
  const clock = ticketClock({ status, dueAt: r.dueAt, resolvedAt: r.resolvedAt }, now);
  return {
    id: r.id,
    number: r.number,
    label: formatTicketNumber(r.number),
    subject: r.subject,
    status,
    priority: r.priority,
    clock: { tone: clock.tone, text: clock.text },
    assigneeName: r.assignedUser?.name ?? null,
  };
}

const SUMMARY_ORDER: Prisma.TicketOrderByWithRelationInput[] = [{ status: "asc" }, { number: "desc" }];

/** This conversation's tickets: open ones first, so the side panel leads with what is still going on. */
export async function loadConversationTickets(ref: ConversationRef, now = new Date()): Promise<TicketSummary[]> {
  const rows = await prisma.ticket.findMany({
    where: ref.kind === "whatsapp" ? { accountId: ref.accountId, chatId: ref.chatId } : { channelConversationId: ref.conversationId },
    orderBy: SUMMARY_ORDER,
    take: 30,
    select: SUMMARY_SELECT,
  });
  return rows.map((r) => toSummary(r, now));
}

export async function loadClientTickets(clientId: string, now = new Date()): Promise<TicketSummary[]> {
  const rows = await prisma.ticket.findMany({ where: { clientId }, orderBy: SUMMARY_ORDER, take: 30, select: SUMMARY_SELECT });
  return rows.map((r) => toSummary(r, now));
}

/** The client a conversation is already linked to, if exactly that link exists. Used to fill the ticket in; never guessed. */
export async function clientOfConversation(ref: ConversationRef): Promise<string | null> {
  if (ref.kind !== "whatsapp") return null;
  if (ref.chatId.endsWith("@g.us")) {
    const link = await prisma.clientWhatsAppGroupLink.findFirst({ where: { whatsappGroupId: ref.chatId, unlinkedAt: null }, select: { clientId: true } });
    return link?.clientId ?? null;
  }
  const link = await prisma.clientWhatsAppChatLink.findFirst({ where: { accountId: ref.accountId, chatId: ref.chatId, unlinkedAt: null }, select: { clientId: true } });
  return link?.clientId ?? null;
}

// ── Writes ───────────────────────────────

export interface TicketActor {
  userId: string;
  name: string;
}

export interface TicketOwner {
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignedTeamId: string | null;
  assignedTeamName: string | null;
}

function eventData(ticketId: string, projectId: string, actor: TicketActor, kind: TicketEventKind, fromValue: string | null, toValue: string | null, body: string | null = null) {
  return { projectId, ticketId, kind, fromValue, toValue, body, actorUserId: actor.userId, actorName: actor.name };
}

const dueWords = (when: Date | null) => (when ? formatDhakaDateTimeInput(when).replace("T", " ") : "No due time");

/**
 * Creates a ticket with the next number of this project. The number and the ticket are one transaction, so a failure
 * leaves no gap and two people creating at once get different numbers.
 */
export async function createTicketRow(input: {
  fields: TicketFields;
  owner: TicketOwner;
  conversation: ConversationRef | null;
  clientId: string | null;
  config: TicketTargets;
  actor: TicketActor;
  now: Date;
}): Promise<{ id: string; number: number }> {
  const projectId = await activeProjectId();
  const { fields, owner, conversation, clientId, actor, now } = input;
  return prisma.$transaction(async (tx) => {
    const [counter] = await tx.$queryRaw<Array<{ n: number }>>`
      INSERT INTO "TicketSettings" ("id", "projectId", "lastNumber", "updatedAt") VALUES (${randomUUID()}, ${projectId}, 1, ${now})
      ON CONFLICT ("projectId") DO UPDATE SET "lastNumber" = "TicketSettings"."lastNumber" + 1
      RETURNING "lastNumber" AS n`;
    const ticket = await tx.ticket.create({
      data: {
        projectId,
        number: Number(counter!.n),
        subject: fields.subject,
        description: fields.description,
        priority: fields.priority,
        category: fields.category,
        assignedUserId: owner.assignedUserId,
        assignedTeamId: owner.assignedTeamId,
        accountId: conversation?.kind === "whatsapp" ? conversation.accountId : null,
        chatId: conversation?.kind === "whatsapp" ? conversation.chatId : null,
        channelConversationId: conversation?.kind === "channel" ? conversation.conversationId : null,
        clientId,
        dueAt: fields.dueAt ?? ticketDueFrom(now, fields.priority, input.config),
        createdById: actor.userId,
      },
      select: { id: true, number: true },
    });
    await tx.ticketEvent.create({ data: eventData(ticket.id, projectId, actor, "CREATED", null, formatTicketNumber(ticket.number)) });
    return ticket;
  });
}

export async function moveTicketRow(id: string, to: TicketStatusValue, actor: TicketActor, config: TicketTargets, now: Date): Promise<void> {
  const projectId = await activeProjectId();
  const ticket = await prisma.ticket.findFirst({ where: { id }, select: { status: true, dueAt: true, pausedAt: true, resolvedAt: true, priority: true } });
  if (!ticket) throw new TicketChangeError("That ticket no longer exists.");
  const from = ticket.status as TicketStatusValue;
  const decision = decideTicketMove({ ...ticket, status: from }, to, now, config);
  if (!decision.ok) throw new TicketChangeError(decision.error);
  await prisma.$transaction(async (tx) => {
    const done = await tx.ticket.updateMany({ where: { id, status: from }, data: decision.move });
    if (done.count !== 1) throw new TicketChangeError(CHANGED);
    await tx.ticketEvent.create({ data: eventData(id, projectId, actor, "STATUS", TICKET_STATUS_LABEL[from], TICKET_STATUS_LABEL[to]) });
  });
}

export interface TicketPatch {
  subject?: string;
  description?: string | null;
  priority?: ConversationPriorityValue;
  category?: string | null;
  owner?: Partial<TicketOwner>;
  dueAt?: Date | null;
}

/**
 * Applies one edit from the ticket page. It holds only if nobody changed the ticket since the page was read, and every
 * field that really changed gets its own line in the history. A new priority brings the new target with it, unless the
 * ticket is paused or the person set a due time in the same edit.
 */
export async function updateTicketRow(id: string, expectedUpdatedAt: Date, patch: TicketPatch, actor: TicketActor, config: TicketTargets, now: Date): Promise<void> {
  const projectId = await activeProjectId();
  const t = await prisma.ticket.findFirst({
    where: { id },
    select: {
      status: true,
      subject: true,
      description: true,
      priority: true,
      category: true,
      dueAt: true,
      assignedUserId: true,
      assignedTeamId: true,
      assignedUser: { select: { name: true } },
      assignedTeam: { select: { name: true } },
      createdAt: true,
    },
  });
  if (!t) throw new TicketChangeError("That ticket no longer exists.");
  if ((TICKET_FINISHED_STATUSES as readonly string[]).includes(t.status)) throw new TicketChangeError("Reopen this ticket before changing it.");

  const data: Prisma.TicketUncheckedUpdateManyInput = {};
  const lines: Array<[TicketEventKind, string | null, string | null]> = [];

  if ((patch.subject !== undefined && patch.subject !== t.subject) || (patch.description !== undefined && patch.description !== t.description)) {
    if (patch.subject !== undefined) data.subject = patch.subject;
    if (patch.description !== undefined) data.description = patch.description;
    lines.push(["EDITED", null, null]);
  }
  if (patch.category !== undefined && patch.category !== t.category) {
    data.category = patch.category;
    lines.push(["CATEGORY", t.category, patch.category]);
  }
  if (patch.owner?.assignedUserId !== undefined && patch.owner.assignedUserId !== t.assignedUserId) {
    data.assignedUserId = patch.owner.assignedUserId;
    lines.push(["ASSIGNED", t.assignedUser?.name ?? "Nobody", patch.owner.assignedUserName ?? "Nobody"]);
  }
  if (patch.owner?.assignedTeamId !== undefined && patch.owner.assignedTeamId !== t.assignedTeamId) {
    data.assignedTeamId = patch.owner.assignedTeamId;
    lines.push(["TEAM", t.assignedTeam?.name ?? "No Team", patch.owner.assignedTeamName ?? "No Team"]);
  }
  let nextDue = t.dueAt;
  if (patch.priority !== undefined && patch.priority !== t.priority) {
    data.priority = patch.priority;
    lines.push(["PRIORITY", CONVERSATION_PRIORITY_LABEL[t.priority], CONVERSATION_PRIORITY_LABEL[patch.priority]]);
    if (patch.dueAt === undefined && t.status !== "WAITING_CUSTOMER" && t.dueAt) nextDue = ticketDueFrom(t.createdAt, patch.priority, config);
  }
  if (patch.dueAt !== undefined) nextDue = patch.dueAt;
  if ((nextDue?.getTime() ?? null) !== (t.dueAt?.getTime() ?? null)) {
    data.dueAt = nextDue;
    lines.push(["DUE", dueWords(t.dueAt), dueWords(nextDue)]);
  }
  if (lines.length === 0) return;

  await prisma.$transaction(async (tx) => {
    const done = await tx.ticket.updateMany({ where: { id, updatedAt: expectedUpdatedAt }, data });
    if (done.count !== 1) throw new TicketChangeError(CHANGED);
    await tx.ticketEvent.createMany({ data: lines.map(([kind, from, to]) => eventData(id, projectId, actor, kind, from, to)) });
  });
}

/** An internal note: it lives in the history and is never read by any send path. */
export async function addTicketNoteRow(id: string, body: string, actor: TicketActor): Promise<void> {
  const projectId = await activeProjectId();
  const ticket = await prisma.ticket.findFirst({ where: { id }, select: { id: true } });
  if (!ticket) throw new TicketChangeError("That ticket no longer exists.");
  await prisma.ticketEvent.create({ data: eventData(id, projectId, actor, "NOTE", null, null, body) });
}
