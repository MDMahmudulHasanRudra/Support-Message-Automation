"use server";

import { revalidatePath } from "next/cache";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { CloudTemplateError, queueCloudTemplate, syncCloudTemplates, usableTemplates } from "@/server/channels/cloudTemplates";

/** WhatsApp (Official API) templates (WHATSAPP_OFFICIAL.md). */

const FEATURE = "WHATSAPP_OFFICIAL" as const;
type Fail = { error: string };

export async function syncTemplatesAction(connectionId: string): Promise<{ count: number } | Fail> {
  const access = await checkPermission("channels.manage", FEATURE);
  if ("denied" in access) return { error: access.denied };
  try {
    const result = await syncCloudTemplates(connectionId);
    revalidatePath(await projectPath(`/settings/channels/${connectionId}`));
    return result;
  } catch (err) {
    if (err instanceof CloudTemplateError) return { error: err.message };
    throw err;
  }
}

export async function listTemplatesAction(conversationId: string) {
  const access = await checkPermission("messages.view", FEATURE);
  if ("denied" in access) return [];
  return usableTemplates(conversationId);
}

/** One template to one person, by a person. Meta charges for it, which is why the button says so first. */
export async function sendTemplateAction(input: { conversationId: string; templateId: string; params: string[]; nonce: string }): Promise<{ ok: true } | Fail> {
  const access = await checkPermission("conversations.reply", FEATURE);
  if ("denied" in access) return { error: access.denied };
  try {
    const r = await queueCloudTemplate({ ...input, params: Array.isArray(input.params) ? input.params : [], userId: access.session.userId });
    if (!r.duplicate) await logSystemEvent("INFO", "channels", "WhatsApp template queued", { conversationId: input.conversationId, messageId: r.messageId }, { actorUserId: access.session.userId });
    revalidatePath(await projectPath(`/conversations/whatsapp-official/c/${input.conversationId}`));
    return { ok: true };
  } catch (err) {
    if (err instanceof CloudTemplateError) return { error: err.message };
    throw err;
  }
}
