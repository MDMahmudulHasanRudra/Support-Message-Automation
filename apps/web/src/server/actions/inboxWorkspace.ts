"use server";

import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { activeProjectId } from "@/server/projectContext";
import {
  DRAFT_SELECT,
  loadDrafts,
  mentionablePeople,
  refWhere,
  resolveWorkspaceAccess,
  toWorkspaceDraft,
  type WorkspaceDraft,
  type WorkspaceNote,
} from "@/server/inboxWorkspace";
import type { Session } from "@/server/auth";
import {
  conversationRefColumns,
  extractNoteMentions,
  isConversationPriority,
  isCopilotRewriteInstruction,
  MAX_NOTE_LENGTH,
  normaliseConversationTags,
  parseConversationRef,
  type ConversationPriorityValue,
  type ConversationRef,
} from "@support-automation/shared";

/**
 * Inbox workspace writes (INBOX_WORKSPACE.md). Every action takes the conversation as a ref the
 * browser sent, re-validates it, and checks the reply key of THAT conversation's module — notes,
 * labels and Copilot requests are reply work, so a read-only role sees the panel and changes nothing.
 * Nothing here sends a message, and nothing here is read by any send path.
 */

type Fail = { error: string };

/** Session + validated ref for a write, or the sentence to show. */
async function forWrite(refInput: unknown, need: "collaboration" | "copilot"): Promise<{ session: Session; ref: ConversationRef } | Fail> {
  const ref = parseConversationRef(refInput);
  if (!ref) return { error: "That conversation could not be found." };
  const granted =
    ref.kind === "whatsapp" ? await checkPermission("messages.reply", "WHATSAPP_CHAT") : await checkPermission("conversations.reply", "OMNICHANNEL");
  if ("denied" in granted) return { error: granted.denied };
  const access = await resolveWorkspaceAccess(granted.session, ref);
  if (!access) return { error: "That conversation could not be found." };
  if (!access[need]) return { error: need === "copilot" ? "AI Copilot is switched off for this project." : "Notes and tags are switched off for this project." };
  if (!access.canWrite) return { error: "Your role can read this conversation but not work on it." };
  return { session: granted.session, ref };
}

/** Session + validated ref for a read (polling). Refuses as "nothing to show", never a redirect. */
async function forRead(refInput: unknown): Promise<{ session: Session; ref: ConversationRef } | Fail> {
  const ref = parseConversationRef(refInput);
  if (!ref) return { error: "That conversation could not be found." };
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return { error: granted.denied };
  const access = await resolveWorkspaceAccess(granted.session, ref);
  if (!access?.copilot) return { error: "Nothing to show." };
  return { session: granted.session, ref };
}

// ── Notes ────────────────────────────────────────────────────────────────────────────────────────

export async function addConversationNote(refInput: unknown, bodyInput: string): Promise<{ note: WorkspaceNote } | Fail> {
  const w = await forWrite(refInput, "collaboration");
  if ("error" in w) return w;
  const body = String(bodyInput ?? "").trim();
  if (!body) return { error: "Write the note first." };
  if (body.length > MAX_NOTE_LENGTH) return { error: `A note can be at most ${MAX_NOTE_LENGTH.toLocaleString()} characters.` };
  const people = await mentionablePeople(w.session.userId);
  const mentionedUserIds = extractNoteMentions(body, people).filter((id) => id !== w.session.userId);
  const created = await prisma.conversationNote.create({
    data: { projectId: await activeProjectId(), ...conversationRefColumns(w.ref), body, mentionedUserIds, authorId: w.session.userId },
    select: { id: true, body: true, authorId: true, mentionedUserIds: true, createdAt: true },
  });
  return { note: { ...created, authorName: w.session.name, createdAt: created.createdAt.toISOString() } };
}

