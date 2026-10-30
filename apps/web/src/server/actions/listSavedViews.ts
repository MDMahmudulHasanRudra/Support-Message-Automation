"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { isSavedViewPage, sanitizeViewQuery, SAVED_VIEW_PAGES } from "@/lib/listSavedViews";

/**
 * Saved views on list pages (PROJECT_MODULES.md §Saved views). Saving a personal view needs only the
 * page's view key; sharing it with everyone who opens the page needs the page's manage key. A person
 * deletes their own views; a shared view can also be deleted by anyone who may share.
 */

export interface SavedViewResult {
  error?: string;
  success?: string;
}

const MAX_PER_PAGE = 20;

export async function saveListView(page: string, name: string, query: string, shared: boolean): Promise<SavedViewResult> {
  if (!isSavedViewPage(page)) return { error: "Views cannot be saved on this page." };
  const keys = SAVED_VIEW_PAGES[page];
  const access = await checkPermission(shared ? keys.manage : keys.view);
  if ("denied" in access) return { error: access.denied };
  const clean = String(name ?? "").trim().slice(0, 60);
  if (!clean) return { error: "Name the view." };
  const q = sanitizeViewQuery(page, String(query ?? ""));
  if (!q) return { error: "Choose a filter or search first; there is nothing to save yet." };
  const existing = await prisma.listSavedView.findFirst({ where: { path: page, ownerId: access.session.userId, name: clean }, select: { id: true } });
  if (existing) {
    await prisma.listSavedView.update({ where: { id: existing.id }, data: { query: q, shared: Boolean(shared) } });
  } else {
    if ((await prisma.listSavedView.count({ where: { path: page, ownerId: access.session.userId } })) >= MAX_PER_PAGE) {
      return { error: `You can keep at most ${MAX_PER_PAGE} views on this page. Delete one first.` };
    }
    await prisma.listSavedView.create({ data: { path: page, name: clean, query: q, shared: Boolean(shared), ownerId: access.session.userId } });
  }
  revalidatePath(await projectPath(page));
  return { success: existing ? `View “${clean}” updated.` : `View “${clean}” saved.` };
}

export async function deleteListView(id: string): Promise<SavedViewResult> {
  const view = await prisma.listSavedView.findFirst({ where: { id }, select: { id: true, path: true, ownerId: true, shared: true } });
  if (!view || !isSavedViewPage(view.path)) return { error: "That view no longer exists." };
  const keys = SAVED_VIEW_PAGES[view.path];
  const access = await checkPermission(keys.view);
  if ("denied" in access) return { error: access.denied };
  if (view.ownerId !== access.session.userId) {
    if (!view.shared) return { error: "That view belongs to someone else." };
    const manage = await checkPermission(keys.manage);
    if ("denied" in manage) return { error: "Only someone who can share views on this page can delete a shared view." };
  }
  await prisma.listSavedView.delete({ where: { id: view.id } });
  revalidatePath(await projectPath(view.path));
  return { success: "View deleted." };
}
