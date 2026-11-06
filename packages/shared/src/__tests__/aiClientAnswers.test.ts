import { describe, expect, it } from "vitest";
import {
  accountPromptRules,
  clientPhoneMatchKeys,
  describeOutstandingDues,
  describeTermForCustomer,
  detectAccountIntent,
  formatCalendarDay,
  narrowAiClientAnswerPolicy,
  resolveAiClientAnswerPolicy,
  validateAnswerFigures,
} from "../aiClientAnswers.js";
import { validateCommerceFigures } from "../aiCommerce.js";

const ON = { clientAccountAnswers: true, clientDueAnswers: true };
const ALL_MODULES = { subscriptions: true, billing: true };
const CLIENTS = new Set(["CLIENT_CENTER"]);

describe("resolveAiClientAnswerPolicy", () => {
  it("is inactive with both switches off, whatever is enabled", () => {
    const p = resolveAiClientAnswerPolicy(CLIENTS, ALL_MODULES, { clientAccountAnswers: false, clientDueAnswers: false });
    expect(p).toEqual({ account: false, dues: false, active: false, blocked: [] });
  });

  it("needs Client Management on, and says so", () => {
    const p = resolveAiClientAnswerPolicy(new Set(), ALL_MODULES, ON);
    expect(p.active).toBe(false);
    expect(p.blocked.map((b) => b.capability)).toEqual(["ACCOUNT", "DUES"]);
    expect(p.blocked[0]!.reason).toMatch(/Client Management is off/);
  });

  it("account answers need Subscriptions; dues need Billing", () => {
    const noSubs = resolveAiClientAnswerPolicy(CLIENTS, { subscriptions: false, billing: true }, ON);
    expect(noSubs).toMatchObject({ account: false, dues: true, active: true });
    expect(noSubs.blocked[0]!.reason).toMatch(/Subscriptions/);
    const noBilling = resolveAiClientAnswerPolicy(CLIENTS, { subscriptions: true, billing: false }, ON);
    expect(noBilling).toMatchObject({ account: true, dues: false, active: true });
    expect(noBilling.blocked[0]!.reason).toMatch(/Billing/);
  });

  it("dues need the account switch on as well", () => {
    const p = resolveAiClientAnswerPolicy(CLIENTS, ALL_MODULES, { clientAccountAnswers: false, clientDueAnswers: true });
    expect(p).toMatchObject({ account: false, dues: false, active: false });
    expect(p.blocked).toEqual([{ capability: "DUES", reason: "Due answers need account answers on." }]);
  });

  it("everything on gives both", () => {
    expect(resolveAiClientAnswerPolicy(CLIENTS, ALL_MODULES, ON)).toEqual({ account: true, dues: true, active: true, blocked: [] });
  });

  it("a viewer only ever narrows, and dues need both keys", () => {
    const full = resolveAiClientAnswerPolicy(CLIENTS, ALL_MODULES, ON);
    expect(narrowAiClientAnswerPolicy(full, { account: true, dues: false })).toMatchObject({ account: true, dues: false, active: true });
    expect(narrowAiClientAnswerPolicy(full, { account: false, dues: true })).toMatchObject({ account: false, dues: false, active: false });
    const accountOnly = resolveAiClientAnswerPolicy(CLIENTS, ALL_MODULES, { clientAccountAnswers: true, clientDueAnswers: false });
    expect(narrowAiClientAnswerPolicy(accountOnly, { account: true, dues: true })).toMatchObject({ account: true, dues: false });
  });
});

