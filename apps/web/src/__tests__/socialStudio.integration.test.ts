import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, encryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { LocalMediaStorage } from "@support-automation/media-storage";

/**
 * Social Studio's publishing engine, RSS import and media library against a REAL database (and a fake
 * Meta Graph API — nothing here is live-provider verified). What must hold:
 *   - one due job is published once however many processors race for it;
 *   - a run that lost its job (lease ran out, another run took over) never makes the post public — at the
 *     fence right before the publishing request, and at any container save before it;
 *   - a slow but healthy Instagram run renews its lease, so a recovery at the original expiry leaves it;
 *   - a job whose request may have left is never re-queued: it is UNKNOWN until reconciliation, the late
 *     answer of the run that sent it, or a person settles it;
 *   - a reschedule and a publisher's claim cannot both win, and a cancel never touches a running job;
 *   - an RSS item becomes exactly one draft, even after a failure half-way and with two runs at once;
 *   - parallel uploads never take a project past its media allowance;
 *   - nothing crosses projects, and the database itself refuses cross-project rows and history rewrites.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const { setMediaStorageForTests } = await import("@/server/mediaStorage");
const engine = await import("@/server/social/engine");
const posts = await import("@/server/social/posts");
const rss = await import("@/server/social/rss");
const media = await import("@/server/social/media");
const { socialTickOnce } = await import("@/server/socialProcessor");
const mediaRoute = await import("@/app/api/social/media/[assetId]/route");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let P: Project;
let Q: Project;
const connections = new Map<string, string>();
let seq = 0;

const inP = <T,>(fn: () => Promise<T>, project: Project = P) => runWithProject(project, fn);

// ── A fake Meta Graph API ─────────────────────────────────────────────────────────────────────────
type Call = { method: string; path: string; params: URLSearchParams };
type Handler = (call: Call) => Promise<Response | "NETWORK"> | Response | "NETWORK";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let ids = 0;
const BASE: Array<[string, RegExp, Handler]> = [
  ["POST", /^\/[^/]+\/feed$/, (c) => json({ id: `${c.path.split("/")[1]}_${++ids}` })],
  ["GET", /^\/[^/]+_\d+$/, () => json({ permalink_url: "https://www.facebook.com/p/1" })],
  ["GET", /^\/[^/]+\/content_publishing_limit$/, () => json({ data: [{ quota_usage: 1, config: { quota_total: 100 } }] })],
  ["POST", /^\/[^/]+\/media$/, () => json({ id: `c-${++ids}` })],
  ["GET", /^\/c-[\w-]+$/, () => json({ status_code: "FINISHED" })],
  ["POST", /^\/[^/]+\/media_publish$/, () => json({ id: `m-${++ids}` })],
  ["GET", /^\/m-[\w-]+$/, () => json({ permalink: "https://www.instagram.com/p/x/" })],
];
const meta = { calls: [] as Call[], routes: [...BASE] };
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "graph.facebook.com") throw new TypeError(`unexpected host ${url.hostname}`);
  const method = init?.method ?? "GET";
  const params = method === "GET" ? url.searchParams : new URLSearchParams(String(init?.body ?? ""));
  const call = { method, path: url.pathname.replace(/^\/v\d+\.\d+/, ""), params };
  meta.calls.push(call);
  const route = [...meta.routes].reverse().find(([m, re]) => m === method && re.test(call.path));
  if (!route) return json({ error: { code: 100, message: `no route ${method} ${call.path}` } }, 400);
  const out = await route[2](call);
  if (out === "NETWORK") throw new TypeError("fetch failed");
  return out;
};
const count = (method: string, path: string) => meta.calls.filter((c) => c.method === method && c.path === path).length;

function gate() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const arrived = new Promise<void>((r) => (reached = r));
  return { open, opened, reached, arrived };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────
async function project(name: string): Promise<Project> {
  const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: null }, rawPrisma);
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "SOCIAL_STUDIO" } }, create: { projectId: p.id, key: "SOCIAL_STUDIO", enabled: true }, update: { enabled: true } });
  const c = await rawPrisma.socialConnection.create({ data: { projectId: p.id, provider: "META", externalUserId: `u${tag}${name}`, connectedByUsername: "admin" } });
  connections.set(p.id, c.id);
  return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" };
}

async function account(platform: "FACEBOOK_PAGE" | "INSTAGRAM", in_: Project = P) {
  const externalId = `${platform === "INSTAGRAM" ? "ig" : "pg"}${tag}${++seq}`;
  return rawPrisma.socialAccount.create({
    data: {
      projectId: in_.id,
      connectionId: connections.get(in_.id)!,
      platform,
      externalId,
      parentExternalId: platform === "INSTAGRAM" ? `pg${tag}parent` : null,
      name: `${platform} ${seq}`,
      tokenCiphertext: encryptSecret(`EAATOKEN${tag}${seq}0000000000`),
      lastSeenAt: new Date(),
    },
  });
}

async function image(in_: Project = P) {
  return rawPrisma.socialMediaAsset.create({ data: { projectId: in_.id, storageKey: `social/${in_.id}/t${tag}${++seq}.jpg`, name: "a.jpg", kind: "IMAGE", mimeType: "image/jpeg", sizeBytes: 1000, uploadedByUsername: "t" } });
}

/** A post written, approved and scheduled through the real actions — due now unless `at` is given. */
async function scheduledPost(accountIds: string[], opts: { content?: string; mediaIds?: string[]; at?: Date } = {}) {
  const content = opts.content ?? `Post ${tag} ${++seq}`;
  const postId = await inP(async () => {
    const { id } = await posts.saveSocialDraft(
      { title: null, content, accountIds, mediaIds: opts.mediaIds ?? [], variants: {}, settings: {}, publishMode: opts.at ? "SCHEDULE" : "NOW", scheduledAt: opts.at ?? null, timezone: "Asia/Dhaka", campaignId: null, aiAssisted: false },
      "writer",
    );
    await posts.applySocialAction(id, "SUBMIT", "writer");
    await posts.applySocialAction(id, "APPROVE", "approver");
    await posts.applySocialAction(id, "SCHEDULE", "publisher", opts.at ? { publishMode: "SCHEDULE", scheduledAt: opts.at } : { publishMode: "NOW" });
    return id;
  });
  const targets = await rawPrisma.socialPostTarget.findMany({ where: { postId }, select: { id: true, accountId: true } });
  return { postId, content, targets, target: targets[0]!.id };
}

