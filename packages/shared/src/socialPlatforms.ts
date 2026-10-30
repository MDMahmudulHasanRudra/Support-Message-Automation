import type { SocialMediaKind } from "./socialStudio.js";

/**
 * Social Studio's platform catalogue (SOCIAL_STUDIO.md §Platforms): what each network accepts through
 * its OFFICIAL publishing API, which Get Assist adapter exists for it, and what it needs from the person
 * who connects it. The rules are written from each platform's public documentation, not taken from any
 * other product. A platform with `implemented: false` is listed so the product can say what is coming;
 * it can never be connected or chosen.
 *
 * Capabilities are what Get Assist's own adapter does — never what a platform might allow in theory.
 */

export const SOCIAL_CAPABILITIES = [
  "PUBLISH_TEXT",
  "PUBLISH_IMAGE",
  "PUBLISH_MULTI_IMAGE",
  "PUBLISH_VIDEO",
  "PUBLISH_CAROUSEL",
  "DELETE",
  "POST_METRICS",
  "RECONCILE",
] as const;
export type SocialCapability = (typeof SOCIAL_CAPABILITIES)[number];

export const SOCIAL_CAPABILITY_LABELS: Record<SocialCapability, string> = {
  PUBLISH_TEXT: "Text posts",
  PUBLISH_IMAGE: "Photo posts",
  PUBLISH_MULTI_IMAGE: "Several photos",
  PUBLISH_VIDEO: "Video posts",
  PUBLISH_CAROUSEL: "Carousels",
  DELETE: "Delete a published post",
  POST_METRICS: "Post statistics",
  RECONCILE: "Find a post whose outcome was unclear",
};

export const SOCIAL_PLATFORM_KEYS = ["FACEBOOK_PAGE", "INSTAGRAM", "THREADS", "LINKEDIN", "YOUTUBE", "TIKTOK", "PINTEREST"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORM_KEYS)[number];

/** The authorization a platform is connected through (one authorization can bring several accounts). */
export type SocialNetwork = "META" | "THREADS" | "LINKEDIN" | "GOOGLE" | "TIKTOK" | "PINTEREST";

export interface SocialPlatformRules {
  key: SocialPlatform;
  label: string;
  network: SocialNetwork;
  /** A Get Assist adapter exists and was mock-tested. NOT a claim of live verification. */
  implemented: boolean;
  capabilities: readonly SocialCapability[];
  maxText: number;
  maxHashtags: number | null;
  /** The platform refuses a post with no photo or video. */
  requiresMedia: boolean;
  imageTypes: readonly string[];
  videoTypes: readonly string[];
  maxImages: number;
  maxVideos: number;
  /** Photos and videos together in one post (a carousel). */
  allowsMixed: boolean;
  maxImageBytes: number;
  /** What the person connecting must grant (official permission / scope names). */
  scopes: readonly string[];
  /** What it takes before real customers can use it, in a sentence. */
  requirement: string;
}

const MB = 1024 * 1024;

export const SOCIAL_PLATFORMS: Readonly<Record<SocialPlatform, SocialPlatformRules>> = {
  FACEBOOK_PAGE: {
    key: "FACEBOOK_PAGE",
    label: "Facebook Page",
    network: "META",
    implemented: true,
    capabilities: ["PUBLISH_TEXT", "PUBLISH_IMAGE", "PUBLISH_MULTI_IMAGE", "PUBLISH_VIDEO", "DELETE", "POST_METRICS", "RECONCILE"],
    maxText: 63_206,
    maxHashtags: null,
    requiresMedia: false,
    imageTypes: ["image/jpeg", "image/png", "image/gif"],
    videoTypes: ["video/mp4", "video/quicktime"],
    maxImages: 10,
    maxVideos: 1,
    allowsMixed: false,
    maxImageBytes: 8 * MB,
    scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
    requirement: "Meta App Review approval for pages_manage_posts and pages_read_engagement (Advanced Access) on the platform's Meta app.",
  },
  INSTAGRAM: {
    key: "INSTAGRAM",
    label: "Instagram (professional account)",
    network: "META",
    implemented: true,
    capabilities: ["PUBLISH_IMAGE", "PUBLISH_VIDEO", "PUBLISH_CAROUSEL", "POST_METRICS", "RECONCILE"],
    maxText: 2_200,
    maxHashtags: 30,
    requiresMedia: true,
    // The Content Publishing API takes JPEG photos only.
    imageTypes: ["image/jpeg"],
    videoTypes: ["video/mp4", "video/quicktime"],
    maxImages: 10,
    maxVideos: 10,
    allowsMixed: true,
    maxImageBytes: 8 * MB,
    scopes: ["pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_content_publish"],
    requirement: "Meta App Review approval for instagram_content_publish and instagram_basic; the account must be a Business or Creator account linked to a Facebook Page.",
  },
  THREADS: {
    key: "THREADS",
    label: "Threads",
    network: "THREADS",
    implemented: false,
    capabilities: [],
    maxText: 500,
    maxHashtags: 1,
    requiresMedia: false,
    imageTypes: ["image/jpeg", "image/png"],
    videoTypes: ["video/mp4", "video/quicktime"],
    maxImages: 20,
    maxVideos: 20,
    allowsMixed: true,
    maxImageBytes: 8 * MB,
    scopes: ["threads_basic", "threads_content_publish"],
    requirement: "A Threads use case on a Meta app, threads_content_publish approval, and a Get Assist adapter (not built yet).",
  },
  LINKEDIN: {
    key: "LINKEDIN",
    label: "LinkedIn",
    network: "LINKEDIN",
    implemented: false,
    capabilities: [],
    maxText: 3_000,
    maxHashtags: null,
    requiresMedia: false,
    imageTypes: ["image/jpeg", "image/png", "image/gif"],
    videoTypes: ["video/mp4"],
    maxImages: 9,
    maxVideos: 1,
    allowsMixed: false,
    maxImageBytes: 8 * MB,
    scopes: ["w_member_social", "w_organization_social"],
    requirement: "A LinkedIn app with the Community Management API approved, and a Get Assist adapter (not built yet).",
  },
  YOUTUBE: {
    key: "YOUTUBE",
    label: "YouTube",
    network: "GOOGLE",
    implemented: false,
    capabilities: [],
    maxText: 5_000,
    maxHashtags: null,
    requiresMedia: true,
    imageTypes: [],
    videoTypes: ["video/mp4", "video/quicktime"],
    maxImages: 0,
    maxVideos: 1,
    allowsMixed: false,
    maxImageBytes: 0,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    requirement: "A verified Google Cloud OAuth app (restricted scope audit for public use), API quota, and a Get Assist adapter (not built yet).",
  },
  TIKTOK: {
    key: "TIKTOK",
    label: "TikTok",
    network: "TIKTOK",
    implemented: false,
    capabilities: [],
    maxText: 2_200,
    maxHashtags: null,
    requiresMedia: true,
    imageTypes: ["image/jpeg", "image/webp"],
    videoTypes: ["video/mp4", "video/quicktime"],
    maxImages: 35,
    maxVideos: 1,
    allowsMixed: false,
    maxImageBytes: 8 * MB,
    scopes: ["video.publish"],
    requirement: "TikTok's Content Posting API audit (unaudited apps can only post privately), and a Get Assist adapter (not built yet).",
  },
  PINTEREST: {
    key: "PINTEREST",
    label: "Pinterest",
    network: "PINTEREST",
    implemented: false,
    capabilities: [],
    maxText: 500,
    maxHashtags: null,
    requiresMedia: true,
    imageTypes: ["image/jpeg", "image/png"],
    videoTypes: ["video/mp4"],
    maxImages: 1,
    maxVideos: 1,
    allowsMixed: false,
    maxImageBytes: 8 * MB,
    scopes: ["pins:write", "boards:read"],
    requirement: "Pinterest API standard access, and a Get Assist adapter (not built yet).",
  },
};

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && (SOCIAL_PLATFORM_KEYS as readonly string[]).includes(value);
}

