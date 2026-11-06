"use server";

import { revalidatePath } from "next/cache";
import { parseConversationRef, readFollowUpFields, type ConversationRef, type FollowUpAction } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { hasPermission } from "@/server/permissions";
import { conversationInProject, mentionablePeople } from "@/server/inboxWorkspace";
import {
  changeFollowUpStatus,
  countMyAttention,
  createFollowUpRow,
  editFollowUpRow,
  FollowUpChangeError,
  linkKindOf,
  loadFollowUpHistory,
  type FollowUpHistoryEntry,
  type FollowUpOwner,
} from "@/server/followUps";
import type { Session } from "@/server/auth";

/**
 * Follow-ups (FOLLOW_UPS.md, feature FOLLOW_UPS). No key of its own:
 *   - reading: `messages.view` (the key that reads conversations);
 *   - changing one: the reply key of the conversation it is about — `messages.reply` for a WhatsApp chat,
 *     `conversations.reply` for a channel conversation — or either of them for a follow-up about no
 *     conversation. Each key keeps its own module's feature check, so a key whose module is off grants nothing.
 * Every action also needs FOLLOW_UPS on, and re-reads the follow-up, conversation and client through the
 * project-scoped client: another project's id is simply not found. Nothing here sends a message.
 */

type Fail = { error: string };
type LinkKind = "whatsapp" | "channel" | "none";

async function readGate(): Promise<{ session: Session } | Fail> {
  const granted = await checkPermission("messages.view", "FOLLOW_UPS");
  return "denied" in granted ? { error: granted.denied } : granted;
}

async function writeGate(kind: LinkKind): Promise<{ session: Session } | Fail> {
  const tries =
    kind === "whatsapp"
      ? (["messages.reply"] as const)
      : kind === "channel"
        ? (["conversations.reply"] as const)
        : (["messages.reply", "conversations.reply"] as const);
  let first: string | null = null;
  for (const key of tries) {
    const granted = await checkPermission(key, "FOLLOW_UPS");
    if ("session" in granted) return granted;
    first ??= granted.denied;
  }
  return { error: first! };
}

function actorOf(session: Session) {
  return { userId: session.userId, name: session.name || session.username };
}

/** The person and Team a follow-up goes to, checked against this project. */
async function readOwner(session: Session, input: { assignedUserId?: unknown; assignedTeamId?: unknown }): Promise<FollowUpOwner | Fail> {
  const userId = typeof input.assignedUserId === "string" && input.assignedUserId ? input.assignedUserId : null;
  const teamId = typeof input.assignedTeamId === "string" && input.assignedTeamId ? input.assignedTeamId : null;
  if (userId) {
    const people = await mentionablePeople(session);
    if (!people.some((p) => p.id === userId)) return { error: "That person cannot be given follow-ups in this project." };
  }
  if (teamId && !(await prisma.team.findFirst({ where: { id: teamId }, select: { id: true } }))) return { error: "That Team is not in this project." };
  return { assignedUserId: userId, assignedTeamId: teamId };
}

async function revalidate() {
  revalidatePath(await projectPath("/follow-ups"));
}

export interface FollowUpInput {
  title?: unknown;
  note?: unknown;
  due?: unknown;
  priority?: unknown;
  assignedUserId?: unknown;
  assignedTeamId?: unknown;
}

/**
 * Creates a follow-up, optionally about one conversation (the ConversationRef the side panel holds) and/or
 * one client. A conversation or client of another project — or of a module that is off — is refused.
 */
export async function createFollowUp(input: FollowUpInput & { conversation?: unknown; clientId?: unknown }): Promise<{ id: string } | Fail> {
  const conversation: ConversationRef | null = input.conversation === undefined || input.conversation === null ? null : parseConversationRef(input.conversation);
  if (input.conversation && !conversation) return { error: "That conversation could not be found." };
  const gate = await writeGate(conversation?.kind ?? "none");
  if ("error" in gate) return gate;
  const disabled = await activeDisabledFeatures();
  if (conversation && !(await conversationInProject(conversation, disabled))) return { error: "That conversation could not be found." };

  let clientId: string | null = null;
  if (typeof input.clientId === "string" && input.clientId) {
    const mayLink = !disabled.has("CLIENT_CENTER") && (await hasPermission(gate.session, "clients.view"));
    const client = mayLink ? await prisma.client.findFirst({ where: { id: input.clientId }, select: { id: true } }) : null;
    if (!client) return { error: "That client could not be found." };
    clientId = client.id;
  }

  const fields = readFollowUpFields(input, new Date());
  if ("error" in fields) return fields;
  const owner = await readOwner(gate.session, input);
  if ("error" in owner) return owner;
  const id = await createFollowUpRow(fields, owner, { conversation, clientId }, actorOf(gate.session));
  await revalidate();
  return { id };
}

/** The row's link kind (which reply key changes it), or null when it is not in this project. */
async function linkKindFor(id: string): Promise<LinkKind | null> {
  if (typeof id !== "string" || !id) return null;
  const row = await prisma.followUp.findFirst({ where: { id }, select: { accountId: true, channelConversationId: true } });
  return row ? linkKindOf(row) : null;
}

export async function updateFollowUp(id: string, input: FollowUpInput): Promise<{ changed: boolean } | Fail> {
  const read = await readGate();
  if ("error" in read) return read;
  const kind = await linkKindFor(id);
  if (!kind) return { error: "That follow-up could not be found." };
  const gate = await writeGate(kind);
  if ("error" in gate) return gate;
  const fields = readFollowUpFields(input, new Date());
  if ("error" in fields) return fields;
  const owner = await readOwner(gate.session, input);
  if ("error" in owner) return owner;
  try {
    const result = await editFollowUpRow(id, fields, owner, actorOf(gate.session));
    await revalidate();
    return result;
  } catch (err) {
    if (err instanceof FollowUpChangeError) return { error: err.message };
    throw err;
  }
}

const ACTIONS: readonly FollowUpAction[] = ["DONE", "DISCARD", "REOPEN"];

export async function setFollowUpStatus(id: string, action: unknown): Promise<{ status: string } | Fail> {
  if (!ACTIONS.includes(action as FollowUpAction)) return { error: "Choose Done, Discard or Reopen." };
  const read = await readGate();
  if ("error" in read) return read;
  const kind = await linkKindFor(id);
  if (!kind) return { error: "That follow-up could not be found." };
  const gate = await writeGate(kind);
  if ("error" in gate) return gate;
  try {
    const status = await changeFollowUpStatus(id, action as FollowUpAction, actorOf(gate.session));
    await revalidate();
    return { status };
  } catch (err) {
    if (err instanceof FollowUpChangeError) return { error: err.message };
    throw err;
  }
}

export async function readFollowUpHistory(id: string): Promise<{ entries: FollowUpHistoryEntry[] } | Fail> {
  const read = await readGate();
  if ("error" in read) return read;
  if (!(await linkKindFor(id))) return { error: "That follow-up could not be found." };
  return { entries: await loadFollowUpHistory(id) };
}

/**
 * The reminder badge (polled from every page): my overdue + due-today follow-ups. Refuses as zero, never
 * a redirect — a role without the key, or the feature off, simply has nothing to show.
 */
export async function readFollowUpBadge(): Promise<{ overdue: number; dueToday: number }> {
  const read = await readGate().catch(() => ({ error: "unavailable" }) as Fail);
  if ("error" in read) return { overdue: 0, dueToday: 0 };
  return countMyAttention(read.session, new Date());
}
