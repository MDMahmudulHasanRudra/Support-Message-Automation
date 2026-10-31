import { describe, expect, it } from "vitest";
import { formatClientCode } from "../clientCodes.js";
import {
  autoMapColumns,
  buildImportRows,
  CLIENT_LIMITS,
  findDuplicateMatches,
  findInFileDuplicates,
  matchKeyOf,
  normalizeChannelDrafts,
  normalizeChannelValue,
  normalizeEmail,
  normalizeTags,
  validateClientFields,
} from "../clients.js";

describe("channel references", () => {
  it("reduces phone and WhatsApp numbers to digits and puts them in one match group", () => {
    expect(normalizeChannelValue("PHONE", "+880 1894-431220")).toBe("8801894431220");
    expect(normalizeChannelValue("WHATSAPP", "8801894431220")).toBe("8801894431220");
    expect(matchKeyOf("PHONE", "8801894431220")).toBe(matchKeyOf("WHATSAPP", "8801894431220"));
  });
  it("gives a locally written Bangladeshi number its country code so it matches the international form", () => {
    expect(normalizeChannelValue("PHONE", "01894431220")).toBe("8801894431220");
    expect(normalizeChannelValue("PHONE", "01894-431220")).toBe("8801894431220");
    expect(normalizeChannelValue("PHONE", "+14155550100")).toBe("14155550100");
  });
  it("refuses a phone that is not a number", () => {
    expect(normalizeChannelValue("PHONE", "call me")).toBeNull();
    expect(normalizeChannelValue("PHONE", "123")).toBeNull();
  });
  it("lower-cases emails and refuses malformed ones", () => {
    expect(normalizeEmail("  Rahim@Example.COM ")).toBe("rahim@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("a b@c.com")).toBeNull();
  });
  it("strips the @ from a handle", () => {
    expect(normalizeChannelValue("INSTAGRAM", "@SomeShop")).toBe("someshop");
  });
  it("keeps one of a repeated reference, one primary per kind, and reports invalid ones", () => {
    const { channels, errors } = normalizeChannelDrafts([
      { kind: "PHONE", value: "+8801894431220", isPrimary: true },
      { kind: "PHONE", value: "01894431220x" },
      { kind: "PHONE", value: "8801894431220" },
      { kind: "PHONE", value: "+8801711111111", isPrimary: true },
      { kind: "EMAIL", value: "bad" },
    ]);
    expect(channels.map((c) => c.normalizedValue)).toEqual(["8801894431220", "8801711111111"]);
    expect(channels.filter((c) => c.isPrimary)).toHaveLength(1);
    expect(errors).toHaveLength(2); // "01894431220x" has a letter in it; "bad" is no email
  });
});

describe("tags", () => {
  it("normalises, de-duplicates and caps", () => {
    expect(normalizeTags("VIP, vip ; Corporate|  corporate ")).toEqual(["vip", "corporate"]);
    expect(normalizeTags(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(CLIENT_LIMITS.tags);
  });
});

describe("validateClientFields", () => {
  it("requires a name and defaults the status to ACTIVE", () => {
    expect(validateClientFields({}).errors).toContain("A client needs a name.");
    expect(validateClientFields({ name: "  Rahim  " }).value).toMatchObject({ name: "Rahim", status: "ACTIVE", tags: [] });
  });
  it("rejects an unknown status, a bad code and over-long text", () => {
    expect(validateClientFields({ name: "A", status: "VIP" }).errors).toContain("That client status is not recognised.");
    expect(validateClientFields({ name: "A", code: "bad code!" }).errors.join()).toMatch(/client code/);
    expect(validateClientFields({ name: "x".repeat(300) }).errors.join()).toMatch(/Name is longer/);
  });
  it("never lets a custom field name reach the prototype", () => {
    const parsed = JSON.parse('{"__proto__":"x","constructor":"y","plan":"gold"}');
    const { value } = validateClientFields({ name: "A", customFields: parsed });
    expect(value?.customFields).toEqual({ plan: "gold" });
    expect(({} as Record<string, unknown>).plan).toBeUndefined();
  });
});

describe("duplicate detection", () => {
  const existing = [
    { clientId: "c1", matchKeys: ["phone:8801894431220", "email:a@x.com"], code: "CL-000001" },
    { clientId: "c2", matchKeys: ["phone:8801711111111"], code: null },
  ];
  it("matches on a shared phone, email or code — never on a similar name", () => {
    expect(findDuplicateMatches({ matchKeys: ["phone:8801894431220"] }, existing)).toEqual([{ clientId: "c1", sharedKeys: ["phone:8801894431220"] }]);
    expect(findDuplicateMatches({ matchKeys: [], code: "cl-000001" }, existing)).toEqual([{ clientId: "c1", sharedKeys: ["code"] }]);
    expect(findDuplicateMatches({ matchKeys: ["phone:8809999999999"] }, existing)).toEqual([]);
  });
  it("does not match a client against itself", () => {
    expect(findDuplicateMatches({ matchKeys: ["phone:8801711111111"], excludeClientId: "c2" }, existing)).toEqual([]);
  });
});

describe("import", () => {
  it("maps common headers", () => {
    expect(autoMapColumns(["Client Name", "Mobile Number", "E-mail", "Package", "Notes"])).toEqual({
      name: "Client Name",
      phone: "Mobile Number",
      email: "E-mail",
      category: "Package",
      // A Notes column becomes the client's first internal note.
      note: "Notes",
    });
  });
  it("reports bad rows and keeps the good ones", () => {
    const { valid, invalid } = buildImportRows(
      [
        { Name: "Rahim", Phone: "+8801894431220; 01711111111", Email: "r@x.com", Tags: "vip, corporate" },
        { Name: "", Phone: "+8801894431221" },
        { Name: "Karim", Phone: "abc" },
        { Name: "", Phone: "" },
      ],
      { name: "Name", phone: "Phone", email: "Email", tags: "Tags" },
    );
    expect(valid.map((r) => [r.rowNumber, r.fields.name])).toEqual([[2, "Rahim"]]);
    expect(valid[0]!.fields.tags).toEqual(["vip", "corporate"]);
    expect(invalid.map((r) => r.rowNumber)).toEqual([3, 4]); // the fully blank line is ignored, not an error
  });
  it("finds rows that repeat an identifier inside the file", () => {
    const { valid } = buildImportRows(
      [
        { Name: "A", Phone: "+8801894431220" },
        { Name: "B", Phone: "8801894431220" },
        { Name: "C", Phone: "+8801700000000" },
      ],
      { name: "Name", phone: "Phone" },
    );
    expect([...findInFileDuplicates(valid)]).toEqual([[3, 2]]);
  });
});

it("formats a client code from its project's series, never with the old CL- form", () => {
  expect(formatClientCode("", 42n, 4)).toBe("0042");
  expect(formatClientCode("N", "7", 4)).toBe("N0007");
});
