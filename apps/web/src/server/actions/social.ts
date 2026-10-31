"use server";

import { revalidatePath } from "next/cache";
import {
  isValidTimeZone,
  parseAccountSettings,
  SOCIAL_REPEAT_EVERY,
  zonedLocalToUtc,
  type SocialAction,
  type SocialPublishMode,
  type SocialRepeatEvery,
  type SocialTargetAction,
} from "@support-automation/shared";
import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { projectPath } from "@/server/projectPaths";
import { addSocialComment, applySocialAction, applyTargetAction, rescheduleSocialPost, saveSocialDraft, SocialRefusal } from "@/server/social/posts";
import { deleteSocialAsset, cleanFolder, cleanTags, SocialMediaError, updateSocialAsset } from "@/server/social/media";
import { createCampaign, deleteTemplate, saveTemplate, SOCIAL_TEMPLATE_KINDS, updateCampaign, type CampaignInput, type SocialTemplateKind } from "@/server/social/library";
import { refreshTargetMetrics } from "@/server/social/engine";
import { createSocialAiRequest, readSocialAiRequest, type SocialAiRequestView } from "@/server/social/ai";

/**
 * Social Studio's actions (SOCIAL_STUDIO.md). Every one checks its own key with the SOCIAL_STUDIO feature
 * (checkPermission also applies the person's project access level, their project role's pages, and a
 * suspended project's read-only rule). Writing, approving and publishing are different keys:
 *   social.edit     drafts, media, campaigns, templates, comments, duplicate, delete a draft;
 *   social.approve  approve / send back (and comment);
 *   social.publish  schedule, publish now, cancel, move, retry, settle an unknown outcome.
 */

export interface SocialActionState {
  error?: string;
  success?: string;
  id?: string;
  warnings?: string[];
}

const FEATURE = "SOCIAL_STUDIO" as const;

async function revalidateSocial(...extra: string[]) {
  for (const p of ["/social", "/social/calendar", "/social/posts", ...extra]) revalidatePath(await projectPath(p));
}

function refusal(err: unknown): SocialActionState {
  if (err instanceof SocialRefusal || err instanceof SocialMediaError) return { error: err.message };
  throw err;
}

const str = (form: FormData, key: string, max = 1000) => String(form.get(key) ?? "").slice(0, max);

/** Reads the composer's form into a draft. */
function readDraft(form: FormData): { ok: true; value: Parameters<typeof saveSocialDraft>[0] } | { ok: false; error: string } {
  const accountIds = form.getAll("account").map(String).filter(Boolean);
  const mediaIds = form.getAll("media").map(String).filter(Boolean);
  const variants: Record<string, string | null> = {};
  const settings: Record<string, Record<string, unknown> | null> = {};
  for (const id of accountIds) {
    const variant = str(form, `variant_${id}`, 70_000);
    variants[id] = variant.trim() ? variant : null;
    const parsed = parseAccountSettings(str(form, `settings_${id}`, 5000));
    if (!parsed.ok) return { ok: false, error: parsed.reason };
    settings[id] = parsed.value;
  }
  const timezone = str(form, "timezone", 64).trim() || "Asia/Dhaka";
  if (!isValidTimeZone(timezone)) return { ok: false, error: "Choose a valid time zone." };
  const local = str(form, "scheduledLocal", 20).trim();
  let scheduledAt: Date | null = null;
  if (local) {
    scheduledAt = zonedLocalToUtc(local, timezone);
    if (!scheduledAt) return { ok: false, error: "The date and time are not valid." };
  }
  const revision = Number(form.get("revision"));
  return {
    ok: true,
    value: {
      id: str(form, "id", 40) || undefined,
      revision: Number.isInteger(revision) && revision > 0 ? revision : undefined,
      title: str(form, "title", 200),
      content: str(form, "content", 70_000),
      accountIds,
      mediaIds,
      variants,
      settings,
      publishMode: form.get("publishMode") === "NOW" ? "NOW" : "SCHEDULE",
      scheduledAt,
      timezone,
      campaignId: str(form, "campaignId", 40) || null,
      aiAssisted: form.get("aiAssisted") === "1",
    },
  };
}

export async function saveSocialPostAction(_prev: SocialActionState, form: FormData): Promise<SocialActionState> {
  const access = await checkPermission("social.edit", FEATURE);
  if ("denied" in access) return { error: access.denied };
  const draft = readDraft(form);
  if (!draft.ok) return { error: draft.error };
  try {
    const saved = await saveSocialDraft(draft.value, access.session.username);
    let success = "Draft saved.";
    if (form.get("intent") === "submit") {
      const reviewer = str(form, "reviewer", 100).trim() || null;
      success = (await applySocialAction(saved.id, "SUBMIT", access.session.username, { reviewerUsername: reviewer })).message;
    }
    await revalidateSocial(`/social/posts/${saved.id}`);
    return { success, id: saved.id, warnings: saved.warnings };
  } catch (err) {
    return refusal(err);
  }
}

