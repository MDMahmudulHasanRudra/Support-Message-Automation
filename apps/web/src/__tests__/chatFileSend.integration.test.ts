import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Sending a file from WhatsApp Chat (CHAT_FILE_SENDING.md), the upload route against a real database
 * and a real media directory: what a send writes (the file under an id-only key of THIS project, and
 * ONE MANUAL_REPLY row of contentType MEDIA that the worker sends), and what is refused before anything
 * is stored — no permission, the feature off, a program dressed as a PDF, a disconnected account, a
 * personal chat the account never had, another account's group.
 */

let current: Session | null;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], accounts: [] as string[] };
let mediaDir = "";

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const { POST } = await import("@/app/p/[project]/api/whatsapp/send-file/route");

const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
const pid = { projectId: ORIGINAL_PROJECT_ID };

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
async function user(name: string, roleId: string): Promise<Session> {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  await rawPrisma.projectAccess.create({ data: { projectId: ORIGINAL_PROJECT_ID, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
async function setV2(enabled: boolean) {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: ORIGINAL_PROJECT_ID, key: "CHAT_UI_V2" } },
    create: { projectId: ORIGINAL_PROJECT_ID, key: "CHAT_UI_V2", enabled },
    update: { enabled },
  });
  forgetProjectFeatureStates();
}

const A = { id: "" };
const OFF = { id: "" };
let G = { id: "", whatsappGroupId: "" };
let G_OFF = { id: "", whatsappGroupId: "" };
const PERSONAL = `8801722${String(Date.now()).slice(-6)}@c.us`;
const sessions = {} as Record<"agent" | "viewer", Session>;

const PDF = Buffer.concat([Buffer.from("%PDF-1.7 "), Buffer.alloc(200, 0x41)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 1)]);

async function send(fields: Record<string, string>, file: { bytes: Buffer; name: string } | null) {
  const form = new FormData();
  form.set("uploadId", fields.uploadId ?? randomUUID());
  for (const [k, v] of Object.entries(fields)) if (k !== "uploadId") form.set(k, v);
  if (file) form.set("file", new File([file.bytes], file.name));
  const request = new NextRequest("http://localhost/p/isp-digital/api/whatsapp/send-file", { method: "POST", body: form });
  const response = await runWithProject(isp, () => POST(request));
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string } };
}

