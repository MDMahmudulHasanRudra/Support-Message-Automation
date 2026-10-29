import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { activeProjectId } from "@/server/projectContext";
import { hasPermission, userHoldsKey } from "@/server/permissions";
import type { Session } from "@/server/auth";
import {
  conversationRefColumns,
  type ConversationPriorityValue,
  type ConversationRef,
} from "@support-automation/shared";

/**
 * The inbox workspace side panel (INBOX_WORKSPACE.md): internal notes, priority / tags, Team
 * assignment and AI Copilot drafts for ONE conversation — a WhatsApp chat or a Messenger /
 * Instagram / Telegram conversation.
 *
 * Every read and write re-derives the conversation here from the ref the browser named, through the
 * project-scoped client: an account / conversation of another project is simply not found. Plain
 * async helpers; the Server Actions live in server/actions/inboxWorkspace.ts.
 */

export interface WorkspaceAccess {
  ref: ConversationRef;
  /** May read the panel at all (messages.view + the conversation's own module). */
  canRead: boolean;
  /** May write notes / labels and ask the Copilot (the reply key of that conversation's module). */
  canWrite: boolean;
  collaboration: boolean;
  copilot: boolean;
}

/** Null when the conversation does not exist in this project or the viewer may not read it. */
export async function resolveWorkspaceAccess(session: Session, ref: ConversationRef): Promise<WorkspaceAccess | null> {
  const disabled = await activeDisabledFeatures();
  const collaboration = !disabled.has("INBOX_COLLABORATION");
  const copilot = !disabled.has("AI_COPILOT");
  if (!collaboration && !copilot) return null;

  if (ref.kind === "whatsapp") {
    if (disabled.has("WHATSAPP_CHAT")) return null;
    const account = await prisma.whatsAppAccount.findFirst({ where: { id: ref.accountId }, select: { id: true } });
    if (!account) return null;
    const exists = ref.chatId.endsWith("@g.us")
      ? await prisma.whatsAppGroup.findFirst({ where: { accountId: ref.accountId, whatsappGroupId: ref.chatId }, select: { id: true } })
      : await prisma.message.findFirst({ where: { accountId: ref.accountId, chatId: ref.chatId, groupId: null }, select: { id: true } });
    if (!exists) return null;
    if (!(await hasPermission(session, "messages.view"))) return null;
    return { ref, canRead: true, canWrite: await hasPermission(session, "messages.reply"), collaboration, copilot };
  }

  if (disabled.has("OMNICHANNEL")) return null;
  const conversation = await prisma.channelConversation.findFirst({ where: { id: ref.conversationId }, select: { id: true } });
  if (!conversation) return null;
  if (!(await hasPermission(session, "messages.view"))) return null;
  return { ref, canRead: true, canWrite: await hasPermission(session, "conversations.reply"), collaboration, copilot };
}

/** The `where` that selects rows about exactly this conversation. */
export function refWhere(ref: ConversationRef) {
  const cols = conversationRefColumns(ref);
  return ref.kind === "whatsapp"
    ? { accountId: cols.accountId, chatId: cols.chatId, channelConversationId: null }
    : { channelConversationId: cols.channelConversationId };
}

export interface WorkspaceNote {
  id: string;
  body: string;
  authorId: string | null;
  authorName: string;
  mentionedUserIds: string[];
  createdAt: string;
}

export interface WorkspaceDraft {
  id: string;
  mode: "ASSIST" | "DRAFT" | "REWRITE";
  instruction: string | null;
  status: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED" | "CANCELLED";
  responseText: string | null;
  scope: string | null;
  summary: string | null;
  intent: string | null;
  nextSteps: string[];
  knowledgeTitles: string[];
  grounded: boolean;
  confidence: number | null;
  warning: string | null;
  reason: string | null;
  error: string | null;
  feedback: string | null;
  usedAt: string | null;
  requestedById: string | null;
  requestedByName: string | null;
  createdAt: string;
}

