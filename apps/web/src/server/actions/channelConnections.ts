"use server";

import { revalidatePath } from "next/cache";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import {
  ChannelConnectionError,
  connectMeta,
  connectTelegram,
  disconnectConnection,
  setConnectionFlags,
  testConnection,
  updateMetaCredentials,
  updateTelegramToken,
  type ConnectionCheck,
} from "@/server/channels/connections";

/**
 * Settings → Messaging Channels (OMNICHANNEL.md §11). Every action needs `channels.manage`, which
 * belongs to the Omnichannel feature. No action returns or logs a token, an app secret or a verify
 * token — the audit trail records what changed and who changed it.
 */

export interface ChannelActionResult {
  error?: string;
  success?: string;
  warning?: string;
  connectionId?: string;
}

const revalidate = async (id?: string) => {
  revalidatePath(await projectPath("/settings/channels"));
  if (id) revalidatePath(await projectPath(`/settings/channels/${id}`));
};

function failure(err: unknown, what: string): ChannelActionResult {
  if (err instanceof ChannelConnectionError) return { error: err.message };
  console.error(`[channels] ${what} failed`, err);
  return { error: `${what} failed because of a server error. Nothing was changed. Check System Logs and try again.` };
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function connectChannelAction(_prev: ChannelActionResult, form: FormData): Promise<ChannelActionResult> {
  const access = await checkPermission("channels.manage");
  if ("denied" in access) return { error: access.denied };
  const type = field(form, "type");
  try {
    const result =
      type === "TELEGRAM"
        ? await connectTelegram({ botToken: field(form, "botToken"), username: access.session.username })
        : type === "MESSENGER" || type === "INSTAGRAM"
          ? await connectMeta({ type, appId: field(form, "appId"), appSecret: field(form, "appSecret"), pageAccessToken: field(form, "pageAccessToken"), username: access.session.username })
          : null;
    if (!result) return { error: "Choose Messenger, Instagram or Telegram." };
    await logSystemEvent(result.warning ? "WARN" : "INFO", "channels", `${type} channel connected`, { status: result.status, warning: result.warning }, {
      actorUserId: access.session.userId,
      targetType: "ChannelConnection",
      targetId: result.id,
    });
    await revalidate(result.id);
    return { success: "Connected.", warning: result.warning ?? undefined, connectionId: result.id };
  } catch (err) {
    if (err instanceof ChannelConnectionError) {
      await logSystemEvent("WARN", "channels", `${type} channel not connected`, { reason: err.message }, { actorUserId: access.session.userId });
    }
    return failure(err, "Connecting");
  }
}

export async function updateChannelCredentialsAction(_prev: ChannelActionResult, form: FormData): Promise<ChannelActionResult> {
  const access = await checkPermission("channels.manage");
  if ("denied" in access) return { error: access.denied };
  const id = field(form, "connectionId");
  const type = field(form, "type");
  try {
    const result =
      type === "TELEGRAM"
        ? await updateTelegramToken(id, { botToken: field(form, "botToken") || null, username: access.session.username })
        : await updateMetaCredentials(id, { appId: field(form, "appId"), appSecret: field(form, "appSecret"), pageAccessToken: field(form, "pageAccessToken"), username: access.session.username });
    await logSystemEvent("WARN", "channels", "Channel credentials updated", { status: result.status, warning: result.warning }, {
      actorUserId: access.session.userId,
      targetType: "ChannelConnection",
      targetId: id,
    });
    await revalidate(id);
    return result.warning ? { warning: result.warning } : { success: type === "TELEGRAM" && !field(form, "botToken") ? "Webhook registered again." : "Credentials saved and accepted." };
  } catch (err) {
    return failure(err, "Saving the credentials");
  }
}

export async function setChannelFlagsAction(id: string, flags: { enabled?: boolean; aiAutomationEnabled?: boolean; humanAgentEnabled?: boolean; name?: string }): Promise<ChannelActionResult> {
  const access = await checkPermission("channels.manage");
  if ("denied" in access) return { error: access.denied };
  try {
    await setConnectionFlags(id, flags);
    await logSystemEvent("INFO", "channels", "Channel settings changed", { ...flags }, { actorUserId: access.session.userId, targetType: "ChannelConnection", targetId: id });
    await revalidate(id);
    return { success: "Saved." };
  } catch (err) {
    return failure(err, "Saving");
  }
}

export async function disconnectChannelAction(id: string): Promise<ChannelActionResult> {
  const access = await checkPermission("channels.manage");
  if ("denied" in access) return { error: access.denied };
  try {
    const { providerNotified } = await disconnectConnection(id);
    await logSystemEvent("WARN", "channels", "Channel disconnected", { providerNotified }, { actorUserId: access.session.userId, targetType: "ChannelConnection", targetId: id });
    await revalidate(id);
    return {
      success: providerNotified
        ? "Disconnected. Its conversations are kept."
        : "Disconnected here and its credentials wiped. The provider could not be told — remove the webhook in its dashboard if messages keep being sent. Conversations are kept.",
    };
  } catch (err) {
    return failure(err, "Disconnecting");
  }
}

export async function testChannelAction(id: string): Promise<ChannelActionResult & { checks?: ConnectionCheck[] }> {
  const access = await checkPermission("channels.manage");
  if ("denied" in access) return { error: access.denied };
  try {
    const result = await testConnection(id);
    await revalidate(id);
    return { success: result.status === "CONNECTED" ? "Everything checked is working." : undefined, warning: result.status === "CONNECTED" ? undefined : "Something needs attention — see below.", checks: result.checks };
  } catch (err) {
    return failure(err, "The check");
  }
}
