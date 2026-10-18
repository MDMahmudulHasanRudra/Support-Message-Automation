import "./helpers/requireTestDatabase.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./helpers/projectFixtures.js";
import { ProviderRegistry } from "../provider/ProviderRegistry.js";
import type { MessageUpdateEvent, RawIncomingMessage } from "../pipeline/types.js";
import { MockProvider } from "./mockProvider.js";

/**
 * An account the registry failed to connect must still collect once something else connects it.
 *
 * The registry wired the message handler only AFTER `connectWithRetry` succeeded. When the automatic
 * connect gave up — a QR nobody scanned at boot, or (the common case) an operator pressing Connect,
 * whose RECONNECT abandons the registry's own attempt so the registry runs out of tries first — it
 * returned early, kept the provider registered, and never called `connectAccount` for that account
 * again. The operator's RECONNECT then connected the SAME provider, which had no handler: CONNECTED,
 * sends working, and no message, receipt or deletion pushed in until the worker restarted. Only the
 * ten-minute reconcile sweep brought messages in, late.
 *
 * `subscribeToMessages` is documented as safe before connect: `connect()` attaches whatever handler
 * the provider holds. So the handlers are recorded first, whatever the connect does.
 */

process.env.WHATSAPP_CONNECT_RETRY_DELAYS_MS = "0,0";

let accountId: string;

beforeEach(async () => {
  accountId = (await prisma.whatsAppAccount.create({ data: { label: `Registry listener ${randomUUID()}`, status: "DISCONNECTED" } })).id;
});

afterEach(async () => {
  await prisma.whatsAppAccount.deleteMany({ where: { id: accountId } });
});

class RecordingProvider extends MockProvider {
  messageHandler: ((message: RawIncomingMessage) => void) | null = null;
  updateHandler: ((update: MessageUpdateEvent) => void) | null = null;
  failConnects = true;
  override subscribeToMessages(handler: (message: RawIncomingMessage) => void): void {
    this.messageHandler = handler;
  }
  subscribeToMessageUpdates(handler: (update: MessageUpdateEvent) => void): void {
    this.updateHandler = handler;
  }
  override async connect(): Promise<void> {
    this.connectAttempts += 1;
    if (this.failConnects) throw new Error("no code was produced");
  }
}

describe("the registry wires an account's handlers whatever its first connect does", () => {
  it("an account whose automatic connect gave up still has its handlers when a later connect succeeds", async () => {
    const provider = new RecordingProvider();
    const registry = new ProviderRegistry(() => provider);

    const connected = await registry.connectAccount({ id: accountId, sessionId: "s", sessionDataPath: "/tmp/never-used" });

    expect(connected).toBe(false);
    expect(provider.connectAttempts).toBe(3); // the automatic path really did give up
    expect(registry.get(accountId)).toBe(provider); // and kept the provider, so it is never called again
    // What a RECONNECT command connects later is this same provider: it must already be listening.
    expect(provider.messageHandler).not.toBeNull();
    expect(provider.updateHandler).not.toBeNull();
  });

  it("a successful first connect is wired exactly as before", async () => {
    const provider = new RecordingProvider();
    provider.failConnects = false;
    const registry = new ProviderRegistry(() => provider);

    expect(await registry.connectAccount({ id: accountId, sessionId: "s", sessionDataPath: "/tmp/never-used" })).toBe(true);
    expect(provider.messageHandler).not.toBeNull();
    expect(provider.updateHandler).not.toBeNull();
  });
});
