"use server";

import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { hasPermission } from "@/server/permissions";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { mentionablePeople } from "@/server/inboxWorkspace";
import { assignChannelConversation, assignChannelConversationTeam, setChannelConversationStatus } from "@/server/channels/replies";
import {
  conversationRefColumns,
  isConversationPriority,
  isInboxScope,
  normaliseConversationTags,
  parseConversationRef,
  parseInboxFilterSet,
  SAVED_VIEW_NAME_MAX,
  type ConversationRef,
  type InboxFilterSet,
} from "@support-automation/shared";

/**
 * Unified inbox list-level actions (INBOX_WORKSPACE.md § Inbox): saved views, @mention notifications
 * and bulk changes. Reading needs messages.view with OMNICHANNEL on; every change re-checks the
 * reply key of each conversation's own module, and nothing here ever sends a message.
 */

type Fail = { error: string };

// ── Saved views ──────────────────────────────────────────────────────────────────────────────────

export interface SavedInboxView {
  id: string;
  name: string;
  shared: boolean;
  scope: string;
  filters: InboxFilterSet;
  mine: boolean;
  pinned: boolean;
  isDefault: boolean;
}

const PREF_KEY = "inbox-saved-views";

async function readPrefs(userId: string): Promise<{ defaultId: string | null; pinned: string[] }> {
  const row = await prisma.listViewPreference.findFirst({ where: { userId, listKey: PREF_KEY }, select: { columns: true } });
  const cols = row?.columns ?? [];
  return {
    defaultId: cols.find((c) => c.startsWith("default:"))?.slice(8) ?? null,
    pinned: cols.filter((c) => c.startsWith("pin:")).map((c) => c.slice(4)),
  };
}

async function writePrefs(userId: string, prefs: { defaultId: string | null; pinned: string[] }) {
  const columns = [...(prefs.defaultId ? [`default:${prefs.defaultId}`] : []), ...prefs.pinned.slice(0, 20).map((id) => `pin:${id}`)];
  const projectId = await activeProjectId();
  await prisma.listViewPreference.upsert({
    where: { projectId_userId_listKey: { projectId, userId, listKey: PREF_KEY } },
    update: { columns },
    create: { projectId, userId, listKey: PREF_KEY, columns },
  });
}

/** The viewer's own views and every shared one, filters re-validated on the way out. */
export async function listSavedInboxViews(): Promise<SavedInboxView[]> {
  const granted = await checkPermission("messages.view", "OMNICHANNEL");
  if ("denied" in granted) return [];
  const userId = granted.session.userId;
  const [rows, prefs] = await Promise.all([
    prisma.inboxSavedView.findMany({ where: { OR: [{ ownerId: userId }, { shared: true }] }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 200 }),
    readPrefs(userId),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    shared: r.shared,
    scope: isInboxScope(r.scope) ? r.scope : "all",
    filters: parseInboxFilterSet(r.filters),
    mine: r.ownerId === userId,
    pinned: prefs.pinned.includes(r.id),
    isDefault: prefs.defaultId === r.id,
  }));
}

/** Create (no id) or update a view. Sharing, and changing a shared view, need channels.manage. */
export async function saveInboxView(input: { id?: string | null; name: string; shared: boolean; scope: string; filters: unknown }): Promise<{ id: string } | Fail> {
  const granted = await checkPermission("messages.view", "OMNICHANNEL");
  if ("denied" in granted) return { error: granted.denied };
  const name = String(input.name ?? "").trim().slice(0, SAVED_VIEW_NAME_MAX);
  if (!name) return { error: "Give the view a name." };
  const scope = isInboxScope(input.scope) ? input.scope : "all";
  const filters = parseInboxFilterSet(input.filters) as unknown as Prisma.InputJsonObject;
  const canShare = await hasPermission(granted.session, "channels.manage");
  if (input.shared && !canShare) return { error: "Only someone who can manage Messaging Channels can share a view with the team." };

  if (input.id) {
    const existing = await prisma.inboxSavedView.findFirst({ where: { id: String(input.id) }, select: { id: true, ownerId: true, shared: true } });
    if (!existing) return { error: "That view no longer exists." };
    const mayEdit = existing.ownerId === granted.session.userId ? !(existing.shared || input.shared) || canShare : existing.shared && canShare;
    if (!mayEdit) return { error: "You can change only your own views (and shared views if you manage Messaging Channels)." };
    await prisma.inboxSavedView.update({ where: { id: existing.id }, data: { name, shared: Boolean(input.shared), scope, filters } });
    return { id: existing.id };
  }
  const count = await prisma.inboxSavedView.count({ where: { ownerId: granted.session.userId } });
  if (count >= 50) return { error: "You already have 50 saved views. Delete one first." };
  const created = await prisma.inboxSavedView.create({
    data: { projectId: await activeProjectId(), ownerId: granted.session.userId, name, shared: Boolean(input.shared), scope, filters },
    select: { id: true },
  });
  return created;
}

