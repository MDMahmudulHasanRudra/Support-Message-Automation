import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isVisitorId, planVisitorAttachment, WEBCHAT_ATTACHMENT_MAX_BYTES, type ChannelAttachment } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { getMediaStorage } from "@/server/mediaStorage";
import { ChannelReplyError, queueChannelReply } from "@/server/channels/replies";

/**
 * An agent sends a PHOTO to a website chat visitor (Website Chat V3). A Route Handler rather than an action because
 * it carries a file. The same checks as a typed reply (`conversations.reply`, Omnichannel, the conversation read
 * through the project-scoped client, the connection usable), the type read from the BYTES (JPEG / PNG / WebP only,
 * never a PDF or anything else from this side), and then the ordinary send queue: ONE `ChannelMessage` with the
 * photo, keyed by the composer's nonce so a double click or a retry never sends two. The file is stored in that
 * visitor's own folder, so the visitor reads it back with their token and agents through the attachment route.
 */
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const access = await checkPermission("conversations.reply", "OMNICHANNEL");
  if ("denied" in access) return json({ error: access.denied }, 403);
  const { conversationId } = await params;
  if (Number(request.headers.get("content-length") ?? 0) > WEBCHAT_ATTACHMENT_MAX_BYTES + 64_000) return json({ error: "Photos can be at most 10 MB." }, 413);

  const conversation = await prisma.channelConversation.findFirst({ where: { id: conversationId }, select: { id: true, type: true, externalThreadId: true } });
  if (!conversation) return json({ error: "That conversation no longer exists." }, 404);
  if (conversation.type !== "WEBCHAT" || !isVisitorId(conversation.externalThreadId)) return json({ error: "Photos can be sent only in website chat conversations." }, 400);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "The photo could not be read. Try again." }, 400);
  }
  const file = form.get("file");
  const nonce = String(form.get("nonce") ?? "");
  const caption = String(form.get("text") ?? "");
  if (!(file instanceof File)) return json({ error: "Choose a photo first." }, 400);
  if (file.size > WEBCHAT_ATTACHMENT_MAX_BYTES) return json({ error: "Photos can be at most 10 MB." }, 413);
  const bytes = Buffer.from(await file.arrayBuffer());
  const plan = planVisitorAttachment({ head: new Uint8Array(bytes.subarray(0, 64)), fileName: file.name || "photo", size: bytes.length, allowPdf: false });
  if (!plan.ok || plan.type !== "IMAGE") return json({ error: plan.ok ? "Only photos (JPEG, PNG or WebP) can be sent here." : plan.error }, 415);

  const storage = getMediaStorage();
  if (!storage) return json({ error: "Media storage is not set up on this server (MEDIA_STORAGE_DIR)." }, 503);
  const ext = plan.mimeType === "image/png" ? "png" : plan.mimeType === "image/webp" ? "webp" : "jpg";
  const storageKey = `webchat/${await activeProjectId()}/${conversation.externalThreadId}/${randomBytes(16).toString("hex")}.${ext}`; // hex: a storage segment must start with a letter or digit
  await storage.put(storageKey, bytes, { maxBytes: WEBCHAT_ATTACHMENT_MAX_BYTES });
  const attachment: ChannelAttachment = { type: "IMAGE", name: plan.fileName.slice(0, 120), storageKey, mimeType: plan.mimeType, size: bytes.length };
  try {
    const result = await queueChannelReply({ conversationId: conversation.id, text: caption, nonce, userId: access.session.userId, attachments: [attachment] });
    // A repeated nonce is the reply already queued: this copy of the file is not needed.
    if (result.duplicate) await storage.delete(storageKey).catch(() => undefined);
    return json({ ok: true, messageId: result.messageId, duplicate: result.duplicate }, 202);
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined);
    if (err instanceof ChannelReplyError) return json({ error: err.message }, 400);
    console.error("[webchat] agent photo failed", (err as Error).name);
    return json({ error: "Something went wrong on the server. The photo was not sent — try again." }, 500);
  }
}
