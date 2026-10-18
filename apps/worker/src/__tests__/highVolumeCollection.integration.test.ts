import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { WhatsAppAccount } from "@prisma/client";
import { prisma } from "./helpers/projectFixtures.js";

/**
 * Group and personal traffic together, at roster scale, through the REAL probe and the REAL
 * reconcile sweep against a real database (18 Oct 2026 incident). What must hold:
 * - personal messages are all recovered even though group traffic far exceeds the sweep's limit;
 * - the group half is bounded by its own limit, and the read says it was cut short;
 * - a second pass stores nothing twice;
 * - nothing old enough to be outside the automation window is answered, and nothing is sent;
 * - the pass stays within modest time and memory.
 */

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(() => new Promise(() => {})),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {},
}));

const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
const { reconcileRecentMessages } = await import("../pipeline/reconcileRecentMessages.js");

const GROUPS = 600;
const GROUP_MESSAGES_EACH = 3;
const PERSONAL = 60;
const PERSONAL_MESSAGES_EACH = 2;
const NOW_S = Math.floor(Date.now() / 1000);
// 16–28 minutes old: inside the sweep's 30-minute window, outside the 15-minute automation window, so
// everything recovered here is stored without rules — the "no unintended sends" half of the check.
const ageSeconds = (i: number) => 16 * 60 + (i % 12) * 60;
const tag = randomUUID().replace(/-/g, "").slice(0, 10);

let account: WhatsAppAccount;
const groupIds = Array.from({ length: GROUPS }, (_, i) => `${tag}${String(i).padStart(4, "0")}-1@g.us`);
const personalIds = Array.from({ length: PERSONAL }, (_, i) => `88019${String(i).padStart(4, "0")}${tag.slice(0, 4).replace(/\D/g, "1")}@c.us`);

function messagesFor(chatId: string, count: number, isGroup: boolean) {
  return Array.from({ length: count }, (_, k) => ({
    id: `false_${chatId}_${k}`,
    type: "chat",
    body: isGroup ? "group question" : "personal question",
    timestamp: NOW_S - ageSeconds(k),
    from: isGroup ? chatId : chatId,
    author: isGroup ? "8801711000333@c.us" : undefined,
    chatId,
    fromMe: false,
    isGroupMsg: isGroup,
  }));
}

function provider() {
  const p = new OpenWAProvider(account.id, `hv-${tag}`, "/tmp/nowhere");
  (p as unknown as { client: unknown }).client = {
    getAllGroups: async () => groupIds.map((id) => ({ id, t: NOW_S - 60 })),
    getAllChats: async () => personalIds.map((id) => ({ id, t: NOW_S - 600 })), // quieter than every group
    getAllMessagesInChat: async (chatId: string) =>
      chatId.endsWith("@g.us") ? messagesFor(chatId, GROUP_MESSAGES_EACH, true) : messagesFor(chatId, PERSONAL_MESSAGES_EACH, false),
  };
  return p;
}

beforeAll(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `High volume ${tag}`, status: "CONNECTED", phoneNumber: `88017${String(Date.now()).slice(-8)}` },
  });
});

afterAll(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("group and personal traffic together", () => {
  it("recovers every personal message, bounds the groups, and stores nothing twice", async () => {
    const outboundBefore = await prisma.outboundMessage.count({ where: { accountId: account.id } });
    const heapBefore = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();
    const started = performance.now();

    const first = await reconcileRecentMessages(account.id, provider());

    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / 1_048_576;
    console.log(
      `[high-volume] first pass: offered=${first.offered} recovered=${first.recovered} failed=${first.failed} ` +
        `elapsed=${Math.round(elapsedMs)}ms cpu=${Math.round((cpu.user + cpu.system) / 1000)}ms heapGrowth=${heapGrowthMb.toFixed(1)}MB`,
    );

    const personalStored = await prisma.message.count({ where: { accountId: account.id, groupId: null, chatId: { in: personalIds } } });
    expect(personalStored).toBe(PERSONAL * PERSONAL_MESSAGES_EACH); // none starved by the groups
    const groupStored = await prisma.message.count({ where: { accountId: account.id, chatId: { endsWith: "@g.us" } } });
    expect(groupStored).toBe(500); // the group half's own limit
    expect(first.incomplete).toMatch(/group read stopped at its limit/i);
    expect(first.failed).toBe(0);

    // Nothing answered or sent: every recovered message is older than the automation window.
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(outboundBefore);
    const statuses = await prisma.message.groupBy({ by: ["processingStatus"], where: { accountId: account.id }, _count: true });
    expect(statuses.map((s) => s.processingStatus)).toEqual(["IGNORED"]);

    // A second pass: the personal half is already stored; the group half moves on, never duplicating.
    const second = await reconcileRecentMessages(account.id, provider());
    expect(second.failed).toBe(0);
    const total = await prisma.message.count({ where: { accountId: account.id } });
    const distinct = await prisma.message.groupBy({ by: ["whatsappMessageId"], where: { accountId: account.id } });
    expect(distinct.length).toBe(total);
    expect(await prisma.message.count({ where: { accountId: account.id, groupId: null, chatId: { in: personalIds } } })).toBe(PERSONAL * PERSONAL_MESSAGES_EACH);

    // Generous bounds: the point is "not unbounded", not a benchmark.
    expect(elapsedMs).toBeLessThan(120_000);
    expect(heapGrowthMb).toBeLessThan(300);
  }, 240_000);
});
