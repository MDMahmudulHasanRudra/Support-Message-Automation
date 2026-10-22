import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { INTELLIGENCE_SQL_PREFILTER, NO_TEAM, type TeamMembershipInterval } from "@support-automation/shared";

vi.mock("@/server/db", () => ({ prisma: {} }));
vi.mock("server-only", () => ({}));

const { parseTeamReportFilters, resolveTeamScope, resolveTeamReportRange } = await import("@/server/teamReport");
const { prefilteredBodySql } = await import("@/server/messageIdentity");
const { PERSONAL_CHAT_SQL } = await import("@/server/chatInbox");

/**
 * The three pure moves of unified reporting WP5. `loadTeamReport`'s parity snapshot never chooses a
 * Team or a member, so the Team filter and the body fragment are pinned here against what they were
 * when they lived inside it.
 */

const NOW = new Date("2026-10-19T06:00:00Z");
const MEMBERS = [
  { id: "m-rina", name: "Rina" },
  { id: "m-omar", name: "Omar" },
  { id: "m-nadia", name: "Nadia" },
];
const TEAMS = [
  { id: "t-support", name: "Support" },
  { id: "t-billing", name: "Billing" },
];
const filtersFor = (params: Record<string, string>) => parseTeamReportFilters({ period: "month", date: "2026-10-10", ...params }, NOW);
const rangeOf = (params: Record<string, string>) => resolveTeamReportRange(filtersFor(params), NOW);
const at = (day: number) => Date.UTC(2026, 9, day);
// Rina: Support the whole month. Omar: Support until the 15th, then Billing. Nadia: in no Team.
const INTERVALS: TeamMembershipInterval[] = [
  { memberId: "m-rina", teamId: "t-support", startedAt: null, endedAt: null },
  { memberId: "m-omar", teamId: "t-support", startedAt: null, endedAt: at(15) },
  { memberId: "m-omar", teamId: "t-billing", startedAt: at(15), endedAt: null },
];
const scopeOf = (params: Record<string, string>) => resolveTeamScope(filtersFor(params), MEMBERS, TEAMS, INTERVALS, rangeOf(params));

describe("resolveTeamScope", () => {
  it("whole team: no predicate, nothing applied", () => {
    const r = scopeOf({});
    expect(r.scope).toBeNull();
    expect(r.teamId).toBeNull();
    expect(r.teamName).toBeNull();
    expect(r.memberId).toBeNull();
    expect(r.filterNote).toBeNull();
    expect(r.memberNames.get("m-rina")).toBe("Rina");
  });

  it("a Team is who was in it at that moment, and its members of the period are listed", () => {
    const r = scopeOf({ team: "t-support" });
    expect(r.teamName).toBe("Support");
    expect(r.teamMemberIds["t-support"]).toEqual(expect.arrayContaining(["m-rina", "m-omar"]));
    expect(r.teamMemberIds["t-billing"]).toEqual(["m-omar"]);
    expect(r.teamMemberIds[NO_TEAM]).toEqual(["m-nadia"]);
    expect(r.scope!("m-rina", at(20))).toBe(true);
    expect(r.scope!("m-omar", at(10))).toBe(true);
    expect(r.scope!("m-omar", at(20))).toBe(false); // moved to Billing on the 15th
    expect(r.scope!("m-nadia", at(10))).toBe(false);
  });

  it("a member inside a Team narrows the predicate to that one person", () => {
    const r = scopeOf({ team: "t-support", member: "m-rina" });
    expect(r.memberId).toBe("m-rina");
    expect(r.scope!("m-rina", at(10))).toBe(true);
    expect(r.scope!("m-omar", at(10))).toBe(false);
    expect(r.applied).toMatchObject({ teamId: "t-support", memberId: "m-rina" });
  });

  it("a member who was not in the chosen Team falls back to the whole Team, with a note", () => {
    const r = scopeOf({ team: "t-billing", member: "m-rina" });
    expect(r.memberId).toBeNull();
    expect(r.filterNote).toBe(`Rina was not in Billing during ${rangeOf({}).label}, so this shows all of Billing.`);
    expect(r.scope!("m-omar", at(20))).toBe(true);
  });

  it("an unknown or inherited-name Team is ignored, never a crash", () => {
    for (const team of ["t-deleted", "toString", "constructor", "__proto__"]) {
      const r = scopeOf({ team });
      expect(r.teamId, team).toBeNull();
      expect(r.scope, team).toBeNull();
    }
  });

  it("No team means members in none", () => {
    const r = scopeOf({ team: NO_TEAM });
    expect(r.teamName).toBe("No team");
    expect(r.scope!("m-nadia", at(10))).toBe(true);
  });

  it("says when the group filter was cut, after any other note", () => {
    const groups = Array.from({ length: 205 }, (_, i) => `1200000000000${String(i).padStart(5, "0")}@g.us`).join(",");
    const r = scopeOf({ groups });
    expect(r.filterNote).toBe("Only the first 200 of the chosen groups are included.");
    const both = scopeOf({ groups, team: "t-billing", member: "m-rina" });
    expect(both.filterNote).toMatch(/^Rina was not in Billing/);
    expect(both.filterNote).toMatch(/ Only the first 200 of the chosen groups are included\.$/);
  });

  it("without a member in the filters, the member name map still covers everybody", () => {
    expect([...scopeOf({}).memberNames.keys()]).toEqual(["m-rina", "m-omar", "m-nadia"]);
  });
});

describe("prefilteredBodySql", () => {
  // The fragment exactly as loadTeamReport spelled it before the move.
  const head = (alias: string) => {
    const col = (name: string) => Prisma.raw(`${alias}."${name}"`);
    return Prisma.sql`CASE WHEN ${col("direction")} = 'INCOMING'
      AND (length(${col("body")}) BETWEEN 1 AND 24 OR ${col("body")} ~* ${INTELLIGENCE_SQL_PREFILTER}) THEN left(${col("body")}, 400) END`;
  };

  it("is byte-identical to the fragment it replaced, for each alias the loaders use", () => {
    for (const alias of ["m", "p"]) {
      const moved = prefilteredBodySql(alias);
      expect(moved.sql).toBe(head(alias).sql);
      expect(moved.values).toEqual(head(alias).values);
    }
    expect(prefilteredBodySql("m").values).toEqual([INTELLIGENCE_SQL_PREFILTER]);
    expect(prefilteredBodySql("p").sql).toContain('p."direction" = \'INCOMING\'');
  });
});

describe("PERSONAL_CHAT_SQL", () => {
  it("is exported with the one rule the inbox uses", () => {
    expect(PERSONAL_CHAT_SQL.sql).toBe(`m."groupId" IS NULL AND (m."chatId" LIKE '%@c.us' OR m."chatId" LIKE '%@lid')`);
  });
});
