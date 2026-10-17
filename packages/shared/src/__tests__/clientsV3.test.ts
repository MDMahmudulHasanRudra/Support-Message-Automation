import { describe, expect, it } from "vitest";
import {
  addDuration,
  allowedColumns,
  clientDisplayName,
  clientInitials,
  clientSubscriptionState,
  currencyDecimals,
  describeExpiry,
  formatMinor,
  fromMinor,
  groupLinkRefusal,
  invoiceState,
  isWhatsAppGroupId,
  missingRequiredFields,
  normalizeRequiredFields,
  pickCurrentSubscription,
  planPayments,
  prepareClientPhoto,
  readPhotoSize,
  renewalStartDate,
  resolveClientModuleSettings,
  reverseLine,
  sanitizeColumns,
  sniffClientPhoto,
  statusForPaid,
  stripPhotoMetadata,
  summarizeOutstanding,
  termState,
  toMinor,
  validateClientFields,
  validateSubscription,
  type PayableDue,
  type SubscriptionTerm,
} from "../index.js";

const sub = (over: Partial<SubscriptionTerm> = {}): SubscriptionTerm => ({
  id: "s1",
  kind: "PAID",
  startDate: "2026-09-17",
  endDate: "2026-11-17",
  pausedAt: null,
  cancelledAt: null,
  isRenewal: false,
  ...over,
});

describe("subscription calendar", () => {
  it("adds months calendar-aware, clamping to the month's last day", () => {
    expect(addDuration("2026-01-31", 1, "MONTH")).toBe("2026-02-28");
    expect(addDuration("2028-01-31", 1, "MONTH")).toBe("2028-02-29");
    expect(addDuration("2028-02-29", 1, "YEAR")).toBe("2029-02-28");
    expect(addDuration("2026-10-17", 12, "MONTH")).toBe("2027-10-17");
    expect(addDuration("2026-12-15", 3, "MONTH")).toBe("2027-03-15");
    expect(addDuration("2026-10-17", 2, "WEEK")).toBe("2026-10-31");
    expect(addDuration("2026-10-17", 30, "DAY")).toBe("2026-11-16");
  });

  it("describes the time left the way a person says it", () => {
    expect(describeExpiry("2026-01-01", "2027-01-15", "2026-10-17")).toBe("90 days remaining");
    expect(describeExpiry("2026-01-01", "2026-10-18", "2026-10-17")).toBe("1 day remaining");
    expect(describeExpiry("2026-01-01", "2026-10-17", "2026-10-17")).toBe("Expires today");
    expect(describeExpiry("2026-01-01", "2026-10-15", "2026-10-17")).toBe("Expired 2 days ago");
    expect(describeExpiry("2026-10-20", "2026-11-20", "2026-10-17")).toBe("Starts in 3 days");
  });

  it("starts a renewal at the old expiry, or today when it has lapsed", () => {
    expect(renewalStartDate("2026-11-01", "2026-10-17")).toBe("2026-11-01");
    expect(renewalStartDate("2026-10-01", "2026-10-17")).toBe("2026-10-17");
  });
});

describe("validateSubscription", () => {
  const base = { service: "Tiger IPTV", kind: "PAID", startDate: "2026-10-17", durationValue: "1", durationUnit: "MONTH", endDate: "", note: "" };
  it("derives the expiry from the duration", () => {
    const r = validateSubscription(base);
    expect(r.ok && r.value).toMatchObject({ endDate: "2026-11-17", durationValue: 1, durationUnit: "MONTH", kind: "PAID" });
  });
  it("accepts an explicit expiry without a duration", () => {
    const r = validateSubscription({ ...base, durationValue: "", endDate: "2026-12-01" });
    expect(r.ok && r.value).toMatchObject({ endDate: "2026-12-01", durationValue: null });
  });
  it("refuses half a subscription", () => {
    expect(validateSubscription({ ...base, service: "" }).ok).toBe(false);
    expect(validateSubscription({ ...base, durationValue: "", endDate: "" }).ok).toBe(false);
    expect(validateSubscription({ ...base, durationValue: "0" }).ok).toBe(false);
    expect(validateSubscription({ ...base, durationValue: "", endDate: "2026-10-17" }).ok).toBe(false);
    expect(validateSubscription({ ...base, durationValue: "121", durationUnit: "MONTH" }).ok).toBe(false);
    expect(validateSubscription({ ...base, kind: "VIP" }).ok).toBe(false);
  });
});