const POST_ACTION_KEYS: Record<Exclude<SocialAction, "EDIT">, "social.edit" | "social.approve" | "social.publish"> = {
  SUBMIT: "social.edit",
  APPROVE: "social.approve",
  REJECT: "social.approve",
  SCHEDULE: "social.publish",
  CANCEL: "social.publish",
  DELETE: "social.edit",
  DUPLICATE: "social.edit",
};

export async function socialPostAction(
  id: string,
  action: Exclude<SocialAction, "EDIT">,
  extra: { revision?: number; note?: string; reviewer?: string; publishMode?: SocialPublishMode; scheduledLocal?: string; timezone?: string; repeatEvery?: string; repeatTimes?: number } = {},
): Promise<SocialActionState> {
  const key = POST_ACTION_KEYS[action];
  if (!key) return { error: "Unknown action." };
  const access = await checkPermission(key, FEATURE);
  if ("denied" in access) return { error: access.denied };
  let scheduledAt: Date | null | undefined;
  if (action === "SCHEDULE" && extra.publishMode !== "NOW" && extra.scheduledLocal) {
    const tz = extra.timezone && isValidTimeZone(extra.timezone) ? extra.timezone : "Asia/Dhaka";
    scheduledAt = zonedLocalToUtc(extra.scheduledLocal, tz);
    if (!scheduledAt) return { error: "The date and time are not valid." };
  }
  try {
    const result = await applySocialAction(String(id), action, access.session.username, {
      revision: extra.revision,
      note: extra.note,
      reviewerUsername: extra.reviewer ?? null,
      publishMode: extra.publishMode,
      scheduledAt,
      repeat:
        extra.repeatEvery && (SOCIAL_REPEAT_EVERY as readonly string[]).includes(extra.repeatEvery) && Number(extra.repeatTimes) > 0
          ? { every: extra.repeatEvery as SocialRepeatEvery, times: Number(extra.repeatTimes) }
          : null,
    });
    if (action === "APPROVE" || action === "SCHEDULE" || action === "CANCEL") {
      await logSystemEvent("INFO", "social", `Social post ${action === "APPROVE" ? "approved" : action === "SCHEDULE" ? "scheduled" : "cancelled"}`, { postId: id }, { actorUserId: access.session.userId, targetType: "SocialPost", targetId: String(id) });
    }
    await revalidateSocial(`/social/posts/${id}`);
    return { success: result.message, id: result.id };
  } catch (err) {
    return refusal(err);
  }
}

export async function socialTargetAction(targetId: string, action: SocialTargetAction | "DELETE_PUBLICATION", extra: { confirmedNotPublished?: boolean; permalink?: string } = {}): Promise<SocialActionState> {
  const access = await checkPermission("social.publish", FEATURE);
  if ("denied" in access) return { error: access.denied };
  try {
    const result = await applyTargetAction(String(targetId), action, access.session.username, extra);
    if (action === "SEND_AGAIN" || action === "MARK_PUBLISHED" || action === "DELETE_PUBLICATION") {
      await logSystemEvent("WARN", "social", `Social publication: ${action.toLowerCase().replace(/_/g, " ")}`, { targetId }, { actorUserId: access.session.userId, targetType: "SocialPostTarget", targetId: String(targetId) });
    }
    await revalidateSocial();
    return { success: result.message };
  } catch (err) {
    return refusal(err);
  }
}

export async function rescheduleSocialPostAction(id: string, scheduledLocal: string, timezone: string): Promise<SocialActionState> {
  const access = await checkPermission("social.publish", FEATURE);
  if ("denied" in access) return { error: access.denied };
  const tz = isValidTimeZone(timezone) ? timezone : "Asia/Dhaka";
  const at = zonedLocalToUtc(scheduledLocal, tz);
  if (!at) return { error: "The date and time are not valid." };
  try {
    await rescheduleSocialPost(String(id), at, access.session.username);
    await revalidateSocial(`/social/posts/${id}`);
    return { success: "Moved." };
  } catch (err) {
    return refusal(err);
  }
}

export async function addSocialCommentAction(postId: string, text: string): Promise<SocialActionState> {
  let access = await checkPermission("social.edit", FEATURE);
  if ("denied" in access) access = await checkPermission("social.approve", FEATURE);
  if ("denied" in access) return { error: access.denied };
  try {
    await addSocialComment(String(postId), String(text ?? ""), access.session.username);
    revalidatePath(await projectPath(`/social/posts/${postId}`));
    return { success: "Comment added." };
  } catch (err) {
    return refusal(err);
  }
}

