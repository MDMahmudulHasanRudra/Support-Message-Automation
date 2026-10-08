"use server";

import { operationClearLabel, WHATSAPP_OPERATION_KINDS, type WhatsAppOperation, type WhatsAppOperationKind } from "@support-automation/shared";
import { checkPermission } from "@/server/authorize";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { listWhatsAppOperations } from "@/server/whatsappOperations";

/**
 * The job indicator's reader, polled from every page. A polled reader refuses as "nothing to show",
 * never a redirect (CLAUDE.md, Permissions): without Bulk Messaging view, or in a project without the
 * Bulk Messaging feature, it is simply an empty list. The project comes from the request (the page
 * URL), never from the caller — there is no project, account or job argument to tamper with. The
 * viewer is the session's user, so what they cleared stays cleared for them and only for them.
 */
export async function readWhatsAppOperations(kind?: WhatsAppOperationKind): Promise<WhatsAppOperation[]> {
  const granted = await checkPermission("bulk_messaging.view", "BULK_MESSAGING");
  if ("denied" in granted) return [];
  const safeKind = kind && (WHATSAPP_OPERATION_KINDS as readonly string[]).includes(kind) ? kind : undefined;
  return listWhatsAppOperations({ kind: safeKind, viewerId: granted.session.userId });
}

export interface ClearOperationResult {
  error?: string;
  /** "Clear" or "Hide" — what happened, in the operator's words. */
  action?: "Clear" | "Hide";
}

const isKind = (kind: string): kind is WhatsAppOperationKind => (WHATSAPP_OPERATION_KINDS as readonly string[]).includes(kind);

/**
 * Clears one operation from the CALLER's own tracker — the job indicator and the module page's
 * "Current operation" — and nothing else. It never cancels, pauses, undoes or deletes: the job keeps
 * running if it was running, its review and results stay where they are, and its page still opens.
 * Cancel is a separate action on that page.
 *
 * Nothing from the browser is trusted beyond the two ids: the user is the session's, the project is
 * the URL's, and the job is looked up through the scoped client — another project's job is "not
 * found" — and must be one the tracker actually shows, in the state it is recorded as cleared in.
 */
export async function clearWhatsAppOperation(kind: string, jobId: string): Promise<ClearOperationResult> {
  const granted = await checkPermission("bulk_messaging.view", "BULK_MESSAGING");
  if ("denied" in granted) return { error: granted.denied };
  if (!isKind(kind) || typeof jobId !== "string" || !jobId) return { error: "That operation could not be found." };

  const op = (await listWhatsAppOperations({ kind })).find((o) => o.id === jobId);
  if (!op) return { error: "That operation is no longer in the tracker. Its page still has every result." };

  const projectId = await activeProjectId();
  await prisma.whatsAppOperationDismissal.upsert({
    where: { projectId_userId_kind_jobId: { projectId, userId: granted.session.userId, kind, jobId } },
    create: { projectId, userId: granted.session.userId, kind, jobId, stateAtDismissal: op.state },
    update: { stateAtDismissal: op.state, dismissedAt: new Date() },
  });
  return { action: operationClearLabel(op.state) };
}

/** Puts a cleared operation back in the caller's tracker (their own dismissal only). */
export async function restoreWhatsAppOperation(kind: string, jobId: string): Promise<ClearOperationResult> {
  const granted = await checkPermission("bulk_messaging.view", "BULK_MESSAGING");
  if ("denied" in granted) return { error: granted.denied };
  if (!isKind(kind) || typeof jobId !== "string") return { error: "That operation could not be found." };
  await prisma.whatsAppOperationDismissal.deleteMany({ where: { userId: granted.session.userId, kind, jobId } });
  return {};
}