const targetRow = (id: string) => rawPrisma.socialPostTarget.findUniqueOrThrow({ where: { id } });
const attemptsOf = (targetId: string) => rawPrisma.socialPublishAttempt.findMany({ where: { targetId }, orderBy: [{ startedAt: "asc" }, { id: "asc" }] });
/** Another processor finds this job's lease ran out (its process stalled or died). */
const expireLease = (id: string) => rawPrisma.socialPostTarget.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });

let mediaRoot: string;

beforeAll(async () => {
  vi.stubEnv("META_APP_SECRET", "0123456789abcdef0123456789abcdef");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.test");
  vi.stubEnv("NEXTAUTH_SECRET", `secret-${tag}-0123456789abcdef0123456789`);
  vi.stubGlobal("fetch", fakeFetch);
  mediaRoot = mkdtempSync(join(tmpdir(), "social-media-"));
  setMediaStorageForTests(new LocalMediaStorage(mediaRoot));
  P = await project("SocialP");
  Q = await project("SocialQ");
  forgetProjectFeatureStates();
});

afterAll(() => {
  setMediaStorageForTests(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(mediaRoot, { recursive: true, force: true });
});

beforeEach(() => {
  meta.calls = [];
  meta.routes = [...BASE];
});

// ── The engine ────────────────────────────────────────────────────────────────────────────────────
describe("publishing engine — claims, leases and the fence", () => {
  it("five runs racing for one due job: one publishes, four skip, Meta is asked once", async () => {
    const fb = await account("FACEBOOK_PAGE");
    const { target } = await scheduledPost([fb.id]);
    const results = await Promise.all(Array.from({ length: 5 }, () => inP(() => engine.publishTarget(target, new Date()))));
    expect(results.filter((r) => r === "PUBLISHED")).toHaveLength(1);
    expect(results.filter((r) => r === "SKIPPED")).toHaveLength(4);
    expect(count("POST", `/${fb.externalId}/feed`)).toBe(1);
    expect(await attemptsOf(target)).toHaveLength(1);
    expect((await targetRow(target)).status).toBe("PUBLISHED");
  });

  it("two processors ticking at once publish each due job exactly once", async () => {
    const accounts = await Promise.all([account("FACEBOOK_PAGE"), account("FACEBOOK_PAGE"), account("FACEBOOK_PAGE")]);
    const made = [];
    for (const a of accounts) made.push(await scheduledPost([a.id]));
    await Promise.all([socialTickOnce(new Date()), socialTickOnce(new Date())]);
    for (const a of accounts) expect(count("POST", `/${a.externalId}/feed`), a.externalId).toBe(1);
    for (const m of made) expect((await targetRow(m.target)).status).toBe("PUBLISHED");
  });

  it("a run whose lease ran out while Instagram processed never publishes; the run that took over publishes once", async () => {
    const ig = await account("INSTAGRAM");
    const { target } = await scheduledPost([ig.id], { mediaIds: [(await image()).id] });
    const g = gate();
    let polls = 0;
    meta.routes.push(["GET", /^\/c-[\w-]+$/, async () => {
      if (++polls === 1) {
        g.reached();
        await g.opened;
      }
      return json({ status_code: "FINISHED" });
    }]);
    const runA = inP(() => engine.publishTarget(target, new Date()));
    await g.arrived;
    await expireLease(target);
    expect(await inP(() => engine.recoverExpiredLease(target, new Date()))).toBe("REQUEUED");
    expect(await inP(() => engine.publishTarget(target, new Date()))).toBe("PUBLISHED");
    g.open();
    expect(await runA).toBe("SKIPPED");
    expect(count("POST", `/${ig.externalId}/media_publish`)).toBe(1);
    const attempts = await attemptsOf(target);
    expect(attempts.map((a) => a.outcome)).toEqual(["REQUEUED", "PUBLISHED"]);
    expect(attempts[0]!.requestSentAt).toBeNull();
    expect((await targetRow(target)).status).toBe("PUBLISHED");
  });

  it("a run that wakes after losing its job at container creation stops there: no publish, no further Meta calls, no overwrite", async () => {
    const ig = await account("INSTAGRAM");
    const { target } = await scheduledPost([ig.id], { mediaIds: [(await image()).id] });
    const g = gate();
    let creates = 0;
    meta.routes.push(["POST", /^\/[^/]+\/media$/, async () => {
      if (++creates === 1) {
        g.reached();
        await g.opened;
        return json({ id: "c-zombie" });
      }
      return json({ id: `c-${++ids}` });
    }]);
    const runA = inP(() => engine.publishTarget(target, new Date()));
    await g.arrived;
    await expireLease(target);
    expect(await inP(() => engine.recoverExpiredLease(target, new Date()))).toBe("REQUEUED");
    expect(await inP(() => engine.publishTarget(target, new Date()))).toBe("PUBLISHED");
    g.open();
    expect(await runA).toBe("SKIPPED");
    expect(count("POST", `/${ig.externalId}/media_publish`)).toBe(1);
    expect(count("GET", "/c-zombie")).toBe(0); // the fenced container save stopped it before any further call
    expect((await targetRow(target)).externalContainerIds).toEqual([]);
  });

  it("a slow but healthy Instagram run renews its lease: a recovery at the original expiry leaves it alone", async () => {
    const ig = await account("INSTAGRAM");
    const { target } = await scheduledPost([ig.id], { mediaIds: [(await image()).id] });
    const g = gate();
    let polls = 0;
    const leases: Date[] = [];
    meta.routes.push(["GET", /^\/c-[\w-]+$/, async () => {
      polls += 1;
      leases.push((await targetRow(target)).leaseExpiresAt!);
      if (polls === 1) return json({ status_code: "IN_PROGRESS" }); // the adapter waits 5 s, then polls again
      if (polls === 2) {
        g.reached();
        await g.opened;
      }
      return json({ status_code: "FINISHED" });
    }]);
    const runA = inP(() => engine.publishTarget(target, new Date()));
    await g.arrived;
    expect(leases[1]!.getTime() - leases[0]!.getTime()).toBeGreaterThanOrEqual(4_000);
    expect(await inP(() => engine.recoverExpiredLease(target, new Date(leases[0]!.getTime() + 1_000)))).toBe("SKIPPED");
    g.open();
    expect(await runA).toBe("PUBLISHED");
    expect(count("POST", `/${ig.externalId}/media_publish`)).toBe(1);
  });

  it("a process that stopped AFTER sending is never re-queued: UNKNOWN, not sent again, then found on the account", async () => {
    const ig = await account("INSTAGRAM");
    const { target, content } = await scheduledPost([ig.id], { mediaIds: [(await image()).id] });
    const g = gate();
    meta.routes.push(["POST", /^\/[^/]+\/media_publish$/, async () => {
      g.reached();
      await g.opened;
      return "NETWORK" as const;
    }]);
    const runA = inP(() => engine.publishTarget(target, new Date()));
    await g.arrived;
    await expireLease(target);
    expect(await inP(() => engine.recoverExpiredLease(target, new Date()))).toBe("UNKNOWN");
    expect(await inP(() => engine.publishTarget(target, new Date()))).toBe("SKIPPED");
    await socialTickOnce(new Date());
    g.open();
    expect(await runA).toBe("UNKNOWN");
    expect(count("POST", `/${ig.externalId}/media_publish`)).toBe(1);
    const [attempt] = await attemptsOf(target);
    expect(attempt!.requestSentAt).not.toBeNull();
    expect(attempt!.outcome).toBe("UNKNOWN");
    expect((await targetRow(target)).status).toBe("UNKNOWN");

    meta.routes.push(["GET", new RegExp(`^/${ig.externalId}/media$`), () => json({ data: [{ id: "m-found", caption: content, timestamp: new Date().toISOString(), permalink: "https://www.instagram.com/p/found/" }] })]);
    expect(await inP(() => engine.reconcileUnknownTarget(target, new Date()))).toBe("MATCHED");
    const settled = await targetRow(target);
    expect(settled.status).toBe("PUBLISHED");
    expect(settled.externalId).toBe("m-found");
    expect(count("POST", `/${ig.externalId}/media_publish`)).toBe(1);
  });

  it("the platform's answer arriving after the lease ran out settles the job PUBLISHED, once", async () => {
    const ig = await account("INSTAGRAM");
    const { target, postId } = await scheduledPost([ig.id], { mediaIds: [(await image()).id] });
    const g = gate();
    meta.routes.push(["POST", /^\/[^/]+\/media_publish$/, async () => {
      g.reached();
      await g.opened;
      return json({ id: "m-late" });
    }]);
    const runA = inP(() => engine.publishTarget(target, new Date()));
    await g.arrived;
    await expireLease(target);
    expect(await inP(() => engine.recoverExpiredLease(target, new Date()))).toBe("UNKNOWN");
    g.open();
    expect(await runA).toBe("PUBLISHED");
    const settled = await targetRow(target);
    expect(settled.status).toBe("PUBLISHED");
    expect(settled.externalId).toBe("m-late");
    const [attempt] = await attemptsOf(target);
    expect(attempt!.outcome).toBe("PUBLISHED");
    expect(attempt!.externalId).toBe("m-late");
    const events = await rawPrisma.socialPostEvent.findMany({ where: { postId, kind: "PUBLISHED" } });
    expect(events).toHaveLength(1);
    expect((await rawPrisma.socialPost.findUniqueOrThrow({ where: { id: postId } })).status).toBe("PUBLISHED");
  });

  it("an ambiguous answer (Meta 500 after sending) is UNKNOWN, never repeated; several look-alikes are left to a person", async () => {
    const fb = await account("FACEBOOK_PAGE");
    const { target, content } = await scheduledPost([fb.id]);
    meta.routes.push(["POST", new RegExp(`^/${fb.externalId}/feed$`), () => json({ error: { message: "Please retry your request later.", code: 2 } }, 500)]);
    expect(await inP(() => engine.publishTarget(target, new Date()))).toBe("UNKNOWN");
    expect(await inP(() => engine.publishTarget(target, new Date()))).toBe("SKIPPED");
    expect(count("POST", `/${fb.externalId}/feed`)).toBe(1);

    const at = new Date().toISOString();
    meta.routes.push(["GET", new RegExp(`^/${fb.externalId}/published_posts$`), () => json({ data: [1, 2].map((i) => ({ id: `${fb.externalId}_9${i}`, message: content, created_time: at })) })]);
    expect(await inP(() => engine.reconcileUnknownTarget(target, new Date()))).toBe("UNMATCHED");
    const row = await targetRow(target);
    expect(row.status).toBe("UNKNOWN");
    expect(row.error).toMatch(/2 posts on the account look like this one/);

    await expect(inP(() => posts.applyTargetAction(target, "SEND_AGAIN", "publisher", {}))).rejects.toThrow(/Confirm that you checked/);
    await inP(() => posts.applyTargetAction(target, "MARK_PUBLISHED", "publisher", { permalink: "https://www.facebook.com/x" }));
    expect((await targetRow(target)).status).toBe("PUBLISHED");
    expect(count("POST", `/${fb.externalId}/feed`)).toBe(1);
  });

  it("a reschedule that meets a publisher's claim refuses, and changes nothing", async () => {
    const fb = await account("FACEBOOK_PAGE");
    const at = new Date(Date.now() + 3_600_000);
    const { postId, target } = await scheduledPost([fb.id], { at });
    const g = gate();
    // A publisher's claim, still committing while the reschedule runs.
    const claim = rawPrisma.$transaction(
      async (tx) => {
        await tx.socialPostTarget.updateMany({ where: { id: target, status: "DUE" }, data: { status: "PUBLISHING", claimToken: "other-run", leaseExpiresAt: new Date(Date.now() + 300_000) } });
        g.reached();
        await g.opened;
      },
      { timeout: 20_000 },
    );
    await g.arrived;
    const moving = inP(() => posts.rescheduleSocialPost(postId, new Date(Date.now() + 7_200_000), "editor"));
    // Wait until the reschedule is blocked on the claimed row, then let the claim commit.
    for (let i = 0; i < 100; i++) {
      const [{ waiting }] = await rawPrisma.$queryRaw<Array<{ waiting: bigint }>>`SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      if (Number(waiting) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    g.open();
    await claim;
    await expect(moving).rejects.toThrow(/started publishing on an account just now/);
    const post = await rawPrisma.socialPost.findUniqueOrThrow({ where: { id: postId } });
    expect(post.scheduledAt?.getTime()).toBe(at.getTime());
    expect((await targetRow(target)).dueAt?.getTime()).toBe(at.getTime());
  });

  it("a reschedule that wins first leaves nothing for a publisher at the old time; cancel never touches a running job", async () => {
    const fb = await account("FACEBOOK_PAGE");
    const at = new Date(Date.now() + 3_600_000);
    const later = new Date(Date.now() + 7_200_000);
    const { postId, target } = await scheduledPost([fb.id], { at });
    await inP(() => posts.rescheduleSocialPost(postId, later, "editor"));
    expect(await inP(() => engine.publishTarget(target, new Date(at.getTime() + 1_000)))).toBe("SKIPPED");
    expect((await targetRow(target)).dueAt?.getTime()).toBe(later.getTime());

    const fb2 = await account("FACEBOOK_PAGE");
    const running = await scheduledPost([fb2.id]);
    const g = gate();
    meta.routes.push(["POST", new RegExp(`^/${fb2.externalId}/feed$`), async () => {
      g.reached();
      await g.opened;
      return json({ id: `${fb2.externalId}_1` });
    }]);
    const run = inP(() => engine.publishTarget(running.target, new Date()));
    await g.arrived;
    const cancelled = await inP(() => posts.applySocialAction(running.postId, "CANCEL", "publisher"));
    expect(cancelled.message).toMatch(/already publishing or published are not affected/);
    expect((await targetRow(running.target)).status).toBe("PUBLISHING");
    g.open();
    expect(await run).toBe("PUBLISHED");
    expect(count("POST", `/${fb2.externalId}/feed`)).toBe(1);
  });
});

// ── RSS import ────────────────────────────────────────────────────────────────────────────────────
describe("RSS import — each item becomes exactly one draft", () => {
  let server: http.Server;
  let port = 0;
  const feeds = new Map<string, string>();
  const fetchOptions = () => ({ resolve: (_h: string, cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }]), allowAddress: (a: string) => a === "127.0.0.1", portOverride: port });
  const xml = (items: Array<{ guid: string; title: string }>) =>
    `<?xml version="1.0"?><rss><channel><title>Blog</title>${items.map((i) => `<item><title>${i.title}</title><link>https://shop.example.com/${i.guid}</link><guid>${i.guid}</guid><pubDate>${new Date().toUTCString()}</pubDate><description>About ${i.title}</description></item>`).join("")}</channel></rss>`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const body = feeds.get(req.url ?? "");
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/rss+xml" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    await rawPrisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS social_rss_test_fail (guid text primary key)`);
    await rawPrisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION social_rss_test_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW."postId" IS NOT NULL AND EXISTS (SELECT 1 FROM social_rss_test_fail WHERE guid = NEW.guid) THEN
          RAISE EXCEPTION 'injected failure after the draft was made';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await rawPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS social_rss_test_fail_trg ON "SocialRssItem"`);
    await rawPrisma.$executeRawUnsafe(`CREATE TRIGGER social_rss_test_fail_trg BEFORE UPDATE ON "SocialRssItem" FOR EACH ROW EXECUTE FUNCTION social_rss_test_fail_fn()`);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rawPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS social_rss_test_fail_trg ON "SocialRssItem"`);
    await rawPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS social_rss_test_fail_fn()`);
    await rawPrisma.$executeRawUnsafe(`DROP TABLE IF EXISTS social_rss_test_fail`);
  });

  async function feedFor(items: Array<{ guid: string; title: string }>) {
    const fb = await account("FACEBOOK_PAGE");
    const path = `/feed-${++seq}`;
    feeds.set(path, xml(items));
    const { id } = await inP(() => rss.saveFeed({ name: `Blog ${seq}`, url: `http://blog${tag}.example.test${path}`, accountIds: [fb.id], prefix: null, includeSummary: true, intervalMinutes: 60, enabled: true }, "admin"));
    await rawPrisma.socialRssFeed.update({ where: { id }, data: { importFrom: new Date(Date.now() - 86_400_000) } });
    return { feedId: id, account: fb };
  }
  const draftsFor = (title: string) => rawPrisma.socialPost.count({ where: { projectId: P.id, title: `RSS: ${title}` } });
  const run = (feedId: string) => inP(() => rss.runFeed(feedId, new Date(), fetchOptions()));

  it("a draft that could not be made is tried again and made exactly once", async () => {
    const title = `Eid sale ${tag}`;
    const { feedId, account: fb } = await feedFor([{ guid: `g1-${tag}`, title }]);
    await rawPrisma.socialAccount.update({ where: { id: fb.id }, data: { enabled: false } });
    const failed = await run(feedId);
    expect(failed.drafts).toBe(0);
    expect(failed.error).toMatch(/tried again/);
    expect(await rawPrisma.socialRssItem.count({ where: { feedId } })).toBe(0);

    await rawPrisma.socialAccount.update({ where: { id: fb.id }, data: { enabled: true } });
    expect((await run(feedId)).drafts).toBe(1);
    expect((await run(feedId)).drafts).toBe(0);
    expect(await draftsFor(title)).toBe(1);
    const item = await rawPrisma.socialRssItem.findFirstOrThrow({ where: { feedId } });
    expect(item.postId).not.toBeNull();
  });

  it("a failure AFTER the draft was made rolls the draft back too, and the next run makes exactly one", async () => {
    const title = `Winter range ${tag}`;
    const guid = `g2-${tag}`;
    const { feedId } = await feedFor([{ guid, title }]);
    await rawPrisma.$executeRawUnsafe(`INSERT INTO social_rss_test_fail (guid) VALUES ($1)`, guid);
    const failed = await run(feedId);
    expect(failed.drafts).toBe(0);
    expect(failed.error).toMatch(/tried again/);
    expect(await draftsFor(title)).toBe(0);
    expect(await rawPrisma.socialRssItem.count({ where: { feedId } })).toBe(0);

    await rawPrisma.$executeRawUnsafe(`DELETE FROM social_rss_test_fail WHERE guid = $1`, guid);
    expect((await run(feedId)).drafts).toBe(1);
    expect((await run(feedId)).drafts).toBe(0);
    expect(await draftsFor(title)).toBe(1);
  });

  it("an item an older version left recorded without a draft is picked up and made once", async () => {
    const title = `Stranded ${tag}`;
    const guid = `g3-${tag}`;
    const { feedId } = await feedFor([{ guid, title }]);
    await rawPrisma.socialRssItem.create({ data: { projectId: P.id, feedId, guid, title, link: null } });
    expect((await run(feedId)).drafts).toBe(1);
    expect((await run(feedId)).drafts).toBe(0);
    expect(await draftsFor(title)).toBe(1);
  });

  it("three runs of one feed at once make one draft per item", async () => {
    const items = [1, 2, 3].map((i) => ({ guid: `g4-${i}-${tag}`, title: `Parallel ${i} ${tag}` }));
    const { feedId } = await feedFor(items);
    const results = await Promise.all([run(feedId), run(feedId), run(feedId)]);
    expect(results.reduce((n, r) => n + r.drafts, 0)).toBe(3);
    for (const i of items) expect(await draftsFor(i.title), i.title).toBe(1);
    expect(await rawPrisma.socialRssItem.count({ where: { feedId, postId: null } })).toBe(0);
  });
});

// ── Media library ─────────────────────────────────────────────────────────────────────────────────
describe("media library — the allowance under parallel uploads", () => {
  it("six parallel uploads into a 1 MB allowance: exactly the two that fit are kept, the rest leave no file", async () => {
    vi.stubEnv("SOCIAL_MEDIA_PROJECT_MB", "1");
    vi.stubEnv("MEDIA_MIN_FREE_DISK_MB", "0");
    const R = await project("SocialMedia");
    const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(400 * 1024 - 4)]);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => runWithProject(R, () => media.uploadSocialAsset({ bytes: jpeg(), fileName: `f${i}.jpg`, folder: null, username: "u" }))));
    const kept = results.filter((r) => r.status === "fulfilled");
    expect(kept).toHaveLength(2);
    for (const r of results) if (r.status === "rejected") expect(String((r.reason as Error).message)).toMatch(/media library is full/);
    const used = await rawPrisma.socialMediaAsset.aggregate({ where: { projectId: R.id, deletedAt: null }, _sum: { sizeBytes: true } });
    expect(used._sum.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
    const dir = join(mediaRoot, "social", R.id);
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(2);
    vi.stubEnv("SOCIAL_MEDIA_PROJECT_MB", "");
  });

  it("a platform fetches a file only through its own unexpired signature", async () => {
    const R = await project("SocialSign");
    const asset = await runWithProject(R, () => media.uploadSocialAsset({ bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(1000)]), fileName: "p.jpg", folder: null, username: "u" }));
    const other = await runWithProject(R, () => media.uploadSocialAsset({ bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(1000)]), fileName: "q.jpg", folder: null, username: "u" }));
    const signed = media.signedAssetUrl(asset.id);
    expect(signed.ok).toBe(true);
    const url = new URL((signed as { url: string }).url);
    expect(url.origin).toBe("https://app.example.test");
    const get = (u: string, id: string) => mediaRoute.GET(new NextRequest(u), { params: Promise.resolve({ assetId: id }) });
    const ok = await get(url.toString(), asset.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    // The same signature for another file, an altered one, and an expired one are all plain 404s.
    expect((await get(url.toString().replace(asset.id, other.id), other.id)).status).toBe(404);
    expect((await get(url.toString().replace(/sig=[^&]+/, "sig=AAAA"), asset.id)).status).toBe(404);
    const past = media.signedAssetUrl(asset.id, new Date(Date.now() - 3 * 3_600_000));
    expect((await get((past as { url: string }).url, asset.id)).status).toBe(404);
    expect((await get(`https://app.example.test/api/social/media/${asset.id}`, asset.id)).status).toBe(404);
    await runWithProject(R, () => media.deleteSocialAsset(asset.id));
    expect((await get(url.toString(), asset.id)).status).toBe(404);
  });
});

