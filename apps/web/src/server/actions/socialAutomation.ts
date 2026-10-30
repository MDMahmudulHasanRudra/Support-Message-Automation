"use server";

import { revalidatePath } from "next/cache";
import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { projectPath } from "@/server/projectPaths";
import { deleteFeed, runFeed, saveFeed } from "@/server/social/rss";
import { SocialRefusal } from "@/server/social/posts";

/**
 * Social Studio automation (SOCIAL_STUDIO.md §Automation): RSS feeds that make drafts. `social.manage`,
 * bound to the Automation page — a feed decides what drafts appear for a project's accounts.
 */

export interface SocialAutomationState {
  error?: string;
  success?: string;
}

const GATE = { feature: "SOCIAL_STUDIO" as const, sections: ["/social/automation"] };

async function refresh() {
  revalidatePath(await projectPath("/social/automation"));
}

export async function saveSocialFeedAction(_prev: SocialAutomationState, form: FormData): Promise<SocialAutomationState> {
  const access = await checkPermission("social.manage", GATE);
  if ("denied" in access) return { error: access.denied };
  try {
    const saved = await saveFeed(
      {
        id: String(form.get("id") ?? "") || undefined,
        name: String(form.get("name") ?? ""),
        url: String(form.get("url") ?? ""),
        accountIds: form.getAll("account").map(String),
        prefix: String(form.get("prefix") ?? "") || null,
        includeSummary: form.get("includeSummary") === "on",
        intervalMinutes: Number(form.get("intervalMinutes") ?? 360),
        enabled: form.get("enabled") === "on",
      },
      access.session.username,
    );
    await logSystemEvent("INFO", "social", "Social Studio RSS feed saved", {}, { actorUserId: access.session.userId, targetType: "SocialRssFeed", targetId: saved.id });
    await refresh();
    return { success: "Saved. Only items published from now on become drafts." };
  } catch (err) {
    if (err instanceof SocialRefusal) return { error: err.message };
    throw err;
  }
}

export async function runSocialFeedAction(id: string): Promise<SocialAutomationState> {
  const access = await checkPermission("social.manage", GATE);
  if ("denied" in access) return { error: access.denied };
  const result = await runFeed(String(id));
  await refresh();
  revalidatePath(await projectPath("/social/posts"));
  if (result.error) return { error: result.error };
  return { success: result.drafts ? `${result.drafts} new draft(s).` : "No new items." };
}

export async function deleteSocialFeedAction(id: string): Promise<SocialAutomationState> {
  const access = await checkPermission("social.manage", GATE);
  if ("denied" in access) return { error: access.denied };
  try {
    await deleteFeed(String(id));
    await refresh();
    return { success: "Deleted. Drafts it made are kept." };
  } catch (err) {
    if (err instanceof SocialRefusal) return { error: err.message };
    throw err;
  }
}