export function platformHas(platform: string, capability: SocialCapability): boolean {
  return isSocialPlatform(platform) && SOCIAL_PLATFORMS[platform].capabilities.includes(capability);
}

// \p{M} keeps Bengali (and every script with combining marks) whole: without it "#অফার" stops at "#অফ".
const HASHTAG = /#[\p{L}\p{M}\p{N}_]+/gu;

export function countHashtags(text: string): number {
  return (text.match(HASHTAG) ?? []).length;
}

export function extractHashtags(text: string): string[] {
  return [...new Set((text.match(HASHTAG) ?? []).map((t) => t.toLowerCase()))];
}

/**
 * Whether one account's version of a post can go to its platform: text length, hashtags, media count,
 * types and combinations. Run when a post is written (as a warning), when it is approved and scheduled
 * (as a refusal) and again by the engine before it publishes. The platform has the final word; these
 * are its documented limits, checked early so a person learns at writing time rather than at 3 a.m.
 */
export function validateForPlatform(platform: SocialPlatform, post: { text: string; media: ReadonlyArray<{ kind: SocialMediaKind; mimeType: string; sizeBytes: number }> }): string[] {
  const rules = SOCIAL_PLATFORMS[platform];
  const problems: string[] = [];
  if (!rules.implemented) return [`Publishing to ${rules.label} is not available yet.`];
  const length = [...post.text].length;
  if (length > rules.maxText) problems.push(`${rules.label}: the text is ${length.toLocaleString("en-US")} characters; the limit is ${rules.maxText.toLocaleString("en-US")}.`);
  if (rules.maxHashtags !== null && countHashtags(post.text) > rules.maxHashtags) problems.push(`${rules.label}: at most ${rules.maxHashtags} hashtags.`);
  const images = post.media.filter((m) => m.kind === "IMAGE");
  const videos = post.media.filter((m) => m.kind === "VIDEO");
  if (rules.requiresMedia && post.media.length === 0) problems.push(`${rules.label} needs a photo or a video.`);
  if (!post.text.trim() && post.media.length === 0) problems.push(`${rules.label}: the post is empty.`);
  if (images.length > rules.maxImages) problems.push(`${rules.label}: at most ${rules.maxImages} photo(s).`);
  if (videos.length > rules.maxVideos) problems.push(`${rules.label}: at most ${rules.maxVideos} video(s).`);
  if (!rules.allowsMixed && images.length > 0 && videos.length > 0) problems.push(`${rules.label}: photos and a video cannot be posted together.`);
  if (rules.allowsMixed && post.media.length > 10) problems.push(`${rules.label}: at most 10 items in a carousel.`);
  for (const m of images) {
    if (!rules.imageTypes.includes(m.mimeType)) problems.push(`${rules.label} does not take ${m.mimeType.replace("image/", "").toUpperCase()} photos${rules.imageTypes.length ? ` (only ${rules.imageTypes.map((t) => t.replace("image/", "").toUpperCase()).join(", ")})` : ""}.`);
    else if (m.sizeBytes > rules.maxImageBytes) problems.push(`${rules.label}: a photo is larger than ${Math.round(rules.maxImageBytes / MB)} MB.`);
  }
  for (const m of videos) {
    if (!rules.videoTypes.includes(m.mimeType)) problems.push(`${rules.label} does not take this video format.`);
  }
  return [...new Set(problems)];
}
