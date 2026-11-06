import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { EMPTY_INBOX_FILTERS, PERMISSIONS, type InboxFilterSet } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * The three small Inbox views (INBOX_WORKSPACE.md): the "upset customer" filter, the "AI is handling" view and the
 * Files tab. Each only narrows or lists what the viewer can already read, inside the project.
 */

let current: Session;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const { loadInbox, inboxFilterOptions } = await import("@/server/channels/inbox");
const { readConversationFiles } = await import("@/server/actions/inboxWorkspace");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ISP = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let BIZ = { id: "", slug: `views-${tag}`, name: `Views ${tag}`, status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(ISP, fn);
const NOW = new Date();
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
let account = "";
let connection = "";
let bizAccount = "";
const ids = { users: [] as string[], roles: [] as string[] };
const s = {} as Record<"reader" | "none", Session>;
let n = 0;

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
async function user(name: string, roleId: string) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  await rawPrisma.projectAccess.create({ data: { projectId: ORIGINAL_PROJECT_ID, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
async function feature(key: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: ORIGINAL_PROJECT_ID, key } }, create: { projectId: ORIGINAL_PROJECT_ID, key, enabled }, update: { enabled } });
  forgetProjectFeatureStates();
}
async function group(name: string, accountId = account, projectId = ORIGINAL_PROJECT_ID) {
  const chatId = `${tag}${n++}@g.us`;
  const row = await rawPrisma.whatsAppGroup.create({ data: { projectId, accountId, whatsappGroupId: chatId, name: `${name} ${tag}`, isActive: true } });
  return { id: row.id, chatId, accountId, projectId };
}
type Group = Awaited<ReturnType<typeof group>>;
const message = (g: Group, minutes: number, over: Record<string, unknown> = {}) =>
  rawPrisma.message.create({
    data: {
      projectId: g.projectId,
      accountId: g.accountId,
      groupId: g.id,
      chatId: g.chatId,
      whatsappMessageId: `m-${randomUUID()}`,
      senderPhone: "8801711000001",
      direction: "INCOMING",
      body: "hello",
      normalizedBody: "hello",
      timestampWa: ago(minutes),
      processingStatus: "PROCESSED",
      ...over,
    },
  });
const mood = async (g: Group, minutes: number, level: number, customerKey = "8801711000001") => {
  const m = await message(g, minutes);
  await rawPrisma.customerMoodEvent.create({
    data: { projectId: g.projectId, messageId: m.id, accountId: g.accountId, groupId: g.id, whatsappGroupId: g.chatId, customerKey, messageAt: ago(minutes), mood: level >= 2 ? "ANGRY" : "NEUTRAL", confidence: 0.9, level, scheduledAt: NOW },
  });
};
const aiReplied = async (g: Group, minutes: number) => {
  const m = await message(g, minutes);
  await rawPrisma.aiFallbackDecision.create({ data: { projectId: g.projectId, messageId: m.id, accountId: g.accountId, groupId: g.id, outcome: "AI_REPLIED" } });
  return m;
};
const titles = async (filters: Partial<InboxFilterSet>) => {
  const r = await inIsp(() => loadInbox({ scope: "all", filters: { ...EMPTY_INBOX_FILTERS, ...filters }, viewerId: s.reader.userId, now: NOW }));
  return r.items.map((i) => i.title).filter((t) => t?.includes(tag)).sort();
};

beforeAll(async () => {
  account = (await rawPrisma.whatsAppAccount.create({ data: { projectId: ORIGINAL_PROJECT_ID, label: `Views ${tag}`, status: "CONNECTED" } })).id;
  connection = (await rawPrisma.channelConnection.create({ data: { projectId: ORIGINAL_PROJECT_ID, type: "TELEGRAM", name: "@views", status: "CONNECTED", webhookKey: `views-${tag}` } })).id;
  const creator = await rawPrisma.user.create({ data: { username: `viewsc_${tag}`, email: `viewsc_${tag}@example.test`, name: "Creator", passwordHash: "x" } });
  ids.users.push(creator.id);
  BIZ = { ...BIZ, id: (await createProjectWithDefaults({ name: BIZ.name, slug: BIZ.slug, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id };
  bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: BIZ.id, label: `Biz ${tag}`, status: "CONNECTED" } })).id;
  s.reader = await user("views_reader", await role("Views reader", ["messages.view", "channels.view"]));
  s.none = await user("views_none", await role("Views none", ["settings.view"]));
});