async function storedFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${rel}${entry.name}/`);
      else out.push(`${rel}${entry.name}`);
    }
  };
  await walk(mediaDir, "");
  return out;
}

const groupFields = () => ({ accountId: A.id, groupId: G.id });
const outbound = () => rawPrisma.outboundMessage.findMany({ where: { accountId: { in: ids.accounts }, contentType: "MEDIA" }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "file-send-"));
  process.env.MEDIA_STORAGE_DIR = mediaDir;
  process.env.MEDIA_MIN_FREE_DISK_MB = "0";
  sessions.agent = await user("FileAgent", await role("File reply", ["messages.view", "messages.reply"]));
  sessions.viewer = await user("FileViewer", await role("File view", ["messages.view"]));
  A.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `File A ${tag}`, status: "CONNECTED" } })).id;
  OFF.id = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `File off ${tag}`, status: "DISCONNECTED" } })).id;
  ids.accounts.push(A.id, OFF.id);
  const group = (accountId: string, suffix: string) =>
    rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId, whatsappGroupId: `file-${tag}-${suffix}@g.us`, name: `File ${suffix} ${tag}`, isActive: true }, select: { id: true, whatsappGroupId: true } });
  G = await group(A.id, "g");
  G_OFF = await group(OFF.id, "off");
  await rawPrisma.message.create({
    data: { ...pid, accountId: A.id, groupId: null, chatId: PERSONAL, whatsappMessageId: `file-${tag}-p`, senderPhone: "8801700000001", direction: "INCOMING", body: "hi", normalizedBody: "hi", timestampWa: new Date(), processingStatus: "PROCESSED" },
  });
});

beforeEach(async () => {
  current = sessions.agent;
  await setV2(true);
});

afterAll(async () => {
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID, key: "CHAT_UI_V2" } });
  forgetProjectFeatureStates();
  await rawPrisma.outboundMessage.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.message.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rm(mediaDir, { recursive: true, force: true });
});

describe("send-file route", () => {
  it("stores the file under this project and queues ONE manual MEDIA row; the same upload id never queues twice", async () => {
    const uploadId = randomUUID();
    const first = await send({ ...groupFields(), uploadId, caption: "Your bill" }, { bytes: PDF, name: "bill.pdf" });
    expect(first).toEqual({ status: 200, body: { ok: true, sentAt: expect.any(Number) } });
    const again = await send({ ...groupFields(), uploadId, caption: "Your bill" }, { bytes: PDF, name: "bill.pdf" });
    expect(again.status).toBe(200);

    const rows = await outbound();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ actionType: "MANUAL_REPLY", contentType: "MEDIA", chatId: G.whatsappGroupId, groupId: G.id, body: "[Document] Your bill", createdById: sessions.agent.userId, status: "PENDING" });
    const content = row.content as { storageKey: string; kind: string; mimeType: string; fileName: string; sizeBytes: number };
    expect(content).toMatchObject({ kind: "DOCUMENT", mimeType: "application/pdf", fileName: "bill.pdf", sizeBytes: PDF.length });
    expect(content.storageKey.startsWith(`outbound/${ORIGINAL_PROJECT_ID}/${A.id}/`)).toBe(true);
    // The duplicate's copy was removed: one file on disk, the one the row names, byte for byte.
    expect(await storedFiles()).toEqual([content.storageKey]);
    expect((await readFile(join(mediaDir, content.storageKey))).equals(PDF)).toBe(true);
    await rawPrisma.outboundMessage.deleteMany({ where: { id: row.id } });
    await rm(join(mediaDir, "outbound"), { recursive: true, force: true });
  });

  it("a photo to an existing personal chat goes as a photo", async () => {
    const result = await send({ accountId: A.id, personalChatId: PERSONAL }, { bytes: JPEG, name: "router.jpg" });
    expect(result.status).toBe(200);
    const [row] = await outbound();
    expect(row).toMatchObject({ chatId: PERSONAL, groupId: null, body: "[Photo]" });
    expect(row!.content).toMatchObject({ kind: "IMAGE", mimeType: "image/jpeg" });
    await rawPrisma.outboundMessage.deleteMany({ where: { id: row!.id } });
    await rm(join(mediaDir, "outbound"), { recursive: true, force: true });
  });

  it("refuses, storing and queueing nothing, whenever any check fails", async () => {
    const refusals: Array<[string, () => Promise<{ status: number; body: { ok: boolean; error?: string } }>, RegExp]> = [
      ["no reply permission", async () => ((current = sessions.viewer), send(groupFields(), { bytes: PDF, name: "a.pdf" })), /permission|not allowed|cannot/i],
      ["signed out", async () => ((current = null), send(groupFields(), { bytes: PDF, name: "a.pdf" })), /Sign in/],
      ["feature off", async () => (await setV2(false), send(groupFields(), { bytes: PDF, name: "a.pdf" })), /not switched on/],
      ["a program named .pdf", () => send(groupFields(), { bytes: EXE, name: "invoice.pdf" }), /program/],
      ["a script", () => send(groupFields(), { bytes: PDF, name: "run.ps1" }), /cannot be sent/],
      ["disconnected account", () => send({ accountId: OFF.id, groupId: G_OFF.id }, { bytes: PDF, name: "a.pdf" }), /disconnected/],
      ["another account's group", () => send({ accountId: OFF.id, groupId: G.id }, { bytes: PDF, name: "a.pdf" }), /could not be found/],
      ["a chat never had", () => send({ accountId: A.id, personalChatId: "8801999999999@c.us" }, { bytes: PDF, name: "a.pdf" }), /never start/],
      ["no file", () => send(groupFields(), null), /Choose a file/],
      ["voice from an mp3", () => send({ ...groupFields(), mode: "VOICE" }, { bytes: Buffer.concat([Buffer.from("ID3"), Buffer.alloc(100)]), name: "a.mp3" }), /voice note/],
    ];
    for (const [label, run, reason] of refusals) {
      current = sessions.agent;
      await setV2(true);
      const result = await run();
      expect(result.body.ok, label).toBe(false);
      expect(result.status, label).toBeGreaterThanOrEqual(400);
      expect(result.body.error, label).toMatch(reason);
    }
    expect(await outbound()).toHaveLength(0);
    expect(await storedFiles()).toEqual([]);
  });
});
