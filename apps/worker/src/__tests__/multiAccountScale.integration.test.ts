import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./helpers/projectFixtures.js";
import { syncGroupsDetailed } from "../commands/commandProcessor.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Three numbers in ONE project, each in its own large set of groups (3,000 / 3,000 / 2,000 — 8,000
 * groups, none shared), synced at the same time and then collecting at once. What must hold:
 * - every group lands on its own account, none on another, none twice;
 * - a second sync changes nothing; a short read is held, a real leave is applied, per account only;
 * - messages arriving on all three at once are each stored once, on the right account and group,
 *   and a replay of the same messages stores nothing more.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const SIZES = [3000, 3000, 2000] as const;
const accounts: string[] = [];
const rosters: Array<Array<{ whatsappGroupId: string; name: string }>> = [];
const roster = (a: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ whatsappGroupId: `${tag}${a}${String(i).padStart(5, "0")}-1700000000@g.us`, name: `Scale ${tag} A${a} G${i}` }));

function provider(groups: () => Array<{ whatsappGroupId: string; name: string }>) {
  const p = new MockProvider();
  p.getGroups = async () => groups();
  return p;
}

const groupCount = (accountId: string, isActive?: boolean) =>
  prisma.whatsAppGroup.count({ where: { accountId, ...(isActive === undefined ? {} : { isActive }) } });

beforeAll(async () => {
  for (let a = 0; a < SIZES.length; a++) {
    const row = await prisma.whatsAppAccount.create({
      data: { label: `Scale ${tag} ${a}`, status: "CONNECTED", phoneNumber: `8801${a}${String(Date.now()).slice(-8)}` },
    });
    accounts.push(row.id);
    rosters.push(roster(a, SIZES[a]!));
  }
});

afterAll(async () => {
  for (const id of accounts) {
    await prisma.message.deleteMany({ where: { accountId: id } }).catch(() => undefined);
    await prisma.whatsAppAccount.delete({ where: { id } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe("three accounts, 8,000 unique groups, one project", () => {
  it("syncs all three at the same time, each group on its own account exactly once", async () => {
    const started = performance.now();
    const outcomes = await Promise.all(accounts.map((id, a) => syncGroupsDetailed(id, provider(() => rosters[a]!))));
    const elapsed = Math.round(performance.now() - started);
    console.log(`[scale] first sync of 8,000 groups across 3 accounts: ${elapsed}ms`, outcomes.map((o) => `${o.created}/${o.discovered} in ${o.persistMs}ms`));

    for (let a = 0; a < accounts.length; a++) {
      expect(outcomes[a]!.discovered).toBe(SIZES[a]);
      expect(outcomes[a]!.created).toBe(SIZES[a]);
      expect(outcomes[a]!.failed).toBe(0);
      expect(await groupCount(accounts[a]!, true)).toBe(SIZES[a]);
      // Not one of this account's groups is on another account.
      const ids = rosters[a]!.map((g) => g.whatsappGroupId);
      expect(await prisma.whatsAppGroup.count({ where: { whatsappGroupId: { in: ids }, accountId: { not: accounts[a]! } } })).toBe(0);
    }
    expect(elapsed).toBeLessThan(120_000);
  }, 240_000);

  it("a second sync of the same lists changes nothing", async () => {
    const outcomes = await Promise.all(accounts.map((id, a) => syncGroupsDetailed(id, provider(() => rosters[a]!))));
    for (let a = 0; a < accounts.length; a++) {
      expect(outcomes[a]!.created).toBe(0);
      expect(outcomes[a]!.deactivated).toBe(0);
      expect(outcomes[a]!.renamed).toBe(0);
      expect(await groupCount(accounts[a]!)).toBe(SIZES[a]);
    }
  }, 240_000);

  it("a short read on one account is held; a real leave on another is applied; the third is untouched", async () => {
    // Account 0: WhatsApp still loading — 2,500 of 3,000 listed (a sixth missing). Must not deactivate.
    const short = await syncGroupsDetailed(accounts[0]!, provider(() => rosters[0]!.slice(0, 2500)));
    expect(short.sweepHeld).toBe(true);
    expect(short.deactivated).toBe(0);
    expect(await groupCount(accounts[0]!, true)).toBe(3000);

    // Account 1: really left 40 groups. Applied, and only there.
    const left = await syncGroupsDetailed(accounts[1]!, provider(() => rosters[1]!.slice(40)));
    expect(left.sweepHeld).toBe(false);
    expect(left.deactivated).toBe(40);
    expect(await groupCount(accounts[1]!, true)).toBe(2960);
    expect(await groupCount(accounts[1]!)).toBe(3000); // soft, never deleted

    expect(await groupCount(accounts[0]!, true)).toBe(3000);
    expect(await groupCount(accounts[2]!, true)).toBe(2000);
  }, 240_000);

  it("collects messages arriving on all three at once: each stored once, on the right account and group", async () => {
    const PER_ACCOUNT = 150;
    const base = Date.now() - 60_000;
    const batch = accounts.flatMap((accountId, a) =>
      Array.from({ length: PER_ACCOUNT }, (_, k) => {
        // Spread across the whole roster, including the last groups of the list.
        const group = rosters[a]![Math.floor((k * SIZES[a]!) / PER_ACCOUNT) + (k % 3)]!;
        return {
          accountId,
          whatsappMessageId: `false_${group.whatsappGroupId}_${tag}${a}${k}`,
          chatId: group.whatsappGroupId,
          whatsappGroupId: group.whatsappGroupId,
          senderPhone: `88017${a}${String(k).padStart(6, "0")}`,
          senderJid: `88017${a}${String(k).padStart(6, "0")}@c.us`,
          direction: "INCOMING" as const,
          body: `scale question ${k}`,
          timestampWa: new Date(base + k * 10),
        };
      }),
    );

    // All three accounts' traffic interleaved and concurrent, as three live listeners would deliver it.
    const started = performance.now();
    await Promise.all(batch.map((raw) => processIncomingMessage(raw)));
    console.log(`[scale] ${batch.length} concurrent messages across 3 accounts stored in ${Math.round(performance.now() - started)}ms`);

    for (let a = 0; a < accounts.length; a++) {
      const stored = await prisma.message.findMany({
        where: { accountId: accounts[a]! },
        select: { chatId: true, whatsappMessageId: true, groupId: true, group: { select: { accountId: true, whatsappGroupId: true } } },
      });
      expect(stored.length).toBe(PER_ACCOUNT);
      for (const m of stored) {
        // Linked to THIS account's copy of THAT group — never another account's, never unlinked.
        expect(m.group?.accountId).toBe(accounts[a]);
        expect(m.group?.whatsappGroupId).toBe(m.chatId);
      }
    }

    // WhatsApp redelivers everything (a reconnect, a catch-up): nothing is stored twice.
    await Promise.all(batch.map((raw) => processIncomingMessage(raw)));
    for (let a = 0; a < accounts.length; a++) {
      expect(await prisma.message.count({ where: { accountId: accounts[a]! } })).toBe(PER_ACCOUNT);
    }
  }, 240_000);
});
