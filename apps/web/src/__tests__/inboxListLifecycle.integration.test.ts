import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { EMPTY_INBOX_FILTERS, parseInboxFilterSet } from "@support-automation/shared";

/**
 * Inbox V3 in the All Conversations list (server/channels/inbox.ts): with the feature on, the default list is
 * the active conversations (Open + Pending), the status filter selects Open / Pending / Snoozed / Resolved for
 * WhatsApp and channel rows alike, rows carry their status, and "Mine" includes a WhatsApp conversation assigned
 * to the viewer. With it off, a channel conversation left Pending or Snoozed is still listed as open — never
 * hidden (the regression this pins: the old filter was status = 'OPEN').
 */

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const { loadInbox } = await import("@/server/channels/inbox");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let P = { id: "", slug: `v3-list-${tag}`, name: `V3 List ${tag}`, status: "ACTIVE" as const };
const inP = <T,>(fn: () => Promise<T>) => runWithProject(P, fn);
const fx = {} as { creator: string; viewer: string; account: string; connection: string; chats: Record<string, string>; channels: Record<string, string> };

async function feature(key: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: P.id, key } }, create: { projectId: P.id, key, enabled }, update: { enabled } });
  forgetProjectFeatureStates();
}
async function group(name: string) {
  const chatId = `${name}-${tag}@g.us`;
  const g = await rawPrisma.whatsAppGroup.create({ data: { projectId: P.id, accountId: fx.account, whatsappGroupId: chatId, name: `${name} ${tag}`, isActive: true } });
  await rawPrisma.message.create({
    data: { projectId: P.id, accountId: fx.account, groupId: g.id, whatsappMessageId: randomUUID(), chatId, senderPhone: "8801911000111", senderName: "Customer", direction: "INCOMING", body: "Hello", normalizedBody: "hello", timestampWa: new Date(), processingStatus: "PROCESSED" },
  });
  return chatId;
}
const list = async (filters: Record<string, unknown> = {}) => (await inP(() => loadInbox({ scope: "all", filters: parseInboxFilterSet({ ...EMPTY_INBOX_FILTERS, ...filters }), viewerId: fx.viewer }))).items;
const titles = (items: Array<{ title: string }>) => new Set(items.map((i) => i.title.replace(` ${tag}`, "")));

beforeAll(async () => {
  fx.creator = (await rawPrisma.user.create({ data: { username: `v3l_${tag}`, email: `v3l_${tag}@example.test`, name: "Creator", passwordHash: "x" } })).id;
  fx.viewer = (await rawPrisma.user.create({ data: { username: `v3lv_${tag}`, email: `v3lv_${tag}@example.test`, name: "Viewer", passwordHash: "x" } })).id;
  P = { ...P, id: (await createProjectWithDefaults({ name: P.name, slug: P.slug, status: "ACTIVE", creatorUserId: fx.creator }, rawPrisma)).id };
  await feature("OMNICHANNEL", true);
  fx.account = (await rawPrisma.whatsAppAccount.create({ data: { projectId: P.id, label: `List ${tag}`, status: "CONNECTED" } })).id;
  fx.chats = {} as Record<string, string>;
  for (const name of ["open", "pending", "snoozed", "resolved", "mine"]) fx.chats[name] = await group(name);
  const states: Array<[string, "OPEN" | "PENDING" | "SNOOZED" | "RESOLVED", Record<string, unknown>]> = [
    ["pending", "PENDING", {}],
    ["snoozed", "SNOOZED", { snoozedUntil: new Date(Date.now() + 3_600_000) }],
    ["resolved", "RESOLVED", {}],
    ["mine", "OPEN", { assignedUserId: fx.viewer }],
  ];
  for (const [name, status, extra] of states) {
    await rawPrisma.whatsAppConversationState.create({ data: { projectId: P.id, accountId: fx.account, chatId: fx.chats[name]!, conversationType: "GROUP", status, ...extra } });
  }
  fx.connection = (await rawPrisma.channelConnection.create({ data: { projectId: P.id, type: "TELEGRAM", name: "@list", status: "CONNECTED", webhookKey: `v3l-${tag}` } })).id;
  fx.channels = {} as Record<string, string>;
  const channelStates: Array<[string, "OPEN" | "PENDING" | "SNOOZED" | "CLOSED"]> = [
    ["ch-open", "OPEN"],
    ["ch-pending", "PENDING"],
    ["ch-snoozed", "SNOOZED"],
    ["ch-resolved", "CLOSED"],
  ];
  for (const [name, status] of channelStates) {
    fx.channels[name] = (
      await rawPrisma.channelConversation.create({
        data: { projectId: P.id, connectionId: fx.connection, type: "TELEGRAM", externalThreadId: `${name}-${tag}`, title: `${name} ${tag}`, status, snoozedUntil: status === "SNOOZED" ? new Date(Date.now() + 3_600_000) : null, lastMessageAt: new Date() },
      })
    ).id;
  }
});

beforeEach(async () => feature("UNIFIED_INBOX_V3", true));

afterAll(async () => {
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, P.id).catch(() => undefined);
  await rawPrisma.project.deleteMany({ where: { id: P.id } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: [fx.creator, fx.viewer] } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: [fx.creator, fx.viewer] } } });
  forgetProjectFeatureStates();
  await rawPrisma.$disconnect();
});

describe("All Conversations with Inbox V3 on", () => {
  it("lists the active conversations by default: Open and Pending, never Snoozed or Resolved", async () => {
    const shown = titles(await list());
    for (const t of ["open", "pending", "mine", "ch-open", "ch-pending"]) expect(shown.has(t)).toBe(true);
    for (const t of ["snoozed", "resolved", "ch-snoozed", "ch-resolved"]) expect(shown.has(t)).toBe(false);
  });

  it("the status filter selects each status for WhatsApp and channel rows, and rows carry it", async () => {
    const pending = await list({ status: "PENDING" });
    expect(titles(pending)).toEqual(new Set(["pending", "ch-pending"]));
    expect(pending.every((i) => i.lifecycleStatus === "PENDING")).toBe(true);
    expect(titles(await list({ status: "SNOOZED" }))).toEqual(new Set(["snoozed", "ch-snoozed"]));
    expect(titles(await list({ status: "RESOLVED" }))).toEqual(new Set(["resolved", "ch-resolved"]));
    expect(titles(await list({ status: "OPEN" }))).toEqual(new Set(["open", "mine", "ch-open"]));
  });

  it("Mine includes a WhatsApp conversation assigned to the viewer, shown with their name", async () => {
    const mine = await list({ view: "mine" });
    expect(titles(mine).has("mine")).toBe(true);
    expect(mine.find((i) => i.title.startsWith("mine"))).toMatchObject({ assignedToMe: true, assigneeName: "Viewer" });
  });
});

describe("All Conversations with Inbox V3 off", () => {
  it("lists exactly as before, and a channel conversation left Pending or Snoozed is still open, never hidden", async () => {
    await feature("UNIFIED_INBOX_V3", false);
    const items = await list();
    const shown = titles(items);
    for (const t of ["open", "pending", "snoozed", "resolved", "mine", "ch-open", "ch-pending", "ch-snoozed"]) expect(shown.has(t)).toBe(true);
    expect(shown.has("ch-resolved")).toBe(false);
    expect(items.every((i) => i.lifecycleStatus === null)).toBe(true);
    // The status filter means nothing with the feature off.
    expect(titles(await list({ status: "PENDING" }))).toEqual(shown);
  });
});
