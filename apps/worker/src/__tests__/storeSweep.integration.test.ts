import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { WhatsAppAccount } from "@prisma/client";
import { prisma } from "./helpers/projectFixtures.js";

/**
 * The store sweep (18 Oct 2026): personal messages from unknown foreign numbers reached the phone and
 * never the database, while every recovery path found nothing — because every one of them finds a
 * message through its chat's activity time, and that chat never showed as active. Exercised through
 * the REAL OpenWAProvider against a fake WhatsApp Web page (its `Store`), and a real database.
 */

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(() => new Promise(() => {})),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {},
}));

const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
const { reconcileRecentMessages, selectStoreSweepIds, sweepMessageStore, STORE_SWEEP_MIN_AGE_MS } = await import(
  "../pipeline/reconcileRecentMessages.js"
);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const digits = tag.replace(/\D/g, "7").padEnd(8, "7").slice(0, 8);
const NOW_S = Math.floor(Date.now() / 1000);
// 16 minutes old: inside both look-back windows, outside the 15-minute automation window, so nothing
// recovered here is answered.
const OLD = NOW_S - 16 * 60;

const unknownChat = `974${digits}@c.us`;
const groupChat = `${tag}-1@g.us`;
const ids = {
  unknownPersonal: `false_${unknownChat}_${tag}A`,
  storedGroup: `false_${groupChat}_${tag}B`,
  status: `false_status@broadcast_${tag}C`,
  sticker: `false_${unknownChat}_${tag}D`,
  encrypted: `false_${unknownChat}_${tag}E`,
  young: `false_${unknownChat}_${tag}F`,
  empty: `false_${unknownChat}_${tag}G`,
};

/** Full messages, as `getMessageById` returns them. */
const full: Record<string, Record<string, unknown>> = {
  [ids.unknownPersonal]: { id: ids.unknownPersonal, type: "chat", body: "Yes. What is the login details", timestamp: OLD, from: unknownChat, chatId: unknownChat, fromMe: false, isGroupMsg: false },
  [ids.storedGroup]: { id: ids.storedGroup, type: "chat", body: "already here", timestamp: OLD, from: groupChat, author: "8801711000333@c.us", chatId: groupChat, fromMe: false, isGroupMsg: true },
  [ids.sticker]: { id: ids.sticker, type: "sticker", body: "", timestamp: OLD + 1, from: unknownChat, chatId: unknownChat, fromMe: false, isGroupMsg: false },
  [ids.encrypted]: { id: ids.encrypted, type: "ciphertext", body: "", timestamp: OLD + 2, from: unknownChat, chatId: unknownChat, fromMe: false, isGroupMsg: false },
  [ids.empty]: { id: ids.empty, type: "chat", body: "", timestamp: OLD + 3, from: unknownChat, chatId: unknownChat, fromMe: false, isGroupMsg: false },
  [ids.young]: { id: ids.young, type: "chat", body: "just now", timestamp: NOW_S - 2, from: unknownChat, chatId: unknownChat, fromMe: false, isGroupMsg: false },
};

/** What WhatsApp Web's message store holds: models with an id carrying the chat (`remote`) and a time. */
const storeModels = [
  { id: { _serialized: ids.unknownPersonal, remote: { _serialized: unknownChat, server: "c.us" } }, t: OLD },
  { id: { _serialized: ids.storedGroup, remote: { _serialized: groupChat, server: "g.us" } }, t: OLD },
  { id: { _serialized: ids.status, remote: { _serialized: "status@broadcast", server: "broadcast" } }, t: OLD },
  { id: { _serialized: ids.sticker, remote: unknownChat }, t: OLD + 1 },
  { id: { _serialized: ids.encrypted, remote: unknownChat }, t: OLD + 2 },
  { id: { _serialized: ids.empty, remote: unknownChat }, t: OLD + 3 },
  { id: { _serialized: ids.young, remote: unknownChat }, t: NOW_S - 2 },
  { id: { _serialized: `false_${unknownChat}_old`, remote: unknownChat }, t: NOW_S - 3 * 3600 }, // outside every window
];

let account: WhatsAppAccount;
const reads: string[] = [];