beforeEach(async () => {
  await feature("UNIFIED_INBOX_V3", true);
  await feature("OMNICHANNEL", true);
  await feature("WHATSAPP_CHAT", true);
  current = s.reader;
});

afterAll(async () => {
  await rawPrisma.channelMessage.deleteMany({ where: { connectionId: connection } });
  await rawPrisma.channelConversation.deleteMany({ where: { connectionId: connection } });
  await rawPrisma.channelConnection.deleteMany({ where: { id: connection } });
  for (const accountId of [account, bizAccount]) {
    await rawPrisma.messageMedia.deleteMany({ where: { accountId } });
    await rawPrisma.customerMoodEvent.deleteMany({ where: { accountId } });
    await rawPrisma.aiFallbackDecision.deleteMany({ where: { accountId } });
    await rawPrisma.outboundMessage.deleteMany({ where: { accountId } });
    await rawPrisma.message.deleteMany({ where: { accountId } });
    await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId } });
    await rawPrisma.whatsAppAccount.deleteMany({ where: { id: accountId } });
  }
  await rawPrisma.moodDetectionSettings.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID, key: { in: ["UNIFIED_INBOX_V3", "OMNICHANNEL", "WHATSAPP_CHAT"] } } });
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, BIZ.id).catch(() => undefined);
  await rawPrisma.project.deleteMany({ where: { id: BIZ.id } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  forgetProjectFeatureStates();
  await rawPrisma.$disconnect();
});

describe("the upset customer filter", () => {
  it("keeps groups whose customer's newest reading in the last day is frustrated or worse", async () => {
    const angry = await group("Angry");
    await mood(angry, 30, 3);
    const calmedDown = await group("Calmed");
    await mood(calmedDown, 60, 3);
    await mood(calmedDown, 30, 0);
    const mild = await group("Mild");
    await mood(mild, 30, 1);
    const old = await group("Old");
    await mood(old, 25 * 60, 4);
    const twoCustomers = await group("TwoCustomers");
    await mood(twoCustomers, 60, 3, "8801711000002");
    await mood(twoCustomers, 30, 0, "8801711000003");
    const plain = await group("Plain");
    await message(plain, 30);

    const names = await titles({ mood: "upset" });
    expect(names).toEqual([`Angry ${tag}`, `TwoCustomers ${tag}`]);
    expect(await titles({})).toContain(`Plain ${tag}`);
  });

  it("no channel conversation can match, and another project's reading is never read", async () => {
    await rawPrisma.channelConversation.create({ data: { projectId: ORIGINAL_PROJECT_ID, connectionId: connection, type: "TELEGRAM", externalThreadId: `mood-${tag}`, title: `Channel mood ${tag}`, status: "OPEN", lastInboundAt: NOW, lastMessageAt: NOW } });
    expect(await titles({ mood: "upset" })).not.toContain(`Channel mood ${tag}`);
    const theirs = await group("TheirAngry", bizAccount, BIZ.id);
    await mood(theirs, 30, 4);
    expect(await titles({ mood: "upset" })).not.toContain(`TheirAngry ${tag}`);
  });

  it("is offered only while Mood Detection is switched on", async () => {
    await rawPrisma.moodDetectionSettings.upsert({ where: { projectId: ORIGINAL_PROJECT_ID }, create: { projectId: ORIGINAL_PROJECT_ID, enabled: false }, update: { enabled: false } });
    expect((await inIsp(() => inboxFilterOptions())).moodDetection).toBe(false);
    await rawPrisma.moodDetectionSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { enabled: true } });
    expect((await inIsp(() => inboxFilterOptions())).moodDetection).toBe(true);
  });
});

