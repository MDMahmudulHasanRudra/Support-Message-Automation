import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { LocalMediaStorage } from "@support-automation/media-storage";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Website Chat V3 against a real database (docs/website-chat-v3). What must hold:
 *   - a widget saved before V3 reads and serves exactly as before (PDFs kept); a new widget is photos only;
 *   - the public configuration never carries a storage key, an uploader, a consent record or the weekly hours;
 *   - the installation check records the listed website the widget started on, and a refused one, at most once a minute;
 *   - a visitor's photo (with caption) is accepted once per nonce; a renamed video, a program or an SVG is refused;
 *   - a visitor reads back only files of their OWN conversation, and a team photo only once it was sent;
 *   - an agent's photo reply exists only for website chat, is queued once per nonce, and refuses anything but a photo;
 *   - brand images: a team photo needs a name and recorded consent; the form can never inject assets or consent;
 *     the public address serves only what the live widget lists, never another widget's or project's;
 *   - Bengali and emoji text round-trips unchanged; the WordPress plugin carries no secret and keeps its option names.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

let current: Session;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const { setMediaStorageForTests } = await import("@/server/mediaStorage");
const webchat = await import("@/server/channels/webchat");
const replies = await import("@/server/channels/replies");
const configRoute = await import("@/app/api/webchat/[key]/route");
const filesRoute = await import("@/app/api/webchat/[key]/files/route");
const mediaRoute = await import("@/app/api/webchat/[key]/media/[messageId]/[index]/route");
const brandRoute = await import("@/app/api/webchat/[key]/brand/[assetId]/route");
const agentPhotoRoute = await import("@/app/p/[project]/api/channels/webchat-photo/[conversationId]/route");
const { wordpressPluginFiles } = await import("@/server/channels/webchatWordpress");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let P: Project;
let Q: Project;
let mediaRoot: string;
const SITE = "https://shop.example.test";
const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000)]);
const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(500)]);
const PDF = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(500)]);
const MP4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), randomBytes(500)]);
const EXE = () => Buffer.concat([Buffer.from("MZ"), randomBytes(500)]);
const SVG = () => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>`);

async function project(name: string): Promise<Project> {
  const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: null }, rawPrisma);
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "OMNICHANNEL" } }, create: { projectId: p.id, key: "OMNICHANNEL", enabled: true }, update: { enabled: true } });
  return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" };
}
const inP = <T,>(fn: () => Promise<T>, project: Project = P) => runWithProject(project, fn);

async function widget(in_: Project = P, origins = [SITE]) {
  const { id } = await inP(() => webchat.connectWebchat({ name: `Site ${randomUUID().slice(0, 6)}`, origins, username: "admin" }), in_);
  const row = await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id } });
  return { id, key: row.webhookKey };
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (url: string, init: { origin?: string | null; method?: string; body?: BodyInit; auth?: string | null } = {}) =>
  new NextRequest(url, { method: init.method ?? "GET", body: init.body, headers: { ...(init.origin === null ? {} : { origin: init.origin ?? SITE }), ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}) } });
const getConfig = (key: string, origin?: string | null) => configRoute.GET(req(`https://app.example.test/api/webchat/${key}?v=3.0.0`, { origin }), params({ key }));
async function visitorFor(key: string) {
  const w = (await webchat.loadPublicWidget(key))!;
  const s = await webchat.startVisitor(w, { ip: `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  return { widget: w, visitorId: s.visitorId, token: s.token! };
}
const upload = (key: string, token: string, file: Buffer, name: string, extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(file)], name));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return filesRoute.POST(req(`https://app.example.test/api/webchat/${key}/files`, { method: "POST", body: form, auth: token }), params({ key }));
};
/** What the worker makes of a visitor message: the conversation and the message, created here directly. */
async function conversationFor(projectId: string, connectionId: string, visitorId: string) {
  return rawPrisma.channelConversation.create({ data: { projectId, connectionId, type: "WEBCHAT", externalThreadId: visitorId, kind: "DIRECT", lastInboundAt: new Date() } });
}

beforeAll(async () => {
  mediaRoot = mkdtempSync(join(tmpdir(), "webchat-v3-"));
  setMediaStorageForTests(new LocalMediaStorage(mediaRoot));
  vi.stubEnv("MEDIA_MIN_FREE_DISK_MB", "0");
  P = await project("WebchatP");
  Q = await project("WebchatQ");
  forgetProjectFeatureStates();
  const permissions = await Promise.all(
    ["conversations.reply", "messages.view", "channels.view", "channels.manage"].map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const role = await rawPrisma.permissionModule.create({ data: { name: `Webchat agent ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  const u = await rawPrisma.user.create({ data: { username: `agent_${tag}`, email: `agent.${tag}@example.test`, name: "Agent Rina", passwordHash: "x", permissionModuleId: role.id } });
  for (const p of [P, Q]) await rawPrisma.projectAccess.create({ data: { projectId: p.id, userId: u.id } });
  current = { userId: u.id, username: u.username, email: u.email!, name: "Agent Rina" } as Session;
});

afterAll(() => {
  setMediaStorageForTests(undefined);
  vi.unstubAllEnvs();
  rmSync(mediaRoot, { recursive: true, force: true });
});

describe("settings and the public configuration", () => {
  it("a widget saved before V3 serves as before and keeps PDFs; a new widget is photos only", async () => {
    const old = await widget();
    await rawPrisma.channelConnection.update({ where: { id: old.id }, data: { widgetSettings: { title: "Help desk", color: "#112233", position: "left", allowAttachments: true, askName: false } } });
    const body = await (await getConfig(old.key)).json();
    expect(body.settings).toMatchObject({ title: "Help desk", color: "#112233", position: "left", allowAttachments: true, allowPdf: true, launcherStyle: "ICON", theme: "light", panelWidth: 360, panelHeight: 540 });
    const v = await visitorFor(old.key);
    expect((await upload(old.key, v.token, PDF(), "invoice.pdf")).status).toBe(202);

    const fresh = await widget();
    const f = await visitorFor(fresh.key);
    const refused = await upload(fresh.key, f.token, PDF(), "invoice.pdf");
    expect(refused.status).toBe(415);
    expect((await refused.json()).error).toMatch(/Only photos/);
  });

  it("never exposes storage keys, uploaders, consent or the weekly hours", async () => {
    const w = await widget();
    await inP(() => webchat.addWidgetAsset(w.id, { kind: "LOGO", bytes: PNG(), username: "admin" }));
    await inP(() => webchat.addWidgetAsset(w.id, { kind: "AVATAR", bytes: JPEG(), username: "admin", name: "Rina", consent: true }));
    const text = await (await getConfig(w.key)).text();
    for (const secret of ["storageKey", "webchat-brand/", "uploadedBy", "consentBy", "consentAt", '"hours"', '"assets"']) expect(text, secret).not.toContain(secret);
    const body = JSON.parse(text);
    expect(body.settings.logoUrl).toMatch(/^brand\//);
    expect(body.settings.team).toEqual([{ name: "Rina", avatarUrl: expect.stringMatching(/^brand\//) }]);
  });

  it("the form cannot add images or invent a team member's consent", async () => {
    const w = await widget();
    await inP(() =>
      webchat.saveWebchatSettings(w.id, {
        origins: [SITE],
        settings: {
          title: "Shop",
          assets: [{ id: "forged_asset_0001", kind: "AVATAR", storageKey: `webchat-brand/${P.id}/${w.id}/forged_asset_0001.png`, mimeType: "image/png", size: 1, uploadedBy: "x", uploadedAt: new Date().toISOString() }],
          team: [{ assetId: "forged_asset_0001", name: "Someone", consentBy: "x", consentAt: new Date().toISOString() }],
          teamOrder: ["forged_asset_0001"],
        },
      }),
    );
    const stored = await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: w.id } });
    const settings = stored.widgetSettings as { assets: unknown[]; team: unknown[]; title: string };
    expect(settings.title).toBe("Shop");
    expect(settings.assets).toEqual([]);
    expect(settings.team).toEqual([]);
  });
});

describe("installation check", () => {
  it("records where the widget started, and a website that is not listed, at most once a minute", async () => {
    const w = await widget();
    expect((await getConfig(w.key)).status).toBe(200);
    let row = await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: w.id } });
    expect([row.widgetSeenOrigin, row.widgetSeenVersion]).toEqual([SITE, "3.0.0"]);
    const first = row.widgetSeenAt!.getTime();
    await getConfig(w.key);
    row = await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.widgetSeenAt!.getTime()).toBe(first);

    const refused = await getConfig(w.key, "https://other-site.example.test");
    expect(refused.status).toBe(403);
    row = await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.widgetRefusedOrigin).toBe("https://other-site.example.test");
    expect(row.widgetSeenOrigin).toBe(SITE);
    const details = await inP(() => webchat.getWebchatDetails(w.id));
    expect(details!.install).toMatchObject({ seenOrigin: SITE, refusedOrigin: "https://other-site.example.test", seenRecently: true });
  });
});

describe("visitor photos", () => {
  it("accepts a photo with a caption once per nonce, and refuses renamed videos, programs and SVG", async () => {
    const w = await widget();
    const v = await visitorFor(w.key);
    const nonce = `n${randomUUID().replace(/-/g, "")}`;
    const first = await upload(w.key, v.token, JPEG(), "photo.jpg", { text: "এটা কি স্টকে আছে? 😊", nonce });
    expect(first.status).toBe(202);
    const again = await upload(w.key, v.token, JPEG(), "photo.jpg", { text: "এটা কি স্টকে আছে? 😊", nonce });
    expect(await again.json()).toMatchObject({ duplicate: true });
    const events = await rawPrisma.channelInboundEvent.findMany({ where: { connectionId: w.id } });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { text: string }).text).toBe("এটা কি স্টকে আছে? 😊");
    // The stored name is hex: a media storage segment must start with a letter or digit, and base64url failed ~1 upload in 32.
    expect((events[0]!.payload as { attachments: Array<{ storageKey: string }> }).attachments[0]!.storageKey).toMatch(/\/[0-9a-f]{32}\.jpg$/);
    for (const [bytes, name] of [[MP4(), "clip.jpg"], [EXE(), "photo.png"], [SVG(), "logo.png"]] as const) {
      expect((await upload(w.key, v.token, bytes, name)).status, name).toBe(415);
    }
    expect(await rawPrisma.channelInboundEvent.count({ where: { connectionId: w.id } })).toBe(1);
  });

  it("a visitor reads only their own conversation's files, and a team photo only once it was sent", async () => {
    const w = await widget();
    const a = await visitorFor(w.key);
    const b = await visitorFor(w.key);
    const key = `webchat/${P.id}/${a.visitorId}/${randomBytes(16).toString("hex")}.jpg`;
    const bytes = JPEG();
    await new LocalMediaStorage(mediaRoot).put(key, bytes, { maxBytes: bytes.length });
    const conv = await conversationFor(P.id, w.id, a.visitorId);
    const inbound = await rawPrisma.channelMessage.create({
      data: { projectId: P.id, conversationId: conv.id, connectionId: w.id, type: "WEBCHAT", direction: "INBOUND", senderType: "CUSTOMER", contentType: "IMAGE", occurredAt: new Date(), attachments: [{ type: "IMAGE", name: "p.jpg", storageKey: key }] },
    });
    const get = (token: string, messageId: string, index = "0", origin?: string) => mediaRoute.GET(req(`https://app.example.test/api/webchat/${w.key}/media/${messageId}/${index}`, { auth: token, origin }), params({ key: w.key, messageId, index }));
    const mine = await get(a.token, inbound.id);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await mine.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await get(b.token, inbound.id)).status).toBe(404);
    expect((await get("x".repeat(43), inbound.id)).status).toBe(401);
    expect((await get(a.token, inbound.id, "0", "https://evil.example.test")).status).toBe(403);

    // The team's photo: invisible while queued, readable once sent.
    const reply = await inP(() => replies.queueChannelReply({ conversationId: conv.id, text: "", nonce: `r${tag}0001`, userId: current.userId, attachments: [{ type: "IMAGE", name: "answer.jpg", storageKey: key }] }));
    expect((await get(a.token, reply.messageId)).status).toBe(404);
    await rawPrisma.channelMessage.update({ where: { id: reply.messageId }, data: { deliveryStatus: "SENT" } });
    expect((await get(a.token, reply.messageId)).status).toBe(200);
    const visible = await webchat.visitorConversation(a.widget, { id: a.visitorId, name: null, email: null, verified: false }, null, false);
    expect(visible.messages.map((m) => m.attachments)).toEqual([[{ index: 0, type: "IMAGE", name: "p.jpg" }], [{ index: 0, type: "IMAGE", name: "answer.jpg" }]]);
  });

  it("another project's widget key never reaches this project's files", async () => {
    const mine = await widget();
    const theirs = await widget(Q);
    const v = await visitorFor(mine.key);
    const key = `webchat/${P.id}/${v.visitorId}/${randomBytes(16).toString("hex")}.jpg`;
    await new LocalMediaStorage(mediaRoot).put(key, JPEG(), { maxBytes: 10_000 });
    const conv = await conversationFor(P.id, mine.id, v.visitorId);
    const m = await rawPrisma.channelMessage.create({ data: { projectId: P.id, conversationId: conv.id, connectionId: mine.id, type: "WEBCHAT", direction: "INBOUND", senderType: "CUSTOMER", contentType: "IMAGE", occurredAt: new Date(), attachments: [{ type: "IMAGE", storageKey: key }] } });
    const other = (await webchat.loadPublicWidget(theirs.key))!;
    expect(await webchat.visitorAttachment(other, { id: v.visitorId, name: null, email: null, verified: false }, m.id, 0)).toBeNull();
  });
});

describe("agent photo replies", () => {
  it("queues one photo reply per nonce for website chat, and refuses other channels and non-photos", async () => {
    const w = await widget();
    const v = await visitorFor(w.key);
    const conv = await conversationFor(P.id, w.id, v.visitorId);
    const send = (file: Buffer, name: string, nonce: string, text = "") => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(file)], name));
      form.append("nonce", nonce);
      form.append("text", text);
      return inP(() => agentPhotoRoute.POST(new NextRequest(`https://app.example.test/p/${P.slug}/api/channels/webchat-photo/${conv.id}`, { method: "POST", body: form }), params({ conversationId: conv.id })));
    };
    const first = await send(JPEG(), "answer.jpg", `p${tag}aaaa1`, "Here it is 👍");
    expect(first.status).toBe(202);
    const again = await send(JPEG(), "answer.jpg", `p${tag}aaaa1`, "Here it is 👍");
    expect(await again.json()).toMatchObject({ duplicate: true });
    const rows = await rawPrisma.channelMessage.findMany({ where: { conversationId: conv.id, direction: "OUTBOUND" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contentType: "IMAGE", text: "Here it is 👍", deliveryStatus: "QUEUED", senderType: "AGENT" });
    const stored = (rows[0]!.attachments as Array<{ storageKey: string }>)[0]!.storageKey;
    expect(stored.startsWith(`webchat/${P.id}/${v.visitorId}/`)).toBe(true);
    expect((await send(PDF(), "terms.pdf", `p${tag}bbbb2`)).status).toBe(415);
    expect((await send(MP4(), "clip.jpg", `p${tag}bbbb3`)).status).toBe(415);

    const messenger = await rawPrisma.channelConnection.create({ data: { projectId: P.id, type: "MESSENGER", name: "FB", status: "CONNECTED", enabled: true, webhookKey: randomBytes(24).toString("base64url") } });
    const fbConv = await rawPrisma.channelConversation.create({ data: { projectId: P.id, connectionId: messenger.id, type: "MESSENGER", externalThreadId: `psid${tag}`, kind: "DIRECT", lastInboundAt: new Date() } });
    await expect(inP(() => replies.queueChannelReply({ conversationId: fbConv.id, text: "", nonce: `m${tag}0001`, userId: current.userId, attachments: [{ type: "IMAGE", storageKey: stored }] }))).rejects.toThrow(/only in website chat/);
  });
});