export interface WorkspaceData {
  access: Omit<WorkspaceAccess, "ref">;
  ref: ConversationRef;
  priority: ConversationPriorityValue;
  tags: string[];
  /** Tags used elsewhere in this project, most used first — suggestions for the tag field. */
  knownTags: string[];
  notes: WorkspaceNote[];
  drafts: WorkspaceDraft[];
  people: { id: string; username: string; name: string }[];
  /** Channel conversations only: Teams and the current Team / person. */
  teams: { id: string; name: string }[] | null;
  assignedTeamId: string | null;
  /** Channel conversations: the person handling it. */
  assignedUserId: string | null;
  /** Channel conversations: assignment / status history, newest first. */
  history: { id: string; kind: string; from: string | null; to: string | null; actorName: string | null; at: string }[];
  /** WhatsApp groups: the owner set on the Groups page (read here, changed there). */
  groupOwner: { name: string; groupName: string } | null;
  viewerId: string;
}

export const DRAFT_SELECT = {
  id: true,
  mode: true,
  instruction: true,
  status: true,
  responseText: true,
  scope: true,
  summary: true,
  intent: true,
  nextSteps: true,
  knowledgeTitles: true,
  grounded: true,
  confidence: true,
  warning: true,
  reason: true,
  error: true,
  feedback: true,
  usedAt: true,
  createdAt: true,
  requestedById: true,
  requestedBy: { select: { name: true } },
} as const;

export function toWorkspaceDraft(d: {
  id: string;
  mode: WorkspaceDraft["mode"];
  instruction: string | null;
  status: WorkspaceDraft["status"];
  responseText: string | null;
  scope: string | null;
  summary: string | null;
  intent: string | null;
  nextSteps: string[];
  knowledgeTitles: string[];
  grounded: boolean;
  confidence: number | null;
  warning: string | null;
  reason: string | null;
  error: string | null;
  feedback: string | null;
  usedAt: Date | null;
  createdAt: Date;
  requestedById: string | null;
  requestedBy: { name: string } | null;
}): WorkspaceDraft {
  return { ...d, usedAt: d.usedAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString(), requestedByName: d.requestedBy?.name ?? null };
}

export async function loadDrafts(ref: ConversationRef): Promise<WorkspaceDraft[]> {
  const rows = await prisma.aiDraft.findMany({ where: refWhere(ref), orderBy: { createdAt: "desc" }, take: 8, select: DRAFT_SELECT });
  return rows.map(toWorkspaceDraft);
}

/**
 * Who may be @mentioned or assigned: active people given access to this project whose role can read
 * conversations (`messages.view`), plus the viewer — so a mention can never notify somebody who could
 * not open the conversation it points to.
 */
export async function mentionablePeople(viewer: Pick<Session, "userId" | "tenant">): Promise<{ id: string; username: string; name: string }[]> {
  const projectId = await activeProjectId();
  const access = await prisma.projectAccess.findMany({ where: { projectId }, select: { userId: true } });
  const ids = [...new Set([viewer.userId, ...access.map((a) => a.userId)])];
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, isActive: true, supportOperatorId: null },
    select: { id: true, username: true, name: true },
    orderBy: { name: "asc" },
    take: 300,
  });
  const allowed = await Promise.all(users.map((u) => (u.id === viewer.userId ? true : userHoldsKey(u.id, viewer.tenant, "messages.view"))));
  return users.filter((_, i) => allowed[i]);
}

