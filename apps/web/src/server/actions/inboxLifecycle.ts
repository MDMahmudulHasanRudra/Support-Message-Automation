"use server";

import { revalidatePath } from "next/cache";
import { isConversationStatus, parseConversationRef, type ConversationRef, type LifecycleRequest } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { mentionablePeople, resolveWorkspaceAccess } from "@/server/inboxWorkspace";
import { assignChannelConversation, assignChannelConversationTeam } from "@/server/channels/replies";
import { assignWhatsAppConversation, changeConversationStatus, LifecycleChangeError, saveLifecyclePolicy } from "@/server/conversationLifecycle";
import { readPresence, recordPresence, type PresencePeer } from "@/server/conversationPresence";
import type { Session } from "@/server/auth";

/**
 * Unified Inbox V3 actions (feature UNIFIED_INBOX_V3). Each one re-validates the conversation the browser
 * named, checks the reply key of THAT conversation's module (messages.reply for WhatsApp, conversations.reply
 * for the channels) and that the feature is on — the same gate the inbox workspace's writes use, so a
 * read-only role sees the status and changes nothing. Nothing here sends a message.
 */

type Fail = { error: string };

async function forLifecycle(refInput: unknown): Promise<{ session: Session; ref: ConversationRef } | Fail> {
  const ref = parseConversationRef(refInput);
  if (!ref) return { error: "That conversation could not be found." };
  const granted =
    ref.kind === "whatsapp" ? await checkPermission("messages.reply", "WHATSAPP_CHAT") : await checkPermission("conversations.reply", "OMNICHANNEL");
  if ("denied" in granted) return { error: granted.denied };
  if ((await activeDisabledFeatures()).has("UNIFIED_INBOX_V3")) return { error: "Conversation status is switched off for this project." };
  const access = await resolveWorkspaceAccess(granted.session, ref);
  if (!access) return { error: "That conversation could not be found." };
  if (!access.lifecycle) return { error: "Conversation status is switched off for this project." };
  if (!access.canWrite) return { error: "Your role can read this conversation but not work on it." };
  return { session: granted.session, ref };
}

function readRequest(input: { to?: unknown; until?: unknown }): LifecycleRequest | null {
  if (!isConversationStatus(input.to)) return null;
  if (input.to === "SNOOZED") {
    const until = typeof input.until === "string" || typeof input.until === "number" ? new Date(input.until) : null;
    return until ? { to: "SNOOZED", until } : null;
  }
  return { to: input.to };
}

export async function setConversationStatus(refInput: unknown, input: { to?: unknown; until?: unknown; note?: unknown }): Promise<{ status: string } | Fail> {
  const w = await forLifecycle(refInput);
  if ("error" in w) return w;
  const request = readRequest(input);
  if (!request) return { error: "Choose Open, Pending, Snoozed (with a time) or Resolved." };
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) || null : null;
  try {
    const status = await changeConversationStatus(w.ref, request, w.session.userId, note);
    return { status };
  } catch (err) {
    if (err instanceof LifecycleChangeError) return { error: err.message };
    throw err;
  }
}

export async function setConversationAssignee(refInput: unknown, userId: string | null): Promise<{ ok: true } | Fail> {
  const w = await forLifecycle(refInput);
  if ("error" in w) return w;
  const target = userId || null;
  if (target) {
    const people = await mentionablePeople(w.session);
    if (!people.some((p) => p.id === target)) return { error: "That person cannot be assigned in this project." };
  }
  try {
    if (w.ref.kind === "channel") await assignChannelConversation(w.ref.conversationId, target, w.session.userId);
    else await assignWhatsAppConversation(w.ref, { userId: target }, w.session.userId);
  } catch (err) {
    if (err instanceof LifecycleChangeError) return { error: err.message };
    throw err;
  }
  return { ok: true };
}

export async function setConversationTeam(refInput: unknown, teamId: string | null): Promise<{ ok: true } | Fail> {
  const w = await forLifecycle(refInput);
  if ("error" in w) return w;
  const target = teamId || null;
  // The project-scoped client: another project's Team is not found here (and the database refuses it too).
  if (target && !(await prisma.team.findFirst({ where: { id: target }, select: { id: true } }))) return { error: "That Team is not in this project." };
  try {
    if (w.ref.kind === "channel") await assignChannelConversationTeam(w.ref.conversationId, target, w.session.userId);
    else await assignWhatsAppConversation(w.ref, { teamId: target }, w.session.userId);
  } catch (err) {
    if (err instanceof LifecycleChangeError) return { error: err.message };
    throw err;
  }
  return { ok: true };
}

/** Settings → Inbox status: what a customer message does to resolved and snoozed conversations. */
export async function saveInboxLifecyclePolicy(input: { reopenResolved: boolean; reopenSnoozed: boolean }): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("settings.edit", "UNIFIED_INBOX_V3");
  if ("denied" in granted) return { error: granted.denied };
  await saveLifecyclePolicy({ reopenResolvedOnCustomerMessage: input.reopenResolved === true, reopenSnoozedOnCustomerMessage: input.reopenSnoozed === true }, granted.session.userId);
  revalidatePath(await projectPath("/settings/inbox-status"));
  return { ok: true };
}

/**
 * The presence heartbeat (V3-05), polled every few seconds by an open conversation: records this person and
 * returns who else is here. Polled, so a refusal is "nobody to show", never a redirect or an error toast.
 */
export async function presenceHeartbeat(refInput: unknown, typing: boolean): Promise<{ peers: PresencePeer[] }> {
  const ref = parseConversationRef(refInput);
  if (!ref) return { peers: [] };
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return { peers: [] };
  if ((await activeDisabledFeatures()).has("UNIFIED_INBOX_V3")) return { peers: [] };
  const access = await resolveWorkspaceAccess(granted.session, ref);
  if (!access?.lifecycle) return { peers: [] };
  await recordPresence(ref, granted.session.userId, typing === true);
  return { peers: await readPresence(ref, granted.session.userId) };
}