function provider() {
  const p = new OpenWAProvider(account.id, `sweep-${tag}`, "/tmp/nowhere");
  (p as unknown as { client: unknown }).client = {
    // The page: evaluate runs the provider's in-page function against this fake `Store`. The chat
    // list knows nothing of the unknown sender — exactly the incident.
    getPage: () => ({
      evaluate: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
        const g = globalThis as unknown as { Store?: unknown };
        const before = g.Store;
        g.Store = { Chat: { filter: () => [] }, Msg: { getModelsArray: () => storeModels } };
        try {
          return await fn(...args);
        } finally {
          g.Store = before;
        }
      },
    }),
    getAllGroups: async () => [],
    getAllChats: async () => [],
    getAllMessagesInChat: async () => [],
    getMessageById: async (id: string) => {
      reads.push(id);
      return full[id] ?? null;
    },
  };
  return p;
}

beforeAll(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `Store sweep ${tag}`, status: "CONNECTED", phoneNumber: `88016${digits}` },
  });
  // The group message is already stored; the sweep must leave it alone.
  await prisma.message.create({
    data: {
      accountId: account.id,
      whatsappMessageId: ids.storedGroup,
      chatId: groupChat,
      senderPhone: "8801711000333",
      direction: "INCOMING",
      body: "already here",
      normalizedBody: "already here",
      timestampWa: new Date(OLD * 1000),
      processingStatus: "IGNORED",
    },
  });
});

afterAll(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("selectStoreSweepIds", () => {
  const now = NOW_S * 1000;
  const ref = (id: string, t: number) => ({ id, chatId: "x@c.us", t });
  it("takes unstored, unskipped messages old enough for the live path to have had its turn, oldest first", () => {
    const refs = [ref("c", NOW_S - 100), ref("a", NOW_S - 300), ref("stored", NOW_S - 200), ref("skip", NOW_S - 250), ref("young", NOW_S - 1), ref("a", NOW_S - 300)];
    expect(selectStoreSweepIds(refs, new Set(["stored"]), new Set(["skip"]), now, STORE_SWEEP_MIN_AGE_MS, 10)).toEqual(["a", "c"]);
  });
  it("stops at the read limit", () => {
    const refs = Array.from({ length: 5 }, (_, i) => ref(`m${i}`, NOW_S - 600 + i));
    expect(selectStoreSweepIds(refs, new Set(), new Set(), now, STORE_SWEEP_MIN_AGE_MS, 2)).toEqual(["m0", "m1"]);
  });
});

describe("a message whose chat never shows as active", () => {
  it("is missed by the chat-based reconcile pass — the incident, reproduced", async () => {
    const result = await reconcileRecentMessages(account.id, provider());
    expect(result.recovered).toBe(0);
    expect(await prisma.message.count({ where: { accountId: account.id, whatsappMessageId: ids.unknownPersonal } })).toBe(0);
  });

  it("is stored by the store sweep, exactly once, without reading what it must not", async () => {
    reads.length = 0;
    const first = await sweepMessageStore(account.id, provider());
    expect(first.read).toBe(true);
    expect(first.recovered).toBe(2); // the text, and the sticker (stored as media, as the live path stores it)
    expect(first.failed).toBe(0);
    expect(first.unreadable).toBe(1); // the ciphertext one: nothing to store yet

    const stored = await prisma.message.findMany({ where: { accountId: account.id, chatId: unknownChat }, orderBy: { timestampWa: "asc" } });
    expect(stored.map((m) => m.whatsappMessageId)).toEqual([ids.unknownPersonal, ids.sticker]);
    expect(stored[0]!.groupId).toBeNull();
    expect(stored[0]!.body).toBe("Yes. What is the login details");

    // Never read: the already-stored group message, the status broadcast, the message the live path
    // is still handling, and anything outside the window.
    expect(reads).not.toContain(ids.storedGroup);
    expect(reads).not.toContain(ids.status);
    expect(reads).not.toContain(ids.young);
    expect(reads.some((id) => id.endsWith("_old"))).toBe(false);

    // Outside the automation window: stored, nothing answered.
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(0);

    // A second pass stores nothing twice and does not re-read the empty message; the encrypted one is
    // tried again, since it may have decrypted since.
    reads.length = 0;
    const second = await sweepMessageStore(account.id, provider());
    expect(second.recovered).toBe(0);
    expect(reads).toEqual([ids.encrypted]);
    expect(await prisma.message.count({ where: { accountId: account.id, chatId: unknownChat } })).toBe(2);
  });
});
