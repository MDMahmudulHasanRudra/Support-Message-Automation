import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { EMPTY_INBOX_FILTERS, parseInboxFilterSet } from "@support-automation/shared";

/**
 * Inbox V3 triage in All Conversations (server/channels/inbox.ts): each row that needs a reply carries when the
 * customer STARTED waiting — their first message after our last reply (a failed send is not a reply) — for WhatsApp
 * and channel rows alike; "Longest waiting" lists those first, longest wait first; "Last message from" narrows to
 * the customer or us. With the feature off, both are ignored and rows carry no wait.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const { loadInbox } = await import("@/server/channels/inbox");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let P = { id: "", slug: `v3-triage-${tag}`, name: `V3 Triage ${tag}`, status: "ACTIVE" as const };
const inP = <T,>(fn: () => Promise<T>) => runWithProject(P, fn);
const fx = {} as { creator: string; account: string; connection: string };
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000);

async function feature(key: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: P.id, key } }, create: { projectId: P.id, key, enabled }, update: { enabled } });
  forgetProjectFeatureStates();
}

/** A WhatsApp group whose messages are [minutes ago, who]: C = customer, T = team member, O = our number. */
async function group(name: string, messages: Array<[number, "C" | "T" | "O"]>) {
  const chatId = `${name}-${tag}@g.us`;
  const g = await rawPrisma.whatsAppGroup.create({ data: { projectId: P.id, accountId: fx.account, whatsappGroupId: chatId, name: `${name} ${tag}`, isActive: true, isMonitored: true } });
  for (const [min, who] of messages) {
    await rawPrisma.message.create({
      data: {
        projectId: P.id, accountId: fx.account, groupId: g.id, whatsappMessageId: randomUUID(), chatId,
        senderPhone: who === "C" ? "8801911000111" : "8801922000222", senderName: who, direction: who === "O" ? "OUTGOING" : "INCOMING",
        isFromTeamMember: who === "T", body: `${who} at ${min}`, normalizedBody: `${who} at ${min}`, timestampWa: ago(min), processingStatus: "PROCESSED",
      },
    });
  }
}

/** A Telegram conversation whose messages are [minutes ago, direction, failed?]. */
async function channel(name: string, messages: Array<[number, "IN" | "OUT", boolean?]>) {
  const last = messages[messages.length - 1]!;
  const lastIn = messages.filter((m) => m[1] === "IN").at(-1);
  const c = await rawPrisma.channelConversation.create({
    data: {
      projectId: P.id, connectionId: fx.connection, type: "TELEGRAM", externalThreadId: `${name}-${tag}`, title: `${name} ${tag}`, status: "OPEN",
      lastMessageAt: ago(last[0]), lastMessageDirection: last[1] === "IN" ? "INBOUND" : "OUTBOUND", lastInboundAt: lastIn ? ago(lastIn[0]) : null,
    },
  });
  for (const [min, dir, failed] of messages) {
    await rawPrisma.channelMessage.create({
      data: {
        projectId: P.id, conversationId: c.id, connectionId: fx.connection, type: "TELEGRAM", direction: dir === "IN" ? "INBOUND" : "OUTBOUND",
        senderType: dir === "IN" ? "CUSTOMER" : "AGENT", text: `${dir} ${min}`, occurredAt: ago(min), deliveryStatus: dir === "OUT" ? (failed ? "FAILED" : "SENT") : null,
      },
    });
  }
}

const list = async (filters: Record<string, unknown> = {}) => (await inP(() => loadInbox({ scope: "all", filters: parseInboxFilterSet({ ...EMPTY_INBOX_FILTERS, ...filters }), viewerId: fx.creator }))).items;
const short = (t: string) => t.replace(` ${tag}`, "");

