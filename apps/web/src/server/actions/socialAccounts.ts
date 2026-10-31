"use server";

import { revalidatePath } from "next/cache";
import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { projectPath } from "@/server/projectPaths";
import { disconnectSocialConnection, refreshSocialConnection, setSocialAccountEnabled, SocialAccountError } from "@/server/social/accounts";

/**
 * Social Studio accounts (SOCIAL_STUDIO.md §Accounts). `social.manage`, bound to the Accounts page:
 * connecting, refreshing and disconnecting decide where this project's posts can go.
 */

export interface SocialAccountsState {
  error?: string;
  success?: string;
}

const GATE = { feature: "SOCIAL_STUDIO" as const, sections: ["/social/accounts"] };

async function done(success: string): Promise<SocialAccountsState> {
  revalidatePath(await projectPath("/social/accounts"));
  revalidatePath(await projectPath("/social"));
  return { success };
}

export async function refreshSocialConnectionAction(connectionId: string): Promise<SocialAccountsState> {
  const access = await checkPermission("social.manage", GATE);
  if ("denied" in access) return { error: access.denied };
  try {
    const result = await refreshSocialConnection(String(connectionId));
    if (!result.ok) return { error: result.message };
    return done(result.message);
  } catch (err) {
    if (err instanceof SocialAccountError) return { error: err.message };
    throw err;
  }
}

export async function disconnectSocialConnectionAction(connectionId: string): Promise<SocialAccountsState> {
  const access = await checkPermission("social.manage", GATE);
  if ("denied" in access) return { error: access.denied };
  try {
    const result = await disconnectSocialConnection(String(connectionId));
    await logSystemEvent("WARN", "social", "Social publishing connection disconnected", result, { actorUserId: access.session.userId, targetType: "SocialConnection", targetId: String(connectionId) });
    return done(`Disconnected ${result.accounts} account(s).${result.waiting ? ` ${result.waiting} scheduled publication(s) will fail until they are connected again.` : ""}`);
  } catch (err) {
    if (err instanceof SocialAccountError) return { error: err.message };
    throw err;
  }
}

export async function setSocialAccountEnabledAction(accountId: string, enabled: boolean): Promise<SocialAccountsState> {
  const access = await checkPermission("social.manage", GATE);
  if ("denied" in access) return { error: access.denied };
  try {
    await setSocialAccountEnabled(String(accountId), Boolean(enabled));
    await logSystemEvent("INFO", "social", `Social account ${enabled ? "switched on" : "switched off"} for publishing`, {}, { actorUserId: access.session.userId, targetType: "SocialAccount", targetId: String(accountId) });
    return done(enabled ? "Switched on for publishing." : "Switched off for publishing.");
  } catch (err) {
    if (err instanceof SocialAccountError) return { error: err.message };
    throw err;
  }
}
