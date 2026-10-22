import "./helpers/requireTestDatabase.js";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { syncGroupsDetailed, syncGroupsWithTimeoutAndRetry } from "../commands/commandProcessor.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import type { RawIncomingMessage } from "../pipeline/types.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Phase 2, Stage 9 (PHASE2.md; Workstream M) — measured, not claimed. Skipped unless
 * PHASE2_BENCHMARK=1, and like every integration file here it refuses anything but a throwaway local
 * database. Results go to PHASE2_BENCHMARK_OUT (JSON) when set, and to the console.
 *
 * The WhatsApp side is the MockProvider: what is measured is this code and PostgreSQL — the browser's
 * own read of a 1,800-group chat store is not, and cannot be without a live number.
 */
const RUN = process.env.PHASE2_BENCHMARK === "1";
const results: Record<string, unknown> = {};
const accounts: string[] = [];

const roster = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ whatsappGroupId: `${tag}-${i}-1600000000@g.us`, name: `Bench ${tag} ${i}` }));

async function newAccount() {
  const a = await prisma.whatsAppAccount.create({ data: { label: `Bench ${randomUUID()}`, status: "CONNECTED", phoneNumber: `88017${Math.floor(Math.random() * 1e8)}` } });
  accounts.push(a.id);
  return a.id;
}

/** Wall time, event-loop delay and heap growth around one awaited piece of work. */
async function measure<T>(work: () => Promise<T>) {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const value = await work();
  const ms = Math.round(performance.now() - started);
  loop.disable();
  return {
    value,
    ms,
    loopDelayP99Ms: Math.round(loop.percentile(99) / 1e6),
    loopDelayMaxMs: Math.round(loop.max / 1e6),
    heapGrowthMb: Math.round(((process.memoryUsage().heapUsed - heapBefore) / 1_048_576) * 10) / 10,
  };
}