describe("brand images", () => {
  it("a team photo needs a name and consent; the public address serves only what the live widget lists", async () => {
    const w = await widget();
    await expect(inP(() => webchat.addWidgetAsset(w.id, { kind: "AVATAR", bytes: JPEG(), username: "admin", name: "Rina" }))).rejects.toThrow(/agreed/);
    await expect(inP(() => webchat.addWidgetAsset(w.id, { kind: "AVATAR", bytes: JPEG(), username: "admin", consent: true }))).rejects.toThrow(/name/);
    await expect(inP(() => webchat.addWidgetAsset(w.id, { kind: "LOGO", bytes: SVG(), username: "admin" }))).rejects.toThrow(/SVG/);
    await expect(inP(() => webchat.addWidgetAsset(w.id, { kind: "LOGO", bytes: Buffer.concat([JPEG(), Buffer.alloc(600 * 1024)]), username: "admin" }))).rejects.toThrow(/512 KB/);
    const { assetId } = await inP(() => webchat.addWidgetAsset(w.id, { kind: "AVATAR", bytes: JPEG(), username: "admin", name: "Rina", consent: true }));
    const stored = (await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: w.id } })).widgetSettings as { team: Array<{ consentBy: string }> };
    expect(stored.team[0]!.consentBy).toBe("admin");

    const fetchBrand = (key: string, id: string) => brandRoute.GET(new NextRequest(`https://app.example.test/api/webchat/${key}/brand/${id}`), params({ key, assetId: id }));
    const served = await fetchBrand(w.key, assetId);
    expect(served.status).toBe(200);
    expect(served.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    const other = await widget(Q);
    expect((await fetchBrand(other.key, assetId)).status).toBe(404);
    await inP(() => webchat.removeWidgetAsset(w.id, assetId));
    expect((await fetchBrand(w.key, assetId)).status).toBe(404);
  });
});

