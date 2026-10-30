import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOCIAL_PLATFORMS } from "@support-automation/shared";
import { facebookPageAdapter, instagramAdapter } from "@/server/social/adapters/meta";
import { adapterFor, implementedAdapterPlatforms } from "@/server/social/adapters";
import type { AdapterContext, PublishInput } from "@/server/social/adapters/types";

/**
 * The Facebook Page and Instagram adapters against a fake Graph API (mock-tested only — not live-verified).
 * What is pinned: the request that makes a post public is preceded by `markSent`; an answer not seen after
 * it is UNKNOWN (never retried by the engine); a failure before it is RETRY_LATER; Meta's auth and rate
 * errors are read as AUTH / RETRY_LATER; Instagram's quota, container reuse and processing errors.
 */

type Call = { method: string; path: string; params: URLSearchParams; auth: string | null; afterSent: boolean };
type Route = (call: Call) => { status: number; body: unknown } | "NETWORK";

function fakeGraph(routes: Array<[RegExp, string, Route]>) {
  const calls: Call[] = [];
  let sent = false;
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const params = method === "GET" ? url.searchParams : new URLSearchParams(String(init?.body ?? ""));
    const call: Call = { method, path: url.pathname.replace(/^\/v\d+\.0/, ""), params, auth: (init?.headers as Record<string, string>)?.Authorization ?? null, afterSent: sent };
    calls.push(call);
    const route = routes.find(([re, m]) => re.test(call.path) && m === method);
    if (!route) return new Response(JSON.stringify({ error: { message: `no route ${method} ${call.path}`, code: 100 } }), { status: 400 });
    const answer = route[2](call);
    if (answer === "NETWORK") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  const saved: string[][] = [];
  const ctx: AdapterContext = {
    fetch: fetchImpl,
    markSent: async () => {
      sent = true;
    },
    saveContainers: async (ids) => {
      saved.push(ids);
    },
    sleep: async () => undefined,
  };
  return { calls, ctx, saved, wasSent: () => sent };
}

const page = (over: Partial<PublishInput> = {}): PublishInput => ({
  account: { platform: "FACEBOOK_PAGE", externalId: "111", parentExternalId: null, token: "PAGE_TOKEN_abcdefghijklmnopqrstuvwxyz" },
  text: "Hello from Get Assist",
  media: [],
  settings: {},
  containerIds: [],
  ...over,
});
const ig = (over: Partial<PublishInput> = {}): PublishInput => ({
  account: { platform: "INSTAGRAM", externalId: "999", parentExternalId: "111", token: "PAGE_TOKEN_abcdefghijklmnopqrstuvwxyz" },
  text: "Caption #sale",
  media: [{ kind: "IMAGE", mimeType: "image/jpeg", sizeBytes: 1000, url: "https://app.example.com/api/social/media/a1?exp=1&sig=x" }],
  settings: {},
  containerIds: [],
  ...over,
});

const okQuota: Route = () => ({ status: 200, body: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } });
const permalink = (link: string): Route => () => ({ status: 200, body: { permalink_url: link, permalink: link } });

beforeEach(() => {
  process.env.META_APP_SECRET = "0123456789abcdef0123456789abcdef";
});
afterEach(() => {
  delete process.env.META_APP_SECRET;
});

