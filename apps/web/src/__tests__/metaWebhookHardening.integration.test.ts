import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";

/**
 * Meta expansion A3 (docs/meta-expansion/09): the Meta webhooks and OAuth refuse what they do not handle,
 * explicitly. What must hold:
 *   - a body is never read past its limit — a lying Content-Length or a chunked body without one is cut
 *     off while streaming, not after it is all in memory; the limits themselves are unchanged;
 *   - a signed body that is not a Meta webhook envelope is a 400 and records nothing;
 *   - an object this server does not handle — WhatsApp Cloud API's `whatsapp_business_account` above all —
 *     is acknowledged and records nothing: it never enters the Messenger pipeline;
 *   - a website-chat (or any non-Meta) connection is never served by a Meta route or reconnected with
 *     Facebook. The checks used to exclude Telegram only.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const SECRET = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
let projectId = "";
let creatorId = "";
let webchatKey = "";
let webchatId = "";

const ingest = await import("@/server/channels/webhookIngest");
const platformWebhook = await import("@/app/api/meta/webhook/route");
const manualWebhook = await import("@/app/api/channels/meta/[key]/route");
const oauth = await import("@/server/channels/metaOAuth");
const { runWithProject } = await import("@/server/projectContext");

const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
const events = () => rawPrisma.channelInboundEvent.count();

/** A request whose body arrives in chunks with no Content-Length, like a chunked upload. */
function chunked(url: string, totalBytes: number, headers: Record<string, string> = {}): NextRequest {
  const chunk = new Uint8Array(64 * 1024).fill(32);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return new NextRequest(url, { method: "POST", body, headers, duplex: "half" } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `metahard_${tag}`, name: "Meta hardening", passwordHash: "x" } })).id;
  const p = await createProjectWithDefaults({ name: `Meta hardening ${tag}`, slug: `meta-hard-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  projectId = p.id;
  webchatKey = `wch${tag}${tag}${tag}`;
  webchatId = (await rawPrisma.channelConnection.create({ data: { projectId, type: "WEBCHAT", name: "Site", status: "CONNECTED", webhookKey: webchatKey, externalAccountId: `site${tag}` } })).id;
  vi.stubEnv("META_INTEGRATION_ENABLED", "true");
  vi.stubEnv("META_APP_ID", "123456789012");
  vi.stubEnv("META_APP_SECRET", SECRET);
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", `verify-${tag}-0123456789`);
  vi.stubEnv("META_OAUTH_REDIRECT_URI", "https://admin.example.test/api/meta/oauth/callback");
  vi.stubEnv("META_ALLOWED_PROJECT_IDS", projectId);
});

afterAll(async () => {
  await rawPrisma.metaOAuthSession.deleteMany({ where: { projectId } });
  await rawPrisma.channelConnection.deleteMany({ where: { projectId } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: creatorId } });
  vi.unstubAllEnvs();
});

describe("body limits — enforced while reading, limits unchanged", () => {
  it("keeps 1 MB for a manual webhook and 8 MB for the platform's", () => {
    expect(ingest.MAX_WEBHOOK_BYTES).toBe(1_000_000);
    expect(ingest.MAX_PLATFORM_WEBHOOK_BYTES).toBe(8_000_000);
  });

  it("stops a chunked body with no Content-Length at the limit", async () => {
    expect(await ingest.readWebhookBody(chunked("https://x.test/", 3_000_000), 1_000_000)).toBeNull();
    const fine = await ingest.readWebhookBody(chunked("https://x.test/", 200_000), 1_000_000);
    expect(fine?.length).toBe(4 * 64 * 1024);
  });

  it("refuses a declared Content-Length over the limit without reading, and a body that outgrows a smaller claim", async () => {
    const declared = new NextRequest("https://x.test/", { method: "POST", body: "{}", headers: { "content-length": "9000000" } });
    expect(await ingest.readWebhookBody(declared, 8_000_000)).toBeNull();
    const response = await platformWebhook.POST(chunked("https://admin.example.test/api/meta/webhook", 9_000_000, { "x-hub-signature-256": "sha256=00" }));
    expect(response.status).toBe(413);
  });
});

describe("the envelope", () => {
  it("answers a signed body that is not a Meta webhook with 400 and records nothing", async () => {
    const before = await events();
    for (const raw of ["[]", '"x"', '{"object":"page"}', '{"object":"PAGE; DROP","entry":[]}', '{"entry":[]}']) {
      const answer = await ingest.ingestPlatformMetaWebhook({ rawBody: Buffer.from(raw), signature: sign(raw), appSecret: SECRET });
      expect(answer.status, raw).toBe(400);
    }
    expect(await events()).toBe(before);
  });

  it("acknowledges a WhatsApp Cloud API body and records nothing — it never enters the Messenger pipeline", async () => {
    const before = await events();
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: `waba${tag}`, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: `pn${tag}` }, messages: [{ id: `wamid.${tag}`, from: "8801700000000", type: "text", text: { body: "hi" } }] } }] }],
    });
    const answer = await ingest.ingestPlatformMetaWebhook({ rawBody: Buffer.from(raw), signature: sign(raw), appSecret: SECRET });
    expect(answer).toMatchObject({ status: 200 });
    expect(await events()).toBe(before);
  });
});

describe("only Meta channel types use Meta routes", () => {
  it("a website-chat connection's key is not a Meta webhook (verify or events)", async () => {
    const verify = await manualWebhook.GET(new NextRequest(`https://admin.example.test/api/channels/meta/${webchatKey}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=123`), { params: Promise.resolve({ key: webchatKey }) });
    expect(verify.status).toBe(404);
    const raw = JSON.stringify({ object: "page", entry: [] });
    const post = await manualWebhook.POST(new NextRequest(`https://admin.example.test/api/channels/meta/${webchatKey}`, { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } }), { params: Promise.resolve({ key: webchatKey }) });
    expect(post.status).toBe(404);
  });

  it("a website-chat connection cannot be 'reconnected with Facebook'", async () => {
    const project = { id: projectId, slug: `meta-hard-${tag}`, name: "x", status: "ACTIVE" as const };
    await expect(
      runWithProject(project, () => oauth.startMetaOAuth({ userId: creatorId, purpose: "RECONNECT", channelType: null, connectionId: webchatId, returnOrigin: "https://shop.example.test", returnPath: `/p/${project.slug}` })),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await rawPrisma.metaOAuthSession.count({ where: { projectId } })).toBe(0);
  });
});
