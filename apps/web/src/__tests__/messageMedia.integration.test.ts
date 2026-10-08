import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { buildMediaStorageKey, LocalMediaStorage } from "@support-automation/media-storage";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * WhatsApp Message & Media Storage — the dashboard side (MEDIA_STORAGE.md): the media endpoint is
 * the only way a file leaves storage, so it is tested as the browser calls it — a GET with the
 * user's session in the URL's project — and the settings/cleanup actions as the page calls them.
 */

let current: Session | null;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => {
    if (!current) throw new Error("NEXT_REDIRECT /login");
    return current;
  },
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// A real request carries its project in a header the proxy sets from the URL, and the project-access
// decision is made from it. `runWithProject` skips that decision (it is for work already authorised),
// so the access test goes through the header instead, exactly as production does.
let headerProject: string | null = null;
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers(headerProject ? { "x-softify-project": headerProject, "x-softify-project-path": "/api/whatsapp/media" } : {}),
}));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { setMediaStorageForTests } = await import("@/server/mediaStorage");
const { GET } = await import("@/app/p/[project]/api/whatsapp/media/[mediaId]/route");
const actions = await import("@/server/actions/mediaStorage");
const reports = await import("@/server/mediaStorageReports");
const { getChatThread } = await import("@/server/chatInbox");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ISP = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(ISP, fn);
const ids = { users: [] as string[], roles: [] as string[], account: "", group: "", biz: "", bizAccount: "" };
const sessions = {} as Record<"viewer" | "editor" | "outsider" | "noChat", Session>;
let root: string;
let storage: LocalMediaStorage;
let savedSettings: { retentionDays: number | null; storeVideos: boolean } | null = null;

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(r.id);
  return r.id;
}
async function user(name: string, roleId: string, projects: string[] = [ORIGINAL_PROJECT_ID]) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  for (const projectId of projects) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}

/** A message with an attachment in the given state; STORED ones get a real file. */
async function media(opts: {
  projectId?: string;
  accountId?: string;
  groupId?: string;
  status?: "STORED" | "PENDING" | "FAILED" | "NOT_STORED" | "DELETED";
  mimeType?: string;
  fileName?: string | null;
  bytes?: Buffer;
  thumbnail?: Buffer;
  createdAt?: Date;
  body?: string;
}) {
  const projectId = opts.projectId ?? ORIGINAL_PROJECT_ID;
  const accountId = opts.accountId ?? ids.account;
  const groupId = opts.groupId ?? ids.group;
  const createdAt = opts.createdAt ?? new Date();
  const group = await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: groupId } });
  const message = await rawPrisma.message.create({
    data: {
      projectId,
      accountId,
      groupId,
      whatsappMessageId: randomUUID(),
      chatId: group.whatsappGroupId,
      senderPhone: "8801700000003",
      direction: "INCOMING",
      body: opts.body ?? "[Image] check this",
      normalizedBody: opts.body ?? "[Image] check this",
      timestampWa: createdAt,
      processingStatus: "PROCESSED",
    },
  });
  const row = await rawPrisma.messageMedia.create({
    data: {
      projectId,
      messageId: message.id,
      accountId,
      groupId,
      mediaType: (opts.mimeType ?? "image/jpeg").startsWith("image/") ? "IMAGE" : "DOCUMENT",
      waType: (opts.mimeType ?? "image/jpeg").startsWith("image/") ? "image" : "document",
      mimeType: opts.mimeType ?? "image/jpeg",
      fileName: opts.fileName ?? null,
      status: "PENDING",
      createdAt,
    },
  });
  if ((opts.status ?? "STORED") !== "STORED") {
    await rawPrisma.messageMedia.update({ where: { id: row.id }, data: { status: opts.status } });
    return { id: row.id, messageId: message.id, key: null as string | null, bytes: null as Buffer | null };
  }
  const bytes = opts.bytes ?? randomBytes(3000);
  const key = buildMediaStorageKey({ projectId, accountId, groupId, mediaId: row.id, createdAt });
  await storage.put(key, bytes);
  let thumbnailKey: string | null = null;
  if (opts.thumbnail) {
    thumbnailKey = buildMediaStorageKey({ projectId, accountId, groupId, mediaId: row.id, createdAt, variant: "thumbnail" });
    await storage.put(thumbnailKey, opts.thumbnail);
  }
  await rawPrisma.messageMedia.update({
    where: { id: row.id },
    data: { status: "STORED", storageKey: key, thumbnailKey, sizeBytes: BigInt(bytes.length), sha256: `sha-${row.id}`, storedAt: createdAt },
  });
  return { id: row.id, messageId: message.id, key, bytes };
}

