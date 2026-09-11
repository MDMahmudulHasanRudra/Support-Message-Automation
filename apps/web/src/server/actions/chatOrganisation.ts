"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { checkChatCategoryName, isChatCategoryColor } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * Organising the chat inbox: categories, pinning, archiving, and the bulk versions of each.
 *
 * Everything here changes what an operator SEES and nothing else. `isMonitored` and
 * `aiAutomationEnabled` are never written from this file — archiving a group must not stop AI
 * answering a customer in it, and a bulk gesture over three hundred rows is exactly where that
 * kind of side effect would go unnoticed until a customer complained.
 *
 * Bulk actions report what they actually did rather than "Done", matching `bulkSetMonitoring`
 * next door: an operator who selected forty groups and saw nothing change needs to know whether
 * they were already in that state or were not found.
 */

export interface ChatOrganisationResult {
  error?: string;
  /** Rows this actually changed. */
  updated?: number;
  /** Rows already in the requested state — not an error, but not work either. */
  unchanged?: number;
}

function revalidateInbox() {
  revalidatePath("/chat");
  revalidatePath("/chat", "layout");
}

/** Shared guard: a bulk action over an empty selection is a no-op, not a failure. */
function normaliseIds(groupIds: string[]): string[] {
  return [...new Set(groupIds.filter(Boolean))];
}

// ---------------------------------------------------------------------------- categories

export async function createChatCategory(formData: FormData): Promise<ChatOrganisationResult> {
  const session = await requireSession();

  const check = checkChatCategoryName(String(formData.get("name") ?? ""));
  if (check.error || !check.name) return { error: check.error };

  const rawColor = String(formData.get("color") ?? "gray");
  const color = isChatCategoryColor(rawColor) ? rawColor : "gray";

  // New categories go to the end rather than the front: the ones already there are the ones
  // being used, and pushing them down on every addition would reshuffle a bar people navigate by
  // muscle memory.
  const last = await prisma.chatCategory.findFirst({ orderBy: { position: "desc" }, select: { position: true } });

  try {
    await prisma.chatCategory.create({
      data: { name: check.name, color, position: (last?.position ?? 0) + 1 },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return { error: `A category called "${check.name}" already exists.` };
    }
    throw err;
  }

  await logSystemEvent("INFO", "chat-inbox", `Chat category "${check.name}" created`, {
    createdBy: session.username,
  });
  revalidateInbox();
  return {};
}

export async function renameChatCategory(id: string, formData: FormData): Promise<ChatOrganisationResult> {
  await requireSession();

  const check = checkChatCategoryName(String(formData.get("name") ?? ""));
  if (check.error || !check.name) return { error: check.error };

  const rawColor = String(formData.get("color") ?? "");
  const color = isChatCategoryColor(rawColor) ? rawColor : undefined;

  try {
    await prisma.chatCategory.update({ where: { id }, data: { name: check.name, ...(color ? { color } : {}) } });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2002") return { error: `A category called "${check.name}" already exists.` };
    if (code === "P2025") return { error: "That category no longer exists." };
    throw err;
  }

  revalidateInbox();
  return {};
}

export async function deleteChatCategory(id: string): Promise<ChatOrganisationResult> {
  const session = await requireSession();

  const category = await prisma.chatCategory.findUnique({
    where: { id },
    select: { name: true, _count: { select: { groups: true } } },
  });
  if (!category) return {};

  // The FK is SET NULL, so the groups survive and simply become uncategorised. Worth saying in
  // the log, because "deleted a category with 40 groups in it" reads alarming without it.
  await prisma.chatCategory.delete({ where: { id } });

  await logSystemEvent("INFO", "chat-inbox", `Chat category "${category.name}" deleted`, {
    groupsUncategorised: category._count.groups,
    deletedBy: session.username,
  });
  revalidateInbox();
  return { updated: category._count.groups };
}

// ---------------------------------------------------------------------------- group actions

export async function setChatCategory(
  groupIds: string[],
  categoryId: string | null,
): Promise<ChatOrganisationResult> {
  await requireSession();
  const ids = normaliseIds(groupIds);
  if (ids.length === 0) return { error: "Select at least one conversation." };

  if (categoryId) {
    const exists = await prisma.chatCategory.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!exists) return { error: "That category no longer exists." };
  }

  // Counted before writing so the result can distinguish "moved 8" from "8 were already there",
  // which is the difference between a bulk action that worked and one that did nothing.
  const alreadyThere = await prisma.whatsAppGroup.count({
    where: { id: { in: ids }, chatCategoryId: categoryId },
  });

  const { count } = await prisma.whatsAppGroup.updateMany({
    where: {
      id: { in: ids },
      // The OR is not defensive noise, it is the whole correctness of this action.
      //
      // `{ not: x }` compiles to `"chatCategoryId" <> x`, and in SQL `NULL <> 'abc'` is NULL
      // rather than TRUE — so the shorthand silently matches no uncategorised row at all.
      // Assigning a category to conversations that had none therefore updated exactly zero rows
      // and reported "0 moved", which is every conversation on a fresh install and was the entire
      // observed symptom. Removing a category still worked, because `{ not: null }` compiles to
      // `IS NOT NULL` and NULL-safety is only a problem when comparing against a value.
      //
      // Verified against a real database, because the intuitive rewrites are also wrong: Prisma
      // 5.22 compiles the `NOT: { chatCategoryId: x }` block form to the same NULL-excluding
      // comparison. Spelling the null case out is what actually works.
      ...(categoryId
        ? { OR: [{ chatCategoryId: null }, { chatCategoryId: { not: categoryId } }] }
        : { chatCategoryId: { not: null } }),
    },
    data: { chatCategoryId: categoryId },
  });

  revalidateInbox();
  return { updated: count, unchanged: alreadyThere };
}