beforeAll(async () => {
  fx.creator = (await rawPrisma.user.create({ data: { username: `v3t_${tag}`, email: `v3t_${tag}@example.test`, name: "Creator", passwordHash: "x" } })).id;
  P = { ...P, id: (await createProjectWithDefaults({ name: P.name, slug: P.slug, status: "ACTIVE", creatorUserId: fx.creator }, rawPrisma)).id };
  await feature("OMNICHANNEL", true);
  fx.account = (await rawPrisma.whatsAppAccount.create({ data: { projectId: P.id, label: `Triage ${tag}`, status: "CONNECTED" } })).id;
  fx.connection = (await rawPrisma.channelConnection.create({ data: { projectId: P.id, type: "TELEGRAM", name: "@triage", status: "CONNECTED", webhookKey: `v3t-${tag}` } })).id;
  // WhatsApp: waiting since the first customer line after the team's reply (90 min), not the latest one (30 min).
  await group("wa-run", [[180, "C"], [120, "T"], [90, "C"], [30, "C"]]);
  // WhatsApp: waiting 50 min; the reply before it came from our number.
  await group("wa-ours", [[70, "C"], [60, "O"], [50, "C"]]);
  // WhatsApp: answered by a team member — not waiting.
  await group("wa-done", [[20, "C"], [10, "T"]]);
  // Telegram: waiting since 120 min — the reply after it FAILED, so it is no answer.
  await channel("tg-failed", [[150, "OUT"], [120, "IN"], [100, "OUT", true], [5, "IN"]]);
  // Telegram: waiting since 40 min.
  await channel("tg-wait", [[60, "IN"], [45, "OUT"], [40, "IN"]]);
  // Telegram: answered.
  await channel("tg-done", [[30, "IN"], [1, "OUT"]]);
});

beforeEach(async () => feature("UNIFIED_INBOX_V3", true));

afterAll(async () => {
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, P.id).catch(() => undefined);
  await rawPrisma.project.deleteMany({ where: { id: P.id } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: fx.creator } });
  await rawPrisma.user.deleteMany({ where: { id: fx.creator } });
  forgetProjectFeatureStates();
  await rawPrisma.$disconnect();
});

describe("triage with Inbox V3 on", () => {
  it("each waiting row carries when the customer started waiting; answered rows carry none", async () => {
    const items = await list();
    const since = (t: string) => items.find((i) => short(i.title) === t)?.waitingSince ?? null;
    expect(since("wa-run")).toBe(ago(90).toISOString());
    expect(since("wa-ours")).toBe(ago(50).toISOString());
    expect(since("tg-failed")).toBe(ago(120).toISOString());
    expect(since("tg-wait")).toBe(ago(40).toISOString());
    expect(since("wa-done")).toBeNull();
    expect(since("tg-done")).toBeNull();
  });

  it("Longest waiting: waiting rows first, longest wait first, then the rest newest first", async () => {
    expect((await list({ sort: "waiting" })).map((i) => short(i.title))).toEqual(["tg-failed", "wa-run", "wa-ours", "tg-wait", "tg-done", "wa-done"]);
  });

  it("Oldest first and the default newest first", async () => {
    expect((await list({ sort: "oldest" })).map((i) => short(i.title))).toEqual(["wa-ours", "tg-wait", "wa-run", "wa-done", "tg-failed", "tg-done"]);
    expect((await list()).map((i) => short(i.title))).toEqual(["tg-done", "tg-failed", "wa-done", "wa-run", "tg-wait", "wa-ours"]);
  });

  it("Last message from the customer, or from us", async () => {
    expect(new Set((await list({ lastSender: "customer" })).map((i) => short(i.title)))).toEqual(new Set(["wa-run", "wa-ours", "tg-failed", "tg-wait"]));
    expect(new Set((await list({ lastSender: "team" })).map((i) => short(i.title)))).toEqual(new Set(["wa-done", "tg-done"]));
  });
});

describe("triage with Inbox V3 off", () => {
  it("sort and last-sender are ignored, and rows carry no wait", async () => {
    await feature("UNIFIED_INBOX_V3", false);
    const plain = (await list()).map((i) => short(i.title));
    expect((await list({ sort: "waiting", lastSender: "team" })).map((i) => short(i.title))).toEqual(plain);
    expect((await list()).every((i) => i.waitingSince === null)).toBe(true);
  });
});
