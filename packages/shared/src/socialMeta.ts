import { SOCIAL_PLATFORMS, type SocialPlatform } from "./socialPlatforms.js";
import type { PublishOutcome, RecentPublication, SocialMetricValue } from "./socialStudio.js";

/**
 * Social Studio's Facebook Page and Instagram publishing through Meta's official Graph API
 * (SOCIAL_STUDIO.md §Meta). The pure half: which permissions publishing needs (separate from the
 * messaging permissions — a Messenger connection never implies the right to post), how the Pages and
 * Instagram accounts found after authorisation are classified, and how Graph's answers are read. The web
 * adapter makes the calls; these decide what they mean, and the tests pin them.
 */

/** Everything the publishing dialog asks for: the two implemented platforms' scopes. */
export const META_SOCIAL_SCOPES: readonly string[] = [...new Set([...SOCIAL_PLATFORMS.FACEBOOK_PAGE.scopes, ...SOCIAL_PLATFORMS.INSTAGRAM.scopes])];

export const SOCIAL_META_CALLBACK_PATH = "/api/social/meta/callback";

export function missingSocialScopes(platform: SocialPlatform, granted: readonly string[]): string[] {
  const have = new Set(granted);
  return SOCIAL_PLATFORMS[platform].scopes.filter((s) => !have.has(s));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────

/** Graph's error text, with anything that looks like a token removed, at most 300 characters. */
export function metaErrorText(body: unknown): string {
  const error = isObj(body) && isObj(body.error) ? body.error : {};
  const message = str(error.error_user_msg) ?? str(error.message) ?? "";
  return message.replace(/access_token=[^&\s]+/gi, "access_token=[hidden]").replace(/EA[A-Za-z0-9]{20,}/g, "[hidden]").slice(0, 300);
}

/**
 * A Graph error response to a PUBLISHING call, read as the engine's outcome:
 *   - 190 / 102 (and their sub-codes): the token is no longer accepted → AUTH;
 *   - 4, 17, 32, 613, Instagram's publishing limit (9 / 2207042): refused for a rate or quota →
 *     RETRY_LATER (Meta answered "no", so nothing was published);
 *   - a 5xx, or Graph's "unknown error" (1) / "service unavailable" (2): it may or may not have been
 *     done → UNKNOWN once the publishing request had left, RETRY_LATER before;
 *   - anything else (permissions, invalid media, policy) → REFUSED with Meta's own words.
 */
export function classifyMetaPublishError(status: number, body: unknown, requestSent: boolean): PublishOutcome {
  const error = isObj(body) && isObj(body.error) ? body.error : {};
  const code = num(error.code);
  const subcode = num(error.error_subcode);
  const text = metaErrorText(body);
  if (code === 190 || code === 102 || subcode === 463 || subcode === 467 || subcode === 460) {
    return { kind: "AUTH", message: "Meta no longer accepts this account's authorization (expired, revoked or the password changed). Reconnect it under Social Studio → Accounts." };
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code === 9 && subcode === 2207042) || subcode === 2207042) {
    return { kind: "RETRY_LATER", rateLimited: true, message: "Meta is limiting how much this account can publish right now. It will be tried again later." };
  }
  if (status >= 500 || code === 1 || code === 2) {
    return requestSent
      ? { kind: "UNKNOWN", message: `Meta had a problem while handling the publication (${text || `HTTP ${status}`}); it may or may not have been published.` }
      : { kind: "RETRY_LATER", rateLimited: false, message: "Meta had a temporary problem before anything was published. It will be tried again." };
  }
  if (code === 10 || code === 200 || code === 3 || (code !== null && code >= 200 && code <= 299)) {
    return { kind: "REFUSED", code: String(code), message: `Meta refused for a missing permission: ${text || "permission error"}. The connection may need to be authorised again with publishing permission, or the platform's app may still need Meta's approval.` };
  }
  return { kind: "REFUSED", code: code === null ? null : String(code), message: text ? `Meta refused the post: ${text}` : `Meta refused the post (HTTP ${status}).` };
}

// ── Discovery ────────────────────────────────────────────────────────────────────────────────────

export interface MetaPageRow {
  id: string;
  name?: string;
  tasks?: string[];
  access_token?: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
}

export interface DiscoveredSocialAccount {
  platform: "FACEBOOK_PAGE" | "INSTAGRAM";
  externalId: string;
  parentExternalId: string | null;
  name: string;
  username: string | null;
  pictureUrl: string | null;
  /** The Page token both are published with; never shown. */
  token: string | null;
  /** ACTIVE, or NEEDS_RECONNECT with the reason in `problem`. */
  status: "ACTIVE" | "NEEDS_RECONNECT";
  problem: string | null;
}

/**
 * The Pages and Instagram accounts a person chose in Meta's dialog, as publishable accounts. A Page is
 * usable only if the person may create content on it (task CREATE_CONTENT or MANAGE) and the publishing
 * permissions were granted; its linked Instagram professional account only with Instagram's too. An
 * account that is not usable is still listed, with the reason, so nobody wonders where it went.
 */
