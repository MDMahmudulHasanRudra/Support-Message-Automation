import { createHmac } from "node:crypto";
import {
  classifyMetaPublishError,
  igQuotaAllows,
  metaPlatformAppSecret,
  readFacebookPostMetrics,
  readIgContainerStatus,
  readInstagramMediaMetrics,
  readRecentFacebookPosts,
  readRecentInstagramMedia,
  type PublishOutcome,
} from "@support-automation/shared";
import type { AdapterAccount, AdapterContext, PublishInput, ReadContext, SocialAdapter } from "./types";

/**
 * Facebook Page and Instagram publishing through Meta's official Graph API (SOCIAL_STUDIO.md §Meta),
 * written from Meta's public documentation:
 *   - Page: POST /{page}/feed (text, link, or several photos uploaded unpublished then attached),
 *     /{page}/photos (one photo), /{page}/videos (one video, fetched by Meta from `file_url`);
 *   - Instagram (Content Publishing API): POST /{ig}/media makes a container (image_url / REELS
 *     video_url / CAROUSEL of children), Meta processes it, POST /{ig}/media_publish publishes it; the
 *     account's rolling 24-hour quota is read first (/content_publishing_limit).
 * Every call carries `appsecret_proof`. Making an Instagram container or an unpublished photo publishes
 * nothing, so it happens BEFORE `markSent`; the call that makes the post public comes right after it.
 */

const TIMEOUT_MS = 45_000;
const IG_POLL_TRIES = 6;
const IG_POLL_MS = 5_000;

function graphBase(): string {
  const version = process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
  return `https://graph.facebook.com/${version}`;
}

type GraphResult = { ok: true; data: Record<string, unknown> } | { ok: false; outcome: PublishOutcome; status: number };