/** Only the author removes a note. Soft delete: the row stays for the audit trail. */
export async function deleteConversationNote(noteId: string): Promise<{ ok: true } | Fail> {
  const note = await prisma.conversationNote.findFirst({
    where: { id: String(noteId), deletedAt: null },
    select: { id: true, authorId: true, accountId: true, chatId: true, channelConversationId: true },
  });
  if (!note) return { error: "That note is already gone." };
  const ref: ConversationRef = note.channelConversationId
    ? { kind: "channel", conversationId: note.channelConversationId }
    : { kind: "whatsapp", accountId: note.accountId!, chatId: note.chatId! };
  const w = await forWrite(ref, "collaboration");
  if ("error" in w) return w;
  if (note.authorId !== w.session.userId) return { error: "Only the person who wrote a note can delete it." };
  await prisma.conversationNote.updateMany({ where: { id: note.id, deletedAt: null }, data: { deletedAt: new Date(), deletedById: w.session.userId } });
  await logSystemEvent("INFO", "inbox", "Conversation note deleted", { noteId: note.id }, { actorUserId: w.session.userId, targetType: "ConversationNote", targetId: note.id });
  return { ok: true };
}

// ── Priority, tags, Team ─────────────────────────────────────────────────────────────────────────

async function upsertLabel(ref: ConversationRef, userId: string, data: { priority?: ConversationPriorityValue; tags?: string[] }) {
  const existing = await prisma.conversationLabel.findFirst({ where: refWhere(ref), select: { id: true } });
  if (existing) {
    await prisma.conversationLabel.update({ where: { id: existing.id }, data: { ...data, updatedById: userId } });
    return;
  }
  try {
    await prisma.conversationLabel.create({
      data: { projectId: await activeProjectId(), ...conversationRefColumns(ref), ...data, updatedById: userId },
    });
  } catch (err) {
    // Two people labelling the same conversation at once: the partial unique index lets one create
    // win; the other becomes an update of that row.
    if ((err as { code?: string }).code !== "P2002") throw err;
    await prisma.conversationLabel.updateMany({ where: refWhere(ref), data: { ...data, updatedById: userId } });
  }
}

export async function setConversationPriority(refInput: unknown, priority: string): Promise<{ ok: true } | Fail> {
  if (!isConversationPriority(priority)) return { error: "Choose a priority from the list." };
  const w = await forWrite(refInput, "collaboration");
  if ("error" in w) return w;
  await upsertLabel(w.ref, w.session.userId, { priority });
  return { ok: true };
}

export async function setConversationTags(refInput: unknown, tagsInput: string[]): Promise<{ tags: string[] } | Fail> {
  const w = await forWrite(refInput, "collaboration");
  if ("error" in w) return w;
  const tags = normaliseConversationTags(Array.isArray(tagsInput) ? tagsInput.map(String) : []);
  await upsertLabel(w.ref, w.session.userId, { tags });
  return { tags };
}

/** Messenger / Instagram / Telegram only: which Team owns the conversation (null = none). */
export async function setChannelConversationTeam(conversationId: string, teamId: string | null): Promise<{ ok: true } | Fail> {
  const w = await forWrite({ kind: "channel", conversationId }, "collaboration");
  if ("error" in w) return w;
  if (teamId) {
    const team = await prisma.team.findFirst({ where: { id: String(teamId) }, select: { id: true } });
    if (!team) return { error: "That Team no longer exists." };
  }
  await prisma.channelConversation.updateMany({ where: { id: conversationId }, data: { assignedTeamId: teamId || null } });
  return { ok: true };
}

// ── AI Copilot ───────────────────────────────────────────────────────────────────────────────────

/** One person's requests per hour, across conversations: the copilot's spending guard. */
const COPILOT_HOURLY_LIMIT = 40;

