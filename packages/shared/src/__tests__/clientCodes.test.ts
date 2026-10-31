import { describe, expect, it } from "vitest";
import {
  belongsToSeries,
  canonicalPrefix,
  codeTenantKey,
  formatClientCode,
  latinLetters,
  parseSerial,
  planCodeConversion,
  prefixRefusal,
  previewClientCodes,
  seriesOfCode,
  suggestCodePrefix,
  validateCodePrefix,
  validateCodeWidth,
  type CodePlanClient,
} from "../clientCodes.js";

describe("client code format", () => {
  it("numbers the primary project 0001, 0002 … 9999, 10000 — growing, never wrapping or clipping", () => {
    expect(formatClientCode("", 1n, 4)).toBe("0001");
    expect(formatClientCode("", 2n, 4)).toBe("0002");
    expect(formatClientCode("", 9999n, 4)).toBe("9999");
    expect(formatClientCode("", 10000n, 4)).toBe("10000");
    expect(formatClientCode("", 10001n, 4)).toBe("10001");
  });

  it("puts a project's prefix in front of the same serial", () => {
    expect(previewClientCodes("N", "1", 4)).toEqual(["N0001", "N0002", "N0003"]);
    expect(formatClientCode("VIP", 12n, 4)).toBe("VIP0012");
  });

  it("carries 20-digit serials exactly (never through a JavaScript number)", () => {
    const big = parseSerial("12345678901234567890")!;
    expect(formatClientCode("N", big + 1n, 4)).toBe("N12345678901234567891");
    expect(previewClientCodes("", "99999999999999999999", 4, 2)).toEqual(["99999999999999999999", "100000000000000000000"]);
  });

  it("reads a serial as digits only, at least 1", () => {
    expect(parseSerial("0007")).toBe(7n);
    expect(parseSerial("0")).toBeNull();
    expect(parseSerial("-3")).toBeNull();
    expect(parseSerial("1e3")).toBeNull();
    expect(parseSerial("")).toBeNull();
  });

  it("validates prefixes and widths", () => {
    expect(canonicalPrefix(" vip ")).toBe("VIP");
    expect(validateCodePrefix("VIP")).toBeNull();
    expect(validateCodePrefix("V1")).toMatch(/letters A–Z only/);
    expect(validateCodePrefix("ABCDEFGHI")).toMatch(/at most 8/);
    expect(validateCodeWidth(4)).toBeNull();
    expect(validateCodeWidth(0)).not.toBeNull();
    expect(validateCodeWidth(13)).not.toBeNull();
  });

  it("keys the original installation's series apart from every customer's", () => {
    expect(codeTenantKey(null)).toBe("__founding__");
    expect(codeTenantKey("cust_1")).toBe("cust_1");
  });
});

describe("prefix suggestion", () => {
  it("offers the first letter, then more of the project's own letters when it is taken", () => {
    expect(suggestCodePrefix({ name: "Noor", slug: "noor" }, new Set([""]))).toBe("N");
    expect(suggestCodePrefix({ name: "Nexus", slug: "nexus" }, new Set(["", "N"]))).toBe("NE");
    expect(suggestCodePrefix({ name: "Nexus", slug: "nexus" }, new Set(["", "N", "NE"]))).toBe("NEX");
  });

  it("falls back to the slug's initials, then the first letter plus another letter", () => {
    expect(suggestCodePrefix({ name: "No", slug: "no-vip" }, new Set(["N", "NO", "NOV", "NOVI", "NOVIP"]))).toBe("NV");
    expect(suggestCodePrefix({ name: "N", slug: "n" }, new Set(["N"]))).toBe("NA");
  });

  it("uses the name's Latin letters when the slug has none, and asks when there are none at all", () => {
    expect(suggestCodePrefix({ name: "Éclair Shop", slug: "123" }, new Set())).toBe("E");
    expect(suggestCodePrefix({ name: "সফটিফাই", slug: "2024" }, new Set())).toBeNull();
    expect(latinLetters("ঢাকা Dhaka-1")).toBe("DHAKA");
  });

  it("refuses a reserved, empty or invalid prefix with the reason", () => {
    const reserved = new Map([["N", "Noor"]]);
    expect(prefixRefusal("N", reserved)).toMatch(/reserved by Noor/);
    expect(prefixRefusal("", reserved)).toMatch(/primary project/);
    expect(prefixRefusal("N1", reserved)).toMatch(/letters/);
    expect(prefixRefusal("NE", reserved)).toBeNull();
  });
});