export async function setChatPinned(groupIds: string[], pinned: boolean): Promise<ChatOrganisationResult> {
  await requireSession();
  const ids = normaliseIds(groupIds);
  if (ids.length === 0) return { error: "Select at least one conversation." };

  const alreadyThere = await prisma.whatsAppGroup.count({
    where: { id: { in: ids }, chatPinnedAt: pinned ? { not: null } : null },
  });

  const { count } = await prisma.whatsAppGroup.updateMany({
    where: { id: { in: ids }, chatPinnedAt: pinned ? null : { not: null } },
    // One timestamp for the whole batch, so pinning forty groups keeps them in their existing
    // relative order rather than scrambling them by microsecond.
    data: { chatPinnedAt: pinned ? new Date() : null },
  });

  revalidateInbox();
  return { updated: count, unchanged: alreadyThere };
}

export async function setChatArchived(groupIds: string[], archived: boolean): Promise<ChatOrganisationResult> {
  await requireSession();
  const ids = normaliseIds(groupIds);
  if (ids.length === 0) return { error: "Select at least one conversation." };

  const alreadyThere = await prisma.whatsAppGroup.count({
    where: { id: { in: ids }, chatArchivedAt: archived ? { not: null } : null },
  });

  const { count } = await prisma.whatsAppGroup.updateMany({
    where: { id: { in: ids }, chatArchivedAt: archived ? null : { not: null } },
    data: {
      chatArchivedAt: archived ? new Date() : null,
      // Archiving un-pins: a pinned row is one you want at the top and an archived one is one you
      // want out of sight, and a group that is both would either sit pinned in a list it is
      // supposed to have left, or vanish with a pin nobody can find to remove.
      ...(archived ? { chatPinnedAt: null } : {}),
    },
  });

  revalidateInbox();
  return { updated: count, unchanged: alreadyThere };
}


/**
 * Records that somebody opened this conversation, which clears it from the "waiting" filter.
 *
 * Called from the thread page via `after()`, so it runs once the page has already been sent — the
 * reader never waits on it, and a failed write costs a stale badge rather than a blank screen.
 *
 * Swallows its own errors for that reason. This is a triage convenience; nothing about answering a
 * customer depends on it, and there is no useful way to report the failure to somebody who is
 * already reading the conversation.
 *
 * Deliberately no `revalidatePath`. The list is a layout-level component, and revalidating it on
 * every thread open would re-render the whole inbox each time somebody clicked a conversation —
 * discarding an unsent draft in the composer, which Composer.tsx goes to some trouble to protect.
 * The badge clears on the list's own next refresh, which is four seconds away.
 */
export async function markChatReviewed(groupId: string): Promise<void> {
  try {
    await requireSession();
    await prisma.whatsAppGroup.update({
      where: { id: groupId },
      data: { chatReviewedAt: new Date() },
    });
  } catch {
    /* see above */
  }
}

/**
 * Marks conversations read, or puts them back in the waiting list — the bulk form of what opening
 * one does on its own.
 *
 * Reading a whole morning's messages on a phone and then clearing them here one at a time is the
 * workflow this exists for: the inbox says nine are waiting, you know you have dealt with them,
 * and clicking into nine conversations to tell it so is worse than useless.
 *
 * Safe to do in bulk precisely because the mark is a timestamp rather than a flag. Every one of
 * these conversations comes straight back the moment its customer sends anything else, and any
 * that are still genuinely unanswered keep their hollow ring and stay in the "seen, unanswered"
 * filter. Nothing here can make a customer disappear — it can only stop asking about the ones you
 * have already seen.
 */
export async function setChatReviewed(groupIds: string[], reviewed: boolean): Promise<ChatOrganisationResult> {
  await requireSession();
  const ids = normaliseIds(groupIds);
  if (ids.length === 0) return { error: "Select at least one conversation." };

  if (!reviewed) {
    // Clearing the mark rather than setting a flag, so the ordinary rule simply resumes:
    // unanswered and unreviewed, therefore waiting.
    const alreadyWaiting = await prisma.whatsAppGroup.count({ where: { id: { in: ids }, chatReviewedAt: null } });
    const { count } = await prisma.whatsAppGroup.updateMany({
      where: { id: { in: ids }, chatReviewedAt: { not: null } },
      data: { chatReviewedAt: null },
    });
    revalidateInbox();
    return { updated: count, unchanged: alreadyWaiting };
  }

  // No `chatReviewedAt: null` narrowing on the write. A row already carrying a mark can still be
  // waiting — its customer has written since — so skipping those would leave exactly the
  // conversations the operator was trying to clear. (It would also hit the NULL-comparison trap
  // documented in CLAUDE.md.) Re-stamping a row that was already settled changes nothing anybody
  // can see.
  const { count } = await prisma.whatsAppGroup.updateMany({
    where: { id: { in: ids } },
    data: { chatReviewedAt: new Date() },
  });

  revalidateInbox();
  return { updated: count };
}

/** Single-conversation form, for the thread header's undo. */
export async function markChatWaiting(groupId: string): Promise<ChatOrganisationResult> {
  return setChatReviewed([groupId], false);
}