// ── Meta taking access back ───────────────────────────────────────────────────────────────────────
describe("Meta deauthorize and data deletion reach Social Studio (Messenger handling unchanged)", () => {
  it("removing the app wipes Social Studio's tokens so nothing is sent with them; data deletion also forgets the person", async () => {
    vi.stubEnv("META_INTEGRATION_ENABLED", "true");
    vi.stubEnv("META_APP_ID", "987654321098");
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", `verify-${tag}-0123456789`);
    const { runWithTenant } = await import("@/server/tenant");
    const { handleMetaDeauthorize, handleMetaDataDeletion } = await import("@/server/channels/metaRevocation");
    const { createHmac } = await import("node:crypto");
    const sign = (userId: string, secret = "0123456789abcdef0123456789abcdef") => {
      const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: userId, issued_at: Math.floor(Date.now() / 1000) })).toString("base64url");
      return `${createHmac("sha256", secret).update(payload).digest("base64url")}.${payload}`;
    };
    const fbUser = `7${Date.now()}`.slice(0, 15);
    const conn = await rawPrisma.socialConnection.create({ data: { projectId: P.id, provider: "META", externalUserId: fbUser, externalUserName: "Page Admin", credentialCiphertext: encryptSecret(`EAAUSER${tag}000000000000`), connectedByUsername: "admin" } });
    const acc = await rawPrisma.socialAccount.create({ data: { projectId: P.id, connectionId: conn.id, platform: "FACEBOOK_PAGE", externalId: `pgrev${tag}`, name: "Revoked page", tokenCiphertext: encryptSecret(`EAAPAGE${tag}000000000000`), lastSeenAt: new Date() } });
    const untouched = await account("FACEBOOK_PAGE");
    const { target } = await scheduledPost([acc.id]);

    expect((await runWithTenant(null, () => handleMetaDeauthorize(sign(fbUser, "f".repeat(32))))).status).toBe(400);
    expect((await rawPrisma.socialAccount.findUniqueOrThrow({ where: { id: acc.id } })).tokenCiphertext).not.toBeNull();

    expect((await runWithTenant(null, () => handleMetaDeauthorize(sign(fbUser)))).status).toBe(200);
    const c1 = await rawPrisma.socialConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect([c1.status, c1.credentialCiphertext, c1.externalUserId]).toEqual(["NEEDS_RECONNECT", null, fbUser]);
    const a1 = await rawPrisma.socialAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect([a1.status, a1.tokenCiphertext]).toEqual(["NEEDS_RECONNECT", null]);
    expect((await rawPrisma.socialAccount.findUniqueOrThrow({ where: { id: untouched.id } })).tokenCiphertext).not.toBeNull();

    // The post scheduled before the removal fails with "reconnect" — Meta is never called with a dead token.
    expect(await inP(() => engine.publishTarget(target, new Date()))).toBe("FAILED");
    expect((await targetRow(target)).error).toMatch(/reconnect/i);
    expect(count("POST", `/pgrev${tag}/feed`)).toBe(0);

    const deletion = await runWithTenant(null, () => handleMetaDataDeletion(sign(fbUser)));
    expect(deletion.status).toBe(200);
    const c2 = await rawPrisma.socialConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(c2.externalUserId).toMatch(/^deleted-[a-f0-9]{18}$/);
    expect(c2.externalUserName).toBeNull();
    expect(await rawPrisma.socialConnection.count({ where: { externalUserId: fbUser } })).toBe(0);
    vi.stubEnv("META_INTEGRATION_ENABLED", "");
  });
});

