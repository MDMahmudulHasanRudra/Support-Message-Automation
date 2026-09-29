import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createKnowledgeItem, deriveKnowledgeScope } from "@support-automation/db";
import { prisma, inIsp } from "./helpers/projectFixtures.js";
import type { WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { findRelevantKnowledge } from "../aiFallback/knowledgeContext.js";

/**
 * The data-isolation boundary: whose information may ground an answer in whose conversation.
 *
 * This is the most important property in the retrieval layer, and until now it did not exist.
 * `findRelevantKnowledge` filtered on `humanVerified` + `ACTIVE` and nothing else — `sourceGroupId`
 * recorded where an entry came from and was used only as a ranking tiebreak. So an entry distilled
 * from Group A's conversation, or researched live for Group A's question, could ground an answer
 * given to Group B: one customer's configuration told to another.
 *
 * Every test here was confirmed to fail before the scope filter existed.
 */

let account: WhatsAppAccount;
let otherAccount: WhatsAppAccount;
let groupA: WhatsAppGroup;
let groupB: WhatsAppGroup;
const createdItemIds: string[] = [];

const uniqueChatId = () => `${randomUUID().replace(/-/g, "").slice(0, 10)}-9999999999@g.us`;

/** A distinctive term, so retrieval finds the fixture and nothing a previous suite left behind. */
const MARKER = `zynthrol${randomUUID().replace(/-/g, "").slice(0, 8)}`;

async function knowledge(over: {
  title: string;
  sourceGroupId?: string | null;
  scope?: "GLOBAL" | "GROUP" | "ACCOUNT";
  scopeAccountId?: string | null;
  humanVerified?: boolean;
}) {
  const item = await createKnowledgeItem({
    title: over.title,
    category: "FAQ",
    question: `How does ${MARKER} work?`,
    answer: `The ${MARKER} setting is configured from the billing screen.`,
    source: "MANUAL",
    sourceGroupId: over.sourceGroupId ?? null,
    scope: over.scope,
    scopeAccountId: over.scopeAccountId ?? null,
    aiGenerated: false,
    humanVerified: over.humanVerified ?? true,
  }, prisma);
  createdItemIds.push(item.id);
  return item;
}

beforeAll(async () => {
  account = await prisma.whatsAppAccount.create({ data: { label: `Isolation ${randomUUID()}`, status: "CONNECTED" } });
  otherAccount = await prisma.whatsAppAccount.create({ data: { label: `Isolation Other ${randomUUID()}`, status: "CONNECTED" } });
  const base = { accountId: account.id, isMonitored: true, lastSyncedAt: new Date() };
  groupA = await prisma.whatsAppGroup.create({ data: { ...base, whatsappGroupId: uniqueChatId(), name: "Group A" } });
  groupB = await prisma.whatsAppGroup.create({ data: { ...base, whatsappGroupId: uniqueChatId(), name: "Group B" } });
});

afterEach(async () => {
  if (createdItemIds.length) {
    await prisma.aiKnowledgeItem.deleteMany({ where: { id: { in: createdItemIds } } });
    createdItemIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.whatsAppGroup.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: [account.id, otherAccount.id] } } });
  await prisma.$disconnect();
});

const titles = (rows: { title: string }[]) => rows.map((row) => row.title).sort();

describe("GROUP knowledge never leaves its group", () => {
  it("is retrievable in the group it came from", async () => {
    await knowledge({ title: `${MARKER} in Group A`, sourceGroupId: groupA.id });

    const found = await inIsp(() => findRelevantKnowledge(`tell me about ${MARKER}`, { groupId: groupA.id, accountId: account.id }));
    expect(titles(found)).toEqual([`${MARKER} in Group A`]);
  });

  it("is NOT retrievable in a different group", async () => {
    // The assertion this whole change exists for.
    await knowledge({ title: `${MARKER} in Group A`, sourceGroupId: groupA.id });

    const found = await inIsp(() => findRelevantKnowledge(`tell me about ${MARKER}`, { groupId: groupB.id, accountId: account.id }));
    expect(found).toEqual([]);
  });

  it("is NOT retrievable with no group at all", async () => {
    // The sandbox and any future context without a conversation. Falling back to "everything" here
    // would make a scope filter that holds in production and leaks in a test harness.
    await knowledge({ title: `${MARKER} in Group A`, sourceGroupId: groupA.id });

    expect(await inIsp(() => findRelevantKnowledge(`tell me about ${MARKER}`, { groupId: null }))).toEqual([]);
  });
});