/** Peak connections this database saw while `work` ran, sampled every 100 ms. */
async function peakConnections<T>(work: () => Promise<T>): Promise<{ value: T; peak: number }> {
  let peak = 0;
  let done = false;
  const sampler = (async () => {
    while (!done) {
      const [row] = await rawPrisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`;
      peak = Math.max(peak, row?.n ?? 0);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  const value = await work();
  done = true;
  await sampler;
  return { value, peak };
}

function message(accountId: string, groupId: string, i: number, at: Date): RawIncomingMessage {
  return {
    accountId,
    whatsappMessageId: `false_${groupId}_B${i}${randomUUID().slice(0, 6)}_8801${String(1e8 + i)}@c.us`,
    chatId: groupId,
    whatsappGroupId: groupId,
    senderPhone: `8801${String(1e8 + i)}`,
    senderJid: `8801${String(1e8 + i)}@c.us`,
    senderName: null,
    direction: "INCOMING",
    body: `benchmark message ${i}`,
    timestampWa: at,
    quotedWhatsappMessageId: null,
    mentionedPhones: [],
  };
}

const percentileOf = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;

afterAll(async () => {
  if (!RUN) return;
  if (process.env.PHASE2_BENCHMARK_OUT) writeFileSync(process.env.PHASE2_BENCHMARK_OUT, JSON.stringify(results, null, 2));
  console.log(`[benchmark] ${JSON.stringify(results, null, 2)}`);
  await prisma.message.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: accounts } } });
});

describe.skipIf(!RUN)("group sync at roster scale (MockProvider)", () => {
  for (const n of [50, 500, 1800, 2500]) {
    it(`${n} groups: first read, then an unchanged re-read`, async () => {
      const id = await newAccount();
      const provider = new MockProvider();
      const groups = roster(randomUUID().slice(0, 6), n);
      provider.getGroups = async () => groups;

      const first = await peakConnections(() => measure(() => syncGroupsWithTimeoutAndRetry(id, provider)));
      const again = await measure(() => syncGroupsDetailed(id, provider));
      expect(first.value.value).toBe(n);
      expect(again.value).toMatchObject({ discovered: n, created: 0, deactivated: 0, failed: 0 });
      results[`groupSync_${n}`] = {
        firstSyncMs: first.value.ms,
        firstSyncGroupsPerSecond: Math.round((n / Math.max(1, first.value.ms)) * 1000),
        rereadMs: again.ms,
        loopDelayP99Ms: first.value.loopDelayP99Ms,
        loopDelayMaxMs: first.value.loopDelayMaxMs,
        heapGrowthMb: first.value.heapGrowthMb,
        peakDbConnections: first.peak,
      };
    }, 300_000);
  }
});

describe.skipIf(!RUN)("incoming messages", () => {
  it("a burst of 500 customer messages, one after another (as the listener hands them over)", async () => {
    const accountId = await newAccount();
    const groupId = `burst-${randomUUID().slice(0, 6)}@g.us`;
    await prisma.whatsAppGroup.create({ data: { accountId, whatsappGroupId: groupId, name: "Burst", isActive: true, isMonitored: true } });
    const latencies: number[] = [];
    const base = Date.now() - 60_000;
    const run = await measure(async () => {
      for (let i = 0; i < 500; i++) {
        const started = performance.now();
        await processIncomingMessage(message(accountId, groupId, i, new Date(base + i)));
        latencies.push(performance.now() - started);
      }
    });
    latencies.sort((a, b) => a - b);
    expect(await prisma.message.count({ where: { accountId } })).toBe(500);
    results.messageBurst_500 = {
      totalMs: run.ms,
      messagesPerSecond: Math.round((500 / Math.max(1, run.ms)) * 1000),
      latencyP50Ms: Math.round(percentileOf(latencies, 0.5)!),
      latencyP95Ms: Math.round(percentileOf(latencies, 0.95)!),
      loopDelayMaxMs: run.loopDelayMaxMs,
      heapGrowthMb: run.heapGrowthMb,
    };
  }, 300_000);

  it("messages keep being stored while a 2,500-group sync runs", async () => {
    const accountId = await newAccount();
    const groupId = `during-${randomUUID().slice(0, 6)}@g.us`;
    await prisma.whatsAppGroup.create({ data: { accountId, whatsappGroupId: groupId, name: "During sync", isActive: true, isMonitored: true } });
    const syncAccount = await newAccount();
    const provider = new MockProvider();
    const groups = roster(randomUUID().slice(0, 6), 2500);
    provider.getGroups = async () => groups;

    const idle: number[] = [];
    const base = Date.now() - 120_000;
    for (let i = 0; i < 50; i++) {
      const started = performance.now();
      await processIncomingMessage(message(accountId, groupId, i, new Date(base + i)));
      idle.push(performance.now() - started);
    }
    const during: number[] = [];
    let syncDone = false;
    const sync = syncGroupsWithTimeoutAndRetry(syncAccount, provider).finally(() => {
      syncDone = true;
    });
    let i = 50;
    while (!syncDone && i < 2000) {
      const started = performance.now();
      await processIncomingMessage(message(accountId, groupId, i, new Date(base + i)));
      during.push(performance.now() - started);
      i += 1;
    }
    expect(await sync).toBe(2500);
    idle.sort((a, b) => a - b);
    during.sort((a, b) => a - b);
    expect(during.length).toBeGreaterThan(0);
    results.messagesDuringSync = {
      idleP50Ms: Math.round(percentileOf(idle, 0.5)!),
      idleP95Ms: Math.round(percentileOf(idle, 0.95)!),
      duringSyncMessages: during.length,
      duringSyncP50Ms: Math.round(percentileOf(during, 0.5)!),
      duringSyncP95Ms: Math.round(percentileOf(during, 0.95)!),
      duringSyncMaxMs: Math.round(during[during.length - 1]!),
    };
  }, 300_000);
});