// ── Projects and the database's own rules ─────────────────────────────────────────────────────────
describe("tenant isolation and database integrity", () => {
  it("another project cannot publish, recover, act on, or read P's jobs and feeds", async () => {
    const fb = await account("FACEBOOK_PAGE");
    const { target, postId } = await scheduledPost([fb.id], { at: new Date(Date.now() + 3_600_000) });
    await rawPrisma.socialPostTarget.update({ where: { id: target }, data: { dueAt: new Date(Date.now() - 1000) } });
    expect(await inP(() => engine.publishTarget(target, new Date()), Q)).toBe("SKIPPED");
    expect(count("POST", `/${fb.externalId}/feed`)).toBe(0);
    expect((await targetRow(target)).status).toBe("DUE");
    await rawPrisma.socialPostTarget.update({ where: { id: target }, data: { status: "PUBLISHING", claimToken: "p-run", leaseExpiresAt: new Date(Date.now() - 1000) } });
    expect(await inP(() => engine.recoverExpiredLease(target, new Date()), Q)).toBe("SKIPPED");
    expect((await targetRow(target)).status).toBe("PUBLISHING");
    await expect(inP(() => posts.applyTargetAction(target, "CANCEL", "intruder"), Q)).rejects.toThrow(/no longer exists/);
    await expect(inP(() => posts.applySocialAction(postId, "CANCEL", "intruder"), Q)).rejects.toThrow(/no longer exists/);
    expect(await inP(() => posts.getSocialPost(postId), Q)).toBeNull();
    const { id: feedId } = await inP(() => rss.saveFeed({ name: "P feed", url: `https://blog${tag}.example.com/feed`, accountIds: [fb.id], prefix: null, includeSummary: false, intervalMinutes: 60, enabled: false }, "admin"));
    expect((await inP(() => rss.runFeed(feedId, new Date()), Q)).error).toMatch(/no longer exists/);
    // Q cannot draft for P's account either.
    await expect(inP(() => posts.saveSocialDraft({ title: null, content: "x", accountIds: [fb.id], mediaIds: [], variants: {}, settings: {}, publishMode: "NOW", scheduledAt: null, timezone: "Asia/Dhaka", campaignId: null, aiAssisted: false }, "intruder"), Q)).rejects.toThrow();
  });

  it("the database refuses a job joining another project's account, any project move, and a rewritten history", async () => {
    const fbQ = await account("FACEBOOK_PAGE", Q);
    const fb = await account("FACEBOOK_PAGE");
    const { postId, target } = await scheduledPost([fb.id], { at: new Date(Date.now() + 3_600_000) });
    await expect(rawPrisma.socialPostTarget.create({ data: { projectId: P.id, postId, accountId: fbQ.id } })).rejects.toThrow();
    await expect(rawPrisma.socialPostTarget.update({ where: { id: target }, data: { projectId: Q.id } })).rejects.toThrow();
    await expect(rawPrisma.socialPost.update({ where: { id: postId }, data: { projectId: Q.id } })).rejects.toThrow();
    const event = await rawPrisma.socialPostEvent.findFirstOrThrow({ where: { postId } });
    await expect(rawPrisma.socialPostEvent.update({ where: { id: event.id }, data: { kind: "EDITED" } })).rejects.toThrow(/append-only/);
    await expect(rawPrisma.socialPublishAttempt.create({ data: { projectId: Q.id, targetId: target, attemptNo: 1, claimToken: "x", startedAt: new Date() } })).rejects.toThrow();
  });

  it("every Social Studio table is project-owned, tied to its parents by same-project triggers, and immutable in project", async () => {
    const tables = ["SocialConnection", "SocialAccount", "SocialPost", "SocialPostTarget", "SocialPublishAttempt", "SocialPostEvent", "SocialMediaAsset", "SocialCampaign", "SocialTemplate", "SocialAiRequest", "SocialRssFeed", "SocialRssItem"];
    const rows = await rawPrisma.$queryRaw<Array<{ table: string; trigger: string }>>`
      SELECT c.relname AS "table", t.tgname AS "trigger" FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname LIKE 'Social%'`;
    for (const table of tables) {
      expect(rows.some((r) => r.table === table && r.trigger === `${table}_projectId_immutable`), `${table} immutable`).toBe(true);
    }
    for (const trigger of ["SocialAccount_connectionId_same_project", "SocialPostTarget_postId_same_project", "SocialPostTarget_accountId_same_project", "SocialPublishAttempt_targetId_same_project", "SocialPostEvent_postId_same_project", "SocialRssItem_feedId_same_project"]) {
      expect(rows.some((r) => r.trigger === trigger), trigger).toBe(true);
    }
  });
});