export function classifyMetaSocialAccounts(rows: readonly MetaPageRow[], granted: readonly string[]): DiscoveredSocialAccount[] {
  const accounts: DiscoveredSocialAccount[] = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    const tasks = new Set(row.tasks ?? []);
    const canPost = tasks.has("CREATE_CONTENT") || tasks.has("MANAGE");
    const fbMissing = missingSocialScopes("FACEBOOK_PAGE", granted);
    const token = typeof row.access_token === "string" && row.access_token.length > 20 ? row.access_token : null;
    const pageProblem = !canPost
      ? "Your role on this Page does not allow creating posts."
      : fbMissing.length
        ? `Not granted: ${fbMissing.join(", ")}.`
        : !token
          ? "Meta did not give a Page token."
          : null;
    accounts.push({
      platform: "FACEBOOK_PAGE",
      externalId: row.id,
      parentExternalId: null,
      name: (row.name ?? row.id).slice(0, 200),
      username: null,
      pictureUrl: str(row.picture?.data?.url)?.startsWith("https://") ? row.picture!.data!.url!.slice(0, 1000) : null,
      token,
      status: pageProblem ? "NEEDS_RECONNECT" : "ACTIVE",
      problem: pageProblem,
    });
    const ig = row.instagram_business_account;
    if (ig && typeof ig.id === "string") {
      const igMissing = missingSocialScopes("INSTAGRAM", granted);
      const igProblem = !canPost
        ? "Your role on the linked Page does not allow creating posts."
        : igMissing.length
          ? `Not granted: ${igMissing.join(", ")}.`
          : !token
            ? "Meta did not give the linked Page's token."
            : null;
      accounts.push({
        platform: "INSTAGRAM",
        externalId: ig.id,
        parentExternalId: row.id,
        name: (ig.name ?? ig.username ?? ig.id).slice(0, 200),
        username: ig.username?.slice(0, 100) ?? null,
        pictureUrl: str(ig.profile_picture_url)?.startsWith("https://") ? ig.profile_picture_url!.slice(0, 1000) : null,
        token,
        status: igProblem ? "NEEDS_RECONNECT" : "ACTIVE",
        problem: igProblem,
      });
    }
  }
  return accounts;
}

// ── Instagram containers ─────────────────────────────────────────────────────────────────────────

export type IgContainerStatus = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED";

/** `GET /{container-id}?fields=status_code,status` → its state (null when unreadable). */
export function readIgContainerStatus(body: unknown): { status: IgContainerStatus; detail: string | null } | null {
  if (!isObj(body)) return null;
  const code = str(body.status_code);
  if (code !== "FINISHED" && code !== "IN_PROGRESS" && code !== "ERROR" && code !== "EXPIRED" && code !== "PUBLISHED") return null;
  return { status: code, detail: str(body.status)?.slice(0, 200) ?? null };
}

/** `GET /{ig-user}/content_publishing_limit?fields=quota_usage,config` → whether one more post fits. */
export function igQuotaAllows(body: unknown): boolean {
  const row = isObj(body) && Array.isArray(body.data) && isObj(body.data[0]) ? body.data[0] : null;
  if (!row) return true;
  const used = num(row.quota_usage);
  const total = isObj(row.config) ? num(row.config.quota_total) : null;
  if (used === null || total === null) return true;
  return used < total;
}

// ── Reading back ─────────────────────────────────────────────────────────────────────────────────

/** `GET /{page-id}/published_posts?fields=id,message,created_time,permalink_url` → recent publications. */
export function readRecentFacebookPosts(body: unknown): RecentPublication[] {
  const rows = isObj(body) && Array.isArray(body.data) ? body.data : [];
  const out: RecentPublication[] = [];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const id = str(row.id);
    const created = str(row.created_time);
    if (!id || !created || Number.isNaN(Date.parse(created))) continue;
    out.push({ externalId: id, text: str(row.message) ?? "", createdAt: new Date(created), permalink: str(row.permalink_url) });
  }
  return out;
}

/** `GET /{ig-user}/media?fields=id,caption,timestamp,permalink` → recent publications. */
export function readRecentInstagramMedia(body: unknown): RecentPublication[] {
  const rows = isObj(body) && Array.isArray(body.data) ? body.data : [];
  const out: RecentPublication[] = [];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const id = str(row.id);
    const created = str(row.timestamp);
    if (!id || !created || Number.isNaN(Date.parse(created))) continue;
    out.push({ externalId: id, text: str(row.caption) ?? "", createdAt: new Date(created), permalink: str(row.permalink) });
  }
  return out;
}

/**
 * `GET /{post-id}?fields=reactions.summary(true).limit(0),comments.summary(true).limit(0),shares` → the
 * counts Meta gives with pages_read_engagement. A field Meta did not return is left out, never zeroed.
 */
export function readFacebookPostMetrics(body: unknown): SocialMetricValue[] {
  if (!isObj(body)) return [];
  const out: SocialMetricValue[] = [];
  const total = (v: unknown) => (isObj(v) && isObj(v.summary) ? num(v.summary.total_count) : null);
  const reactions = total(body.reactions);
  if (reactions !== null) out.push({ name: "reactions", label: "Reactions", value: reactions });
  const comments = total(body.comments);
  if (comments !== null) out.push({ name: "comments", label: "Comments", value: comments });
  const shares = isObj(body.shares) ? num(body.shares.count) : null;
  if (shares !== null) out.push({ name: "shares", label: "Shares", value: shares });
  return out;
}

/** `GET /{ig-media-id}?fields=like_count,comments_count` → likes and comments (instagram_basic). */
export function readInstagramMediaMetrics(body: unknown): SocialMetricValue[] {
  if (!isObj(body)) return [];
  const out: SocialMetricValue[] = [];
  const likes = num(body.like_count);
  if (likes !== null) out.push({ name: "likes", label: "Likes", value: likes });
  const comments = num(body.comments_count);
  if (comments !== null) out.push({ name: "comments", label: "Comments", value: comments });
  return out;
}