export async function deleteInboxView(id: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("messages.view", "OMNICHANNEL");
  if ("denied" in granted) return { error: granted.denied };
  const existing = await prisma.inboxSavedView.findFirst({ where: { id: String(id) }, select: { id: true, ownerId: true, shared: true } });
  if (!existing) return { ok: true };
  const may = existing.ownerId === granted.session.userId ? !existing.shared || (await hasPermission(granted.session, "channels.manage")) : existing.shared && (await hasPermission(granted.session, "channels.manage"));
  if (!may) return { error: "You can delete only your own views." };
  await prisma.inboxSavedView.deleteMany({ where: { id: existing.id } });
  return { ok: true };
}

/** The viewer's pins and default view (a preference only; it never changes what they may see). */
export async function setInboxViewPreference(input: { viewId: string; pinned?: boolean; isDefault?: boolean }): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("messages.view", "OMNICHANNEL");
  if ("denied" in granted) return { error: granted.denied };
  const userId = granted.session.userId;
  const view = await prisma.inboxSavedView.findFirst({ where: { id: String(input.viewId), OR: [{ ownerId: userId }, { shared: true }] }, select: { id: true } });
  if (!view) return { error: "That view no longer exists." };
  const prefs = await readPrefs(userId);
  if (input.pinned !== undefined) prefs.pinned = input.pinned ? [...new Set([...prefs.pinned, view.id])] : prefs.pinned.filter((id) => id !== view.id);
  if (input.isDefault !== undefined) prefs.defaultId = input.isDefault ? view.id : prefs.defaultId === view.id ? null : prefs.defaultId;
  await writePrefs(userId, prefs);
  return { ok: true };
}

// ── @mention notifications ───────────────────────────────────────────────────────────────────────

export interface InboxMentionItem {
  id: string;
  excerpt: string;
  authorName: string;
  href: string;
  conversationTitle: string;
  createdAt: string;
  read: boolean;
}

/**
 * The viewer's mentions, newest first. A mention is shown only while the viewer can still read
 * conversations here (messages.view) and the conversation's module is on; the note excerpt goes to
 * nobody but the person mentioned.
 */
export async function listMyMentions(): Promise<{ unread: number; items: InboxMentionItem[] }> {
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return { unread: 0, items: [] };
  const disabled = await activeDisabledFeatures();
  if (disabled.has("INBOX_COLLABORATION")) return { unread: 0, items: [] };
  const userId = granted.session.userId;
  const [unread, rows] = await Promise.all([
    prisma.inboxMention.count({ where: { userId, readAt: null, note: { deletedAt: null } } }),
    prisma.inboxMention.findMany({
      where: { userId, note: { deletedAt: null } },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        readAt: true,
        createdAt: true,
        note: {
          select: {
            body: true,
            accountId: true,
            chatId: true,
            channelConversationId: true,
            author: { select: { name: true } },
            channelConversation: { select: { title: true, customerName: true, customerUsername: true } },
          },
        },
      },
    }),
  ]);
  const groupKeys = rows.filter((r) => r.note.chatId?.endsWith("@g.us")).map((r) => ({ accountId: r.note.accountId!, whatsappGroupId: r.note.chatId! }));
  const groups = groupKeys.length
    ? await prisma.whatsAppGroup.findMany({ where: { OR: groupKeys }, select: { id: true, accountId: true, whatsappGroupId: true, name: true } })
    : [];
  const groupOf = new Map(groups.map((g) => [`${g.accountId}|${g.whatsappGroupId}`, g]));
  const items: InboxMentionItem[] = [];
  for (const r of rows) {
    const n = r.note;
    let href: string;
    let title: string;
    if (n.channelConversationId) {
      if (disabled.has("OMNICHANNEL")) continue;
      href = `/conversations/all/c/${n.channelConversationId}`;
      title = n.channelConversation?.title ?? n.channelConversation?.customerName ?? (n.channelConversation?.customerUsername ? `@${n.channelConversation.customerUsername}` : "Conversation");
    } else {
      if (disabled.has("WHATSAPP_CHAT")) continue;
      const g = groupOf.get(`${n.accountId}|${n.chatId}`);
      href = g ? `/chat/account/${n.accountId}/${g.id}` : `/chat/account/${n.accountId}/personal/${encodeURIComponent(n.chatId!)}`;
      title = g?.name ?? n.chatId!.split("@")[0]!;
    }
    items.push({ id: r.id, excerpt: n.body.slice(0, 160), authorName: n.author?.name ?? "Someone", href, conversationTitle: title, createdAt: r.createdAt.toISOString(), read: r.readAt !== null });
  }
  return { unread, items };
}

