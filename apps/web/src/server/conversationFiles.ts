import { Prisma } from "@prisma/client";
import { isWebchatStorageKey, type ChannelAttachment, type ConversationRef } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";

/**
 * Every attachment of one conversation, newest first, for the side panel's Files tab (INBOX_WORKSPACE.md §Files).
 * It reads what the thread already shows, through the project-scoped client, and each link goes to the same checked
 * route the thread uses, so it opens nothing new. Storage keys never leave this file. A message deleted for everyone
 * keeps its row, but its file is not listed, as the thread does not offer it.
 */

const MAX_FILES = 200;

export interface ConversationFile {
  id: string;
  kind: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "OTHER";
  name: string | null;
  sizeBytes: number | null;
  at: string;
  /** Null when there is nothing to open here (not downloaded yet, or held by the provider). */
  href: string | null;
  /** Why there is no link, in words. */
  note: string | null;
}

const WHATSAPP_KIND: Record<string, ConversationFile["kind"]> = { IMAGE: "IMAGE", GIF: "IMAGE", STICKER: "IMAGE", VIDEO: "VIDEO", AUDIO: "AUDIO", DOCUMENT: "DOCUMENT" };
const CHANNEL_KIND: Record<string, ConversationFile["kind"]> = { IMAGE: "IMAGE", VIDEO: "VIDEO", AUDIO: "AUDIO", FILE: "DOCUMENT", DOCUMENT: "DOCUMENT" };

export async function loadConversationFiles(ref: ConversationRef): Promise<ConversationFile[]> {
  if (ref.kind === "whatsapp") {
    const base = await projectPath("/api/whatsapp/media");
    const rows = await prisma.messageMedia.findMany({
      where: { accountId: ref.accountId, status: { not: "DELETED" }, message: { chatId: ref.chatId, revokedAt: null } },
      orderBy: [{ message: { timestampWa: "desc" } }, { id: "desc" }],
      take: MAX_FILES,
      select: { id: true, mediaType: true, fileName: true, sizeBytes: true, declaredSizeBytes: true, status: true, message: { select: { timestampWa: true } } },
    });
    return rows.map((r) => {
      const stored = r.status === "STORED";
      const size = r.sizeBytes ?? r.declaredSizeBytes;
      return {
        id: r.id,
        kind: WHATSAPP_KIND[r.mediaType] ?? "OTHER",
        name: r.fileName,
        sizeBytes: size === null ? null : Number(size),
        at: r.message.timestampWa.toISOString(),
        href: stored ? `${base}/${r.id}` : null,
        note: stored ? null : "Not stored here",
      };
    });
  }

  const base = await projectPath("/api/channels/attachment");
  const projectId = await activeProjectId();
  const rows = await prisma.channelMessage.findMany({
    where: { conversationId: ref.conversationId, attachments: { not: Prisma.AnyNull } },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: MAX_FILES,
    select: { id: true, occurredAt: true, attachments: true },
  });
  const files: ConversationFile[] = [];
  for (const row of rows) {
    const list = Array.isArray(row.attachments) ? (row.attachments as unknown as ChannelAttachment[]) : [];
    list.forEach((a, index) => {
      // A visitor's file is stored here; another channel's is a provider link (Meta's expire), and only http(s) is a link.
      const stored = a.storageKey && isWebchatStorageKey(a.storageKey, projectId) ? `${base}/${row.id}/${index}` : null;
      const href = stored ?? (a.url && /^https?:\/\//i.test(a.url) ? a.url : null);
      files.push({
        id: `${row.id}:${index}`,
        kind: CHANNEL_KIND[a.type] ?? "OTHER",
        name: a.name ?? null,
        sizeBytes: typeof a.size === "number" ? a.size : null,
        at: row.occurredAt.toISOString(),
        href,
        note: href ? null : "Held by the channel",
      });
    });
  }
  return files.slice(0, MAX_FILES);
}
