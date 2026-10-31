import { describe, expect, it } from "vitest";
import { describeAmounts, detectMoneyColumns, readRowMoney, sanitizeMoneyMapping, type SmartMoneyMapping } from "../clientImportMoney.js";

const headers = ["Name", "SAR", "AED", "OMR", "KWD", "BHD", "QAR", "RAND", "TK", "KSH", "USA", "JOD", "Rial", "Remarks"];
const multi: SmartMoneyMapping = {
  mode: "MULTI",
  columns: [
    { column: "SAR", currency: "SAR" },
    { column: "AED", currency: "AED" },
    { column: "OMR", currency: "OMR" },
    { column: "KWD", currency: "KWD" },
    { column: "BHD", currency: "BHD" },
    { column: "JOD", currency: "JOD" },
    { column: "RAND", currency: "ZAR" },
    { column: "TK", currency: "BDT" },
  ],
};

describe("finding currency columns in a customer's file", () => {
  it("recognises the eleven example columns and leaves the rest alone", () => {
    const found = detectMoneyColumns(headers);
    expect(Object.fromEntries(found.filter((f) => f.currency).map((f) => [f.column, f.currency]))).toEqual({
      SAR: "SAR", AED: "AED", OMR: "OMR", KWD: "KWD", BHD: "BHD", QAR: "QAR", RAND: "ZAR", TK: "BDT", KSH: "KES", USA: "USD", JOD: "JOD",
    });
    expect(found.find((f) => f.column === "Rial")?.ambiguous).toEqual(expect.arrayContaining(["OMR"]));
    expect(found.some((f) => f.column === "Name" || f.column === "Remarks")).toBe(false);
  });
});

describe("one row's amounts", () => {
  it("records one amount exactly as written, in its column's currency", () => {
    expect(readRowMoney({ SAR: "SAR30.00" }, multi)).toEqual({ status: "ONE", amounts: [{ currency: "SAR", amount: "30.00", original: "SAR30.00", column: "SAR" }] });
    expect(readRowMoney({ OMR: "Rial4.000" }, multi)).toMatchObject({ status: "ONE", amounts: [{ currency: "OMR", amount: "4.000" }] });
    expect(readRowMoney({ KWD: "din8.000" }, multi)).toMatchObject({ status: "ONE", amounts: [{ currency: "KWD", amount: "8.000" }] });
    expect(readRowMoney({ BHD: "din2.550" }, multi)).toMatchObject({ status: "ONE", amounts: [{ currency: "BHD", amount: "2.550" }] });
    expect(readRowMoney({ AED: "dh30.00" }, multi)).toMatchObject({ status: "ONE", amounts: [{ currency: "AED", amount: "30.00" }] });
    expect(readRowMoney({ JOD: "7.35" }, multi)).toMatchObject({ status: "ONE", amounts: [{ currency: "JOD", amount: "7.35" }] });
  });

  it("records nothing for zero or blank amounts", () => {
    expect(readRowMoney({ SAR: "0.00", AED: "", TK: "0" }, multi)).toEqual({ status: "ZERO", amounts: [] });
    expect(readRowMoney({ Name: "x" }, multi)).toEqual({ status: "NONE", amounts: [] });
    expect(readRowMoney({ SAR: "30" }, null)).toEqual({ status: "NONE", amounts: [] });
  });

  it("flags several currencies on one row, and never adds them up", () => {
    const r = readRowMoney({ SAR: "30", AED: "12.50" }, multi);
    expect(r.status).toBe("MULTIPLE");
    expect(describeAmounts(r.amounts)).toBe("SAR 30 · AED 12.50");
  });

  it("keeps an unreadable or contradictory cell as written, with the reason", () => {
    expect(readRowMoney({ SAR: "paid" }, multi)).toMatchObject({ status: "PROBLEM", amounts: [{ amount: null, original: "paid", problem: expect.any(String) }] });
    expect(readRowMoney({ SAR: "AED 30" }, multi)).toMatchObject({ status: "PROBLEM", amounts: [{ problem: expect.stringMatching(/AED in the SAR column/) }] });
    expect(readRowMoney({ AED: "Rial 4" }, multi)).toMatchObject({ status: "PROBLEM" });
    // More decimals than the currency has: kept exactly, flagged — never rounded.
    expect(readRowMoney({ SAR: "7.355" }, multi)).toMatchObject({ status: "PROBLEM", amounts: [{ amount: "7.355", problem: expect.stringMatching(/2 decimal places/) }] });
  });

  it("reads a single amount column with a currency column", () => {
    const single: SmartMoneyMapping = { mode: "SINGLE", amountColumn: "Amount", currencyColumn: "Cur" };
    expect(readRowMoney({ Amount: "30.00", Cur: "TK" }, single)).toMatchObject({ status: "ONE", amounts: [{ currency: "BDT", amount: "30.00" }] });
    expect(readRowMoney({ Amount: "30.00", Cur: "din" }, single)).toMatchObject({ status: "PROBLEM" });
    expect(readRowMoney({ Amount: "30.00" }, { mode: "SINGLE", amountColumn: "Amount", currency: "KES" })).toMatchObject({ status: "ONE", amounts: [{ currency: "KES" }] });
  });
});

describe("what the server accepts", () => {
  it("refuses unknown columns and currencies", () => {
    expect(sanitizeMoneyMapping(multi, headers)).toEqual({ ok: true, money: multi });
    expect(sanitizeMoneyMapping({ mode: "MULTI", columns: [{ column: "Nope", currency: "SAR" }] }, headers)).toMatchObject({ ok: false });
    expect(sanitizeMoneyMapping({ mode: "MULTI", columns: [{ column: "Rial", currency: "" }] }, headers)).toMatchObject({ ok: false, error: expect.stringMatching(/choose which currency/) });
    expect(sanitizeMoneyMapping({ mode: "SINGLE", amountColumn: "SAR" }, headers)).toMatchObject({ ok: false });
    expect(sanitizeMoneyMapping(undefined, headers)).toEqual({ ok: true, money: null });
  });
});
