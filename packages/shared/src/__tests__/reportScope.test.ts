import { describe, expect, it } from "vitest";
import { parseReportScope, resolveReportScope } from "../unifiedReporting/index.js";

describe("report scope", () => {
  it("absent/unknown -> group", () => {
    for (const raw of [undefined, null, "", "everything", "GROUP"]) {
      expect(parseReportScope(raw)).toBe("group");
    }
    expect(parseReportScope("personal")).toBe("personal");
    expect(parseReportScope(" combined ")).toBe("combined");
  });
  it("flag off -> group with no note", () => {
    expect(resolveReportScope({ requested: "combined", featureEnabled: false, canViewPersonal: true })).toEqual({ scope: "group", note: null });
  });
  it("personal without messages.view -> group with note", () => {
    for (const requested of ["personal", "combined"] as const) {
      expect(resolveReportScope({ requested, featureEnabled: true, canViewPersonal: false })).toEqual({
        scope: "group",
        note: "Personal chat reporting needs the View Messages permission.",
      });
    }
    expect(resolveReportScope({ requested: "group", featureEnabled: true, canViewPersonal: false })).toEqual({ scope: "group", note: null });
  });
  it("combined allowed with both", () => {
    expect(resolveReportScope({ requested: "combined", featureEnabled: true, canViewPersonal: true })).toEqual({ scope: "combined", note: null });
    expect(resolveReportScope({ requested: "personal", featureEnabled: true, canViewPersonal: true })).toEqual({ scope: "personal", note: null });
  });
});
