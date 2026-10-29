import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { activeProjectId } from "@/server/projectContext";
import { hasPermission } from "@/server/permissions";
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

/** Who may be @mentioned: the people given access to this project, plus the viewer. */
export async function mentionablePeople(viewerId: string): Promise<{ id: string; username: string; name: string }[]> {
  const projectId = await activeProjectId();
  const access = await prisma.projectAccess.findMany({ where: { projectId }, select: { userId: true } });
  const ids = [...new Set([viewerId, ...access.map((a) => a.userId)])];
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, isActive: true, supportOperatorId: null },
    select: { id: true, username: true, name: true },
    orderBy: { name: "asc" },
    take: 300,
  });
  return users;
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
    access.collaboration ? mentionablePeople(session.userId) : [],
    access.collaboration
      ? prisma.$queryRaw<{ tag: string }[]>`
          SELECT tag FROM "ConversationLabel", unnest("tags") AS tag
          WHERE "projectId" = ${await activeProjectId()}
          GROUP BY tag ORDER BY count(*) DESC, tag LIMIT 40`
      : [],
    ref.kind === "channel" && access.collaboration
      ? prisma.channelConversation.findFirst({ where: { id: ref.conversationId }, select: { assignedTeamId: true } })
      : null,
    ref.kind === "channel" && access.collaboration ? prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }) : null,
  ]);

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
    viewerId: session.userId,
  };
}
