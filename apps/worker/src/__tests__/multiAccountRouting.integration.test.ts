import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, resolveWhatsAppAccount, isResolutionError } from "@support-automation/db";
import type { WhatsAppAccount, WhatsAppServiceRoute } from "@prisma/client";
import { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { processOneCommandViaRegistry } from "../commands/commandProcessor.js";
import { processOneViaRegistry as processOneOutboundViaRegistry } from "../queue/outboundQueueProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Coverage for Phase 6's multi-account routing: the centralized resolver (packages/db) and the
 * worker's ProviderRegistry-based dispatch. Runs against the same shared dev Postgres the real
 * worker/dashboard use (see pipeline.integration.test.ts's own doc comment) — deliberately never
 * mutates the real `isPrimary` singleton, since a real worker container may be polling this same
 * database concurrently. Where a test's expected outcome depends on which account is *actually*
 * Primary right now, it reads that state and branches its assertion rather than changing it.
 */

let connectedAccount: WhatsAppAccount;
let disconnectedAccount: WhatsAppAccount;
let originalRoute: WhatsAppServiceRoute | null;

async function currentPrimaryResolution(): Promise<{ accountId: string; accountLabel: string } | { error: string }> {
  const primary = await prisma.whatsAppAccount.findFirst({ where: { isPrimary: true } });
  if (!primary) return { error: "No Primary WhatsApp account is configured" };
  if (primary.status !== "CONNECTED") return { error: "is not connected" };
  return { accountId: primary.id, accountLabel: primary.label };
}

beforeAll(async () => {
  originalRoute = await prisma.whatsAppServiceRoute.findUnique({ where: { serviceKey: "PRIORITY_SUPPORT" } });
});

afterAll(async () => {
  if (originalRoute) {
    await prisma.whatsAppServiceRoute.upsert({
      where: { serviceKey: "PRIORITY_SUPPORT" },
      update: originalRoute,
      create: originalRoute,
    });
  } else {
    await prisma.whatsAppServiceRoute.deleteMany({ where: { serviceKey: "PRIORITY_SUPPORT" } });
  }
});

beforeEach(async () => {
  connectedAccount = await prisma.whatsAppAccount.create({
    data: { label: `Routing Test Connected ${randomUUID()}`, status: "CONNECTED" },
  });
  disconnectedAccount = await prisma.whatsAppAccount.create({
    data: { label: `Routing Test Disconnected ${randomUUID()}`, status: "DISCONNECTED" },
  });
});

afterEach(async () => {
  await prisma.whatsAppServiceRoute.deleteMany({ where: { serviceKey: "PRIORITY_SUPPORT" } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: [connectedAccount.id, disconnectedAccount.id] } } });
});

describe("resolveWhatsAppAccount", () => {
  it("resolves to the explicitly configured account when it is connected", async () => {
    await prisma.whatsAppServiceRoute.create({
      data: { serviceKey: "PRIORITY_SUPPORT", accountId: connectedAccount.id, fallbackPolicy: "PRIMARY_FALLBACK", enabled: true },
    });

    const result = await resolveWhatsAppAccount("PRIORITY_SUPPORT");
    expect(isResolutionError(result)).toBe(false);
    if (!isResolutionError(result)) {
      expect(result.accountId).toBe(connectedAccount.id);
      expect(result.source).toBe("CONFIGURED");
    }
  });

  it("never resolves to a different connected account just because one exists", async () => {
    await prisma.whatsAppServiceRoute.create({
      data: { serviceKey: "PRIORITY_SUPPORT", accountId: connectedAccount.id, fallbackPolicy: "PRIMARY_FALLBACK", enabled: true },
    });
    // A second, unrelated connected account exists in the system at the same time — must never be picked.
    const decoyAccount = await prisma.whatsAppAccount.create({
      data: { label: `Routing Test Decoy ${randomUUID()}`, status: "CONNECTED" },
    });
    try {
      const result = await resolveWhatsAppAccount("PRIORITY_SUPPORT");
      expect(isResolutionError(result)).toBe(false);
      if (!isResolutionError(result)) {
        expect(result.accountId).toBe(connectedAccount.id);
        expect(result.accountId).not.toBe(decoyAccount.id);
      }
    } finally {
      await prisma.whatsAppAccount.delete({ where: { id: decoyAccount.id } });
    }
  });

  it("returns a clear error instead of silently falling back when policy is STRICT_NO_FALLBACK", async () => {
    await prisma.whatsAppServiceRoute.create({
      data: { serviceKey: "PRIORITY_SUPPORT", accountId: disconnectedAccount.id, fallbackPolicy: "STRICT_NO_FALLBACK", enabled: true },
    });

    const result = await resolveWhatsAppAccount("PRIORITY_SUPPORT");
    expect(isResolutionError(result)).toBe(true);
    if (isResolutionError(result)) {
      expect(result.error).toMatch(/unavailable/i);
      expect(result.error).toMatch(/not fall back/i);
    }
  });

  it("falls back to Primary when the configured account is unavailable and policy is PRIMARY_FALLBACK", async () => {
    await prisma.whatsAppServiceRoute.create({
      data: { serviceKey: "PRIORITY_SUPPORT", accountId: disconnectedAccount.id, fallbackPolicy: "PRIMARY_FALLBACK", enabled: true },
    });

    const [result, expected] = await Promise.all([resolveWhatsAppAccount("PRIORITY_SUPPORT"), currentPrimaryResolution()]);
    if ("error" in expected) {
      expect(isResolutionError(result)).toBe(true);
    } else {
      expect(isResolutionError(result)).toBe(false);
      if (!isResolutionError(result)) {
        expect(result.accountId).toBe(expected.accountId);
        expect(result.source).toBe("PRIMARY_FALLBACK");
      }
    }
  });

  it("falls back to Primary when no route is configured for the service at all", async () => {
    const [result, expected] = await Promise.all([resolveWhatsAppAccount("PRIORITY_SUPPORT"), currentPrimaryResolution()]);
    if ("error" in expected) {
      expect(isResolutionError(result)).toBe(true);
    } else {
      expect(isResolutionError(result)).toBe(false);
      if (!isResolutionError(result)) {
        expect(result.accountId).toBe(expected.accountId);
        expect(result.source).toBe("PRIMARY_DEFAULT");
      }
    }
  });

  it("treats a disabled route the same as no route (falls back to Primary)", async () => {
    await prisma.whatsAppServiceRoute.create({
      data: { serviceKey: "PRIORITY_SUPPORT", accountId: connectedAccount.id, fallbackPolicy: "PRIMARY_FALLBACK", enabled: false },
    });

    const [result, expected] = await Promise.all([resolveWhatsAppAccount("PRIORITY_SUPPORT"), currentPrimaryResolution()]);
    if ("error" in expected) {
      expect(isResolutionError(result)).toBe(true);
    } else {
      expect(isResolutionError(result)).toBe(false);
      if (!isResolutionError(result)) {
        expect(result.accountId).not.toBe(connectedAccount.id);
      }
    }
  });

  it("rejects a second Primary account via the database's own partial unique index (never just app-level validation)", async () => {
    // Runs entirely inside a transaction against two brand-new accounts and is never committed —
    // this proves the constraint without ever touching whichever account is really Primary right now.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.whatsAppAccount.create({ data: { label: `Constraint Test A ${randomUUID()}`, isPrimary: true } });
        await tx.whatsAppAccount.create({ data: { label: `Constraint Test B ${randomUUID()}`, isPrimary: true } });
      }),
    ).rejects.toThrow();
  });
});