async function graph(
  ctx: ReadContext,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string>,
  token: string,
  requestSent: boolean,
): Promise<GraphResult> {
  const appSecret = metaPlatformAppSecret(process.env);
  if (!appSecret) return { ok: false, status: 0, outcome: { kind: "REFUSED", message: "The platform's Meta app is not configured on this server (META_APP_SECRET)." } };
  const url = new URL(`${graphBase()}${path}`);
  const proof = createHmac("sha256", appSecret).update(token).digest("hex");
  const body = new URLSearchParams({ ...params, appsecret_proof: proof });
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual", cache: "no-store" };
  if (method === "GET") for (const [k, v] of body) url.searchParams.set(k, v);
  else {
    init.body = body;
    (init.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded";
  }
  let response: Response;
  try {
    response = await ctx.fetch(url, init);
  } catch {
    return {
      ok: false,
      status: 0,
      outcome: requestSent
        ? { kind: "UNKNOWN", message: "The connection to Meta broke before it answered; the post may or may not have been published." }
        : { kind: "RETRY_LATER", rateLimited: false, message: "Meta could not be reached. It will be tried again." },
    };
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) return { ok: false, status: response.status, outcome: classifyMetaPublishError(response.status, data, requestSent) };
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      status: response.status,
      outcome: requestSent ? { kind: "UNKNOWN", message: "Meta answered in an unexpected shape; the post may have been published." } : { kind: "RETRY_LATER", rateLimited: false, message: "Meta answered in an unexpected shape." },
    };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

const idOf = (data: Record<string, unknown>, key = "id"): string | null => (typeof data[key] === "string" && data[key] ? (data[key] as string) : null);

async function permalinkOf(ctx: ReadContext, id: string, token: string, field: "permalink_url" | "permalink"): Promise<string | null> {
  const r = await graph(ctx, "GET", `/${encodeURIComponent(id)}`, { fields: field }, token, false);
  if (!r.ok) return null;
  const link = r.data[field];
  return typeof link === "string" && link.startsWith("https://") ? link.slice(0, 1000) : null;
}

function published(externalId: string, permalink: string | null): PublishOutcome {
  return { kind: "PUBLISHED", externalId, permalink };
}

const unexpected = (what: string): PublishOutcome => ({ kind: "UNKNOWN", message: `Meta accepted the ${what} but did not return its id; check the account.` });

// ── Facebook Page ────────────────────────────────────────────────────────────────────────────────

export const facebookPageAdapter: SocialAdapter = {
  platform: "FACEBOOK_PAGE",

  async publish(input: PublishInput, ctx: AdapterContext): Promise<PublishOutcome> {
    const { account, text, media } = input;
    const page = encodeURIComponent(account.externalId);
    const token = account.token;
    const images = media.filter((m) => m.kind === "IMAGE");
    const videos = media.filter((m) => m.kind === "VIDEO");
    const link = typeof input.settings.link === "string" && /^https?:\/\//.test(input.settings.link) ? input.settings.link : null;

    if (videos.length === 1 && images.length === 0) {
      await ctx.markSent();
      const r = await graph(ctx, "POST", `/${page}/videos`, { file_url: videos[0]!.url, description: text }, token, true);
      if (!r.ok) return r.outcome;
      const id = idOf(r.data);
      return id ? published(id, await permalinkOf(ctx, id, token, "permalink_url")) : unexpected("video");
    }
    if (images.length === 1) {
      await ctx.markSent();
      const r = await graph(ctx, "POST", `/${page}/photos`, { url: images[0]!.url, message: text, published: "true" }, token, true);
      if (!r.ok) return r.outcome;
      const id = idOf(r.data, "post_id") ?? idOf(r.data);
      return id ? published(id, await permalinkOf(ctx, id, token, "permalink_url")) : unexpected("photo");
    }
    const params: Record<string, string> = { message: text };
    if (images.length > 1) {
      // Uploaded unpublished first (nothing public yet), then attached to one post.
      for (let i = 0; i < images.length; i++) {
        const r = await graph(ctx, "POST", `/${page}/photos`, { url: images[i]!.url, published: "false" }, token, false);
        if (!r.ok) return r.outcome;
        const photoId = idOf(r.data);
        if (!photoId) return { kind: "RETRY_LATER", rateLimited: false, message: "Meta did not return a photo id for an unpublished upload." };
        params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: photoId });
      }
    } else if (link) {
      params.link = link;
    }
    await ctx.markSent();
    const r = await graph(ctx, "POST", `/${page}/feed`, params, token, true);
    if (!r.ok) return r.outcome;
    const id = idOf(r.data);
    return id ? published(id, await permalinkOf(ctx, id, token, "permalink_url")) : unexpected("post");
  },

  async findRecent(account: AdapterAccount, since: Date, ctx: ReadContext) {
    const r = await graph(ctx, "GET", `/${encodeURIComponent(account.externalId)}/published_posts`, { fields: "id,message,created_time,permalink_url", since: String(Math.floor(since.getTime() / 1000)), limit: "50" }, account.token, false);
    if (!r.ok) throw new Error("message" in r.outcome ? r.outcome.message : "Meta could not be read.");
    return readRecentFacebookPosts(r.data);
  },

  async deletePublication(account: AdapterAccount, externalId: string, ctx: ReadContext) {
    const r = await graph(ctx, "DELETE", `/${encodeURIComponent(externalId)}`, {}, account.token, true);
    if (!r.ok) return { ok: false, message: "message" in r.outcome ? r.outcome.message : "Meta refused." };
    return r.data.success === true ? { ok: true } : { ok: false, message: "Meta did not confirm the deletion." };
  },

  async metrics(account: AdapterAccount, externalId: string, ctx: ReadContext) {
    const r = await graph(ctx, "GET", `/${encodeURIComponent(externalId)}`, { fields: "reactions.summary(true).limit(0),comments.summary(true).limit(0),shares" }, account.token, false);
    return r.ok ? readFacebookPostMetrics(r.data) : null;
  },
};

// ── Instagram ────────────────────────────────────────────────────────────────────────────────────

async function containerStatus(ctx: ReadContext, id: string, token: string) {
  const r = await graph(ctx, "GET", `/${encodeURIComponent(id)}`, { fields: "status_code,status" }, token, false);
  return r.ok ? readIgContainerStatus(r.data) : null;
}

/** Waits for a container to finish processing, within this attempt's budget. */
async function waitFinished(ctx: AdapterContext, id: string, token: string): Promise<"FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "UNREADABLE" | { error: string }> {
  for (let i = 0; i < IG_POLL_TRIES; i++) {
    const s = await containerStatus(ctx, id, token);
    if (!s) return "UNREADABLE";
    if (s.status === "FINISHED") return "FINISHED";
    if (s.status === "ERROR") return { error: s.detail ?? "Instagram could not process the media." };
    if (s.status === "EXPIRED") return "EXPIRED";
    if (s.status === "PUBLISHED") return "FINISHED";
    await ctx.sleep(IG_POLL_MS);
  }
  return "IN_PROGRESS";
}