describe("text and the WordPress plugin", () => {
  it("Bengali, Banglish and emoji text is stored exactly as typed", async () => {
    const w = await widget();
    const v = await visitorFor(w.key);
    const text = "আমার অর্ডার কোথায়? ami order korechi 😊🙏🏽 👨‍👩‍👧";
    await webchat.recordVisitorMessage(v.widget, { id: v.visitorId, name: null, email: null, verified: false }, { text, nonce: `t${tag}abcd` });
    const event = await rawPrisma.channelInboundEvent.findFirstOrThrow({ where: { connectionId: w.id } });
    expect((event.payload as { text: string }).text).toBe(text);
  });

  it("the plugin carries no secret, keeps 1.0.0's option names and removes them on delete", () => {
    const files = wordpressPluginFiles({ scriptUrl: "https://app.example.test/api/webchat/widget.js", widgetKey: "k".repeat(32), widgetName: "Shop */ <?php evil(); ?>" });
    expect(files.map((f) => f.name)).toEqual(["getassist-chat/getassist-chat.php", "getassist-chat/uninstall.php", "getassist-chat/readme.txt"]);
    const main = files[0]!.data.toString("utf8");
    for (const option of ["getassist_chat_secret", "getassist_chat_identify", "getassist_chat_disabled"]) expect(main).toContain(`'${option}'`);
    expect(main).toContain("Version: 1.1.0");
    expect(main).not.toMatch(/define\('GETASSIST_CHAT_SECRET/);
    expect(main).not.toContain("*/ <?php evil");
    expect(files[1]!.data.toString("utf8")).toContain("delete_option($option)");
  });
});