describe("ProviderRegistry — cross-account isolation", () => {
  it("sends an outbound message through the correct account's provider, never a different one that is also connected", async () => {
    const providerA = new MockProvider();
    const providerB = new MockProvider();
    const registry = new ProviderRegistry();
    registry.registerForTesting(connectedAccount.id, providerA);
    registry.registerForTesting(disconnectedAccount.id, providerB); // status doesn't matter to the registry itself — key is what matters

    const message = await prisma.outboundMessage.create({
      data: {
        accountId: connectedAccount.id,
        chatId: "1234@c.us",
        toPhone: "+8801000000001",
        body: "routed via connectedAccount",
        actionType: "AUTO_REPLY",
        idempotencyKey: randomUUID(),
        status: "PENDING",
        scheduledAt: new Date(Date.now() - 60_000), // see the "defers" test below for why this is explicit
      },
    });

    const handled = await processOneOutboundViaRegistry(registry);
    expect(handled).toBe(true);

    expect(providerA.sentMessages).toEqual([{ chatId: "1234@c.us", body: "routed via connectedAccount" }]);
    expect(providerB.sentMessages).toEqual([]);

    const refreshed = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(refreshed.status).toBe("SENT");
  });

  it("defers (does not fail) a message whose account has no connected provider in this worker", async () => {
    const registry = new ProviderRegistry(); // deliberately empty — simulates an account not yet connected

    const message = await prisma.outboundMessage.create({
      data: {
        accountId: connectedAccount.id,
        chatId: "5678@c.us",
        toPhone: "+8801000000002",
        body: "should defer, not fail",
        actionType: "AUTO_REPLY",
        idempotencyKey: randomUUID(),
        status: "PENDING",
        // Explicit, safely-in-the-past scheduledAt — the DB container's clock runs measurably ahead
        // of the host's in this environment, so relying on the schema's @default(now()) here can
        // make the row not-yet-due by the time the very next line's `new Date()` (host clock) checks it.
        scheduledAt: new Date(Date.now() - 60_000),
      },
    });

    const handled = await processOneOutboundViaRegistry(registry);
    expect(handled).toBe(true);

    const refreshed = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(refreshed.status).toBe("PENDING"); // not FAILED — no send was attempted, so no retry budget spent
    expect(refreshed.attemptCount).toBe(0);
  });

  it("routes a LOGOUT command to the correct account's provider and never touches a different account", async () => {
    const providerA = new MockProvider();
    const providerB = new MockProvider();
    const registry = new ProviderRegistry();
    registry.registerForTesting(connectedAccount.id, providerA);
    registry.registerForTesting(disconnectedAccount.id, providerB);

    await prisma.workerCommand.create({ data: { type: "LOGOUT", accountId: connectedAccount.id } });

    const handled = await processOneCommandViaRegistry(registry);
    expect(handled).toBe(true);

    expect(providerA.loggedOut).toBe(true);
    expect(providerB.loggedOut).toBe(false);

    const refreshedAccountA = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: connectedAccount.id } });
    const refreshedAccountB = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: disconnectedAccount.id } });
    expect(refreshedAccountA.phoneNumber).toBeNull();
    expect(refreshedAccountB.status).toBe("DISCONNECTED"); // untouched
  });

  it("fails a command cleanly (not silently) when its accountId has no connected provider in this worker", async () => {
    const registry = new ProviderRegistry(); // empty

    const command = await prisma.workerCommand.create({ data: { type: "LOGOUT", accountId: connectedAccount.id } });

    const handled = await processOneCommandViaRegistry(registry);
    expect(handled).toBe(true);

    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("FAILED");
  });
});
