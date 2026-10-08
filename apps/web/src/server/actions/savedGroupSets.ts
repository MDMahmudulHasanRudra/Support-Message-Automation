"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";

import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * Saved selections of groups, for the hundred you pick every time there is maintenance.
 *
 * Nothing here sends anything or changes a group. A set is a bookmark: saving one records which
 * ids were chosen, loading one hands them back, and every existing gate — membership
 * verification, the job cap, the duplicate-group cooldown, the confirmation step — still stands
 * between it and a message going out.
 */

export interface SavedGroupSetResult {
  error?: string;
  id?: string;
}

const MAX_NAME = 60;

export async function createSavedGroupSet(name: string, groupIds: string[]): Promise<SavedGroupSetResult> {
  const granted = await checkPermission("bulk_messaging.manage");
  if ("denied" in granted) return { error: granted.denied };
  const session = granted.session;

  const trimmed = name.replace(/\s+/g, " ").trim();
  if (!trimmed) return { error: "Give the set a name." };
  if (trimmed.length > MAX_NAME) return { error: `Keep the name under ${MAX_NAME} characters.` };

  const ids = [...new Set(groupIds.filter(Boolean))];
  if (ids.length === 0) return { error: "Select some groups first — there is nothing to save." };

  try {
    const created = await prisma.savedGroupSet.create({
      data: { name: trimmed, groupIds: ids, createdById: session.userId },
    });
    await logSystemEvent("INFO", "bulk-messaging", `Saved group set "${trimmed}" created`, {
      groups: ids.length,
      createdBy: session.username,
    });
    revalidatePath(await projectPath("/group-message-sender"));
    return { id: created.id };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return { error: `A set called "${trimmed}" already exists. Rename it or update that one.` };
    }
    throw err;
  }
}

/** Overwrites an existing set with the current selection — "update this one to what I have now". */
export async function replaceSavedGroupSet(id: string, groupIds: string[]): Promise<SavedGroupSetResult> {
  const granted = await checkPermission("bulk_messaging.manage");
  if ("denied" in granted) return { error: granted.denied };

  const ids = [...new Set(groupIds.filter(Boolean))];
  if (ids.length === 0) return { error: "Select some groups first — there is nothing to save." };

  try {
    await prisma.savedGroupSet.update({ where: { id }, data: { groupIds: ids } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") return { error: "That set no longer exists." };
    throw err;
  }

  revalidatePath(await projectPath("/group-message-sender"));
  return { id };
}

export async function deleteSavedGroupSet(id: string): Promise<SavedGroupSetResult> {
  const granted = await checkPermission("bulk_messaging.manage");
  if ("denied" in granted) return { error: granted.denied };
  await prisma.savedGroupSet.deleteMany({ where: { id } });
  revalidatePath(await projectPath("/group-message-sender"));
  return {};
}

export interface LoadedGroupSet {
  error?: string;
  /** Ids that still resolve to a selectable group on this account. */
  usable?: string[];
  /** Saved ids that no longer resolve — deleted, resynced away, or on another account. */
  missing?: number;
}

/**
 * Resolves a saved set against what exists now.
 *
 * A snapshot goes stale, and the honest handling is to say so rather than send to eighty groups
 * under the name of a set that once meant a hundred. The count is reported; the choice of whether
 * that still constitutes the intended audience belongs to the person about to broadcast.
 */
export async function loadSavedGroupSet(id: string, accountId: string): Promise<LoadedGroupSet> {
  const granted = await checkPermission("bulk_messaging.view");
  if ("denied" in granted) return { error: granted.denied };

  const set = await prisma.savedGroupSet.findUnique({ where: { id }, select: { groupIds: true } });
  if (!set) return { error: "That set no longer exists." };

  // Scoped to the account and to active groups, because both are reasons a saved id is no longer
  // a valid target — and sending to a group this account has left fails at the queue anyway.
  const rows = await prisma.whatsAppGroup.findMany({
    where: { id: { in: set.groupIds }, accountId, isActive: true },
    select: { id: true },
  });

  return { usable: rows.map((row) => row.id), missing: set.groupIds.length - rows.length };
}
