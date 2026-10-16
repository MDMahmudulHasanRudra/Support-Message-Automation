import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./helpers/projectFixtures.js";
import type { WhatsAppAccount } from "@prisma/client";
import type { RawIncomingMessage } from "../pipeline/types.js";
import { recordConnectionState } from "../provider/openwa/connectionState.js";
import { catchUpMissedMessages } from "../pipeline/catchUpMissedMessages.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Phase 2, Stage 4 (PHASE2.md): one-to-one messages missed while the worker was not listening are
 * recovered like group messages. The live path has always stored personal messages; the gap sweep
 * read groups only, so a customer who wrote to the number directly during a restart was lost for good.
 *
 * What must hold, all with the catch-up's existing rules unchanged:
 *   - a recovered personal message is stored, against no group, under its own chat;
 *   - one older than the automation window is stored WITHOUT rules (no execution record, IGNORED);
 *   - one inside the window goes through the ordinary pipeline;
 *   - a replay of the same messages stores nothing twice;
 *   - a read that could not check everything records the gap PARTIAL with the reason, never RECOVERED.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;
let account: WhatsAppAccount;
/** Digits only — team-member matching normalises numbers to digits (CLAUDE.md, Testing). */
const customerNumber = () => `8801${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;

function personal(chatId: string, at: Date, body = "amar line kaj korche na"): RawIncomingMessage {
  return {
    accountId: account.id,
    whatsappMessageId: `false_${chatId}_${randomUUID()}`,
    chatId,
    whatsappGroupId: null,
    senderPhone: chatId.split("@")[0]!,
    senderJid: chatId,
    senderName: null,
    direction: "INCOMING",
    body,
    timestampWa: at,
    quotedWhatsappMessageId: null,
    mentionedPhones: [],
  };
}

async function gapThenReconnect(checkpointAgoMs: number) {
  await recordConnectionState(account.id, "DISCONNECTED");
  await prisma.processingCheckpoint.create({ data: { accountId: account.id, lastProcessedTimestampWa: new Date(Date.now() - checkpointAgoMs) } });
  await recordConnectionState(account.id, "CONNECTED");
}

const gap = () => prisma.collectionGap.findFirstOrThrow({ where: { accountId: account.id }, orderBy: { startedAt: "asc" } });

beforeEach(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `Personal catch-up ${randomUUID()}`, status: "CONNECTED", lastConnectedAt: new Date(), phoneNumber: customerNumber() },
  });
});

afterEach(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => undefined);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a personal message missed while the worker was down", () => {
  it("is stored under its own chat, and an old one is recorded without rules", async () => {
    await gapThenReconnect(2 * HOUR);
    const phoneChat = `${customerNumber()}@c.us`;
    const lidChat = `${String(Date.now()).slice(-9)}123456@lid`;
    const old = personal(phoneChat, new Date(Date.now() - HOUR));
    const recent = personal(lidChat, new Date(Date.now() - 2 * MINUTE), "hello, are you there?");
    const provider = new MockProvider();
    provider.missedMessages = [old, recent];

    const result = await catchUpMissedMessages(account.id, provider);

    expect(result).toMatchObject({ offered: 2, stored: 1, automated: 1, duplicates: 0 });
    const rows = await prisma.message.findMany({
      where: { accountId: account.id },
      select: { id: true, whatsappMessageId: true, chatId: true, groupId: true, processingStatus: true, senderJid: true },
    });
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((row) => row.whatsappMessageId === old.whatsappMessageId)!;
    const recentRow = rows.find((row) => row.whatsappMessageId === recent.whatsappMessageId)!;
    expect(oldRow).toMatchObject({ chatId: phoneChat, groupId: null, processingStatus: "IGNORED", senderJid: phoneChat });
    expect(recentRow).toMatchObject({ chatId: lidChat, groupId: null, senderJid: lidChat });

    // Outside the automation window: stored for the record, never evaluated — no decision exists.
    expect(await prisma.automationExecution.count({ where: { messageId: oldRow.id } })).toBe(0);
    // Inside it: the ordinary pipeline ran, exactly as if it had arrived live.
    expect(await prisma.automationExecution.count({ where: { messageId: recentRow.id } })).toBe(1);
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id, relatedMessageId: oldRow.id } })).toBe(0);

    expect(await gap()).toMatchObject({ recoveryStatus: "RECOVERED", recoveredCount: 2, recoveryNote: null });
  });

  it("is stored once, however many times the gap is swept", async () => {
    await gapThenReconnect(2 * HOUR);
    const message = personal(`${customerNumber()}@c.us`, new Date(Date.now() - HOUR));
    const provider = new MockProvider();
    provider.missedMessages = [message];

    await catchUpMissedMessages(account.id, provider);
    // The checkpoint moved past it, so wind it back: a replay must still be refused by the dedup key.
    await prisma.processingCheckpoint.update({ where: { accountId: account.id }, data: { lastProcessedTimestampWa: new Date(Date.now() - 2 * HOUR) } });
    const second = await catchUpMissedMessages(account.id, provider);

    expect(second).toMatchObject({ offered: 1, stored: 0, automated: 0, duplicates: 1 });
    expect(await prisma.message.count({ where: { accountId: account.id, whatsappMessageId: message.whatsappMessageId } })).toBe(1);
  });
});

describe("a sweep that could not check everything", () => {
  it("records the gap PARTIAL with the reason, and still stores what it read", async () => {
    await gapThenReconnect(2 * HOUR);
    const provider = new MockProvider();
    provider.missedMessages = [personal(`${customerNumber()}@c.us`, new Date(Date.now() - HOUR))];
    provider.probeIncomplete = "One-to-one chats could not be listed (Protocol error), so personal messages in this window were not checked.";

    const result = await catchUpMissedMessages(account.id, provider);

    expect(result.stored).toBe(1);
    const row = await gap();
    expect(row.recoveryStatus).toBe("PARTIAL");
    expect(row.recoveredCount).toBe(1);
    expect(row.recoveryNote).toContain("One-to-one chats could not be listed");
  });

  it("keeps every reason when more than one applies", async () => {
    await gapThenReconnect(20 * HOUR);
    const provider = new MockProvider();
    provider.probeIncomplete = "The history of 2 chat(s) could not be read.";

    await catchUpMissedMessages(account.id, provider);

    const row = await gap();
    expect(row.recoveryStatus).toBe("PARTIAL");
    expect(row.recoveryNote).toContain("12 hours");
    expect(row.recoveryNote).toContain("The history of 2 chat(s) could not be read.");
  });
});