export async function markMentionsRead(ids: string[] | "all"): Promise<void> {
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return;
  await prisma.inboxMention.updateMany({
    where: { userId: granted.session.userId, readAt: null, ...(ids === "all" ? {} : { id: { in: ids.map(String).slice(0, 200) } }) },
    data: { readAt: new Date() },
  });
}

// ── Bulk changes ─────────────────────────────────────────────────────────────────────────────────

export type BulkOp =
  | { op: "priority"; value: string }
  | { op: "addTag"; tag: string }
  | { op: "removeTag"; tag: string }
  | { op: "assignee"; userId: string | null }
  | { op: "team"; teamId: string | null }
  | { op: "status"; status: "OPEN" | "CLOSED" };

export interface BulkResult {
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
  notes: string[];
}

const BULK_MAX = 200;

/**
 * Applies one change to many conversations. Every ref is re-validated against this project, every
 * conversation is checked with its own module's reply key, and the counts say exactly what happened.
 * WhatsApp has no per-conversation assignee or status (ownership is per group, on the Groups page),
 * so those ops skip WhatsApp rows and say so rather than inventing a second owner.
 */
export async function bulkUpdateConversations(refsInput: unknown[], opInput: BulkOp): Promise<BulkResult | Fail> {
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return { error: granted.denied };
  const session = granted.session;
  const refs = (Array.isArray(refsInput) ? refsInput : []).slice(0, BULK_MAX).map(parseConversationRef).filter((r): r is ConversationRef => r !== null);
  if (refs.length === 0) return { error: "Select at least one conversation." };
  const disabled = await activeDisabledFeatures();
  if (disabled.has("INBOX_COLLABORATION") && (opInput.op === "priority" || opInput.op === "addTag" || opInput.op === "removeTag" || opInput.op === "team" || opInput.op === "assignee")) {
    return { error: "Priority, tags and assignment are switched off for this project." };
  }

  const canWhatsApp = !disabled.has("WHATSAPP_CHAT") && (await hasPermission(session, "messages.reply"));
  const canChannel = !disabled.has("OMNICHANNEL") && (await hasPermission(session, "conversations.reply"));
  const result: BulkResult = { changed: 0, unchanged: 0, skipped: 0, failed: 0, notes: [] };
  const note = (s: string) => {
    if (!result.notes.includes(s)) result.notes.push(s);
  };

  // Validate op arguments once.
  let tag: string | null = null;
  if (opInput.op === "addTag" || opInput.op === "removeTag") {
    tag = normaliseConversationTags([String(opInput.tag ?? "")])[0] ?? null;
    if (!tag) return { error: "Type a tag." };
  }
  if (opInput.op === "priority" && !isConversationPriority(opInput.value)) return { error: "Choose a priority." };
  if (opInput.op === "status" && opInput.status !== "OPEN" && opInput.status !== "CLOSED") return { error: "Unknown status." };
  if (opInput.op === "assignee" && opInput.userId) {
    const people = await mentionablePeople(session);
    if (!people.some((p) => p.id === opInput.userId)) return { error: "That person cannot be assigned in this project." };
  }
  if (opInput.op === "team" && opInput.teamId && !(await prisma.team.findFirst({ where: { id: String(opInput.teamId) }, select: { id: true } }))) {
    return { error: "That Team no longer exists." };
  }

  // Which refs exist in THIS project (scoped client), in two queries.
  const channelIds = refs.filter((r) => r.kind === "channel").map((r) => (r as { conversationId: string }).conversationId);
  const waRefs = refs.filter((r): r is Extract<ConversationRef, { kind: "whatsapp" }> => r.kind === "whatsapp");
  const [channelRows, accountRows] = await Promise.all([
    channelIds.length ? prisma.channelConversation.findMany({ where: { id: { in: channelIds } }, select: { id: true } }) : [],
    waRefs.length ? prisma.whatsAppAccount.findMany({ where: { id: { in: [...new Set(waRefs.map((r) => r.accountId))] } }, select: { id: true } }) : [],
  ]);
  const channelExists = new Set(channelRows.map((r) => r.id));
  const accountExists = new Set(accountRows.map((r) => r.id));
  const projectId = await activeProjectId();

  for (const ref of refs) {
    try {
      if (ref.kind === "channel") {
        if (!channelExists.has(ref.conversationId)) {
          result.failed++;
          note("Some conversations no longer exist.");
          continue;
        }
        if (!canChannel) {
          result.skipped++;
          note("Your role cannot change Messenger / Instagram / Telegram conversations.");
          continue;
        }
      } else {
        if (!accountExists.has(ref.accountId)) {
          result.failed++;
          note("Some conversations no longer exist.");
          continue;
        }
        if (!canWhatsApp) {
          result.skipped++;
          note("Your role cannot change WhatsApp conversations.");
          continue;
        }
        if (opInput.op === "assignee" || opInput.op === "team" || opInput.op === "status") {
          result.skipped++;
          note("WhatsApp conversations were left alone: their owner is set per group on the Groups page, and they have no open/closed state.");
          continue;
        }
      }

      if (opInput.op === "priority" || opInput.op === "addTag" || opInput.op === "removeTag") {
        const where = ref.kind === "whatsapp" ? { accountId: ref.accountId, chatId: ref.chatId, channelConversationId: null } : { channelConversationId: ref.conversationId };
        const existing = await prisma.conversationLabel.findFirst({ where, select: { id: true, priority: true, tags: true } });
        const before = { priority: existing?.priority ?? "NONE", tags: existing?.tags ?? [] };
        const next =
          opInput.op === "priority"
            ? { priority: opInput.value as typeof before.priority, tags: before.tags }
            : opInput.op === "addTag"
              ? { priority: before.priority, tags: normaliseConversationTags([...before.tags, tag!]) }
              : { priority: before.priority, tags: before.tags.filter((t) => t !== tag) };
        if (next.priority === before.priority && next.tags.join(",") === before.tags.join(",")) {
          result.unchanged++;
          continue;
        }
        if (existing) await prisma.conversationLabel.update({ where: { id: existing.id }, data: { ...next, updatedById: session.userId } });
        else {
          try {
            await prisma.conversationLabel.create({ data: { projectId, ...conversationRefColumns(ref), ...next, updatedById: session.userId } });
          } catch (err) {
            if ((err as { code?: string }).code !== "P2002") throw err;
            await prisma.conversationLabel.updateMany({ where, data: { ...next, updatedById: session.userId } });
          }
        }
        result.changed++;
      } else if (ref.kind === "channel") {
        const before = await prisma.channelConversation.findFirst({ where: { id: ref.conversationId }, select: { assignedUserId: true, assignedTeamId: true, status: true } });
        if (!before) {
          result.failed++;
          continue;
        }
        if (opInput.op === "assignee") {
          if (before.assignedUserId === opInput.userId) result.unchanged++;
          else {
            await assignChannelConversation(ref.conversationId, opInput.userId, session.userId);
            result.changed++;
          }
        } else if (opInput.op === "team") {
          if (before.assignedTeamId === opInput.teamId) result.unchanged++;
          else {
            await assignChannelConversationTeam(ref.conversationId, opInput.teamId, session.userId);
            result.changed++;
          }
        } else if (opInput.op === "status") {
          if (before.status === opInput.status) result.unchanged++;
          else {
            await setChannelConversationStatus(ref.conversationId, opInput.status, new Date(), session.userId);
            result.changed++;
          }
        }
      }
    } catch (err) {
      console.error("[inbox] bulk change failed for one conversation", err);
      result.failed++;
      note("Some changes failed; try those conversations again.");
    }
  }
  return result;
}
