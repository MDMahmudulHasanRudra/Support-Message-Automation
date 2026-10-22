import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ prisma: {} }));

const { parseTeamReportFilters, teamReportQuery } = await import("@/server/teamReport");

const NOW = new Date("2026-10-19T06:00:00Z");

describe("Team Report scope in the URL", () => {
  it("teamReportQuery omits scope=group (old URLs byte-identical)", () => {
    const base = parseTeamReportFilters({ period: "day", date: "2026-10-18" }, NOW);
    const withoutScope = teamReportQuery(base);
    expect(withoutScope).toBe("period=day&date=2026-10-18&by=day");
    expect(teamReportQuery({ ...base, scope: "group" })).toBe(withoutScope);
    expect(teamReportQuery(base, { scope: "group" })).toBe(withoutScope);
    expect(withoutScope).not.toContain("scope");
  });
  it("writes scope only for personal and combined, and parses it back", () => {
    const base = parseTeamReportFilters({ period: "day", date: "2026-10-18", scope: "combined" }, NOW);
    expect(base.scope).toBe("combined");
    expect(teamReportQuery(base)).toBe("period=day&date=2026-10-18&by=day&scope=combined");
    expect(teamReportQuery(base, { scope: "personal" })).toContain("scope=personal");
  });
  it("an unknown scope is group and leaves the filters unchanged", () => {
    const plain = parseTeamReportFilters({ period: "day", date: "2026-10-18" }, NOW);
    expect(parseTeamReportFilters({ period: "day", date: "2026-10-18", scope: "everything" }, NOW)).toEqual(plain);
    expect("scope" in plain).toBe(false);
  });
});
