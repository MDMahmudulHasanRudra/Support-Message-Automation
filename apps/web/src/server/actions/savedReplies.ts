"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

/**
 * The replies operators keep and reuse.
 *
 * Nothing here sends anything. `recordSavedReplyUse` is the only action with a side effect beyond
 * CRUD, and all it does is increment a counter — the text goes into the composer for the person
 * to adjust, and pressing send remains a separate, deliberate act. A picker that sent on click
 * would be a one-tap path to putting the wrong canned message in front of a customer.
 */

export interface SavedReplyResult {
  error?: string;
}

/** Long enough for a real paragraph, short enough that the picker stays scannable. */
const MAX_TITLE = 60;
const MAX_BODY = 2000;

export async function createSavedReply(formData: FormData): Promise<SavedReplyResult> {
  const session = await requireSession();

  const title = String(formData.get("title") ?? "").replace(/\s+/g, " ").trim();
  const body = String(formData.get("body") ?? "").replace(/\r\n/g, "\n").trim();

  if (!title) return { error: "Give the reply a name so you can find it." };
  if (title.length > MAX_TITLE) return { error: `Keep the name under ${MAX_TITLE} characters.` };
  if (!body) return { error: "The reply cannot be empty." };
  if (body.length > MAX_BODY) return { error: `Keep the reply under ${MAX_BODY} characters.` };

  const last = await prisma.savedReply.findFirst({ orderBy: { position: "desc" }, select: { position: true } });

  await prisma.savedReply.create({
    data: { title, body, position: (last?.position ?? 0) + 1, createdById: session.userId },
  });

  revalidatePath("/chat", "layout");
  return {};
}

export async function updateSavedReply(id: string, formData: FormData): Promise<SavedReplyResult> {
  await requireSession();

  const title = String(formData.get("title") ?? "").replace(/\s+/g, " ").trim();
  const body = String(formData.get("body") ?? "").replace(/\r\n/g, "\n").trim();

  if (!title) return { error: "Give the reply a name so you can find it." };
  if (title.length > MAX_TITLE) return { error: `Keep the name under ${MAX_TITLE} characters.` };
  if (!body) return { error: "The reply cannot be empty." };
  if (body.length > MAX_BODY) return { error: `Keep the reply under ${MAX_BODY} characters.` };

  try {
    await prisma.savedReply.update({ where: { id }, data: { title, body } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") return { error: "That reply no longer exists." };
    throw err;
  }

  revalidatePath("/chat", "layout");
  return {};
}

export async function deleteSavedReply(id: string): Promise<SavedReplyResult> {
  await requireSession();
  // deleteMany so removing one somebody else already deleted is a no-op rather than an error.
  await prisma.savedReply.deleteMany({ where: { id } });
  revalidatePath("/chat", "layout");
  return {};
}

/**
 * Counts one use, so the picker can float the replies people actually reach for.
 *
 * Fire-and-forget from the caller's point of view: the text is already in the composer by the
 * time this runs, and a failed counter must never look like a failed insert. It deliberately does
 * not revalidate — re-rendering the whole chat layout to move one row in a picker would throw away
 * whatever the operator had half-typed.
 */
export async function recordSavedReplyUse(id: string): Promise<void> {
  await requireSession();
  await prisma.savedReply.updateMany({ where: { id }, data: { usageCount: { increment: 1 } } });
}