export const instagramAdapter: SocialAdapter = {
  platform: "INSTAGRAM",

  async publish(input: PublishInput, ctx: AdapterContext): Promise<PublishOutcome> {
    const { account, text, media } = input;
    const ig = encodeURIComponent(account.externalId);
    const token = account.token;
    if (media.length === 0) return { kind: "REFUSED", message: "Instagram needs a photo or a video." };

    const quota = await graph(ctx, "GET", `/${ig}/content_publishing_limit`, { fields: "quota_usage,config" }, token, false);
    if (quota.ok && !igQuotaAllows(quota.data)) {
      return { kind: "RETRY_LATER", rateLimited: true, message: "This Instagram account reached its 24-hour publishing limit. It will be tried again later." };
    }
    if (!quota.ok && quota.outcome.kind === "AUTH") return quota.outcome;

    // An earlier attempt's container is used again while it is still valid.
    let creationId: string | null = null;
    const previous = input.containerIds.at(-1);
    if (previous) {
      const s = await containerStatus(ctx, previous, token);
      if (s && (s.status === "FINISHED" || s.status === "IN_PROGRESS")) creationId = previous;
    }

    if (!creationId) {
      const mediaType = input.settings.igMediaType === "STORIES" ? "STORIES" : "REELS";
      if (media.length === 1) {
        const m = media[0]!;
        const params: Record<string, string> = m.kind === "IMAGE" ? { image_url: m.url, caption: text } : { media_type: mediaType, video_url: m.url, caption: text };
        if (m.kind === "IMAGE" && input.settings.igMediaType === "STORIES") params.media_type = "STORIES";
        const r = await graph(ctx, "POST", `/${ig}/media`, params, token, false);
        if (!r.ok) return r.outcome;
        creationId = idOf(r.data);
        if (!creationId) return { kind: "RETRY_LATER", rateLimited: false, message: "Instagram did not return a container id." };
        await ctx.saveContainers([creationId]);
      } else {
        const children: string[] = [];
        for (const m of media) {
          const params: Record<string, string> = m.kind === "IMAGE" ? { image_url: m.url, is_carousel_item: "true" } : { media_type: "VIDEO", video_url: m.url, is_carousel_item: "true" };
          const r = await graph(ctx, "POST", `/${ig}/media`, params, token, false);
          if (!r.ok) return r.outcome;
          const child = idOf(r.data);
          if (!child) return { kind: "RETRY_LATER", rateLimited: false, message: "Instagram did not return a carousel item id." };
          children.push(child);
        }
        for (const child of children) {
          const state = await waitFinished(ctx, child, token);
          if (state === "FINISHED") continue;
          if (typeof state === "object") return { kind: "REFUSED", message: `Instagram could not process a carousel item: ${state.error}` };
          return { kind: "RETRY_LATER", rateLimited: false, message: "Instagram is still processing the carousel's media. It will be tried again." };
        }
        const parent = await graph(ctx, "POST", `/${ig}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: text }, token, false);
        if (!parent.ok) return parent.outcome;
        creationId = idOf(parent.data);
        if (!creationId) return { kind: "RETRY_LATER", rateLimited: false, message: "Instagram did not return a carousel container id." };
        await ctx.saveContainers([...children, creationId]);
      }
    }

    const state = await waitFinished(ctx, creationId, token);
    if (typeof state === "object") {
      await ctx.saveContainers([]);
      return { kind: "REFUSED", message: `Instagram could not process the media: ${state.error}` };
    }
    if (state === "EXPIRED") {
      await ctx.saveContainers([]);
      return { kind: "RETRY_LATER", rateLimited: false, message: "Instagram's prepared media expired; it will be prepared again." };
    }
    if (state !== "FINISHED") return { kind: "RETRY_LATER", rateLimited: false, message: "Instagram is still processing the media. It will be published when it is ready." };

    await ctx.markSent();
    const r = await graph(ctx, "POST", `/${ig}/media_publish`, { creation_id: creationId }, token, true);
    if (!r.ok) return r.outcome;
    const id = idOf(r.data);
    return id ? published(id, await permalinkOf(ctx, id, token, "permalink")) : unexpected("Instagram post");
  },

  async findRecent(account: AdapterAccount, since: Date, ctx: ReadContext) {
    const r = await graph(ctx, "GET", `/${encodeURIComponent(account.externalId)}/media`, { fields: "id,caption,timestamp,permalink", limit: "50" }, account.token, false);
    if (!r.ok) throw new Error("message" in r.outcome ? r.outcome.message : "Meta could not be read.");
    return readRecentInstagramMedia(r.data).filter((p) => p.createdAt.getTime() >= since.getTime());
  },

  async metrics(account: AdapterAccount, externalId: string, ctx: ReadContext) {
    const r = await graph(ctx, "GET", `/${encodeURIComponent(externalId)}`, { fields: "like_count,comments_count" }, account.token, false);
    return r.ok ? readInstagramMediaMetrics(r.data) : null;
  },
};