describe("detectAccountIntent — requests", () => {
  const requests = [
    "I want to pay my bill",
    "i would like to make a payment",
    "Please upgrade my line",
    "I want to change my package",
    "change my package to 30 Mbps",
    "please disconnect",
    "cancel my connection from next month",
    "I need to renew",
    "can you take my payment?",
    "ami bill dite chai",
    "package change korte chai",
    "line bondho korte chai",
    "amar line kete dite chai",
    "আমি বিল দিতে চাই",
    "প্যাকেজ পরিবর্তন করতে চাই",
    "লাইন বন্ধ করতে চাই",
  ];
  for (const text of requests) it(`"${text}" is a request`, () => expect(detectAccountIntent(text).request).toBe(true));

  const notRequests = [
    "How can I pay my bill?",
    "what is my due?",
    "when does my package expire?",
    "what packages do you have?",
    "please change my wifi password",
    "is there a fee to change package?",
    "bill koto?",
    "amar package ki?",
    "আমার বিল কত?",
    "মেয়াদ কবে শেষ?",
    "internet is slow",
  ];
  for (const text of notRequests) it(`"${text}" is not a request`, () => expect(detectAccountIntent(text).request).toBe(false));
});

describe("detectAccountIntent — questions", () => {
  for (const text of ["what is my due?", "How much do I owe", "when does my line expire", "what is my package", "bill koto", "baki koto vai", "meyad kobe sesh", "আমার বিল কত?", "বকেয়া কত", "মেয়াদ কবে শেষ"]) {
    it(`"${text}" asks about the account`, () => expect(detectAccountIntent(text).question).toBe(true));
  }
  for (const text of ["internet is slow", "router light is red", "hello", "ধন্যবাদ"]) {
    it(`"${text}" does not`, () => expect(detectAccountIntent(text).question).toBe(false));
  }
});

describe("clientPhoneMatchKeys", () => {
  it("a Bangladeshi WhatsApp number matches its stored form and its local digits form", () => {
    expect(clientPhoneMatchKeys("8801712345678").sort()).toEqual(["01712345678", "8801712345678"]);
  });
  it("another country's number matches only itself — never a suffix", () => {
    expect(clientPhoneMatchKeys("966551234567")).toEqual(["966551234567"]);
  });
  it("nothing that is not a number", () => {
    expect(clientPhoneMatchKeys("abc")).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats a stored calendar day without shifting it", () => {
    expect(formatCalendarDay("2026-11-15")).toBe("15 Nov 2026");
    expect(formatCalendarDay("2026-01-01")).toBe("1 Jan 2026");
  });

  it("describes a term by its derived state", () => {
    expect(describeTermForCustomer({ service: "Home 20 Mbps", state: "ACTIVE", startDate: "2026-10-15", endDate: "2026-11-15" })).toBe("package Home 20 Mbps — active, expires on 15 Nov 2026.");
    expect(describeTermForCustomer({ service: "Home 20 Mbps", state: "EXPIRED", startDate: "2026-09-15", endDate: "2026-10-15" })).toBe("package Home 20 Mbps — expired on 15 Oct 2026.");
  });

  it("states dues per currency from minor units, exactly, never summed across currencies", () => {
    const dues = [
      { status: "UNPAID", amount: 120000n, paid: 0n, currency: "BDT", dueDate: "2026-11-01" },
      { status: "PARTIALLY_PAID", amount: 50050n, paid: 50000n, currency: "BDT", dueDate: "2026-11-20" },
      { status: "UNPAID", amount: 1500n, paid: 0n, currency: "USD", dueDate: "2026-11-20" },
      { status: "UNPAID", amount: 30000n, paid: 0n, currency: "SAR", dueDate: "2026-11-20" },
      { status: "UNPAID", amount: 1200n, paid: 0n, currency: "JPY", dueDate: "2026-11-20" },
      { status: "PAID", amount: 999900n, paid: 999900n, currency: "BDT", dueDate: "2026-10-01" },
      { status: "CANCELLED", amount: 777700n, paid: 0n, currency: "EUR", dueDate: "2026-10-01" },
    ];
    const out = describeOutstandingDues(dues, "2026-11-07");
    expect(out.amounts).toEqual(["BDT 1,200.50", "JPY 12", "SAR 300.00", "USD 15.00"]);
    expect(out.text).toBe("BDT 1,200.50 (2 open invoices, 1 overdue); JPY 12 (1 open invoice); SAR 300.00 (1 open invoice); USD 15.00 (1 open invoice).");
    // No cross-currency total appears anywhere.
    expect(out.text).not.toMatch(/total/i);
  });

  it("never says nothing is owed when an open due has no amount", () => {
    const out = describeOutstandingDues([{ status: "UNPAID", amount: null, paid: 0n, currency: null, dueDate: "2026-11-01" }], "2026-11-07");
    expect(out.text).toBe("1 open due has no amount recorded; a person must confirm it.");
    expect(describeOutstandingDues([], "2026-11-07").text).toBe("nothing is outstanding.");
  });
});