describe("Facebook Page adapter", () => {
  it("publishes a text post after marking it sent, with the token and appsecret_proof", async () => {
    const g = fakeGraph([
      [/^\/111\/feed$/, "POST", () => ({ status: 200, body: { id: "111_222" } })],
      [/^\/111_222$/, "GET", permalink("https://www.facebook.com/111/posts/222")],
    ]);
    const out = await facebookPageAdapter.publish(page({ settings: { link: "https://shop.example.com/sale" } }), g.ctx);
    expect(out).toEqual({ kind: "PUBLISHED", externalId: "111_222", permalink: "https://www.facebook.com/111/posts/222" });
    const feed = g.calls.find((c) => c.path === "/111/feed")!;
    expect(feed.afterSent).toBe(true);
    expect(feed.auth).toBe("Bearer PAGE_TOKEN_abcdefghijklmnopqrstuvwxyz");
    expect(feed.params.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/);
    expect(feed.params.get("message")).toBe("Hello from Get Assist");
    expect(feed.params.get("link")).toBe("https://shop.example.com/sale");
  });

  it("uploads several photos unpublished BEFORE marking sent, then attaches them to one post", async () => {
    let n = 0;
    const g = fakeGraph([
      [/^\/111\/photos$/, "POST", (c) => ({ status: 200, body: { id: `p${++n}`, published: c.params.get("published") } })],
      [/^\/111\/feed$/, "POST", () => ({ status: 200, body: { id: "111_333" } })],
      [/^\/111_333$/, "GET", permalink("https://www.facebook.com/x")],
    ]);
    const media = [1, 2].map((i) => ({ kind: "IMAGE" as const, mimeType: "image/jpeg", sizeBytes: 10, url: `https://app.example.com/m${i}` }));
    const out = await facebookPageAdapter.publish(page({ media }), g.ctx);
    expect(out.kind).toBe("PUBLISHED");
    const photos = g.calls.filter((c) => c.path === "/111/photos");
    expect(photos.every((c) => !c.afterSent && c.params.get("published") === "false")).toBe(true);
    const feed = g.calls.find((c) => c.path === "/111/feed")!;
    expect(feed.afterSent).toBe(true);
    expect(feed.params.get("attached_media[0]")).toBe('{"media_fbid":"p1"}');
    expect(feed.params.get("attached_media[1]")).toBe('{"media_fbid":"p2"}');
  });

  it("an answer not seen after sending is UNKNOWN; before sending it is RETRY_LATER", async () => {
    const lost = fakeGraph([[/^\/111\/feed$/, "POST", () => "NETWORK"]]);
    expect((await facebookPageAdapter.publish(page(), lost.ctx)).kind).toBe("UNKNOWN");
    const media = [1, 2].map((i) => ({ kind: "IMAGE" as const, mimeType: "image/jpeg", sizeBytes: 10, url: `https://app.example.com/m${i}` }));
    const early = fakeGraph([[/^\/111\/photos$/, "POST", () => "NETWORK"]]);
    const out = await facebookPageAdapter.publish(page({ media }), early.ctx);
    expect(out.kind).toBe("RETRY_LATER");
    expect(early.wasSent()).toBe(false);
    const fiveHundred = fakeGraph([[/^\/111\/feed$/, "POST", () => ({ status: 500, body: { error: { message: "Please retry", code: 2 } } })]]);
    expect((await facebookPageAdapter.publish(page(), fiveHundred.ctx)).kind).toBe("UNKNOWN");
  });

  it("reads Meta's errors: expired token → AUTH, rate limit → RETRY_LATER, policy → REFUSED", async () => {
    const auth = fakeGraph([[/^\/111\/feed$/, "POST", () => ({ status: 400, body: { error: { message: "Error validating access token", code: 190 } } })]]);
    expect((await facebookPageAdapter.publish(page(), auth.ctx)).kind).toBe("AUTH");
    const limited = fakeGraph([[/^\/111\/feed$/, "POST", () => ({ status: 400, body: { error: { message: "Application request limit reached", code: 4 } } })]]);
    expect(await facebookPageAdapter.publish(page(), limited.ctx)).toMatchObject({ kind: "RETRY_LATER", rateLimited: true });
    const refused = fakeGraph([[/^\/111\/feed$/, "POST", () => ({ status: 400, body: { error: { message: "Invalid parameter access_token=EAAsecretvalue123", code: 100 } } })]]);
    const out = await facebookPageAdapter.publish(page(), refused.ctx);
    expect(out.kind).toBe("REFUSED");
    expect(JSON.stringify(out)).not.toContain("EAAsecretvalue123");
  });

  it("reads back recent posts and statistics", async () => {
    const g = fakeGraph([
      [/^\/111\/published_posts$/, "GET", () => ({ status: 200, body: { data: [{ id: "111_1", message: "Hi", created_time: "2026-10-30T10:00:00+0000", permalink_url: "https://fb.com/1" }] } })],
      [/^\/111_1$/, "GET", () => ({ status: 200, body: { reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 } } })],
    ]);
    const recent = await facebookPageAdapter.findRecent(page().account, new Date("2026-10-30T09:00:00Z"), g.ctx);
    expect(recent).toEqual([{ externalId: "111_1", text: "Hi", createdAt: new Date("2026-10-30T10:00:00Z"), permalink: "https://fb.com/1" }]);
    expect(await facebookPageAdapter.metrics!(page().account, "111_1", g.ctx)).toEqual([
      { name: "reactions", label: "Reactions", value: 7 },
      { name: "comments", label: "Comments", value: 2 },
      { name: "shares", label: "Shares", value: 1 },
    ]);
  });
});

