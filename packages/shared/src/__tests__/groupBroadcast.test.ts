import { describe, expect, it } from "vitest";
import {
  MAX_EXCEL_ROWS,
  matchExcelGroups,
  normalizeGroupName,
  parseExcelRows,
  validateMessageText,
  type GroupCandidate,
  type ExcelGroupRow,
} from "../groupBroadcast.js";

describe("normalizeGroupName", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeGroupName("  ABC   ISP  Support  ")).toBe("abc isp support");
  });

  it("strips zero-width characters that would otherwise defeat matching", () => {
    expect(normalizeGroupName("ABC​ISP Support")).toBe("abcisp support");
  });

  it("does not fuzzy-normalize punctuation or accents", () => {
    expect(normalizeGroupName("ABC-ISP")).toBe("abc-isp");
    expect(normalizeGroupName("ABC ISP")).not.toBe(normalizeGroupName("ABC-ISP"));
  });
});

describe("parseExcelRows", () => {
  it("rejects a file with no rows", () => {
    const result = parseExcelRows([]);
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]).toMatch(/no data rows/i);
  });

  it("rejects a file missing the required Group Name column", () => {
    const result = parseExcelRows([{ Message: "hi" }]);
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]).toMatch(/Group Name/);
  });

  it("is tolerant of header casing/whitespace", () => {
    const result = parseExcelRows([{ " group name  ": "ABC Support", " MESSAGE ": "hello" }]);
    expect(result.rows).toEqual([{ rowNumber: 2, groupName: "ABC Support", message: "hello" }]);
  });

  it("flags and drops empty group name rows instead of silently accepting them", () => {
    const result = parseExcelRows([
      { "Group Name": "ABC Support", Message: "hi" },
      { "Group Name": "   ", Message: "hi" },
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Row 3.*empty/i);
  });

  it("treats a blank Message cell as null, not an empty string", () => {
    const result = parseExcelRows([{ "Group Name": "ABC Support", Message: "" }]);
    expect(result.rows[0]!.message).toBeNull();
  });

  it("rejects group names containing control characters", () => {
    const result = parseExcelRows([{ "Group Name": "ABC\x07Support" }]);
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]).toMatch(/control characters/i);
  });

  it("rejects a file exceeding the max row count", () => {
    const rows = Array.from({ length: MAX_EXCEL_ROWS + 1 }, (_, i) => ({ "Group Name": `Group ${i}` }));
    const result = parseExcelRows(rows);
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]).toMatch(/exceeds the maximum/i);
  });

  it("rejects an overly long message", () => {
    const result = parseExcelRows([{ "Group Name": "ABC Support", Message: "x".repeat(5000) }]);
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]).toMatch(/exceeds 4096/);
  });
});

describe("matchExcelGroups", () => {
  const candidates: GroupCandidate[] = [
    { id: "g1", name: "ABC ISP Support" },
    { id: "g2", name: "XYZ Support" },
    { id: "g3", name: "Client Support" },
    { id: "g4", name: "Client Support" }, // deliberately ambiguous with g3
  ];

  function row(groupName: string, message: string | null = null, rowNumber = 2): ExcelGroupRow {
    return { rowNumber, groupName, message };
  }

  it("matches an exact name to exactly one group", () => {
    const [result] = matchExcelGroups([row("ABC ISP Support", "Maintenance tonight.")], candidates);
    expect(result!.status).toBe("MATCHED");
    expect(result!.matchedGroupId).toBe("g1");
    expect(result!.message).toBe("Maintenance tonight.");
  });

  it("matches after normalization (case/whitespace only)", () => {
    const [result] = matchExcelGroups([row("  xyz   support  ")], candidates);
    expect(result!.status).toBe("MATCHED");
    expect(result!.matchedGroupId).toBe("g2");
  });

  it("never guesses on an ambiguous name -- reports AMBIGUOUS with both candidates, no matchedGroupId", () => {
    const [result] = matchExcelGroups([row("Client Support")], candidates);
    expect(result!.status).toBe("AMBIGUOUS");
    expect(result!.matchedGroupId).toBeNull();
    expect(result!.ambiguousCandidates.map((c) => c.id).sort()).toEqual(["g3", "g4"]);
  });

  it("reports UNMATCHED for a name with no synchronized group, and never invents a fuzzy match", () => {
    const [result] = matchExcelGroups([row("Totally Unknown Group")], candidates);
    expect(result!.status).toBe("UNMATCHED");
    expect(result!.matchedGroupId).toBeNull();
  });

  it("does not fuzzy-match a near-miss name (e.g. a typo) -- must be UNMATCHED, not a guess", () => {
    const [result] = matchExcelGroups([row("ABC ISP Suport")], candidates); // missing a 'p'
    expect(result!.status).toBe("UNMATCHED");
  });

  it("flags the second occurrence of a duplicated group name in the same file", () => {
    const results = matchExcelGroups(
      [row("ABC ISP Support", "first", 2), row("abc isp support", "second", 3)],
      candidates,
    );
    expect(results[0]!.status).toBe("MATCHED");
    expect(results[1]!.status).toBe("DUPLICATE");
  });
});

describe("validateMessageText", () => {
  it("rejects an empty message", () => {
    expect(validateMessageText("   ")).toMatch(/cannot be empty/i);
  });

  it("accepts a normal message", () => {
    expect(validateMessageText("Server maintenance tonight.")).toBeNull();
  });

  it("rejects an overly long message", () => {
    expect(validateMessageText("x".repeat(5000))).toMatch(/exceeds/i);
  });
});