describe("which series a code belongs to", () => {
  it("never confuses N with NE: a serial is digits only", () => {
    expect(seriesOfCode("NE0001", ["", "N", "NE"])).toBe("NE");
    expect(seriesOfCode("N0001", ["", "N", "NE"])).toBe("N");
    expect(seriesOfCode("0001", ["", "N"])).toBe("");
    expect(seriesOfCode("n0001", ["N"])).toBe("N");
    expect(seriesOfCode("CL-000041", ["", "N"])).toBeNull();
    expect(seriesOfCode("X0001", ["", "N"])).toBeNull();
    expect(belongsToSeries("N0001", "N")).toBe(true);
    expect(belongsToSeries("NE0001", "N")).toBe(false);
    expect(belongsToSeries("0001", "")).toBe(true);
    expect(belongsToSeries("CL-000041", "")).toBe(false);
  });
});

describe("converting existing codes", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
  const clients: CodePlanClient[] = [
    { id: "c3", code: "CL-000041", createdAt: at(3), archived: false },
    { id: "c1", code: "CL-000007", createdAt: at(1), archived: true },
    { id: "c2", code: "ACME-77", createdAt: at(2), archived: false },
    { id: "c4", code: "0002", createdAt: at(4), archived: false },
    { id: "c0", code: "CL-000099", createdAt: at(3), archived: false },
  ];
  const series = { prefix: "", minWidth: 4, nextSerial: "1", version: 1 };

  it("numbers old generated codes in creation order, skips codes already used, and keeps the rest", () => {
    const plan = planCodeConversion({ clients, aliases: [], series, options: { convertLegacyPattern: true, convertCustom: false } });
    const to = Object.fromEntries(plan.rows.map((r) => [r.clientId, r.to]));
    // c1 (oldest, archived too), then c0 and c3 (same time: id decides), skipping 0002 which c4 already has.
    expect(to).toEqual({ c1: "0001", c0: "0003", c3: "0004", c2: null, c4: null });
    expect(plan.changes).toBe(3);
    expect(plan.kept).toBe(2);
    expect(plan.nextSerialAfter).toBe("5");
    expect(plan.rows.find((r) => r.clientId === "c2")!.category).toBe("CUSTOM");
    expect(plan.rows.find((r) => r.clientId === "c4")!.category).toBe("IN_SERIES");
  });

  it("converts custom codes only when asked, and never onto a reserved alias", () => {
    const plan = planCodeConversion({ clients, aliases: ["0001"], series: { ...series, prefix: "N" }, options: { convertLegacyPattern: true, convertCustom: true } });
    const to = Object.fromEntries(plan.rows.map((r) => [r.clientId, r.to]));
    expect(to.c2).toBe("N0002");
    expect(to.c4).toBe("N0005"); // "0002" is not N's form, so it is a custom code here
    expect(new Set(Object.values(to)).size).toBe(5);
  });

  it("is deterministic: the same inputs give the same plan and hash, a change gives another", () => {
    const a = planCodeConversion({ clients, aliases: [], series, options: { convertLegacyPattern: true, convertCustom: false } });
    const b = planCodeConversion({ clients: [...clients].reverse(), aliases: [], series, options: { convertLegacyPattern: true, convertCustom: false } });
    expect(b.hash).toBe(a.hash);
    const c = planCodeConversion({ clients, aliases: [], series: { ...series, nextSerial: "2" }, options: { convertLegacyPattern: true, convertCustom: false } });
    expect(c.hash).not.toBe(a.hash);
  });

  it("changes nothing when nothing is selected", () => {
    const plan = planCodeConversion({ clients, aliases: [], series, options: { convertLegacyPattern: false, convertCustom: false } });
    expect(plan.changes).toBe(0);
    expect(plan.nextSerialAfter).toBe("1");
  });
});