async function get(mediaId: string, init: { headers?: Record<string, string>; query?: string; project?: typeof ISP; viaUrl?: string } = {}) {
  const slug = init.viaUrl ?? "isp-digital";
  const request = new NextRequest(`http://localhost/p/${slug}/api/whatsapp/media/${mediaId}${init.query ?? ""}`, { headers: init.headers });
  const call = () => GET(request, { params: Promise.resolve({ mediaId }) });
  if (!init.viaUrl) return runWithProject(init.project ?? ISP, call);
  // As production resolves it: the project from the URL's header, access decided for this user.
  headerProject = slug;
  try {
    return await call();
  } finally {
    headerProject = null;
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "web-media-"));
  storage = new LocalMediaStorage(root);
  setMediaStorageForTests(storage);
  sessions.viewer = await user("media_viewer", await role("Media viewer", ["messages.view"]));
  sessions.editor = await user("media_editor", await role("Media editor", ["messages.view", "settings.view", "settings.edit"]));
  sessions.noChat = await user("media_nochat", await role("Media no chat", ["settings.view"]));
  const pid = { projectId: ORIGINAL_PROJECT_ID };
  const account = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Media ${tag}`, status: "CONNECTED" } });
  ids.account = account.id;
  ids.group = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: account.id, whatsappGroupId: `media-${tag}@g.us`, name: "Media group", isActive: true } })).id;

  const biz = await createProjectWithDefaults({ name: `Media Biz ${tag}`, slug: `media-biz-${tag}`, status: "ACTIVE", creatorUserId: ids.users[0]! }, rawPrisma);
  ids.biz = biz.id;
  ids.bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `Media Biz ${tag}`, status: "CONNECTED" } })).id;
  // Somebody who can view chats — but only in Bizify.
  sessions.outsider = await user("media_outsider", await role("Media outsider", ["messages.view"]), [biz.id]);

  const s = await rawPrisma.mediaStorageSettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } });
  savedSettings = { retentionDays: s.retentionDays, storeVideos: s.storeVideos };
});

beforeEach(() => {
  current = sessions.viewer;
});

afterAll(async () => {
  setMediaStorageForTests(undefined);
  if (savedSettings) await rawPrisma.mediaStorageSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: savedSettings });
  await rawPrisma.mediaCleanupJob.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID, requestedById: { in: ids.users } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [ids.account, ids.bizAccount] } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, ids.biz).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: ids.biz } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rm(root, { recursive: true, force: true });
  await rawPrisma.$disconnect();
});

describe("the media endpoint", () => {
  it("streams a stored image to someone who can view the chat, inline, with safe headers", async () => {
    const m = await media({ bytes: Buffer.from("jpeg-bytes-0123456789") });
    const res = await get(m.id);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("jpeg-bytes-0123456789");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("21");
  });

  it("serves byte ranges, so a video can seek without downloading all of it", async () => {
    const m = await media({ mimeType: "video/mp4", bytes: Buffer.from("0123456789abcdef") });
    const part = await get(m.id, { headers: { range: "bytes=4-7" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 4-7/16");
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe("4567");
    expect((await get(m.id, { headers: { range: "bytes=99-" } })).status).toBe(416);
    const etag = part.headers.get("etag")!;
    expect((await get(m.id, { headers: { "if-none-match": etag } })).status).toBe(304);
  });

  it("serves WhatsApp's preview separately from the original", async () => {
    const m = await media({ bytes: Buffer.from("original"), thumbnail: Buffer.from("thumb") });
    const res = await get(m.id, { query: "?variant=thumbnail" });
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("thumb");
  });

  it("never renders a file a browser could execute: HTML is an attachment download", async () => {
    const m = await media({ mimeType: "text/html", fileName: "invoice.html", bytes: Buffer.from("<script>alert(1)</script>") });
    const res = await get(m.id);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="invoice.html"/);
    const forced = await get((await media({})).id, { query: "?download=1" });
    expect(forced.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("refuses without a session, and without permission to view the chat", async () => {
    const m = await media({});
    current = null;
    expect((await get(m.id)).status).toBe(401);
    current = sessions.noChat;
    expect((await get(m.id)).status).toBe(403);
  });

  it("another project's file is not found from here, and a user of another project cannot reach this one", async () => {
    const biz = await rawPrisma.whatsAppGroup.create({ data: { projectId: ids.biz, accountId: ids.bizAccount, whatsappGroupId: `mb-${tag}-${randomUUID().slice(0, 4)}@g.us`, name: "Biz", isActive: true } });
    const theirs = await media({ projectId: ids.biz, accountId: ids.bizAccount, groupId: biz.id });
    expect((await get(theirs.id)).status).toBe(404);

    const mine = await media({});
    current = sessions.outsider;
    expect((await get(mine.id, { viaUrl: "isp-digital" })).status).toBe(403);
    // …while in their own project, through its own URL, they get their own file — and still not ours.
    expect((await get(theirs.id, { viaUrl: `media-biz-${tag}` })).status).toBe(200);
    expect((await get(mine.id, { viaUrl: `media-biz-${tag}` })).status).toBe(404);
  });

  it("a file that is not stored — waiting, failed, switched off, removed or missing — is a 404, never a broken file", async () => {
    for (const status of ["PENDING", "FAILED", "NOT_STORED", "DELETED"] as const) {
      expect((await get((await media({ status })).id)).status).toBe(404);
    }
    // A row marked removed is never served, even if a file were still sitting under its key.
    const removed = await media({});
    await rawPrisma.messageMedia.update({ where: { id: removed.id }, data: { status: "DELETED", statusReason: "RETENTION" } });
    expect(await storage.exists(removed.key!)).toBe(true);
    expect((await get(removed.id)).status).toBe(404);
    const gone = await media({});
    await storage.delete(gone.key!);
    expect((await get(gone.id)).status).toBe(404);
    expect((await get("does-not-exist")).status).toBe(404);
  });

  it("without storage configured it says so", async () => {
    const m = await media({});
    setMediaStorageForTests(null);
    try {
      expect((await get(m.id)).status).toBe(503);
    } finally {
      setMediaStorageForTests(storage);
    }
  });
});

describe("the chat thread", () => {
  it("carries each attachment's metadata — never its bytes — beside the message", async () => {
    const m = await media({ bytes: randomBytes(1234), thumbnail: Buffer.from("t") });
    const thread = await inIsp(() => getChatThread(ids.group));
    const entry = thread!.entries.find((e) => e.id === m.messageId)!;
    expect(entry.media).toMatchObject({ id: m.id, type: "IMAGE", status: "STORED", mimeType: "image/jpeg", sizeBytes: 1234, hasThumbnail: true });
    expect(JSON.stringify(entry.media)).not.toMatch(/storageKey|whatsapp\//);
  });
});

describe("settings and cleanup", () => {
  it("saves the switches and retention, and refuses a role that may only view settings", async () => {
    current = sessions.editor;
    const form = new FormData();
    for (const f of ["storeImages", "storeAudio", "storeDocuments", "storeStickers", "storeGifs", "storeOther"]) form.set(f, "on");
    form.set("retention", "custom");
    form.set("retentionCustomDays", "120");
    const saved = await inIsp(() => actions.saveMediaStorageSettings({}, form));
    expect(saved.error).toBeUndefined();
    const row = await rawPrisma.mediaStorageSettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } });
    expect(row).toMatchObject({ storeVideos: false, storeImages: true, retentionDays: 120, updatedById: sessions.editor.userId });

    form.set("retentionCustomDays", "2");
    expect((await inIsp(() => actions.saveMediaStorageSettings({}, form))).error).toMatch(/between 7 and 3650/);

    current = sessions.noChat;
    expect((await inIsp(() => actions.saveMediaStorageSettings({}, form))).error).toBeTruthy();
  });

  it("changing retention stops a retention cleanup in flight, but never an admin's manual one", async () => {
    current = sessions.editor;
    const retention = await rawPrisma.mediaCleanupJob.create({ data: { projectId: ORIGINAL_PROJECT_ID, trigger: "RETENTION", olderThan: new Date(), retentionDays: 120, status: "RUNNING", requestedById: sessions.editor.userId } });
    const manual = await rawPrisma.mediaCleanupJob.create({ data: { projectId: ORIGINAL_PROJECT_ID, trigger: "MANUAL", olderThan: new Date(), status: "SCHEDULED", requestedById: sessions.editor.userId } });
    const form = new FormData();
    form.set("retention", "never");
    const saved = await inIsp(() => actions.saveMediaStorageSettings({}, form));
    expect(saved.retentionNote).toMatch(/keep everything/);
    expect((await rawPrisma.mediaCleanupJob.findUniqueOrThrow({ where: { id: retention.id } })).status).toBe("CANCELLED");
    expect((await rawPrisma.mediaCleanupJob.findUniqueOrThrow({ where: { id: manual.id } })).status).toBe("SCHEDULED");
    await rawPrisma.mediaCleanupJob.update({ where: { id: manual.id }, data: { status: "CANCELLED" } });
  });

  it("previews with real counts, needs the typed confirmation, and allows one cleanup at a time", async () => {
    current = sessions.editor;
    const old = new Date(Date.now() - 400 * 24 * 60 * 60_000);
    const before = await inIsp(() => actions.previewMediaCleanup("365"));
    const a = await media({ createdAt: old, bytes: randomBytes(1000) });
    const b = await media({ createdAt: old, bytes: randomBytes(500) });
    const after = await inIsp(() => actions.previewMediaCleanup("365"));
    expect(after.files! - before.files!).toBe(2);
    expect(after.bytes! - before.bytes!).toBe(a.bytes!.length + b.bytes!.length);

    expect((await inIsp(() => actions.startMediaCleanup({ olderThanDays: "365", confirmation: "delete please" }))).error).toMatch(/Type DELETE/);
    expect(await rawPrisma.mediaCleanupJob.count({ where: { projectId: ORIGINAL_PROJECT_ID, status: { in: ["SCHEDULED", "RUNNING"] } } })).toBe(0);

    const results = await Promise.all([1, 2, 3].map(() => inIsp(() => actions.startMediaCleanup({ olderThanDays: "365", confirmation: "DELETE" }))));
    expect(results.filter((r) => r.jobId)).toHaveLength(1);
    expect(results.filter((r) => r.error)).toHaveLength(2);
    const job = await rawPrisma.mediaCleanupJob.findUniqueOrThrow({ where: { id: results.find((r) => r.jobId)!.jobId! } });
    expect(job).toMatchObject({ trigger: "MANUAL", status: "SCHEDULED", requestedById: sessions.editor.userId });
    // Scheduling deleted nothing: that is the worker's job, in the background.
    expect(await storage.exists(a.key!)).toBe(true);

    expect(await inIsp(() => actions.cancelMediaCleanup(job.id))).toEqual({});
    expect((await rawPrisma.mediaCleanupJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");

    current = sessions.viewer;
    expect((await inIsp(() => actions.startMediaCleanup({ olderThanDays: "365", confirmation: "DELETE" }))).error).toBeTruthy();
  });

  it("reports usage from the recorded sizes of stored files only", async () => {
    current = sessions.editor;
    const before = await inIsp(() => reports.getMediaUsage());
    await media({ bytes: randomBytes(700) });
    await media({ status: "FAILED" });
    const after = await inIsp(() => reports.getMediaUsage());
    expect(after.totalBytes - before.totalBytes).toBe(700);
    expect(after.totalFiles - before.totalFiles).toBe(1);
    expect(after.byStatus.FAILED - before.byStatus.FAILED).toBe(1);
  });
});
