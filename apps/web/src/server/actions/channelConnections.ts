"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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
import { cancelMetaSession, connectMetaAssets, MetaOAuthError, type MetaConnectOutcome } from "@/server/channels/metaOAuth";

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

// ─── Connect with Facebook (docs/meta-integration) ─────────────────────────────────────────────

/**
 * Save the Pages and Instagram accounts the person ticked on the choice screen. Everything is checked
 * again on the server — the session is theirs, claimed, unexpired; each account is still listed by
 * Meta and connectable — so a ticked box that has gone stale is refused with its reason, not saved.
 */
export async function connectMetaAssetsAction(sessionId: string, keys: string[]): Promise<{ error?: string; outcomes?: MetaConnectOutcome[] }> {
  const access = await checkPermission("channels.manage");
  if ("denied" in access) return { error: access.denied };
  if (typeof sessionId !== "string" || !Array.isArray(keys) || keys.some((k) => typeof k !== "string" || k.length > 120)) return { error: "Choose at least one account." };
  try {
    const outcomes = await connectMetaAssets({ sessionId, userId: access.session.userId, username: access.session.username, keys });
    for (const o of outcomes) {
      await logSystemEvent(o.outcome === "CONNECTED" ? "INFO" : "WARN", "channels", o.outcome === "CONNECTED" ? "Channel connected with Facebook" : "Channel not connected with Facebook", { account: o.name, outcome: o.outcome, reason: o.outcome === "CONNECTED" ? null : o.message }, {
        actorUserId: access.session.userId,
        targetType: "ChannelConnection",
        targetId: o.connectionId ?? undefined,
      });
    }
    // No revalidatePath here: it would re-render the choice screen under the person's feet, and the
    // finished attempt can no longer be opened — the results would vanish. The lists are dynamic pages.
    return { outcomes };
  } catch (err) {
    if (err instanceof MetaOAuthError) return { error: err.message };
    console.error("[channels] connecting with Facebook failed", err);
    return { error: "Connecting failed because of a server error. Nothing more was changed. Check System Logs and try again." };
  }
}

export async function cancelMetaChoiceAction(sessionId: string): Promise<void> {
  const access = await checkPermission("channels.manage");
  if (!("denied" in access) && typeof sessionId === "string") {
    await cancelMetaSession({ sessionId, userId: access.session.userId });
    await logSystemEvent("INFO", "channels", "Facebook connection cancelled on the choice screen", {}, { actorUserId: access.session.userId });
  }
  redirect(await projectPath("/settings/channels"));
}