export async function loadWorkspace(session: Session, ref: ConversationRef): Promise<WorkspaceData | null> {
  const access = await resolveWorkspaceAccess(session, ref);
  if (!access) return null;
  const where = refWhere(ref);
  const [label, notes, drafts, people, knownTagRows, channel, teams] = await Promise.all([
    access.collaboration ? prisma.conversationLabel.findFirst({ where, select: { priority: true, tags: true } }) : null,
    access.collaboration
      ? prisma.conversationNote.findMany({
          where: { ...where, deletedAt: null },
          orderBy: { createdAt: "asc" },
          take: 100,
          select: { id: true, body: true, authorId: true, mentionedUserIds: true, createdAt: true, author: { select: { name: true } } },
        })
      : [],
    access.copilot ? loadDrafts(ref) : [],
    access.collaboration ? mentionablePeople(session) : [],
    access.collaboration
      ? prisma.$queryRaw<{ tag: string }[]>`
          SELECT tag FROM "ConversationLabel", unnest("tags") AS tag
          WHERE "projectId" = ${await activeProjectId()}
          GROUP BY tag ORDER BY count(*) DESC, tag LIMIT 40`
      : [],
    ref.kind === "channel" && access.collaboration
      ? prisma.channelConversation.findFirst({ where: { id: ref.conversationId }, select: { assignedTeamId: true, assignedUserId: true } })
      : null,
    ref.kind === "channel" && access.collaboration ? prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }) : null,
  ]);
  const [events, group] = await Promise.all([
    ref.kind === "channel" && access.collaboration
      ? prisma.conversationEvent.findMany({
          where: { channelConversationId: ref.conversationId },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { id: true, kind: true, fromValue: true, toValue: true, createdAt: true, actor: { select: { name: true } } },
        })
      : [],
    ref.kind === "whatsapp" && ref.chatId.endsWith("@g.us") && access.collaboration
      ? prisma.whatsAppGroup.findFirst({ where: { accountId: ref.accountId, whatsappGroupId: ref.chatId }, select: { id: true, name: true, assignedTeamMember: { select: { name: true } } } })
      : null,
  ]);
  // Names for the ids history refers to (people and Teams of this project).
  const names = new Map<string, string>([...people.map((p) => [p.id, p.name] as const), ...(teams ?? []).map((t) => [t.id, t.name] as const)]);
  const nameOf = (kind: string, v: string | null) => (v === null ? null : kind === "STATUS" ? (v === "CLOSED" ? "Closed" : "Open") : (names.get(v) ?? "someone no longer here"));

  return {
    access: { canRead: access.canRead, canWrite: access.canWrite, collaboration: access.collaboration, copilot: access.copilot },
    ref,
    priority: label?.priority ?? "NONE",
    tags: label?.tags ?? [],
    knownTags: knownTagRows.map((r) => r.tag),
    notes: notes.map((n) => ({
      id: n.id,
      body: n.body,
      authorId: n.authorId,
      authorName: n.author?.name ?? "Former user",
      mentionedUserIds: n.mentionedUserIds,
      createdAt: n.createdAt.toISOString(),
    })),
    drafts,
    people,
    teams,
    assignedTeamId: channel?.assignedTeamId ?? null,
    assignedUserId: channel?.assignedUserId ?? null,
    history: events.map((e) => ({ id: e.id, kind: e.kind, from: nameOf(e.kind, e.fromValue), to: nameOf(e.kind, e.toValue), actorName: e.actor?.name ?? null, at: e.createdAt.toISOString() })),
    groupOwner: group ? { name: group.assignedTeamMember?.name ?? "", groupName: group.name } : null,
    viewerId: session.userId,
  };
}

/**
 * Priority, tags and group owner for one account's listed chats (WhatsApp Chat list), keyed by chat id.
 * Empty unless INBOX_COLLABORATION is on, so the list is byte-for-byte the old one when it is off. Two
 * queries for the whole list, never one per row.
 */
export async function chatListLabels(
  accountId: string,
  conversations: { id: string; kind: string; chatId: string }[],
): Promise<Record<string, { priority: ConversationPriorityValue; tags: string[]; owner: string | null }>> {
  if ((await activeDisabledFeatures()).has("INBOX_COLLABORATION") || conversations.length === 0) return {};
  const groupIds = conversations.filter((c) => c.kind === "GROUP").map((c) => c.id);
  const [labels, groups] = await Promise.all([
    prisma.conversationLabel.findMany({
      where: { accountId, channelConversationId: null, chatId: { in: conversations.map((c) => c.chatId) } },
      select: { chatId: true, priority: true, tags: true },
    }),
    groupIds.length
      ? prisma.whatsAppGroup.findMany({
          where: { id: { in: groupIds }, assignedTeamMemberId: { not: null } },
          select: { whatsappGroupId: true, assignedTeamMember: { select: { name: true } } },
        })
      : [],
  ]);
  const out: Record<string, { priority: ConversationPriorityValue; tags: string[]; owner: string | null }> = {};
  for (const l of labels) if (l.chatId) out[l.chatId] = { priority: l.priority, tags: l.tags, owner: null };
  for (const g of groups) {
    const owner = g.assignedTeamMember?.name ?? null;
    out[g.whatsappGroupId] = { ...(out[g.whatsappGroupId] ?? { priority: "NONE", tags: [] }), owner };
  }
  return out;
}
