"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import {
  parseResponseFilters,
  parseUnansweredFilters,
  responseWhere,
  SUPPORT_RESPONSE_MAX_SELECTION,
  unansweredWhere,
} from "@/server/supportResponse";

/**
 * Messages → Unanswered Groups / Response Time (SUPPORT_RESPONSE.md).
 *
 * Clearing dismisses the CURRENT episode only: its status becomes CLEARED, with who, when and why.
 * No message, group, support activity or response record is touched, and the group is not
 * blacklisted — the next customer message opens a new episode. Gated on `messages.reply`, the key
 * of the people who answer customers (Read Only has only `messages.view`).
 */

export interface ClearResult {
  error?: string;
  cleared?: number;
  /** Already answered or cleared by the time the request ran. */
  skipped?: number;
}

async function clearWhere(ids: string[] | null, query: Record<string, string>, reason: string | undefined, userId: string): Promise<ClearResult> {
  const filters = parseUnansweredFilters(query);
  if (filters.status !== "UNANSWERED") return { error: "Only unanswered groups can be cleared." };
  const base = unansweredWhere(filters, new Date());
  const targets = await prisma.supportResponseEpisode.findMany({
    where: ids ? { AND: [base, { id: { in: ids } }] } : base,
    select: { id: true },
    take: SUPPORT_RESPONSE_MAX_SELECTION,
  });
  const targetIds = targets.map((t) => t.id);
  // Guarded on the status: a Support reply that lands at the same moment wins, and the row stays ANSWERED.
  const { count } = await prisma.supportResponseEpisode.updateMany({
    where: { id: { in: targetIds }, status: "UNANSWERED" },
    data: { status: "CLEARED", clearedAt: new Date(), clearedByUserId: userId, clearReason: reason?.trim().slice(0, 300) || null },
  });
  await logSystemEvent(
    "INFO",
    "support-response",
    `Cleared ${count} unanswered group(s)`,
    { episodeIds: targetIds.slice(0, 200), requested: ids ? ids.length : "all matching", reason: reason?.trim() || null },
    { actorUserId: userId, targetType: "SupportResponseEpisode" },
  );
  revalidatePath(await projectPath("/messages/unanswered"));
  return { cleared: count, skipped: (ids ? ids.length : targetIds.length) - count };
}

/** Clears the chosen episodes (still within the page's filters). */
export async function clearUnansweredEpisodes(input: { ids: string[]; query: Record<string, string>; reason?: string }): Promise<ClearResult> {
  const granted = await checkPermission("messages.reply");
  if ("denied" in granted) return { error: granted.denied };
  const ids = (input.ids ?? []).filter((id) => typeof id === "string").slice(0, SUPPORT_RESPONSE_MAX_SELECTION);
  if (ids.length === 0) return { error: "Select at least one group to clear." };
  return clearWhere(ids, input.query ?? {}, input.reason, granted.session.userId);
}

/** Clears every unanswered episode matching the page's filters. */
export async function clearAllUnanswered(input: { query: Record<string, string>; reason?: string }): Promise<ClearResult> {
  const granted = await checkPermission("messages.reply");
  if ("denied" in granted) return { error: granted.denied };
  return clearWhere(null, input.query ?? {}, input.reason, granted.session.userId);
}

/** Every id matching a tab's filters — the "select all N matching" widening. */
export async function selectAllMatchingEpisodeIds(input: {
  tab: "unanswered" | "response-time";
  query: Record<string, string>;
}): Promise<{ ids: string[]; truncated: boolean; error?: string }> {
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return { ids: [], truncated: false, error: granted.denied };
  const where = input.tab === "unanswered" ? unansweredWhere(parseUnansweredFilters(input.query ?? {}), new Date()) : responseWhere(parseResponseFilters(input.query ?? {}));
  const rows = await prisma.supportResponseEpisode.findMany({ where, select: { id: true }, take: SUPPORT_RESPONSE_MAX_SELECTION + 1, orderBy: { id: "asc" } });
  return { ids: rows.slice(0, SUPPORT_RESPONSE_MAX_SELECTION).map((r) => r.id), truncated: rows.length > SUPPORT_RESPONSE_MAX_SELECTION };
}

export interface SupportTeamSetupState {
  error?: string;
  saved?: boolean;
}

/**
 * Which Teams are the Support Team (Settings → Support Activity Setup). Only Teams of this project
 * are accepted. Takes effect from the next message: nothing is recalculated backwards.
 */
export async function saveSupportResponseTeams(_prev: SupportTeamSetupState, formData: FormData): Promise<SupportTeamSetupState> {
  const granted = await checkPermission("support_activity.manage");
  if ("denied" in granted) return { error: granted.denied };
  const requested = formData.getAll("teamIds").map(String).filter(Boolean);
  const teams = requested.length ? await prisma.team.findMany({ where: { id: { in: requested } }, select: { id: true, name: true } }) : [];
  if (teams.length !== new Set(requested).size) return { error: "One of those Teams is not in this project. Nothing was saved." };
  await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: { responseTrackingTeamIds: teams.map((t) => t.id) },
    create: { id: "global", responseTrackingTeamIds: teams.map((t) => t.id) },
  });
  await logSystemEvent(
    "INFO",
    "support-response",
    teams.length ? `Support Team for response tracking: ${teams.map((t) => t.name).join(", ")}` : "Response tracking switched off (no Support Team)",
    { teamIds: teams.map((t) => t.id) },
    { actorUserId: granted.session.userId, targetType: "SupportActivitySettings" },
  );
  revalidatePath(await projectPath("/support-activity/settings"));
  return { saved: true };
}
