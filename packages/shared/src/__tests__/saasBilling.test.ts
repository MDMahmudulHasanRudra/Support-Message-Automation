import { describe, expect, it } from "vitest";
import {
  addInterval,
  billingNotice,
  dueReminder,
  formatMoneyMinor,
  limitRefusal,
  parseMoneyToMinor,
  parsePlanInput,
  subscriptionState,
  type SubscriptionFacts,
} from "../saasBilling.js";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const base: SubscriptionFacts = {
  startsAt: d("2026-10-01"),
  trialEndsAt: null,
  paidThrough: d("2026-11-01"),
  graceDays: 7,
  autoEnforce: true,
  suspendedAt: null,
  cancelledAt: null,
};

describe("money", () => {
  it("parses taka amounts into poisha and formats them back", () => {
    expect(parseMoneyToMinor("1,500")).toBe(150000n);
    expect(parseMoneyToMinor("৳ 1500.5")).toBe(150050n);
    expect(parseMoneyToMinor("BDT 99.99")).toBe(9999n);
    expect(parseMoneyToMinor("0")).toBe(0n);
    for (const bad of ["", "-5", "1.234", "abc", "1e5"]) expect(parseMoneyToMinor(bad)).toBeNull();
    expect(formatMoneyMinor(150050n, "BDT")).toBe("BDT 1,500.50");
    expect(formatMoneyMinor(1234567800n, "BDT")).toBe("BDT 12,345,678.00");
  });
});

describe("addInterval", () => {
  it("keeps the day of month, clamping to the month's last day", () => {
    expect(addInterval(d("2026-01-31"), "MONTH").toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(addInterval(d("2026-10-21"), "MONTH", 3).toISOString().slice(0, 10)).toBe("2027-01-21");
    expect(addInterval(d("2028-02-29"), "YEAR").toISOString().slice(0, 10)).toBe("2029-02-28");
  });
});

describe("subscriptionState", () => {
  it("covered → ACTIVE (paid) or TRIALING (trial only)", () => {
    expect(subscriptionState(base, d("2026-10-20"))).toMatchObject({ state: "ACTIVE", held: false });
    expect(subscriptionState({ ...base, paidThrough: null, trialEndsAt: d("2026-10-15") }, d("2026-10-10"))).toMatchObject({ state: "TRIALING", held: false });
  });

  it("enforced: PAST_DUE through the grace days, then SUSPENDED (held)", () => {
    expect(subscriptionState(base, d("2026-11-05"))).toMatchObject({ state: "PAST_DUE", held: false });
    expect(subscriptionState(base, d("2026-11-08"))).toMatchObject({ state: "SUSPENDED", held: true, manualSuspension: false });
    expect(subscriptionState({ ...base, graceDays: 0 }, d("2026-11-01"))).toMatchObject({ state: "SUSPENDED", held: true });
  });

  it("NOT enforced (Customer #1's protection): never held by itself, however late", () => {
    const manual = { ...base, autoEnforce: false };
    expect(subscriptionState(manual, d("2027-06-01"))).toMatchObject({ state: "PAST_DUE", held: false, suspendsAt: null });
    expect(subscriptionState({ ...manual, paidThrough: null }, d("2030-01-01"))).toMatchObject({ state: "ACTIVE", held: false });
  });

  it("an admin's suspension holds at once, whatever is paid; cancellation holds from its date", () => {
    expect(subscriptionState({ ...base, suspendedAt: d("2026-10-05") }, d("2026-10-06"))).toMatchObject({ state: "SUSPENDED", held: true, manualSuspension: true });
    expect(subscriptionState({ ...base, autoEnforce: false, suspendedAt: d("2026-10-05") }, d("2026-10-06")).held).toBe(true);
    expect(subscriptionState({ ...base, cancelledAt: d("2026-11-01") }, d("2026-10-20")).state).toBe("ACTIVE");
    expect(subscriptionState({ ...base, cancelledAt: d("2026-11-01") }, d("2026-11-02"))).toMatchObject({ state: "CANCELLED", held: true });
  });

  it("enforced with nothing paid and no trial is due from the start date", () => {
    expect(subscriptionState({ ...base, paidThrough: null }, d("2026-10-03"))).toMatchObject({ state: "PAST_DUE" });
    expect(subscriptionState({ ...base, paidThrough: null }, d("2026-10-09")).held).toBe(true);
  });
});

describe("notices and reminders", () => {
  it("the workspace says read-only when held, and warns before expiry", () => {
    expect(billingNotice(subscriptionState(base, d("2026-11-10")), d("2026-11-10"))?.tone).toBe("danger");
    expect(billingNotice(subscriptionState(base, d("2026-11-03")), d("2026-11-03"))?.message).toMatch(/2026-11-08/);
    expect(billingNotice(subscriptionState(base, d("2026-10-28")), d("2026-10-28"))?.tone).toBe("info");
    expect(billingNotice(subscriptionState(base, d("2026-10-10")), d("2026-10-10"))).toBeNull();
  });

  it("only the closest reminder day reached is due, once per period", () => {
    const at = (iso: string) => dueReminder("s1", subscriptionState(base, d(iso)), d(iso), [7, 3, 1]);
    expect(at("2026-10-10")).toBeNull();
    expect(at("2026-10-25")).toMatchObject({ kind: "EXPIRING", daysBefore: 7 });
    expect(at("2026-10-29")).toMatchObject({ kind: "EXPIRING", daysBefore: 3 });
    expect(at("2026-10-29")!.dedupKey).not.toBe(at("2026-10-25")!.dedupKey);
    expect(at("2026-11-03")).toMatchObject({ kind: "PAST_DUE" });
    expect(at("2026-11-10")).toMatchObject({ kind: "SUSPENDED" });
    // A manual suspension sends no "you were suspended for non-payment" email.
    expect(dueReminder("s1", subscriptionState({ ...base, suspendedAt: d("2026-10-05") }, d("2026-10-06")), d("2026-10-06"), [7])).toBeNull();
  });
});

describe("limits and plans", () => {
  it("refuses the N+1th, never with a null limit", () => {
    expect(limitRefusal("WHATSAPP_ACCOUNTS", 1, 2, "Starter")).toBeNull();
    expect(limitRefusal("WHATSAPP_ACCOUNTS", 2, 2, "Starter")).toMatch(/2 WhatsApp numbers/);
    expect(limitRefusal("USERS", 500, null, "Unlimited")).toBeNull();
  });

  it("parses a plan form, keeping only known features", () => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ name: " Starter ", price: "1,500", currency: "BDT", interval: "MONTH", trialDays: "14", maxWhatsAppAccounts: "2", maxUsers: "" })) form.set(k, v);
    form.append("features", "WHATSAPP_CHAT");
    form.append("features", "NOT_A_FEATURE");
    expect(parsePlanInput(form, ["WHATSAPP_CHAT", "AI_REPLY"])).toEqual({
      plan: { name: "Starter", description: null, priceMinor: 150000n, currency: "BDT", interval: "MONTH", trialDays: 14, maxWhatsAppAccounts: 2, maxUsers: null, features: ["WHATSAPP_CHAT"] },
    });
    form.set("currency", "USD");
    form.set("price", "abc");
    expect(parsePlanInput(form, [])).toMatchObject({ errors: { currency: expect.any(String), priceMinor: expect.any(String) } });
  });
});