describe("Instagram adapter", () => {
  it("makes a container, waits for it, marks sent, then publishes", async () => {
    const g = fakeGraph([
      [/^\/999\/content_publishing_limit$/, "GET", okQuota],
      [/^\/999\/media$/, "POST", () => ({ status: 200, body: { id: "c1" } })],
      [/^\/c1$/, "GET", () => ({ status: 200, body: { status_code: "FINISHED" } })],
      [/^\/999\/media_publish$/, "POST", (c) => ({ status: 200, body: { id: c.params.get("creation_id") === "c1" ? "m1" : "wrong" } })],
      [/^\/m1$/, "GET", permalink("https://www.instagram.com/p/abc/")],
    ]);
    const out = await instagramAdapter.publish(ig(), g.ctx);
    expect(out).toEqual({ kind: "PUBLISHED", externalId: "m1", permalink: "https://www.instagram.com/p/abc/" });
    expect(g.calls.find((c) => c.path === "/999/media")!.afterSent).toBe(false);
    expect(g.calls.find((c) => c.path === "/999/media_publish")!.afterSent).toBe(true);
    expect(g.saved).toEqual([["c1"]]);
  });

  it("waits for the account's 24-hour quota instead of publishing", async () => {
    const g = fakeGraph([[/^\/999\/content_publishing_limit$/, "GET", () => ({ status: 200, body: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } })]]);
    expect(await instagramAdapter.publish(ig(), g.ctx)).toMatchObject({ kind: "RETRY_LATER", rateLimited: true });
    expect(g.calls.some((c) => c.path === "/999/media")).toBe(false);
  });

  it("keeps a container still processing for the next attempt, and re-uses it then", async () => {
    const first = fakeGraph([
      [/^\/999\/content_publishing_limit$/, "GET", okQuota],
      [/^\/999\/media$/, "POST", () => ({ status: 200, body: { id: "c9" } })],
      [/^\/c9$/, "GET", () => ({ status: 200, body: { status_code: "IN_PROGRESS" } })],
    ]);
    expect((await instagramAdapter.publish(ig(), first.ctx)).kind).toBe("RETRY_LATER");
    expect(first.wasSent()).toBe(false);
    expect(first.saved).toEqual([["c9"]]);

    const second = fakeGraph([
      [/^\/999\/content_publishing_limit$/, "GET", okQuota],
      [/^\/c9$/, "GET", () => ({ status: 200, body: { status_code: "FINISHED" } })],
      [/^\/999\/media_publish$/, "POST", () => ({ status: 200, body: { id: "m9" } })],
      [/^\/m9$/, "GET", permalink("https://www.instagram.com/p/x/")],
    ]);
    expect((await instagramAdapter.publish(ig({ containerIds: ["c9"] }), second.ctx)).kind).toBe("PUBLISHED");
    expect(second.calls.some((c) => c.path === "/999/media" && c.method === "POST")).toBe(false);
  });

  it("refuses media Instagram could not process, and an unseen publish answer is UNKNOWN", async () => {
    const bad = fakeGraph([
      [/^\/999\/content_publishing_limit$/, "GET", okQuota],
      [/^\/999\/media$/, "POST", () => ({ status: 200, body: { id: "c2" } })],
      [/^\/c2$/, "GET", () => ({ status: 200, body: { status_code: "ERROR", status: "Unsupported aspect ratio" } })],
    ]);
    expect(await instagramAdapter.publish(ig(), bad.ctx)).toMatchObject({ kind: "REFUSED" });
    const lost = fakeGraph([
      [/^\/999\/content_publishing_limit$/, "GET", okQuota],
      [/^\/999\/media$/, "POST", () => ({ status: 200, body: { id: "c3" } })],
      [/^\/c3$/, "GET", () => ({ status: 200, body: { status_code: "FINISHED" } })],
      [/^\/999\/media_publish$/, "POST", () => "NETWORK"],
    ]);
    expect((await instagramAdapter.publish(ig(), lost.ctx)).kind).toBe("UNKNOWN");
  });

  it("builds a carousel from children made before anything is published", async () => {
    let n = 0;
    const g = fakeGraph([
      [/^\/999\/content_publishing_limit$/, "GET", okQuota],
      [/^\/999\/media$/, "POST", (c) => ({ status: 200, body: { id: c.params.get("media_type") === "CAROUSEL" ? "parent" : `child${++n}` } })],
      [/^\/(child\d|parent)$/, "GET", () => ({ status: 200, body: { status_code: "FINISHED" } })],
      [/^\/999\/media_publish$/, "POST", () => ({ status: 200, body: { id: "m3" } })],
      [/^\/m3$/, "GET", permalink("https://www.instagram.com/p/c/")],
    ]);
    const media = [
      { kind: "IMAGE" as const, mimeType: "image/jpeg", sizeBytes: 1, url: "https://app.example.com/1" },
      { kind: "VIDEO" as const, mimeType: "video/mp4", sizeBytes: 1, url: "https://app.example.com/2" },
    ];
    expect((await instagramAdapter.publish(ig({ media }), g.ctx)).kind).toBe("PUBLISHED");
    const parent = g.calls.find((c) => c.params.get("media_type") === "CAROUSEL")!;
    expect(parent.params.get("children")).toBe("child1,child2");
    expect(parent.afterSent).toBe(false);
    expect(g.saved.at(-1)).toEqual(["child1", "child2", "parent"]);
  });
});

describe("adapter registry", () => {
  it("offers exactly the platforms the catalogue marks implemented", () => {
    const implemented = Object.values(SOCIAL_PLATFORMS).filter((p) => p.implemented).map((p) => p.key).sort();
    expect([...implementedAdapterPlatforms()].sort()).toEqual(implemented);
    expect(adapterFor("LINKEDIN")).toBeNull();
    expect(adapterFor("nonsense")).toBeNull();
  });
});