describe("subscription state", () => {
  const today = "2026-10-17";
  it("reads each term as of today", () => {
    expect(termState(sub(), today)).toBe("ACTIVE");
    expect(termState(sub({ endDate: "2026-10-20" }), today)).toBe("EXPIRING");
    expect(termState(sub({ endDate: "2026-10-17" }), today)).toBe("EXPIRED");
    expect(termState(sub({ kind: "TRIAL", endDate: "2026-10-30" }), today)).toBe("TRIAL");
    expect(termState(sub({ startDate: "2026-10-20" }), today)).toBe("SCHEDULED");
    expect(termState(sub({ startDate: "2026-10-20", isRenewal: true }), today)).toBe("ACTIVE");
    expect(termState(sub({ pausedAt: new Date() }), today)).toBe("PAUSED");
    expect(termState(sub({ cancelledAt: new Date(), pausedAt: new Date() }), today)).toBe("CANCELLED");
  });
  it("uses the project's renewal window", () => {
    expect(termState(sub({ endDate: "2026-10-30" }), today, 7)).toBe("ACTIVE");
    expect(termState(sub({ endDate: "2026-10-30" }), today, 14)).toBe("EXPIRING");
  });
  it("picks the latest-ending uncancelled term as current, and never a cancelled one", () => {
    const a = sub({ id: "a", endDate: "2026-11-17" });
    const b = sub({ id: "b", startDate: "2026-11-17", endDate: "2026-12-17", isRenewal: true });
    const c = sub({ id: "c", endDate: "2027-12-17", cancelledAt: new Date() });
    expect(pickCurrentSubscription([a, b, c])?.id).toBe("b");
    expect(pickCurrentSubscription([c])).toBeNull();
    expect(clientSubscriptionState(null, true, today)).toBe("CANCELLED");
    expect(clientSubscriptionState(null, false, today)).toBe("NONE");
  });
});

describe("money in minor units", () => {
  it("never loses a cent to floating point", () => {
    expect(toMinor("0.1")! + toMinor("0.2")!).toBe(toMinor("0.30"));
    expect(fromMinor(toMinor("1,250.5")!)).toBe("1250.50");
    expect(toMinor("1.234")).toBeNull();
    expect(toMinor("-5")).toBeNull();
  });
  it("writes each currency with its own decimals", () => {
    expect(currencyDecimals("BDT")).toBe(2);
    expect(currencyDecimals("JPY")).toBe(0);
    expect(currencyDecimals("OMR")).toBe(2); // 3 in reality, capped at what storage holds
    expect(formatMinor(150000n, "BDT")).toBe("BDT 1,500.00");
    expect(formatMinor(150000n, "JPY")).toBe("JPY 1,500");
  });
});

const due = (over: Partial<PayableDue> = {}): PayableDue => ({ id: "d1", clientId: "c1", status: "UNPAID", currency: "AED", amount: 30000n, paid: 0n, ...over });