describe("accountPromptRules", () => {
  it("adds nothing when inactive", () => {
    expect(accountPromptRules({ account: false, dues: false, active: false, blocked: [] }, "FOUND")).toEqual([]);
  });
  it("says payment cannot be taken and dues are unavailable when only account answers are on", () => {
    const rules = accountPromptRules({ account: true, dues: false, active: true, blocked: [] }, "UNVERIFIED").join("\n");
    expect(rules).toMatch(/Payment cannot be taken here/);
    expect(rules).toMatch(/What the customer owes is not available here/);
    expect(rules).toMatch(/could not be verified/);
  });
});

describe("validateAnswerFigures", () => {
  const base = { commerceActive: false, commerceGroundingText: "", accountActive: true, accountAmounts: ["BDT 1,200.00"], knowledgeText: "" };

  it("is off when neither commerce nor account answers are on", () => {
    expect(validateAnswerFigures({ ...base, accountActive: false, reply: "You owe ৳9,999" })).toBe(true);
  });

  it("accepts an amount the dues entry gave, in any spelling", () => {
    expect(validateAnswerFigures({ ...base, reply: "Your due is ৳1,200." })).toBe(true);
    expect(validateAnswerFigures({ ...base, reply: "Apnar baki 1200 taka." })).toBe(true);
    // Bengali digits are compared as ASCII.
    expect(validateAnswerFigures({ ...base, reply: "আপনার বকেয়া ১,২০০ টাকা।" })).toBe(true);
  });

  it("refuses an amount it was not given — Bengali digits included", () => {
    expect(validateAnswerFigures({ ...base, reply: "Your due is ৳1,500." })).toBe(false);
    expect(validateAnswerFigures({ ...base, reply: "আপনার বকেয়া ১৫০০ টাকা।" })).toBe(false);
  });

  it("reads ISO codes as currency markers when account answers are on (a due can be in any currency)", () => {
    const three = { ...base, accountAmounts: ["BDT 1,200.00", "SAR 300.00", "USD 15.00"] };
    expect(validateAnswerFigures({ ...three, reply: "You owe SAR 300 and USD 15." })).toBe(true);
    expect(validateAnswerFigures({ ...three, reply: "You owe SAR 350." })).toBe(false);
    expect(validateAnswerFigures({ ...three, reply: "You owe 450 AED." })).toBe(false);
    // Commerce alone never reads them, so its check is unchanged.
    expect(validateCommerceFigures("You owe SAR 350.", "").ok).toBe(true);
  });

  it("a date or client code in the grounding is never an allowed amount", () => {
    // Only the amounts are passed: "client 0012" and "15 Nov 2026" grant nothing.
    expect(validateAnswerFigures({ ...base, accountAmounts: [], reply: "You owe ৳2026." })).toBe(false);
    expect(validateAnswerFigures({ ...base, accountAmounts: [], reply: "You owe ৳12." })).toBe(false);
  });

  it("with account answers only, verified knowledge prices stay answerable", () => {
    expect(validateAnswerFigures({ ...base, accountAmounts: [], knowledgeText: "Home 20 Mbps costs 1,000 taka a month.", reply: "The 20 Mbps package is ৳1,000 a month." })).toBe(true);
  });

  it("with commerce on, the commerce rule is unchanged: knowledge does not ground a price", () => {
    expect(
      validateAnswerFigures({ ...base, commerceActive: true, accountAmounts: [], knowledgeText: "Home 20 Mbps costs 1,000 taka a month.", reply: "The 20 Mbps package is ৳1,000 a month." }),
    ).toBe(false);
    // …and an account amount that was given still counts.
    expect(validateAnswerFigures({ ...base, commerceActive: true, reply: "Your due is ৳1,200." })).toBe(true);
  });
});
