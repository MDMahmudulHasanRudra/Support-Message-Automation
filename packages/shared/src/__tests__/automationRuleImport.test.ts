import { describe, expect, it } from "vitest";
import { buildRuleExportRow, buildRuleImportTemplateRows, parseRuleImportRows } from "../automationRuleImport.js";
import { MAX_EXCEL_ROWS } from "../groupBroadcast.js";

function validRawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Name: "Greeting",
    Description: "",
    Type: "AUTO_REPLY",
    "Match Type": "KEYWORDS",
    "Match Value": "",
    Keywords: "hi, hello",
    Priority: 10,
    Actions: "AUTO_REPLY",
    "Action Tag": "",
    "Action Category": "",
    "Action Forward Chat Id": "",
    "Reply Message": "Hi there!",
    "Cooldown Seconds": 3600,
    "Reply Delay Min Ms": "",
    "Reply Delay Max Ms": "",
    "Sender Scope": "",
    "Previous Sender Scope": "",
    "Group Scope Ids": "",
    "Time Window Start Hour": "",
    "Time Window End Hour": "",
    "Time Window Days": "",
    ...overrides,
  };
}

describe("parseRuleImportRows — file-level checks", () => {
  it("rejects an empty file", () => {
    const result = parseRuleImportRows([]);
    expect(result.results).toHaveLength(0);
    expect(result.fileErrors[0]).toMatch(/no data rows/i);
  });

  it("rejects a file exceeding the row limit", () => {
    const rows = Array.from({ length: MAX_EXCEL_ROWS + 1 }, () => validRawRow());
    const result = parseRuleImportRows(rows);
    expect(result.results).toHaveLength(0);
    expect(result.fileErrors[0]).toMatch(/exceeds the maximum/i);
  });

  it("rejects a file missing required columns", () => {
    const result = parseRuleImportRows([{ Name: "x" }]);
    expect(result.results).toHaveLength(0);
    expect(result.fileErrors[0]).toMatch(/Missing required column/i);
  });

  it("is tolerant of header casing/whitespace", () => {
    const row = {
      " NAME ": "Greeting",
      "  type": "AUTO_REPLY",
      "MATCH type ": "ALWAYS",
      "actions ": "AUTO_REPLY",
    };
    const result = parseRuleImportRows([row]);
    expect(result.fileErrors).toEqual([]);
    expect(result.results[0]!.outcome).toBe("VALID");
    expect(result.results[0]!.row?.name).toBe("Greeting");
  });
});

describe("parseRuleImportRows — per-row validation", () => {
  it("accepts a valid row", () => {
    const result = parseRuleImportRows([validRawRow()]);
    expect(result.results).toHaveLength(1);
    const row = result.results[0]!;
    expect(row.outcome).toBe("VALID");
    expect(row.row?.name).toBe("Greeting");
    expect(row.row?.actions).toEqual([{ type: "AUTO_REPLY" }]);
    expect(row.row?.keywords).toEqual(["hi", "hello"]);
  });

  it("rejects a row missing the required Name field", () => {
    const result = parseRuleImportRows([validRawRow({ Name: "" })]);
    expect(result.results[0]!.outcome).toBe("INVALID");
    expect(result.results[0]!.reason).toMatch(/Name/i);
  });

  it("rejects an invalid Type enum value", () => {
    const result = parseRuleImportRows([validRawRow({ Type: "NOT_A_TYPE" })]);
    expect(result.results[0]!.outcome).toBe("INVALID");
    expect(result.results[0]!.reason).toMatch(/Invalid Type/i);
  });

  it("rejects an invalid Match Type enum value", () => {
    const result = parseRuleImportRows([validRawRow({ "Match Type": "FUZZY" })]);
    expect(result.results[0]!.outcome).toBe("INVALID");
    expect(result.results[0]!.reason).toMatch(/Invalid Match Type/i);
  });

  it("rejects an invalid action token", () => {
    const result = parseRuleImportRows([validRawRow({ Actions: "TELEPORT" })]);
    expect(result.results[0]!.outcome).toBe("INVALID");
    expect(result.results[0]!.reason).toMatch(/Invalid action/i);
  });

  it("rejects GROUP_BROADCAST as an action (never offered in the manual form either)", () => {
    const result = parseRuleImportRows([validRawRow({ Actions: "GROUP_BROADCAST" })]);
    expect(result.results[0]!.outcome).toBe("INVALID");
  });

  it("rejects a REGEX matchType with no Match Value", () => {
    const result = parseRuleImportRows([validRawRow({ "Match Type": "REGEX", "Match Value": "" })]);
    expect(result.results[0]!.outcome).toBe("INVALID");
    expect(result.results[0]!.reason).toMatch(/REGEX rule requires/i);
  });

  it("rejects a non-numeric Priority", () => {
    const result = parseRuleImportRows([validRawRow({ Priority: "high" })]);
    expect(result.results[0]!.outcome).toBe("INVALID");
    expect(result.results[0]!.reason).toMatch(/Priority/i);
  });

  it("rejects a time window with only one of start/end hour set", () => {
    const result = parseRuleImportRows([validRawRow({ "Time Window Start Hour": "9" })]);
    expect(result.results[0]!.outcome).toBe("INVALID");
    expect(result.results[0]!.reason).toMatch(/must both be set together/i);
  });

  it("rejects a zero-width time window (start === end)", () => {
    const result = parseRuleImportRows([
      validRawRow({ "Time Window Start Hour": "22", "Time Window End Hour": "22" }),
    ]);
    expect(result.results[0]!.outcome).toBe("INVALID");
    expect(result.results[0]!.reason).toMatch(/cannot be the same/i);
  });

  it("accepts a valid time window and builds the correct conditions shape", () => {
    const result = parseRuleImportRows([
      validRawRow({ "Time Window Start Hour": "22", "Time Window End Hour": "6", "Time Window Days": "0,6" }),
    ]);
    expect(result.results[0]!.outcome).toBe("VALID");
    expect(result.results[0]!.row?.conditions.timeWindow).toEqual({ startHour: 22, endHour: 6, days: [0, 6] });
  });

  it("builds groupScope conditions from comma-separated Group Scope Ids", () => {
    const result = parseRuleImportRows([validRawRow({ "Group Scope Ids": "grp1, grp2" })]);
    expect(result.results[0]!.row?.conditions.groupScope).toEqual({ type: "SPECIFIC", groupIds: ["grp1", "grp2"] });
  });
});

