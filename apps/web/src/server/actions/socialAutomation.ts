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
  /** What was submitted, sent back with an error: React resets a form after its action, so without it a refusal empties every field. */
  values?: { name: string; url: string; accountIds: string[]; prefix: string; includeSummary: boolean; intervalMinutes: number; enabled: boolean };
}

const GATE = { feature: "SOCIAL_STUDIO" as const, sections: ["/social/automation"] };

async function refresh() {
  revalidatePath(await projectPath("/social/automation"));
}

export async function saveSocialFeedAction(_prev: SocialAutomationState, form: FormData): Promise<SocialAutomationState> {
  const values = {
    name: String(form.get("name") ?? "").slice(0, 200),
    url: String(form.get("url") ?? "").slice(0, 1000),
    accountIds: form.getAll("account").map(String).slice(0, 50),
    prefix: String(form.get("prefix") ?? "").slice(0, 300),
    includeSummary: form.get("includeSummary") === "on",
    intervalMinutes: Number(form.get("intervalMinutes") ?? 360),
    enabled: form.get("enabled") === "on",
  };
  const access = await checkPermission("social.manage", GATE);
  if ("denied" in access) return { error: access.denied, values };
  try {
    const saved = await saveFeed({ id: String(form.get("id") ?? "") || undefined, ...values, prefix: values.prefix || null }, access.session.username);
    await logSystemEvent("INFO", "social", "Social Studio RSS feed saved", {}, { actorUserId: access.session.userId, targetType: "SocialRssFeed", targetId: saved.id });
    await refresh();
    return { success: "Saved. Only items published from now on become drafts." };
  } catch (err) {
    if (err instanceof SocialRefusal) return { error: err.message, values };
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
