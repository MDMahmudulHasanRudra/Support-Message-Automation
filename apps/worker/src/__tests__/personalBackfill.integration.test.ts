import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WhatsAppAccount } from "@prisma/client";
import { prisma } from "./helpers/projectFixtures.js";
import { ProviderRegistry } from "../provider/ProviderRegistry.js";
import type { RawIncomingMessage } from "../pipeline/types.js";
import { MockProvider } from "./mockProvider.js";

/**
 * The one-time personal-message backfill (PERSONAL_MESSAGES_RUNBOOK.md). What must hold:
 * - a dry run writes NOTHING — no message, no file — and counts what WhatsApp holds, what is stored,
 *   what could be recovered and what cannot be read;
 * - a write run stores only what is missing, store-only: no reply queued, no rule run, no
 *   notification, no wait opened; a second run stores nothing twice;
 * - only personal chats, only the requested account (in its own project), only the date range;
 * - a chat whose read did not reach the start of the range is PARTIAL, a failing chat is retried
 *   once then reported without stopping the others, and a cancel stops after the chat in progress;
 * - an interrupted write run resumes from its checkpoint file.
 */

process.env.PERSONAL_BACKFILL_PAUSE_MS = "0";
const backfill = await import("../pipeline/personalBackfill.js");

const MINUTE = 60_000;
const NOW = Date.now();
const FROM = new Date(NOW - 3 * 24 * 60 * MINUTE);
let account: WhatsAppAccount;
let provider: MockProvider;
let registry: ProviderRegistry;
let sessionDir: string;
const digits = () => `8801${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;

function msg(chatId: string, minutesAgo: number, fields: Partial<RawIncomingMessage> = {}): RawIncomingMessage {
  return {
    accountId: account.id,
    whatsappMessageId: `false_${chatId}_${randomUUID()}`,
    chatId,
    whatsappGroupId: null,
    senderPhone: chatId.split("@")[0]!,
    senderJid: chatId,
    senderName: null,
    direction: "INCOMING",
    body: "amar line kaj korche na",
    timestampWa: new Date(NOW - minutesAgo * MINUTE),
    quotedWhatsappMessageId: null,
    mentionedPhones: [],
    ...fields,
  };
}

function request(mode: "DRY_RUN" | "WRITE", overrides: Partial<Parameters<typeof backfill.startPersonalBackfill>[1]> = {}) {
  return { accountId: account.id, from: FROM, to: new Date(NOW), mode, maxChats: 500, earlierPages: 2, ...overrides };
}

async function runToEnd(mode: "DRY_RUN" | "WRITE", overrides = {}) {
  const started = backfill.startPersonalBackfill(registry, request(mode, overrides));
  expect(started.ok).toBe(true);
  await backfill.waitForPersonalBackfill();
  return backfill.readPersonalBackfill()!;
}

const rowsOf = (chatId: string) => prisma.message.findMany({ where: { accountId: account.id, chatId } });

beforeEach(async () => {
  backfill.resetPersonalBackfillForTests();
  sessionDir = await mkdtemp(join(tmpdir(), "personal-backfill-"));
  account = await prisma.whatsAppAccount.create({
    data: { label: `Backfill ${randomUUID()}`, status: "CONNECTED", phoneNumber: digits(), sessionDataPath: sessionDir, sessionId: `s-${randomUUID()}` },
  });
  provider = new MockProvider();
  registry = new ProviderRegistry(() => provider);
  registry.registerForTesting(account.id, provider);
});

afterEach(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => undefined);
  await rm(sessionDir, { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a dry run", () => {
  it("counts what WhatsApp holds, what is stored and what could be recovered — and writes nothing", async () => {
    const chat = `${digits()}@c.us`;
    const lid = `${String(Date.now()).slice(-9)}123456@lid`;
    const stored = msg(chat, 60);
    await prisma.message.create({
      data: {
        accountId: account.id, chatId: chat, whatsappMessageId: stored.whatsappMessageId, senderPhone: stored.senderPhone,
        direction: "INCOMING", body: stored.body, normalizedBody: stored.body, timestampWa: stored.timestampWa,
      },
    });
    provider.backfillPersonalChats = [
      { id: chat, t: Math.floor(NOW / 1000) },
      { id: lid, t: Math.floor(NOW / 1000) - 60 },
      { id: "120363000000000000@g.us", t: Math.floor(NOW / 1000) }, // a group: never touched
    ];
    provider.chatHistory.set(chat, {
      ok: true,
      undecrypted: 1,
      reachedSince: true,
      earlierPagesLoaded: 0,
      messages: [stored, msg(chat, 30), msg(chat, 20, { body: "" }), msg(chat, 10, { revoked: true, body: "" }), msg(chat, 5 * 24 * 60)],
    });
    provider.chatHistory.set(lid, { ok: true, undecrypted: 0, reachedSince: false, earlierPagesLoaded: 2, messages: [msg(lid, 15)] });

    const state = await runToEnd("DRY_RUN");

    expect(state.status).toBe("COMPLETED");
    expect(state.totals).toMatchObject({
      chatsFound: 2,
      chatsDone: 2,
      chatsPartial: 1,
      // chat: stored + 1 readable + 1 empty + 1 deleted (the 5-day-old one is outside the range) + 1 encrypted; lid: 1
      available: 6,
      alreadyStored: 1,
      recoverable: 2,
      unreadable: 2,
      deleted: 1,
      stored: 0,
    });
    expect(provider.historyReads.sort()).toEqual([chat, lid].sort());
    expect(await rowsOf(chat)).toHaveLength(1); // only the one that was already there
    expect(await rowsOf(lid)).toHaveLength(0);
    expect(await readdir(sessionDir)).toEqual([]); // not even a progress file
  });
});

describe("a write run", () => {
  it("stores only what is missing, store-only, and never twice", async () => {
    const chat = `${digits()}@c.us`;
    const recent = msg(chat, 2); // even a minute-old message is only stored, never answered
    provider.backfillPersonalChats = [{ id: chat, t: Math.floor(NOW / 1000) }];
    provider.chatHistory.set(chat, { ok: true, undecrypted: 0, reachedSince: true, earlierPagesLoaded: 0, messages: [msg(chat, 90), recent] });
    const outboundBefore = await prisma.outboundMessage.count({ where: { accountId: account.id } });
    const notificationsBefore = await prisma.notification.count();

    const first = await runToEnd("WRITE");
    expect(first.totals).toMatchObject({ recoverable: 2, stored: 2, alreadyStored: 0 });
    const rows = await rowsOf(chat);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.processingStatus === "IGNORED" && row.groupId === null && row.loadedFromHistoryAt !== null)).toBe(true);
    expect(rows.every((row) => row.projectId === account.projectId)).toBe(true);
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(outboundBefore);
    expect(await prisma.automationExecution.count({ where: { messageId: { in: rows.map((r) => r.id) } } })).toBe(0);
    expect(await prisma.notification.count()).toBe(notificationsBefore);

    // Same range again: everything is already there. (A new range, so the checkpoint does not answer it.)
    const again = await runToEnd("WRITE", { from: new Date(FROM.getTime() + 1) });
    expect(again.totals).toMatchObject({ alreadyStored: 2, recoverable: 0, stored: 0 });
    expect(await rowsOf(chat)).toHaveLength(2);
  });

  it("retries a failing chat once, reports it, and carries on; the next run resumes and retries only that chat", async () => {
    const [a, b, c] = [`${digits()}1@c.us`, `${digits()}2@c.us`, `${digits()}3@c.us`];
    provider.backfillPersonalChats = [a, b, c].map((id, i) => ({ id, t: Math.floor(NOW / 1000) - i }));
    for (const id of [a, c]) provider.chatHistory.set(id, { ok: true, undecrypted: 0, reachedSince: true, earlierPagesLoaded: 0, messages: [msg(id, 40)] });
    let calls = 0;
    provider.chatHistory.set(b, async () => {
      calls += 1;
      return { ok: false, reason: "Protocol error: Target closed" };
    });

    const first = await runToEnd("WRITE");
    expect(calls).toBe(2); // one retry
    expect(first.totals).toMatchObject({ chatsDone: 2, chatsFailed: 1, stored: 2 });

    provider.chatHistory.set(b, { ok: true, undecrypted: 0, reachedSince: true, earlierPagesLoaded: 0, messages: [msg(b, 40)] });
    provider.historyReads = [];
    const second = await runToEnd("WRITE");
    expect(provider.historyReads).toEqual([b]); // a and c came from the checkpoint
    expect(second.totals).toMatchObject({ chatsResumed: 2, chatsDone: 3, chatsFailed: 0 });
    expect(await rowsOf(b)).toHaveLength(1);
  });

  it("stops after the chat in progress when cancelled", async () => {
    const chats = Array.from({ length: 5 }, (_, i) => `${digits()}${i}@c.us`);
    provider.backfillPersonalChats = chats.map((id, i) => ({ id, t: Math.floor(NOW / 1000) - i }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.chatHistory.set(chats[0]!, async () => {
      await gate;
      return { ok: true, undecrypted: 0, reachedSince: true, earlierPagesLoaded: 0, messages: [msg(chats[0]!, 40)] };
    });

    backfill.startPersonalBackfill(registry, request("WRITE"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backfill.cancelPersonalBackfill()).toBe(true);
    release();
    await backfill.waitForPersonalBackfill();

    const state = backfill.readPersonalBackfill()!;
    expect(state.status).toBe("CANCELLED");
    expect(state.totals.chatsDone).toBe(1);
    expect(provider.historyReads).toEqual([chats[0]]);
  });
});

describe("refusals", () => {
  it("only one run at a time", async () => {
    provider.backfillPersonalChats = [{ id: `${digits()}@c.us`, t: Math.floor(NOW / 1000) }];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.chatHistory.set(provider.backfillPersonalChats[0]!.id, async () => {
      await gate;
      return { ok: true, undecrypted: 0, reachedSince: true, earlierPagesLoaded: 0, messages: [] };
    });
    expect(backfill.startPersonalBackfill(registry, request("DRY_RUN")).ok).toBe(true);
    expect(backfill.startPersonalBackfill(registry, request("DRY_RUN")).ok).toBe(false);
    release();
    await backfill.waitForPersonalBackfill();
  });

  it("fails clearly for an account this worker is not connected to", async () => {
    provider.connectionStatus = "DISCONNECTED";
    const state = await runToEnd("DRY_RUN");
    expect(state.status).toBe("FAILED");
    expect(state.error).toMatch(/not connected/i);
  });
});

describe("the request", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const parse = (query: string) => backfill.parseBackfillRequest(new URLSearchParams(query), now);

  it("is a dry run unless a write is asked for AND confirmed", () => {
    expect(parse("account=a&from=2026-10-15")).toMatchObject({ ok: true, request: { mode: "DRY_RUN", maxChats: 500, earlierPages: 2 } });
    expect(parse("account=a&from=2026-10-15&mode=write").ok).toBe(false);
    expect(parse("account=a&from=2026-10-15&mode=write&confirm=WRITE")).toMatchObject({ ok: true, request: { mode: "WRITE" } });
  });

  it("is bounded: an account, a past range of at most 14 days, capped chats and pages", () => {
    expect(parse("from=2026-10-15").ok).toBe(false);
    expect(parse("account=a&from=2026-09-01").ok).toBe(false);
    expect(parse("account=a&from=2026-10-15&to=2026-10-14").ok).toBe(false);
    expect(parse("account=a&from=2026-10-15&to=2026-10-30").ok).toBe(false);
    expect(parse("account=a&from=2026-10-15&maxChats=999999&earlierPages=99")).toMatchObject({ ok: true, request: { maxChats: 2000, earlierPages: 10 } });
    expect(parse("account=a&from=2026-10-15&maxChats=0").ok).toBe(false);
  });
});
