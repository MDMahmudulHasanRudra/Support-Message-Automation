"use server";

import { revalidatePath } from "next/cache";
import {
  isConversationPriority,
  isTicketStatus,
  parseConversationRef,
  parseDhakaDateTimeInput,
  MAX_TICKET_DESCRIPTION,
  MAX_TICKET_SUBJECT,
  readTicketFields,
  readTicketNote,
  readTicketSettings,
  type ConversationPriorityValue,
  type ConversationRef,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { hasPermission } from "@/server/permissions";
import { conversationInProject, mentionablePeople } from "@/server/inboxWorkspace";
import { linkKindOf } from "@/server/followUps";
import {
  addTicketNoteRow,
  clientOfConversation,
  createTicketRow,
  loadTicketConfig,
  moveTicketRow,
  saveTicketConfig,
  TicketChangeError,
  updateTicketRow,
  type TicketActor,
  type TicketOwner,
  type TicketPatch,
} from "@/server/tickets";
import type { Session } from "@/server/auth";

/**
 * Support tickets (TICKETS.md, feature TICKETS). No key of its own, the same as follow-ups:
 *   - reading: `messages.view`;
 *   - changing one: the reply key of the conversation it is about (`messages.reply` for WhatsApp, `conversations.reply`
 *     for a channel), or either of them for a ticket about no conversation.
 * Every action re-reads the ticket, conversation and client through the project-scoped client: another project's id is
 * simply not found. Nothing here sends a message.
 */

type Fail = { error: string };
type LinkKind = "whatsapp" | "channel" | "none";

async function writeGate(kind: LinkKind): Promise<{ session: Session } | Fail> {
  const tries = kind === "whatsapp" ? (["messages.reply"] as const) : kind === "channel" ? (["conversations.reply"] as const) : (["messages.reply", "conversations.reply"] as const);
  let first: string | null = null;
  for (const key of tries) {
    const granted = await checkPermission(key, "TICKETS");
    if ("session" in granted) return granted;
    first ??= granted.denied;
  }
  return { error: first! };
}

const actorOf = (session: Session): TicketActor => ({ userId: session.userId, name: session.name || session.username });

async function refresh(id?: string) {
  revalidatePath(await projectPath("/tickets"));
  if (id) revalidatePath(await projectPath(`/tickets/${id}`));
}

/** The person and Team a ticket goes to, checked against this project, with the names the history records. */
async function readOwner(session: Session, input: { assignedUserId?: unknown; assignedTeamId?: unknown }): Promise<Partial<TicketOwner> | Fail> {
  const owner: Partial<TicketOwner> = {};
  if (input.assignedUserId !== undefined) {
    const userId = typeof input.assignedUserId === "string" && input.assignedUserId ? input.assignedUserId : null;
    let name: string | null = null;
    if (userId) {
      const person = (await mentionablePeople(session)).find((p) => p.id === userId);
      if (!person) return { error: "That person cannot be given tickets in this project." };
      name = person.name;
    }
    owner.assignedUserId = userId;
    owner.assignedUserName = name;
  }
  if (input.assignedTeamId !== undefined) {
    const teamId = typeof input.assignedTeamId === "string" && input.assignedTeamId ? input.assignedTeamId : null;
    let name: string | null = null;
    if (teamId) {
      const team = await prisma.team.findFirst({ where: { id: teamId }, select: { name: true } });
      if (!team) return { error: "That Team is not in this project." };
      name = team.name;
    }
    owner.assignedTeamId = teamId;
    owner.assignedTeamName = name;
  }
  return owner;
}

export interface TicketInput {
  subject?: unknown;
  description?: unknown;
  priority?: unknown;
  category?: unknown;
  due?: unknown;
  assignedUserId?: unknown;
  assignedTeamId?: unknown;
  conversation?: unknown;
  clientId?: unknown;
}

/** Creates a ticket, on its own or about one conversation and/or client. A link to another project is refused. */
export async function createTicket(input: TicketInput): Promise<{ id: string; number: number } | Fail> {
  let conversation: ConversationRef | null = null;
  if (input.conversation !== undefined && input.conversation !== null) {
    conversation = parseConversationRef(input.conversation);
    if (!conversation) return { error: "That conversation could not be found." };
  }
  const gate = await writeGate(conversation?.kind ?? "none");
  if ("error" in gate) return gate;
  const disabled = await activeDisabledFeatures();
  if (conversation && !(await conversationInProject(conversation, disabled))) return { error: "That conversation could not be found." };

  const config = await loadTicketConfig();
  const parsed = readTicketFields(input, config.categories);
  if (!parsed.ok) return { error: parsed.error };

  const owner = await readOwner(gate.session, { assignedUserId: input.assignedUserId ?? null, assignedTeamId: input.assignedTeamId ?? null });
  if ("error" in owner) return owner;

  const mayLinkClient = !disabled.has("CLIENT_CENTER") && (await hasPermission(gate.session, "clients.view"));
  let clientId: string | null = null;
  if (typeof input.clientId === "string" && input.clientId) {
    if (!mayLinkClient) return { error: "You cannot link a client here." };
    const client = await prisma.client.findFirst({ where: { id: input.clientId }, select: { id: true } });
    if (!client) return { error: "That client could not be found." };
    clientId = client.id;
  } else if (conversation && mayLinkClient) {
    // A conversation already linked to a client brings that client with it.
    clientId = await clientOfConversation(conversation);
  }

  const created = await createTicketRow({
    fields: parsed.fields,
    owner: { assignedUserId: owner.assignedUserId ?? null, assignedUserName: owner.assignedUserName ?? null, assignedTeamId: owner.assignedTeamId ?? null, assignedTeamName: owner.assignedTeamName ?? null },
    conversation,
    clientId,
    config,
    actor: actorOf(gate.session),
    now: new Date(),
  });
  await refresh();
  return created;
}

async function gateForTicket(id: string): Promise<{ session: Session } | Fail> {
  const ticket = typeof id === "string" ? await prisma.ticket.findFirst({ where: { id }, select: { accountId: true, channelConversationId: true } }) : null;
  if (!ticket) return { error: "That ticket no longer exists." };
  return writeGate(linkKindOf(ticket));
}

function failure(err: unknown): Fail {
  if (err instanceof TicketChangeError) return { error: err.message };
  throw err;
}

export async function setTicketStatus(id: string, to: unknown): Promise<{ ok: true } | Fail> {
  if (!isTicketStatus(to)) return { error: "That status is not known." };
  const gate = await gateForTicket(id);
  if ("error" in gate) return gate;
  try {
    await moveTicketRow(id, to, actorOf(gate.session), await loadTicketConfig(), new Date());
  } catch (err) {
    return failure(err);
  }
  await refresh(id);
  return { ok: true };
}

export interface TicketEditInput {
  subject?: unknown;
  description?: unknown;
  priority?: unknown;
  category?: unknown;
  due?: unknown;
  assignedUserId?: unknown;
  assignedTeamId?: unknown;
}

/** One edit from the ticket page. `expectedUpdatedAt` is when the page read it: a newer change wins and this one is refused. */
export async function updateTicket(id: string, expectedUpdatedAt: string, input: TicketEditInput): Promise<{ ok: true } | Fail> {
  const gate = await gateForTicket(id);
  if ("error" in gate) return gate;
  const expected = new Date(expectedUpdatedAt);
  if (Number.isNaN(expected.getTime())) return { error: "Reload the page and try again." };
  const config = await loadTicketConfig();
  const patch: TicketPatch = {};

  if (input.subject !== undefined) {
    const subject = typeof input.subject === "string" ? input.subject.trim() : "";
    if (!subject || subject.length > MAX_TICKET_SUBJECT) return { error: `Write a subject of up to ${MAX_TICKET_SUBJECT} characters.` };
    patch.subject = subject;
  }
  if (input.description !== undefined) {
    const description = typeof input.description === "string" && input.description.trim() ? input.description.trim() : null;
    if (description && description.length > MAX_TICKET_DESCRIPTION) return { error: `Keep the description to ${MAX_TICKET_DESCRIPTION} characters.` };
    patch.description = description;
  }
  if (input.priority !== undefined) {
    if (!isConversationPriority(input.priority) || input.priority === "NONE") return { error: "Choose a priority." };
    patch.priority = input.priority as ConversationPriorityValue;
  }
  if (input.category !== undefined) {
    const category = typeof input.category === "string" && input.category ? input.category : null;
    if (category && !config.categories.includes(category)) return { error: "Choose a category from the list." };
    patch.category = category;
  }
  if (input.due !== undefined) {
    if (typeof input.due === "string" && input.due) {
      const dueAt = parseDhakaDateTimeInput(input.due);
      if (!dueAt) return { error: "That due time does not look right." };
      patch.dueAt = dueAt;
    } else {
      patch.dueAt = null;
    }
  }
  if (input.assignedUserId !== undefined || input.assignedTeamId !== undefined) {
    const owner = await readOwner(gate.session, input);
    if ("error" in owner) return owner;
    patch.owner = owner;
  }
  try {
    await updateTicketRow(id, expected, patch, actorOf(gate.session), config, new Date());
  } catch (err) {
    return failure(err);
  }
  await refresh(id);
  return { ok: true };
}

export async function addTicketNote(id: string, body: unknown): Promise<{ ok: true } | Fail> {
  const parsed = readTicketNote(body);
  if (!parsed.ok) return { error: parsed.error };
  const gate = await gateForTicket(id);
  if ("error" in gate) return gate;
  try {
    await addTicketNoteRow(id, parsed.body, actorOf(gate.session));
  } catch (err) {
    return failure(err);
  }
  await refresh(id);
  return { ok: true };
}

export interface TicketSettingsState {
  error?: string;
  success?: string;
}

export async function saveTicketSettings(_prev: TicketSettingsState, form: FormData): Promise<TicketSettingsState> {
  const granted = await checkPermission("settings.edit", "TICKETS");
  if ("denied" in granted) return { error: granted.denied };
  const parsed = readTicketSettings({
    urgentHours: form.get("urgentHours"),
    highHours: form.get("highHours"),
    normalHours: form.get("normalHours"),
    lowHours: form.get("lowHours"),
    categories: form.get("categories"),
  });
  if (!parsed.ok) return { error: parsed.error };
  await saveTicketConfig(parsed.targets, parsed.categories);
  revalidatePath(await projectPath("/settings/tickets"));
  return { success: "Saved. New tickets use these from now on; tickets already open keep their due time." };
}