describe("the AI is handling view", () => {
  const echo = async (g: Group, customerMessageId: string, minutes: number) => {
    const providerMessageId = `echo-${randomUUID()}`;
    await rawPrisma.outboundMessage.create({
      data: { projectId: g.projectId, accountId: g.accountId, chatId: g.chatId, toPhone: "8801711000001", body: "reply", actionType: "AUTO_REPLY", status: "SENT", relatedMessageId: customerMessageId, providerMessageId, idempotencyKey: `views-${randomUUID()}` },
    });
    await message(g, minutes, { direction: "OUTGOING", whatsappMessageId: providerMessageId, body: "reply", normalizedBody: "reply" });
  };

  it("WhatsApp: the AI answered and nothing has been said since but its own echo", async () => {
    const handled = await group("AiHandled");
    await echo(handled, (await aiReplied(handled, 30)).id, 29);

    const person = await group("PersonReplied");
    await echo(person, (await aiReplied(person, 30)).id, 29);
    await message(person, 20, { direction: "OUTGOING", body: "a person", normalizedBody: "a person" });

    const customer = await group("CustomerAgain");
    await echo(customer, (await aiReplied(customer, 30)).id, 29);
    await message(customer, 20);

    const stale = await group("StaleAi");
    await aiReplied(stale, 25 * 60);
    await rawPrisma.aiFallbackDecision.updateMany({ where: { accountId: account, groupId: stale.id }, data: { createdAt: ago(25 * 60) } });

    const failed = await group("FailedSend");
    const failedMessage = await aiReplied(failed, 30);
    await rawPrisma.outboundMessage.create({
      data: { projectId: failed.projectId, accountId: failed.accountId, chatId: failed.chatId, toPhone: "8801711000001", body: "reply", actionType: "AUTO_REPLY", status: "FAILED", relatedMessageId: failedMessage.id, idempotencyKey: `views-${randomUUID()}` },
    });

    const noAi = await group("NoAi");
    await message(noAi, 30);

    expect(await titles({ view: "ai" })).toEqual([`AiHandled ${tag}`]);
  });

  it("channels: the newest message is the AI's own reply, not a survey and not a failed send", async () => {
    const convo = async (title: string, messages: Array<{ key?: string; status?: string; at: number }>) => {
      const c = await rawPrisma.channelConversation.create({ data: { projectId: ORIGINAL_PROJECT_ID, connectionId: connection, type: "TELEGRAM", externalThreadId: `${title}-${tag}`, title: `${title} ${tag}`, status: "OPEN", lastInboundAt: ago(40), lastMessageAt: NOW } });
      for (const m of messages) {
        await rawPrisma.channelMessage.create({
          data: {
            projectId: ORIGINAL_PROJECT_ID,
            conversationId: c.id,
            connectionId: connection,
            type: "TELEGRAM",
            direction: m.key ? "OUTBOUND" : "INBOUND",
            senderType: m.key?.startsWith("ai:") ? "AI" : m.key ? "AGENT" : "CUSTOMER",
            text: "x",
            contentType: "TEXT",
            occurredAt: ago(m.at),
            deliveryStatus: (m.status ?? "SENT") as "SENT",
            ...(m.key ? { idempotencyKey: `${m.key}${randomUUID()}` } : { externalMessageId: randomUUID() }),
          },
        });
      }
    };
    await convo("ChAi", [{ at: 40 }, { key: "ai:", at: 30 }]);
    await convo("ChPerson", [{ at: 40 }, { key: "ai:", at: 30 }, { key: "manual:", at: 20 }]);
    await convo("ChCustomer", [{ key: "ai:", at: 30 }, { at: 20 }]);
    await convo("ChSurvey", [{ at: 40 }, { key: "csat:", at: 30 }]);
    await convo("ChFailed", [{ at: 40 }, { key: "ai:", status: "FAILED", at: 30 }]);
    const names = await titles({ view: "ai" });
    expect(names).toContain(`ChAi ${tag}`);
    for (const other of ["ChPerson", "ChCustomer", "ChSurvey", "ChFailed"]) expect(names).not.toContain(`${other} ${tag}`);
  });

  it("with Inbox V3 off a saved view holding it opens as the plain list", async () => {
    await feature("UNIFIED_INBOX_V3", false);
    expect(await titles({ view: "ai" })).toContain(`NoAi ${tag}`);
  });
});

