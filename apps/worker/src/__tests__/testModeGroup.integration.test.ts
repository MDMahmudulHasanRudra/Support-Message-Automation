import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AutomationSettings, WhatsAppAccount } from "@prisma/client";
import { checkAutoReplySafety } from "../pipeline/safety.js";

/**
 * `WhatsAppGroup.testModeEnabled` lets an approved test group exercise every message and rule type
 * back-to-back, without waiting out cooldowns and per-hour caps.
 *
 * These tests exist to pin the *boundary* rather than the convenience. Test mode lifts throttles;
 * it must never lift a safety mechanism, because the WhatsApp number serving the test groups is
 * the same number serving every real customer, and because the project's own written testing
 * policy says membership verification, the queue, idempotency, the kill switch and the
 * monitored-group policy all stay active during test-group testing.
 *
 * Every assertion below is therefore one of two shapes: "the throttle is lifted here" or
 * "this is still enforced here".
 */

let account: WhatsAppAccount;
let settings: AutomationSettings;
const createdGroupIds: string[] = [];

const PHONE_PREFIX = String(randomInt(100_000, 999_999));
let phoneSequence = 0;
function uniquePhone(): string {
  return `+8809${PHONE_PREFIX}${String(++phoneSequence).padStart(4, "0")}`;
}

async function makeGroup(testModeEnabled: boolean, isMonitored = true) {
  const group = await prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: `${randomUUID().replace(/-/g, "").slice(0, 12)}-1234567890@g.us`,
      name: `Test Mode Group ${randomUUID()}`,
      isMonitored,
      isActive: true,
      testModeEnabled,
    },
  });
  createdGroupIds.push(group.id);
  return group;
}

/** Settings with every throttle set to zero-tolerance, so any un-exempted check must block. */
function throttledSettings(overrides: Partial<AutomationSettings> = {}): AutomationSettings {
  return {
    ...settings,
    automationEnabled: true,
    mode: "SAFE_AUTO_REPLY",
    rateLimitingEnabled: true,
    maxRepliesPerClientPerHour: 0,
    maxRepliesPerClientPerDay: 0,
    globalMaxPerMinute: 0,
    globalMaxPerHour: 0,
    globalMaxPerDay: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `Test Mode Account ${randomUUID()}`, status: "CONNECTED" },
  });
  settings = await prisma.automationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
});

afterEach(async () => {
  if (createdGroupIds.length) {
    await prisma.whatsAppGroup.deleteMany({ where: { id: { in: createdGroupIds } } });
    createdGroupIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => {});
  await prisma.$disconnect();
});

describe("test mode lifts the throttles", () => {
  it("allows a reply when every rate limit is already exhausted", async () => {
    const group = await makeGroup(true);
    const result = await checkAutoReplySafety({
      accountId: account.id,
      toPhone: uniquePhone(),
      groupId: group.id,
      rule: null,
      cooldownSeconds: null,
      settings: throttledSettings(),
    });
    expect(result.allowed, result.reason).toBe(true);
  });

  it("ignores an active cooldown", async () => {
    const group = await makeGroup(true);
    const result = await checkAutoReplySafety({
      accountId: account.id,
      toPhone: uniquePhone(),
      groupId: group.id,
      rule: null,
      // An hour-long cooldown would make testing anything twice impossible.
      cooldownSeconds: 3600,
      settings: throttledSettings(),
    });
    expect(result.allowed, result.reason).toBe(true);
  });

  it("lets a rule type run that SAFE_AUTO_REPLY would otherwise hold back", async () => {
    // Without this, most rule types can never be exercised at all — which is the whole point of
    // having a test group.
    const group = await makeGroup(true);
    const result = await checkAutoReplySafety({
      accountId: account.id,
      toPhone: uniquePhone(),
      groupId: group.id,
      rule: { id: "r1", type: "GENERIC" } as never,
      cooldownSeconds: null,
      settings: throttledSettings({ mode: "SAFE_AUTO_REPLY" }),
    });
    expect(result.allowed, result.reason).toBe(true);
  });
});

describe("test mode does not lift anything that protects the account", () => {
  it("still obeys the kill switch", async () => {
    const group = await makeGroup(true);
    const result = await checkAutoReplySafety({
      accountId: account.id,
      toPhone: uniquePhone(),
      groupId: group.id,
      rule: null,
      cooldownSeconds: null,
      settings: throttledSettings({ automationEnabled: false }),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/kill switch/i);
  });

  it("still obeys MANUAL_ONLY", async () => {
    // MANUAL_ONLY is an operator saying "send nothing" — a kill switch, not a throttle.
    const group = await makeGroup(true);
    const result = await checkAutoReplySafety({
      accountId: account.id,
      toPhone: uniquePhone(),
      groupId: group.id,
      rule: null,
      cooldownSeconds: null,
      settings: throttledSettings({ mode: "MANUAL_ONLY" }),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/MANUAL_ONLY/i);
  });

  it("still requires the group to be monitored", async () => {
    // Being unmonitored means this system was never invited to automate the conversation. That is
    // a different thing from a throttle, and marking a group as a test group must not override it.
    const group = await makeGroup(true, false);
    const result = await checkAutoReplySafety({
      accountId: account.id,
      toPhone: uniquePhone(),
      groupId: group.id,
      rule: null,
      cooldownSeconds: null,
      settings: throttledSettings(),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not a monitored conversation/i);
  });

  it("still requires a destination", async () => {
    const group = await makeGroup(true);
    const result = await checkAutoReplySafety({
      accountId: account.id,
      toPhone: "",
      groupId: group.id,
      rule: null,
      cooldownSeconds: null,
      settings: throttledSettings(),
    });
    expect(result.allowed).toBe(false);
  });
});

describe("an ordinary group is unaffected", () => {
  it("is still blocked by an exhausted rate limit", async () => {
    // The exemption must be scoped to the flagged group, never leak into normal traffic.
    const group = await makeGroup(false);
    const result = await checkAutoReplySafety({
      accountId: account.id,
      toPhone: uniquePhone(),
      groupId: group.id,
      rule: null,
      cooldownSeconds: null,
      settings: throttledSettings(),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/limit reached/i);
  });

  it("is still blocked by SAFE_AUTO_REPLY for an ineligible rule type", async () => {
    const group = await makeGroup(false);
    const result = await checkAutoReplySafety({
      accountId: account.id,
      toPhone: uniquePhone(),
      groupId: group.id,
      rule: { id: "r1", type: "GENERIC" } as never,
      cooldownSeconds: null,
      settings: { ...throttledSettings(), rateLimitingEnabled: false },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/SAFE_AUTO_REPLY/i);
  });

  it("a direct message with no group is still rate limited", async () => {
    // No group means no flag to read, so the throttles must apply — the absence of a group must
    // never be mistaken for an exemption.
    const result = await checkAutoReplySafety({
      accountId: account.id,
      toPhone: uniquePhone(),
      groupId: null,
      rule: null,
      cooldownSeconds: null,
      settings: throttledSettings(),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/limit reached/i);
  });
});
