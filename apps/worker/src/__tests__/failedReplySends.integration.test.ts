import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, inIsp, ISP_DIGITAL } from "./helpers/projectFixtures.js";
import { processOne, recoverStuckOutboundMessages, UNCERTAIN_STRANDED_REASON } from "../queue/outboundQueueProcessor.js";
import type { SendOptions, SendResult } from "../provider/WhatsAppProvider.js";
import { MockProvider } from "./mockProvider.js";

/**
 * The worker's half of Failed Replies (FAILED_REPLIES.md): a send whose outcome is not known is NEVER
 * retried by itself. Three ways an outcome becomes unknown, three tests, and one control:
 *   - the provider answers `uncertain` (a call into WhatsApp Web threw after it began);
 *   - the send throws past the provider;
 *   - the worker dies mid-send, and recovery finds the row PROCESSING with `sendStartedAt` set.
 * The control: a refusal the provider RETURNS (nothing handed over) keeps its automatic retries, unstamped,
 * and a row stranded BEFORE the hand-over still goes back to PENDING, exactly as before.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let accountId = "";
const ids: string[] = [];
const chatId = `frs-${tag}@g.us`;

class ThrowingProvider extends MockProvider {
  public calls = 0;
  async sendMessage(_chatId: string, _body: string, _mentions?: string[], _options?: SendOptions): Promise<SendResult> {
    this.calls++;
    throw new Error("Runtime.callFunctionOn timed out");
  }
}

async function queue(extra: Record<string, unknown> = {}) {
  const row = await prisma.outboundMessage.create({
    data: {
      projectId: ISP_DIGITAL,
      accountId,
      chatId,
      toPhone: chatId,
      body: `Hello ${tag}`,
      // A person's reply: the kill switch does not cancel it and a rate limit defers it, so only the send decides.
      actionType: "MANUAL_REPLY",
      idempotencyKey: `frs-${randomUUID()}`,
      scheduledAt: new Date(Date.now() - 60_000),
      ...extra,
    },
  });
  ids.push(row.id);
  return row.id;
}
const row = (id: string) => prisma.outboundMessage.findUniqueOrThrow({ where: { id } });

/** Drains until this row leaves PENDING/PROCESSING (other files' leftovers are processed too). */
async function drain(provider: MockProvider, id: string) {
  for (let i = 0; i < 50; i++) {
    const r = await row(id);
    if (r.status !== "PENDING" && r.status !== "PROCESSING") return r;
    if (r.status === "PENDING" && r.scheduledAt.getTime() > Date.now()) return r; // waiting for a backoff
    if (!(await inIsp(() => processOne(provider)))) break;
  }
  return row(id);
}

beforeAll(async () => {
  accountId = (await prisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `FRS ${tag}`, status: "CONNECTED" } })).id;
});

afterAll(async () => {
  await prisma.outboundMessage.deleteMany({ where: { id: { in: ids } } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: accountId } });
});

describe("an unknown outcome is held for a person", () => {
  it("the provider answering `uncertain` settles FAILED + deliveryUncertain at once — sent once, never again", async () => {
    const provider = new MockProvider();
    provider.nextResult = { success: false, error: "Protocol error (Runtime.callFunctionOn): Target closed", uncertain: true };
    const id = await queue();
    const settled = await drain(provider, id);
    expect(settled).toMatchObject({ status: "FAILED", deliveryUncertain: true, attemptCount: 1 });
    expect(settled.sendStartedAt).not.toBeNull();
    // Draining again does not touch it.
    await drain(provider, id);
    expect(provider.sentMessages.filter((m) => m.chatId === chatId)).toHaveLength(1);
  });

  it("a send that throws past the provider is held the same way", async () => {
    const provider = new ThrowingProvider();
    const id = await queue();
    expect(await drain(provider, id)).toMatchObject({ status: "FAILED", deliveryUncertain: true });
    expect(provider.calls).toBe(1);
  });

  it("the failure text is redacted before it is stored (it is shown on Failed Replies)", async () => {
    const provider = new MockProvider();
    provider.nextResult = { success: false, error: `Evaluation failed for 8801711000222@c.us`, uncertain: true };
    const id = await queue();
    const settled = await drain(provider, id);
    expect(settled.failureReason).toBe("Evaluation failed for [wa-id]");
  });
});

describe("a refusal the provider returned keeps its automatic retries", () => {
  it("goes back to PENDING with a backoff, unstamped and not uncertain", async () => {
    const provider = new MockProvider();
    provider.nextResult = { success: false, error: "Provider is not connected." };
    const id = await queue();
    const after = await drain(provider, id);
    expect(after).toMatchObject({ status: "PENDING", deliveryUncertain: false, sendStartedAt: null, attemptCount: 1 });
    expect(after.scheduledAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("crash recovery", () => {
  it("a row stranded AFTER the hand-over began is held as uncertain; one stranded BEFORE goes back to PENDING", async () => {
    const handedOver = await queue({ status: "PROCESSING", sendStartedAt: new Date(Date.now() - 10 * 60_000) });
    const notYet = await queue({ status: "PROCESSING" });
    await prisma.$executeRaw`UPDATE "OutboundMessage" SET "updatedAt" = now() - interval '1 hour' WHERE id IN (${handedOver}, ${notYet})`;
    await recoverStuckOutboundMessages();
    expect(await row(handedOver)).toMatchObject({ status: "FAILED", deliveryUncertain: true, failureReason: UNCERTAIN_STRANDED_REASON });
    expect(await row(notYet)).toMatchObject({ status: "PENDING", deliveryUncertain: false });
  });

  it("a row still inside the stuck timeout is left alone, stamped or not", async () => {
    const recent = await queue({ status: "PROCESSING", sendStartedAt: new Date() });
    await recoverStuckOutboundMessages();
    expect((await row(recent)).status).toBe("PROCESSING");
  });
});
