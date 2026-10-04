"use server";

import { WHATSAPP_OPERATION_KINDS, type WhatsAppOperation, type WhatsAppOperationKind } from "@support-automation/shared";
import { checkPermission } from "@/server/authorize";
import { listWhatsAppOperations } from "@/server/whatsappOperations";

/**
 * The job indicator's reader, polled from every page. A polled reader refuses as "nothing to show",
 * never a redirect (CLAUDE.md, Permissions): without Bulk Messaging view, or in a project without the
 * Bulk Messaging feature, it is simply an empty list. The project comes from the request (the page
 * URL), never from the caller — there is no project, account or job argument to tamper with.
 */
export async function readWhatsAppOperations(kind?: WhatsAppOperationKind): Promise<WhatsAppOperation[]> {
  const granted = await checkPermission("bulk_messaging.view", "BULK_MESSAGING");
  if ("denied" in granted) return [];
  const safeKind = kind && (WHATSAPP_OPERATION_KINDS as readonly string[]).includes(kind) ? kind : undefined;
  return listWhatsAppOperations({ kind: safeKind });
}
