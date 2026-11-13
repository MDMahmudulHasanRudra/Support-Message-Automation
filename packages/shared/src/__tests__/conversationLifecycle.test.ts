import { describe, expect, it } from "vitest";
import {
  channelStatusOf,
  channelStorageOf,
  CONVERSATION_STATUSES,
  decideTransition,
  DEFAULT_LIFECYCLE_POLICY,
  presenceKey,
  snoozeHasEnded,
  statusAfterCustomerMessage,
  whatsAppConversationType,
} from "../conversationLifecycle.js";

const NOW = new Date("2026-11-06T10:00:00Z");
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

describe("decideTransition", () => {
  it("allows the working moves and names the event each writes", () => {
    expect(decideTransition("OPEN", { to: "PENDING" }, NOW)).toMatchObject({ ok: true, to: "PENDING", event: "PENDING" });
    expect(decideTransition("OPEN", { to: "RESOLVED" }, NOW)).toMatchObject({ ok: true, to: "RESOLVED", event: "RESOLVE" });
    expect(decideTransition("PENDING", { to: "RESOLVED" }, NOW)).toMatchObject({ ok: true, event: "RESOLVE" });
    expect(decideTransition("RESOLVED", { to: "OPEN" }, NOW)).toMatchObject({ ok: true, to: "OPEN", event: "REOPEN" });
    expect(decideTransition("SNOOZED", { to: "OPEN" }, NOW)).toMatchObject({ ok: true, to: "OPEN", event: "UNSNOOZE", snoozedUntil: null });
    expect(decideTransition("OPEN", { to: "SNOOZED", until: inMinutes(60) }, NOW)).toMatchObject({ ok: true, to: "SNOOZED", snoozedUntil: inMinutes(60) });
    // Re-snoozing to a new time is allowed.
    expect(decideTransition("SNOOZED", { to: "SNOOZED", until: inMinutes(120) }, NOW).ok).toBe(true);
  });

  it("refuses no-ops, moves out of RESOLVED other than reopening, and bad snooze times", () => {
    for (const status of ["OPEN", "PENDING", "RESOLVED"] as const) expect(decideTransition(status, { to: status }, NOW).ok).toBe(false);
    expect(decideTransition("RESOLVED", { to: "PENDING" }, NOW).ok).toBe(false);
    expect(decideTransition("RESOLVED", { to: "SNOOZED", until: inMinutes(60) }, NOW).ok).toBe(false);
    expect(decideTransition("OPEN", { to: "SNOOZED", until: inMinutes(0) }, NOW).ok).toBe(false);
    expect(decideTransition("OPEN", { to: "SNOOZED", until: inMinutes(91 * 24 * 60) }, NOW).ok).toBe(false);
    expect(decideTransition("OPEN", { to: "SNOOZED", until: new Date("nonsense") }, NOW).ok).toBe(false);
  });
});

describe("statusAfterCustomerMessage", () => {
  it("reopens pending always, snoozed and resolved per the policy, and leaves open alone", () => {
    expect(statusAfterCustomerMessage("PENDING", DEFAULT_LIFECYCLE_POLICY)).toBe("OPEN");
    expect(statusAfterCustomerMessage("SNOOZED", DEFAULT_LIFECYCLE_POLICY)).toBe("OPEN");
    expect(statusAfterCustomerMessage("RESOLVED", DEFAULT_LIFECYCLE_POLICY)).toBe("OPEN");
    expect(statusAfterCustomerMessage("OPEN", DEFAULT_LIFECYCLE_POLICY)).toBeNull();
    const keep = { reopenResolvedOnCustomerMessage: false, reopenSnoozedOnCustomerMessage: false };
    expect(statusAfterCustomerMessage("RESOLVED", keep)).toBeNull();
    expect(statusAfterCustomerMessage("SNOOZED", keep)).toBeNull();
    expect(statusAfterCustomerMessage("PENDING", keep)).toBe("OPEN");
  });
});

describe("snooze, channel storage and conversation type", () => {
  it("a snooze ends at its time and not before", () => {
    expect(snoozeHasEnded("SNOOZED", inMinutes(-1), NOW)).toBe(true);
    expect(snoozeHasEnded("SNOOZED", inMinutes(1), NOW)).toBe(false);
    expect(snoozeHasEnded("OPEN", inMinutes(-1), NOW)).toBe(false);
  });

  it("channel CLOSED is RESOLVED, both ways, for every status", () => {
    expect(channelStatusOf("CLOSED")).toBe("RESOLVED");
    for (const s of CONVERSATION_STATUSES) expect(channelStatusOf(channelStorageOf(s))).toBe(s);
  });

  it("the type comes from WhatsApp's own chat domains", () => {
    expect(whatsAppConversationType("12036-1@g.us")).toBe("GROUP");
    expect(whatsAppConversationType("8801711000000@c.us")).toBe("PERSONAL");
    expect(whatsAppConversationType("12345678901234@lid")).toBe("PERSONAL");
    expect(whatsAppConversationType("status@broadcast")).toBeNull();
  });
});

describe("presenceKey", () => {
  it("is one key for a WhatsApp group whichever of our numbers opened it, and per number for a personal chat", () => {
    const group = "120363000000000001@g.us";
    expect(presenceKey({ kind: "whatsapp", accountId: "a1", chatId: group })).toBe(presenceKey({ kind: "whatsapp", accountId: "a2", chatId: group }));
    const person = "8801700000000@c.us";
    expect(presenceKey({ kind: "whatsapp", accountId: "a1", chatId: person })).not.toBe(presenceKey({ kind: "whatsapp", accountId: "a2", chatId: person }));
    expect(presenceKey({ kind: "channel", conversationId: "c1" })).toBe("ch:c1");
  });
});