describe("the Files tab", () => {
  const media = (g: Group, messageId: string, over: Record<string, unknown> = {}) =>
    rawPrisma.messageMedia.create({ data: { projectId: g.projectId, messageId, accountId: g.accountId, groupId: g.id, mediaType: "DOCUMENT", waType: "document", fileName: "bill.pdf", sizeBytes: BigInt(2048), status: "STORED", storageKey: `secret-key/${randomUUID()}`, ...over } });
  const refOf = (g: Group) => ({ kind: "whatsapp" as const, accountId: g.accountId, chatId: g.chatId });

  it("lists a WhatsApp chat's files newest first, links only what is stored, and never shows a storage key", async () => {
    const g = await group("Files");
    await media(g, (await message(g, 60)).id, { fileName: "older.pdf" });
    await media(g, (await message(g, 30)).id, { fileName: "newer.pdf" });
    await media(g, (await message(g, 20)).id, { fileName: "waiting.pdf", status: "PENDING", storageKey: null });
    await media(g, (await message(g, 10, { revokedAt: NOW })).id, { fileName: "deleted-for-everyone.pdf" });
    const result = await inIsp(() => readConversationFiles(refOf(g)));
    if ("error" in result) throw new Error(result.error);
    expect(result.files.map((f) => f.name)).toEqual(["waiting.pdf", "newer.pdf", "older.pdf"]);
    expect(result.files[0]).toMatchObject({ href: null, note: "Not stored here" });
    expect(result.files[1]!.href).toBe(`/p/isp-digital/api/whatsapp/media/${result.files[1]!.id}`);
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("lists a channel's attachments; a stored visitor file links to our route, and only http(s) is a link", async () => {
    const c = await rawPrisma.channelConversation.create({ data: { projectId: ORIGINAL_PROJECT_ID, connectionId: connection, type: "TELEGRAM", externalThreadId: `files-${tag}`, status: "OPEN" } });
    const m = await rawPrisma.channelMessage.create({
      data: {
        projectId: ORIGINAL_PROJECT_ID,
        conversationId: c.id,
        connectionId: connection,
        type: "TELEGRAM",
        direction: "INBOUND",
        senderType: "CUSTOMER",
        contentType: "FILE",
        occurredAt: NOW,
        externalMessageId: randomUUID(),
        attachments: [
          { type: "IMAGE", name: "photo.jpg", storageKey: `webchat/${ORIGINAL_PROJECT_ID}/v_visitor1234567890123/photo1234567890123456.jpg` },
          { type: "FILE", name: "link.pdf", url: "https://cdn.example.test/link.pdf" },
          { type: "FILE", name: "evil.html", url: "javascript:alert(1)" },
          { type: "FILE", name: "telegram.pdf", fileId: "abc" },
        ],
      },
    });
    const result = await inIsp(() => readConversationFiles({ kind: "channel", conversationId: c.id }));
    if ("error" in result) throw new Error(result.error);
    expect(result.files.map((f) => f.href)).toEqual([`/p/isp-digital/api/channels/attachment/${m.id}/0`, "https://cdn.example.test/link.pdf", null, null]);
    expect(JSON.stringify(result)).not.toContain("webchat/");
  });

  it("refuses a viewer without messages.view, Inbox V3 off, and another project's conversation", async () => {
    const g = await group("FilesRefused");
    await media(g, (await message(g, 30)).id);
    current = s.none;
    expect(await inIsp(() => readConversationFiles(refOf(g)))).toHaveProperty("error");
    current = s.reader;
    await feature("UNIFIED_INBOX_V3", false);
    expect(await inIsp(() => readConversationFiles(refOf(g)))).toHaveProperty("error");
    await feature("UNIFIED_INBOX_V3", true);
    const theirs = await group("FilesTheirs", bizAccount, BIZ.id);
    await media(theirs, (await message(theirs, 30)).id);
    expect(await inIsp(() => readConversationFiles(refOf(theirs)))).toHaveProperty("error");
  });
});