export async function refreshSocialMetricsAction(targetId: string): Promise<SocialActionState> {
  const access = await checkPermission("social.view", FEATURE);
  if ("denied" in access) return { error: access.denied };
  const ok = await refreshTargetMetrics(String(targetId));
  revalidatePath(await projectPath("/social/analytics"));
  return ok ? { success: "Statistics updated." } : { error: "The platform returned no statistics for this post." };
}

// ── Media library ───────────────────────────────────────────────────────────────────────────────

export async function updateSocialAssetAction(_prev: SocialActionState, form: FormData): Promise<SocialActionState> {
  const access = await checkPermission("social.edit", FEATURE);
  if ("denied" in access) return { error: access.denied };
  try {
    await updateSocialAsset(str(form, "id", 40), { name: str(form, "name", 200), folder: cleanFolder(form.get("folder")), tags: cleanTags(form.get("tags")), altText: str(form, "altText", 600) || null });
    revalidatePath(await projectPath("/social/media"));
    return { success: "Saved." };
  } catch (err) {
    return refusal(err);
  }
}

export async function deleteSocialAssetAction(id: string): Promise<SocialActionState> {
  const access = await checkPermission("social.edit", FEATURE);
  if ("denied" in access) return { error: access.denied };
  try {
    await deleteSocialAsset(String(id));
    revalidatePath(await projectPath("/social/media"));
    return { success: "Deleted." };
  } catch (err) {
    return refusal(err);
  }
}

// ── Campaigns and templates ─────────────────────────────────────────────────────────────────────

function readCampaign(form: FormData): CampaignInput {
  const day = (k: string) => {
    const v = str(form, k, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  };
  return {
    name: str(form, "name", 200),
    description: str(form, "description", 2000) || null,
    color: str(form, "color", 7) || null,
    startsOn: day("startsOn"),
    endsOn: day("endsOn"),
    leadId: str(form, "leadId", 40) || null,
  };
}

export async function saveSocialCampaignAction(_prev: SocialActionState, form: FormData): Promise<SocialActionState> {
  const access = await checkPermission("social.edit", FEATURE);
  if ("denied" in access) return { error: access.denied };
  try {
    const id = str(form, "id", 40);
    const input = readCampaign(form);
    if (id) await updateCampaign(id, { ...input, status: form.get("status") === "ARCHIVED" ? "ARCHIVED" : "ACTIVE" });
    const created = id ? { id } : await createCampaign(input, access.session.username);
    revalidatePath(await projectPath("/social/campaigns"));
    return { success: id ? "Campaign saved." : "Campaign created.", id: created.id };
  } catch (err) {
    return refusal(err);
  }
}

export async function saveSocialTemplateAction(_prev: SocialActionState, form: FormData): Promise<SocialActionState> {
  const access = await checkPermission("social.edit", FEATURE);
  if ("denied" in access) return { error: access.denied };
  const kind = String(form.get("kind")) as SocialTemplateKind;
  if (!SOCIAL_TEMPLATE_KINDS.includes(kind)) return { error: "Choose what kind it is." };
  try {
    const saved = await saveTemplate({ id: str(form, "id", 40) || undefined, kind, name: str(form, "name", 200), content: str(form, "content", 12_000) }, access.session.username);
    revalidatePath(await projectPath("/social/templates"));
    return { success: "Saved.", id: saved.id };
  } catch (err) {
    return refusal(err);
  }
}

export async function deleteSocialTemplateAction(id: string): Promise<SocialActionState> {
  const access = await checkPermission("social.edit", FEATURE);
  if ("denied" in access) return { error: access.denied };
  try {
    await deleteTemplate(String(id));
    revalidatePath(await projectPath("/social/templates"));
    return { success: "Deleted." };
  } catch (err) {
    return refusal(err);
  }
}

// ── AI Content Studio ───────────────────────────────────────────────────────────────────────────

export async function requestSocialAiAction(input: Record<string, unknown>): Promise<SocialActionState> {
  const access = await checkPermission("social.edit", FEATURE);
  if ("denied" in access) return { error: access.denied };
  try {
    const created = await createSocialAiRequest(input, access.session.username);
    return { id: created.id, success: "Asked. The answer usually takes a few seconds." };
  } catch (err) {
    return refusal(err);
  }
}

/** Polled by the AI page: a refusal reads as "nothing to show", never a redirect. */
export async function readSocialAiAction(id: string): Promise<SocialAiRequestView | null> {
  const access = await checkPermission("social.view", FEATURE);
  if ("denied" in access) return null;
  return readSocialAiRequest(String(id));
}
