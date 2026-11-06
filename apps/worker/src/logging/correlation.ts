import { prisma } from "../db.js";
import { messageTraceId } from "./logRef.js";

/**
 * The trace id of the customer message a reply or alert belongs to (P1-07, doc 20 O4): the same
 * `messageTraceId` the pipeline logs and stores on the AI decision, so a System Log entry about a failed
 * reply lands in that message's trail on the Logs page.
 *
 * Read only where a durable entry is written (giving up, refusing), never per send: one indexed lookup.
 * Never throws — a correlation that cannot be found is simply absent, and the entry is still written.
 */
export async function correlationForMessage(messageId: string | null | undefined): Promise<string | null> {
  if (!messageId) return null;
  try {
    const message = await prisma.message.findFirst({ where: { id: messageId }, select: { accountId: true, whatsappMessageId: true } });
    return message ? messageTraceId(message.accountId, message.whatsappMessageId) : null;
  } catch {
    return null;
  }
}
