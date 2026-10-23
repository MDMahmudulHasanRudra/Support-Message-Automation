import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import {
  buildOutgoingFileKey,
  OUTGOING_CAPTION_MAX,
  OUTGOING_FILE_MAX_BYTES,
  outgoingFileSummary,
  planOutgoingFile,
  type OutgoingFileContent,
  type OutgoingFileMode,
} from "@support-automation/shared";
import { assertValidStorageKey, createMediaStorageFromEnv } from "@support-automation/media-storage";
import { prisma } from "@/server/db";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { logSystemEvent } from "@/server/logSystemEvent";
import { projectPath } from "@/server/projectPaths";
import { isChatUiV2Enabled, resolveConversation } from "@/server/chatThreadV2";
import { CONVERSATION_NOT_FOUND, sendTarget } from "@/server/chatSendTarget";

/**
 * Sends a photo, video, audio file, voice note or document from WhatsApp Chat (CHAT_FILE_SENDING.md).
 *
 * A Route Handler rather than a Server Action because a file is a multipart upload with progress,
 * which an action cannot report. It checks everything a typed reply checks, in the same order —
 * session → `messages.reply` with WHATSAPP_CHAT → CHAT_UI_V2 → the conversation re-derived on the
 * server → the account connected, the group still joined or the personal chat already existing — then
 * the file itself: size, and its type read from its own bytes (`planOutgoingFile`), never from its
 * name or what the browser said. The file goes into media storage under an id-only key, and ONE
 * `OutboundMessage` (MANUAL_REPLY, contentType MEDIA) is queued; the worker re-checks the row and
 * sends it through the one outbound queue. Nothing here talks to WhatsApp.
 */
export const dynamic = "force-dynamic";

type Reply = { ok: true; sentAt: number } | { ok: false; error: string };
const reply = (status: number, body: Reply) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const refuse = (status: number, error: string) => reply(status, { ok: false, error });

const MODES: readonly OutgoingFileMode[] = ["AUTO", "DOCUMENT", "VOICE"];
/** Multipart overhead on top of the file itself. */
const BODY_SLACK = 256 * 1024;
const TOO_LARGE = `The file is larger than ${OUTGOING_FILE_MAX_BYTES / 1024 / 1024} MB. Send a smaller one.`;

function minFreeBytes(): number {
  const mb = Number(process.env.MEDIA_MIN_FREE_DISK_MB ?? 2048);
  return (Number.isFinite(mb) && mb >= 0 ? mb : 2048) * 1024 * 1024;
}

const field = (form: FormData, name: string): string | null => {
  const value = form.get(name);
  return typeof value === "string" && value.length > 0 ? value : null;
};

export async function POST(request: NextRequest) {
  if (!(await getSession())) return refuse(401, "Sign in again to send files.");
  const access = await checkPermission("messages.reply", "WHATSAPP_CHAT");
  if ("denied" in access) return refuse(403, access.denied);
  if (!(await isChatUiV2Enabled())) return refuse(403, "The new conversation view is not switched on for this project, so nothing was sent.");

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > OUTGOING_FILE_MAX_BYTES + BODY_SLACK) return refuse(413, TOO_LARGE);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse(400, "The file did not arrive completely. Try again.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return refuse(400, "Choose a file to send.");
  const uploadId = field(form, "uploadId");
  if (!uploadId || !/^[A-Za-z0-9-]{8,64}$/.test(uploadId)) return refuse(400, "The upload could not be identified. Reload the page and try again.");
  const mode = (field(form, "mode") ?? "AUTO") as OutgoingFileMode;
  if (!MODES.includes(mode)) return refuse(400, "Choose how to send the file.");
  const caption = (field(form, "caption") ?? "").trim();
  if (caption.length > OUTGOING_CAPTION_MAX) return refuse(400, `A caption can be at most ${OUTGOING_CAPTION_MAX} characters.`);

  const conversation = await resolveConversation({
    accountId: field(form, "accountId") ?? "",
    groupId: field(form, "groupId"),
    personalChatId: field(form, "personalChatId"),
  });
  if (!conversation) return refuse(404, CONVERSATION_NOT_FOUND);
  const target = await sendTarget(conversation);
  if (!target.ok) return refuse(409, target.error);

  if (file.size > OUTGOING_FILE_MAX_BYTES) return refuse(413, TOO_LARGE);
  const bytes = Buffer.from(await file.arrayBuffer());
  const plan = planOutgoingFile({ head: bytes.subarray(0, 64), fileName: file.name, size: bytes.byteLength, mode });
  if (!plan.ok) return refuse(415, plan.error);

  const storage = createMediaStorageFromEnv();
  if (!storage) return refuse(503, "File storage is not set up on this server, so files cannot be sent. Ask your administrator to set MEDIA_STORAGE_DIR.");
  const free = await storage.freeBytes().catch(() => null);
  if (free !== null && free - bytes.byteLength < minFreeBytes()) {
    return refuse(507, "The server's storage is nearly full, so the file was not sent. Ask your administrator to free some space.");
  }

  const projectId = await activeProjectId();
  const userId = access.session.userId;
  const storageKey = buildOutgoingFileKey({ projectId, accountId: conversation.accountId, id: randomUUID(), createdAt: new Date() });
  assertValidStorageKey(storageKey);
  try {
    await storage.put(storageKey, bytes, { maxBytes: OUTGOING_FILE_MAX_BYTES });
  } catch (err) {
    await logSystemEvent("ERROR", "chat-inbox", "Failed to store a file to send", { error: (err as Error).message, accountId: conversation.accountId, userId });
    return refuse(500, "The file could not be stored on the server, so nothing was sent. Try again — if it keeps failing, check System Logs.");
  }

  const content: OutgoingFileContent = { storageKey, fileName: plan.fileName, mimeType: plan.mimeType, sizeBytes: bytes.byteLength, kind: plan.kind, caption };
  const where = conversation.kind === "GROUP" ? conversation.groupRowId : `personal:${conversation.accountId}:${conversation.chatId}`;
  try {
    await prisma.outboundMessage.create({
      data: {
        accountId: conversation.accountId,
        chatId: conversation.chatId,
        // The per-client rate limit keys off this, exactly as for a typed reply.
        toPhone: conversation.chatId,
        body: outgoingFileSummary(plan.kind, plan.fileName, caption),
        contentType: "MEDIA",
        content: { ...content },
        actionType: "MANUAL_REPLY",
        // One upload id = one send: a request retried after a dropped response cannot send twice.
        idempotencyKey: `manual-file:${where}:${uploadId}`,
        groupId: target.groupRowId,
        groupNameSnapshot: target.name,
        createdById: userId,
      },
    });
  } catch (err) {
    // Nothing references this stored copy now, so it goes.
    await storage.delete(storageKey).catch(() => undefined);
    if ((err as { code?: string }).code === "P2002") return reply(200, { ok: true, sentAt: Date.now() });
    await logSystemEvent("ERROR", "chat-inbox", "Failed to queue a file", { error: (err as Error).message, accountId: conversation.accountId, userId });
    return refuse(500, "The file could not be queued because of a server error, and nothing was sent. Try again — if it keeps failing, check System Logs.");
  }

  await logSystemEvent("INFO", "chat-inbox", `Queued a ${plan.kind.toLowerCase()} to ${target.name}`, {
    kind: plan.kind,
    mimeType: plan.mimeType,
    sizeBytes: bytes.byteLength,
    accountId: conversation.accountId,
    userId,
  });
  revalidatePath(await projectPath("/chat"), "layout");
  return reply(200, { ok: true, sentAt: Date.now() });
}