describe("planPayments", () => {
  it("records a partial and a full payment with the right statuses", () => {
    const r = planPayments([due(), due({ id: "d2", amount: 10000n, paid: 2500n, status: "PARTIALLY_PAID" })], [
      { dueId: "d1", amount: "100" },
      { dueId: "d2", amount: "75.00" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]!.total).toBe(17500n);
    expect(r.payments[0]!.lines.map((l) => [l.dueId, l.statusAfter, l.paidAfter])).toEqual([
      ["d1", "PARTIALLY_PAID", 10000n],
      ["d2", "PAID", 10000n],
    ]);
  });
  it("splits a batch into one payment per client and currency, never mixing them", () => {
    const r = planPayments([due(), due({ id: "d2", currency: "BDT" }), due({ id: "d3", clientId: "c2" })], [
      { dueId: "d1", amount: "1" },
      { dueId: "d2", amount: "1" },
      { dueId: "d3", amount: "1" },
    ]);
    expect(r.ok && r.payments.map((p) => `${p.clientId}:${p.currency}`).sort()).toEqual(["c1:AED", "c1:BDT", "c2:AED"]);
  });
  it("refuses overpayment, settled dues, missing amounts, duplicates and bad decimals — all or nothing", () => {
    const bad = (dues: PayableDue[], amount: string, id = "d1") => {
      const r = planPayments(dues, [{ dueId: id, amount }]);
      return r.ok ? null : r.errors[0]!.message;
    };
    expect(bad([due()], "300.01")).toMatch(/More than what is left/);
    expect(bad([due({ status: "PAID" })], "1")).toMatch(/already paid/);
    expect(bad([due({ status: "CANCELLED" })], "1")).toMatch(/cancelled/);
    expect(bad([due({ amount: null })], "1")).toMatch(/no amount/);
    expect(bad([due({ currency: "JPY", amount: 30000n })], "1.50")).toMatch(/no decimals/);
    expect(bad([due()], "0")).toMatch(/more than zero/);
    expect(bad([due()], "1", "missing")).toMatch(/no longer exists/);
    const dup = planPayments([due()], [{ dueId: "d1", amount: "1" }, { dueId: "d1", amount: "1" }]);
    expect(dup.ok).toBe(false);
    const mixed = planPayments([due(), due({ id: "d2", status: "PAID" })], [{ dueId: "d1", amount: "1" }, { dueId: "d2", amount: "1" }]);
    expect(mixed.ok).toBe(false);
  });
  it("reverses an allocation back to the status the paid amount implies", () => {
    expect(reverseLine({ status: "PAID", amount: 10000n, paid: 10000n }, 10000n)).toEqual({ paidAfter: 0n, statusAfter: "UNPAID" });
    expect(reverseLine({ status: "PAID", amount: 10000n, paid: 10000n }, 4000n)).toEqual({ paidAfter: 6000n, statusAfter: "PARTIALLY_PAID" });
    expect(reverseLine({ status: "WAIVED", amount: 10000n, paid: 4000n }, 4000n)).toEqual({ paidAfter: 0n, statusAfter: "WAIVED" });
    expect(statusForPaid(100n, 100n)).toBe("PAID");
  });
});

describe("outstanding by currency", () => {
  it("never sums across currencies and ignores waived, cancelled and amount-less dues", () => {
    const rows = summarizeOutstanding(
      [
        { status: "UNPAID", currency: "AED", amount: 20000n, paid: 0n, dueDate: "2026-10-01" },
        { status: "PARTIALLY_PAID", currency: "AED", amount: 30000n, paid: 10000n, dueDate: "2026-11-01" },
        { status: "UNPAID", currency: "SAR", amount: 24000n, paid: 0n, dueDate: "2026-10-30" },
        { status: "WAIVED", currency: "SAR", amount: 99900n, paid: 0n, dueDate: "2026-10-30" },
        { status: "UNPAID", currency: null, amount: null, paid: 0n, dueDate: "2026-10-30" },
        { status: "PAID", currency: "AED", amount: 5000n, paid: 5000n, dueDate: "2026-09-01" },
      ],
      "2026-10-17",
    );
    expect(rows.map((r) => [r.currency, r.remaining, r.openCount, r.overdueCount, r.collected])).toEqual([
      ["AED", 40000n, 2, 1, 15000n],
      ["SAR", 24000n, 1, 0, 0n],
    ]);
  });
  it("labels an invoice from its status and dates — never from a subscription", () => {
    expect(invoiceState({ status: "UNPAID", amount: 1n, paid: 0n, dueDate: "2026-10-01" }, "2026-10-17")).toBe("OVERDUE");
    expect(invoiceState({ status: "PARTIALLY_PAID", amount: 2n, paid: 1n, dueDate: "2026-10-30" }, "2026-10-17")).toBe("PART_PAID");
    expect(invoiceState({ status: "PAID", amount: 2n, paid: 2n, dueDate: "2026-10-01" }, "2026-10-17")).toBe("PAID");
  });
});

describe("column catalogues", () => {
  it("never offers a billing column without the billing permission", () => {
    expect(allowedColumns("clients", { subscriptions: true, groups: true }).some((c) => c.key === "outstanding")).toBe(false);
    expect(allowedColumns("clients", { billing: true }).some((c) => c.key === "outstanding")).toBe(true);
  });
  it("drops unknown, forbidden and repeated keys and keeps the identity column first", () => {
    const can = { subscriptions: true, groups: true };
    expect(sanitizeColumns("clients", ["email", "outstanding", "nope", "email", "client", "__proto__"], can)).toEqual(["client", "email"]);
    expect(sanitizeColumns("clients", [], can)).toEqual(["client", "country", "phone", "service", "expiry", "subscription", "soldBy", "whatsappGroup"]);
    expect(sanitizeColumns("billing", ["due", "invoice", "billed"], { billing: true })).toEqual(["invoice", "due", "billed"]);
  });
});

describe("module settings and required fields", () => {
  it("means everything on and nothing required with no row", () => {
    expect(resolveClientModuleSettings(null)).toMatchObject({ subscriptions: true, billing: true, payments: true, whatsappGroups: true, requiredFields: [] });
  });
  it("switches payments off with billing", () => {
    const s = resolveClientModuleSettings({ subscriptionsEnabled: true, billingEnabled: false, paymentsEnabled: true, whatsappGroupLinksEnabled: true, requiredFields: ["phone", "bogus"], renewalWindowDays: 500, defaultCountry: "bd" });
    expect(s).toMatchObject({ billing: false, payments: false, requiredFields: ["phone"], renewalWindowDays: 90, defaultCountry: "BD" });
  });
  it("names each missing required field", () => {
    expect(normalizeRequiredFields(["email", "name", "email"])).toEqual(["name", "email"]);
    expect(missingRequiredFields(["name", "phone"], { name: true })).toEqual(["Phone / WhatsApp number is required in this project."]);
  });
  it("allows a code-only client only when asked to", () => {
    expect(validateClientFields({}).errors).toContain("A client needs a name.");
    expect(validateClientFields({}, { allowBlankName: true }).value?.name).toBe("");
    expect(clientDisplayName("", null)).toBe("Unnamed client");
    expect(clientDisplayName("", "Orchid Ltd")).toBe("Orchid Ltd");
    expect(clientInitials("Orchid Networks", null, "CL-1")).toBe("ON");
    expect(clientInitials("", null, "CL-000001")).toBe("CL");
  });
});

describe("group links", () => {
  it("only links an active WhatsApp group of the same account", () => {
    expect(isWhatsAppGroupId("120363025555@g.us")).toBe(true);
    expect(isWhatsAppGroupId("8801700000000@c.us")).toBe(false);
    const g = { whatsappGroupId: "120363025555@g.us", isActive: true, accountId: "a1" };
    expect(groupLinkRefusal(g, "a1")).toBeNull();
    expect(groupLinkRefusal(g, "a2")).toMatch(/another WhatsApp account/);
    expect(groupLinkRefusal({ ...g, isActive: false }, "a1")).toMatch(/inactive/);
    expect(groupLinkRefusal({ ...g, whatsappGroupId: "8801@c.us" }, "a1")).toMatch(/Only a WhatsApp group/);
    expect(groupLinkRefusal(null, "a1")).toMatch(/does not exist/);
  });
});

// ── Photos ──────────────────────────────────────────────────────────────────────────────────────

const crc32 = (bytes: Uint8Array) => {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const pngChunk = (type: string, data: number[]) => {
  const t = [...type].map((c) => c.charCodeAt(0));
  return [...be32(data.length), ...t, ...data, ...be32(crc32(new Uint8Array([...t, ...data])))];
};
const png = (w: number, h: number, extra: number[] = []) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk("IHDR", [...be32(w), ...be32(h), 8, 2, 0, 0, 0]), ...extra, ...pngChunk("IDAT", [1, 2, 3]), ...pngChunk("IEND", [])]);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const jpeg = (w: number, h: number) =>
  new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x06, ...ascii("JFIF"),
    0xff, 0xe1, 0x00, 0x0c, ...ascii("Exif"), 0, 0, ...ascii("GPS!"),
    0xff, 0xfe, 0x00, 0x06, ...ascii("note"),
    0xff, 0xc0, 0x00, 0x0b, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 1, 1, 0x11, 0,
    0xff, 0xda, 0x00, 0x02, 9, 9, 9, 0xff, 0xd9,
  ]);
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const webp = (w: number, h: number) => {
  const vp8x = [...ascii("VP8X"), ...le32(10), 0x08 | 0x04, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, 0, (h - 1) & 255, ((h - 1) >> 8) & 255, 0];
  const exif = [...ascii("EXIF"), ...le32(4), ...ascii("GPS!")];
  const vp8l = [...ascii("VP8L"), ...le32(6), 0x2f, 0, 0, 0, 0, 0];
  const body = [...ascii("WEBP"), ...vp8x, ...exif, ...vp8l];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
};
const contains = (hay: Uint8Array, needle: string) => Buffer.from(hay).includes(Buffer.from(needle));