describe("GLOBAL knowledge reaches every group", () => {
  it("is retrievable from both groups and from none", async () => {
    // The other half of the boundary: narrowing must not quietly break product knowledge, which is
    // the overwhelming majority of what the knowledge base holds.
    await knowledge({ title: `${MARKER} everywhere`, sourceGroupId: null });

    for (const scope of [{ groupId: groupA.id }, { groupId: groupB.id }, { groupId: null }]) {
      const found = await inIsp(() => findRelevantKnowledge(`tell me about ${MARKER}`, scope));
      expect(titles(found), JSON.stringify(scope)).toEqual([`${MARKER} everywhere`]);
    }
  });

  it("is returned alongside the asking group's own entry, and not the other group's", async () => {
    await knowledge({ title: `${MARKER} everywhere`, sourceGroupId: null });
    await knowledge({ title: `${MARKER} for A`, sourceGroupId: groupA.id });
    await knowledge({ title: `${MARKER} for B`, sourceGroupId: groupB.id });

    expect(titles(await inIsp(() => findRelevantKnowledge(`tell me about ${MARKER}`, { groupId: groupA.id }, 10)))).toEqual([
      `${MARKER} everywhere`,
      `${MARKER} for A`,
    ]);
  });
});

describe("ACCOUNT knowledge is narrowed to its account", () => {
  it("reaches a group on that account and not one served by another", async () => {
    await knowledge({
      title: `${MARKER} for this account`,
      scope: "ACCOUNT",
      scopeAccountId: account.id,
    });

    expect(
      titles(await inIsp(() => findRelevantKnowledge(`tell me about ${MARKER}`, { groupId: groupA.id, accountId: account.id }))),
    ).toEqual([`${MARKER} for this account`]);

    expect(
      await inIsp(() => findRelevantKnowledge(`tell me about ${MARKER}`, { groupId: groupA.id, accountId: otherAccount.id })),
    ).toEqual([]);
  });
});

describe("the unverified gate still comes first", () => {
  it("does not retrieve an unverified entry even when the scope matches perfectly", async () => {
    // Scope narrows; it never widens. An entry that fails the existing safety gate must stay
    // unreachable whatever its scope says, or this change would have traded one boundary for
    // another.
    await knowledge({ title: `${MARKER} unverified`, sourceGroupId: groupA.id, humanVerified: false });
    await knowledge({ title: `${MARKER} unverified global`, sourceGroupId: null, humanVerified: false });

    expect(await inIsp(() => findRelevantKnowledge(`tell me about ${MARKER}`, { groupId: groupA.id }))).toEqual([]);
  });
});

describe("scope is derived from provenance", () => {
  it("narrows anything that came from a group, and leaves everything else global", () => {
    // Pure, and the rule in one line: "unknown or ambiguous" resolves to the narrow answer.
    expect(deriveKnowledgeScope({ sourceGroupId: "g1" })).toBe("GROUP");
    expect(deriveKnowledgeScope({ sourceGroupId: null })).toBe("GLOBAL");
    expect(deriveKnowledgeScope({})).toBe("GLOBAL");
    // An explicit decision always wins — that is how a person promotes an entry, and how the Forge
    // repository sync states that it reads the product rather than a conversation.
    expect(deriveKnowledgeScope({ sourceGroupId: "g1", scope: "GLOBAL" })).toBe("GLOBAL");
  });
});

describe("every writer produces a version row", () => {
  it("writes version 1 alongside the item, so a snapshot can resolve it", async () => {
    // Two writers created knowledge with no `AiKnowledgeVersion` at all, so `currentVersion: 1`
    // pointed at nothing — and an evidence snapshot recording "version 1" would resolve to no
    // content, which defeats the point of recording it.
    const item = await knowledge({ title: `${MARKER} versioned`, sourceGroupId: null });

    const versions = await prisma.aiKnowledgeVersion.findMany({ where: { itemId: item.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.title).toBe(`${MARKER} versioned`);
  });

  it("stores a content hash, and the same content hashes the same", async () => {
    const first = await knowledge({ title: `${MARKER} hashed`, sourceGroupId: null });
    const second = await knowledge({ title: `${MARKER} hashed`, sourceGroupId: groupA.id });

    const rows = await prisma.aiKnowledgeItem.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { contentHash: true },
    });
    expect(rows[0]!.contentHash).toBeTruthy();
    // Identical content, different scope — the hash describes the CONTENT, which is what makes it
    // useful for spotting a duplicate import and useless as an automatic merge trigger.
    expect(rows[0]!.contentHash).toBe(rows[1]!.contentHash);
  });
});