export async function requestCopilot(
  refInput: unknown,
  mode: "ASSIST" | "DRAFT" | "REWRITE",
  options: { instruction?: string; baseText?: string } = {},
): Promise<{ draft: WorkspaceDraft } | Fail> {
  if (mode !== "ASSIST" && mode !== "DRAFT" && mode !== "REWRITE") return { error: "Unknown Copilot request." };
  const w = await forWrite(refInput, "copilot");
  if ("error" in w) return w;

  let instruction: string | null = null;
  let baseText: string | null = null;
  if (mode === "REWRITE") {
    if (!isCopilotRewriteInstruction(options.instruction)) return { error: "Choose how to rewrite it." };
    baseText = String(options.baseText ?? "").trim();
    if (!baseText) return { error: "There is no text to rewrite yet." };
    if (baseText.length > 4000) return { error: "That text is too long to rewrite (4,000 characters at most)." };
    instruction = options.instruction;
  }

  const where = refWhere(w.ref);
  // One request in flight per person per conversation: a double click asks once.
  const inFlight = await prisma.aiDraft.findFirst({
    where: { ...where, requestedById: w.session.userId, status: { in: ["PENDING", "PROCESSING"] } },
    select: { id: true },
  });
  if (inFlight) return { error: "The Copilot is still working on your last request." };
  const lastHour = await prisma.aiDraft.count({ where: { requestedById: w.session.userId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
  if (lastHour >= COPILOT_HOURLY_LIMIT) return { error: `You have used the Copilot ${COPILOT_HOURLY_LIMIT} times in the last hour. Try again a little later.` };

  // The database decides "one active request per person per conversation" (partial unique index
  // AiDraft_one_active_*): of two concurrent requests exactly one is inserted, so a double click never
  // pays for two AI calls. The findFirst above is only the friendly fast path.
  let created;
  try {
    created = await prisma.aiDraft.create({
      data: { projectId: await activeProjectId(), ...conversationRefColumns(w.ref), mode, instruction, baseText, requestedById: w.session.userId },
      select: DRAFT_SELECT,
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { error: "The Copilot is still working on your last request." };
    throw err;
  }
  return { draft: toWorkspaceDraft(created) };
}

/** Stops the asker's own request that has not finished. A call already sent to the provider may still
 *  be billed; its answer is discarded (the worker writes a result only while the row is PROCESSING). */
export async function cancelCopilotRequest(draftId: string): Promise<{ ok: true } | Fail> {
  const draft = await ownDraft(draftId);
  if (!draft) return { error: "That request is gone." };
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return { error: granted.denied };
  const done = await prisma.aiDraft.updateMany({
    where: { id: draft.id, requestedById: granted.session.userId, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "CANCELLED", reason: "Cancelled by you.", completedAt: new Date(), leaseExpiresAt: null },
  });
  if (done.count === 0) return { error: "It already finished, or it is someone else's request." };
  return { ok: true };
}

/** Polled by the panel while a request is in flight. */
export async function readCopilotDrafts(refInput: unknown): Promise<{ drafts: WorkspaceDraft[] } | Fail> {
  const r = await forRead(refInput);
  if ("error" in r) return r;
  return { drafts: await loadDrafts(r.ref) };
}

async function ownDraft(draftId: string) {
  const draft = await prisma.aiDraft.findFirst({
    where: { id: String(draftId) },
    select: { id: true, accountId: true, chatId: true, channelConversationId: true },
  });
  if (!draft) return null;
  const ref: ConversationRef = draft.channelConversationId
    ? { kind: "channel", conversationId: draft.channelConversationId }
    : { kind: "whatsapp", accountId: draft.accountId!, chatId: draft.chatId! };
  const w = await forWrite(ref, "copilot");
  return "error" in w ? null : draft;
}

/** The agent put this draft into the composer (acceptance is measured from this). */
export async function markCopilotDraftUsed(draftId: string): Promise<void> {
  const draft = await ownDraft(draftId);
  if (draft) await prisma.aiDraft.updateMany({ where: { id: draft.id, usedAt: null }, data: { usedAt: new Date() } });
}

export async function rateCopilotDraft(draftId: string, rating: "UP" | "DOWN" | null): Promise<{ ok: true } | Fail> {
  if (rating !== "UP" && rating !== "DOWN" && rating !== null) return { error: "Unknown rating." };
  const draft = await ownDraft(draftId);
  if (!draft) return { error: "That suggestion is gone." };
  await prisma.aiDraft.updateMany({ where: { id: draft.id }, data: { feedback: rating } });
  return { ok: true };
}