describe("client photos", () => {
  it("reads the type and size from the bytes", () => {
    expect(sniffClientPhoto(png(64, 48))).toBe("image/png");
    expect(readPhotoSize(png(64, 48), "image/png")).toEqual({ width: 64, height: 48 });
    expect(readPhotoSize(jpeg(300, 200), "image/jpeg")).toEqual({ width: 300, height: 200 });
    expect(readPhotoSize(webp(256, 128), "image/webp")).toEqual({ width: 256, height: 128 });
    expect(sniffClientPhoto(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
  it("removes EXIF, comments and text chunks before anything is stored", () => {
    const withText = png(64, 64, pngChunk("tEXt", ascii("GPS=23.8,90.4")));
    const cleanPng = stripPhotoMetadata(withText, "image/png")!;
    expect(contains(withText, "GPS=")).toBe(true);
    expect(contains(cleanPng, "GPS=")).toBe(false);
    expect(contains(cleanPng, "IDAT")).toBe(true);

    const cleanJpeg = stripPhotoMetadata(jpeg(64, 64), "image/jpeg")!;
    expect(contains(cleanJpeg, "Exif")).toBe(false);
    expect(contains(cleanJpeg, "note")).toBe(false);
    expect(contains(cleanJpeg, "JFIF")).toBe(true);
    expect(readPhotoSize(cleanJpeg, "image/jpeg")).toEqual({ width: 64, height: 64 });

    const cleanWebp = stripPhotoMetadata(webp(64, 64), "image/webp")!;
    expect(contains(cleanWebp, "EXIF")).toBe(false);
    expect(cleanWebp[20]! & 0x0c).toBe(0);
    expect(readPhotoSize(cleanWebp, "image/webp")).toEqual({ width: 64, height: 64 });
    // The RIFF size matches the new body.
    expect(cleanWebp[4]! | (cleanWebp[5]! << 8)).toBe(cleanWebp.length - 8);
  });
  it("refuses oversize, undersize, unknown and damaged pictures", () => {
    expect(prepareClientPhoto(png(2000, 64))).toMatchObject({ ok: false });
    expect(prepareClientPhoto(png(8, 8))).toMatchObject({ ok: false });
    expect(prepareClientPhoto(new Uint8Array(300 * 1024))).toMatchObject({ ok: false });
    expect(prepareClientPhoto(png(64, 64).subarray(0, 40))).toMatchObject({ ok: false });
    expect(prepareClientPhoto(png(64, 64))).toMatchObject({ ok: true, type: "image/png", width: 64 });
  });
});
