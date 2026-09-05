import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { WhatsAppAccount } from "@prisma/client";
import { enqueueNotification } from "../notifications/enqueueNotification.js";
import { getEventDelivery, resolveWhatsAppDestinations } from "../notifications/eventSettings.js";

/**
 * The Notification Center decides whether an alert is raised at all, which makes it the one place
 * in this module where a bug is silent: a suppressed escalation looks exactly like a quiet day.
 *
 * So these test the two directions separately and equally — that muting genuinely stops a
 * notification being written, and that every path which is NOT explicitly muted still delivers,
 * including when the settings row is missing entirely or the lookup fails.
 */

let account: WhatsAppAccount;
const touchedEvents: Array<"UNKNOWN_PATTERN" | "SUPPORT_ESCALATION" | "AI_HUMAN_FALLBACK"> = [];

beforeAll(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `Notif Test ${randomUUID()}`, status: "CONNECTED" },
  });
});

afterEach(async () => {
  await prisma.notification.deleteMany({ where: { accountId: account.id } });
  if (touchedEvents.length) {
    await prisma.notificationEventSetting.deleteMany({ where: { event: { in: touchedEvents } } });
    touchedEvents.length = 0;
  }
});

afterAll(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => {});
  await prisma.$disconnect();
});

async function configure(
  event: "UNKNOWN_PATTERN" | "SUPPORT_ESCALATION" | "AI_HUMAN_FALLBACK",
  data: { enabled?: boolean; sendToTeams?: boolean; sendToWhatsApp?: boolean; whatsappGroupIds?: string[] },
) {
  touchedEvents.push(event);
  await prisma.notificationEventSetting.upsert({
    where: { event },
    update: data,
    create: { event, ...data },
  });
}

const raise = (event: "UNKNOWN_PATTERN" | "SUPPORT_ESCALATION" | "AI_HUMAN_FALLBACK", type: "WHATSAPP" | "TEAMS" = "WHATSAPP") =>
  enqueueNotification({
    type,
    event,
    destination: type === "WHATSAPP" ? "123@g.us" : "https://example.invalid/hook",
    accountId: type === "WHATSAPP" ? account.id : null,
    payload: { body: "test" },
  });

describe("an event with no settings row behaves exactly as before the Notification Center", () => {
  it("is delivered", async () => {
    // The module has to be additive. A deployment that never opens the page must not lose alerts.
    const result = await raise("UNKNOWN_PATTERN");
    expect(result.suppressed).toBeUndefined();
    expect(await prisma.notification.count({ where: { accountId: account.id } })).toBe(1);
  });

  it("falls back to the global destinations", async () => {
    const delivery = await getEventDelivery("UNKNOWN_PATTERN");
    expect(resolveWhatsAppDestinations(delivery, ["global-a@g.us", "global-b@g.us"])).toEqual([
      "global-a@g.us",
      "global-b@g.us",
    ]);
  });
});

describe("muting", () => {
  it("writes nothing at all when the event is disabled", async () => {
    // Not "writes a row and skips delivery" — that would leave the log full of things that never
    // went, which is its own kind of lie.
    await configure("UNKNOWN_PATTERN", { enabled: false });
    const result = await raise("UNKNOWN_PATTERN");

    expect(result.suppressed).toBe(true);
    expect(await prisma.notification.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("mutes one event without touching another", async () => {
    // The whole point of the module: silence the noisy alert, keep the one that matters.
    await configure("UNKNOWN_PATTERN", { enabled: false });

    await raise("UNKNOWN_PATTERN");
    await raise("SUPPORT_ESCALATION");

    const rows = await prisma.notification.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe("SUPPORT_ESCALATION");
  });
});

describe("per-channel switches", () => {
  it("suppresses WhatsApp while leaving Teams alone", async () => {
    await configure("AI_HUMAN_FALLBACK", { sendToWhatsApp: false, sendToTeams: true });

    expect((await raise("AI_HUMAN_FALLBACK", "WHATSAPP")).suppressed).toBe(true);
    expect((await raise("AI_HUMAN_FALLBACK", "TEAMS")).suppressed).toBeUndefined();

    const rows = await prisma.notification.findMany({ where: { event: "AI_HUMAN_FALLBACK" } });
    expect(rows.every((row) => row.type === "TEAMS")).toBe(true);
  });

  it("suppresses Teams while leaving WhatsApp alone", async () => {
    await configure("AI_HUMAN_FALLBACK", { sendToWhatsApp: true, sendToTeams: false });

    expect((await raise("AI_HUMAN_FALLBACK", "TEAMS")).suppressed).toBe(true);
    expect((await raise("AI_HUMAN_FALLBACK", "WHATSAPP")).suppressed).toBeUndefined();
  });
});

describe("per-event routing", () => {
  it("uses the event's own groups when it has them", async () => {
    await configure("SUPPORT_ESCALATION", { whatsappGroupIds: ["escalations@g.us"] });
    const delivery = await getEventDelivery("SUPPORT_ESCALATION");

    expect(resolveWhatsAppDestinations(delivery, ["global@g.us"])).toEqual(["escalations@g.us"]);
  });

  it("treats an empty list as 'not configured', not as 'send nowhere'", async () => {
    // Those are different intentions and only the first should inherit. Reading an empty array as
    // "deliver to no one" would silently break every event an admin merely opened and saved.
    await configure("SUPPORT_ESCALATION", { whatsappGroupIds: [] });
    const delivery = await getEventDelivery("SUPPORT_ESCALATION");

    expect(delivery.whatsappGroupIds).toBeNull();
    expect(resolveWhatsAppDestinations(delivery, ["global@g.us"])).toEqual(["global@g.us"]);
  });
});

describe("the event is recorded on the notification", () => {
  it("stores why the alert was raised, not just where it went", async () => {
    // The gap the module was built to close: NotificationType was the channel, so nothing recorded
    // the reason, and per-event routing, muting and reporting were all impossible.
    await raise("SUPPORT_ESCALATION");
    const row = await prisma.notification.findFirstOrThrow({ where: { accountId: account.id } });

    expect(row.event).toBe("SUPPORT_ESCALATION");
    expect(row.type).toBe("WHATSAPP");
  });
});