describe("parseRuleImportRows — in-file duplicate detection", () => {
  it("flags a repeated name (case/whitespace-insensitive) as DUPLICATE_IN_FILE, keeping the first occurrence VALID", () => {
    const result = parseRuleImportRows([validRawRow({ Name: "Greeting" }), validRawRow({ Name: "  greeting  " })]);
    expect(result.results[0]!.outcome).toBe("VALID");
    expect(result.results[1]!.outcome).toBe("DUPLICATE_IN_FILE");
    expect(result.results[1]!.reason).toMatch(/appears more than once/i);
  });

  it("does not flag distinctly-named rows as duplicates", () => {
    const result = parseRuleImportRows([validRawRow({ Name: "Greeting" }), validRawRow({ Name: "Farewell" })]);
    expect(result.results.every((r) => r.outcome === "VALID")).toBe(true);
  });
});

describe("buildRuleExportRow / parseRuleImportRows round-trip", () => {
  it("an exported row parses back to an equivalent valid import row", () => {
    const exportRow = buildRuleExportRow({
      name: "Greeting",
      description: "A greeting rule",
      type: "AUTO_REPLY",
      matchType: "KEYWORDS",
      matchValue: null,
      keywords: ["hi", "hello"],
      priority: 10,
      status: "ACTIVE",
      actions: [{ type: "AUTO_REPLY" }, { type: "TAG", tag: "greeting" }],
      conditions: { sender: { type: "CLIENT" }, groupScope: { type: "SPECIFIC", groupIds: ["g1", "g2"] } },
      replyMessage: "Hi there!",
      cooldownSeconds: 3600,
      replyDelayMinMs: null,
      replyDelayMaxMs: null,
      executionCount: 5,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const parsed = parseRuleImportRows([exportRow as unknown as Record<string, unknown>]);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.results[0]!.outcome).toBe("VALID");
    expect(parsed.results[0]!.row?.name).toBe("Greeting");
    expect(parsed.results[0]!.row?.keywords).toEqual(["hi", "hello"]);
    expect(parsed.results[0]!.row?.actions).toEqual([{ type: "AUTO_REPLY" }, { type: "TAG", tag: "greeting" }]);
    expect(parsed.results[0]!.row?.conditions.sender).toEqual({ type: "CLIENT" });
    expect(parsed.results[0]!.row?.conditions.groupScope).toEqual({ type: "SPECIFIC", groupIds: ["g1", "g2"] });
  });
});

describe("buildRuleImportTemplateRows", () => {
  it("produces rows whose fields all pass validation", () => {
    const templateRows = buildRuleImportTemplateRows();
    expect(templateRows.length).toBeGreaterThan(0);
    const result = parseRuleImportRows(templateRows as Array<Record<string, unknown>>);
    expect(result.fileErrors).toEqual([]);
    for (const row of result.results) {
      expect(row.outcome, `row for "${row.row?.name}" should be valid: ${row.reason}`).toBe("VALID");
    }
  });
});
