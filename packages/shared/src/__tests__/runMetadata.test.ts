import { describe, expect, it } from "vitest";
import {
  buildReportRunMetadata,
  countOperatorReplies,
  COMBINED_CALCULATION_VERSION,
  dataQualityLines,
  emptyDataQualityCounts,
  GROUP_CALCULATION_VERSION,
  IDENTITY_MODE_STATEMENT,
  PERSONAL_CALCULATION_VERSION,
  runMetadataLines,
  type ReportScope,
} from "../index.js";

const base = (over: Partial<Parameters<typeof buildReportRunMetadata>[0]> = {}) =>
  buildReportRunMetadata({
    scope: "group",
    generatedAt: Date.UTC(2026, 9, 20, 6, 0),
    period: {
      start: Date.UTC(2026, 9, 1) - 6 * 3_600_000,
      end: Date.UTC(2026, 10, 1) - 6 * 3_600_000,
      label: "October 2026",
      contextMs: 4 * 3_600_000,
      lookaheadMs: 24 * 3_600_000,
      name: "Monthly",
    },
    filters: { team: null, member: null, groupCount: 0, account: null, granularity: "day" },
    health: { status: "HEALTHY", lastMessageAt: Date.UTC(2026, 9, 20, 5, 55), lastProcessedAt: null },
    reliability: {
      logicalMessages: 120,
      attribution: { idAndPhone: 10, idOnly: 4, phoneOnly: 3 },
      conflicting: 2,
      unattributedSenders: 1,
      gaps: { total: 2, incomplete: 1, recoveredMessages: 7 },
      days: { total: 31, incomplete: 1, unverified: 0 },
    },
    operatorReplies: { linked: 5, unlinked: 2 },
    pendingReattributions: 3,
    ...over,
  });

describe("run metadata", () => {
  it("calculationVersions by scope", () => {
    expect(base({ scope: "group" }).calculationVersions).toEqual([GROUP_CALCULATION_VERSION]);
    expect(base({ scope: "personal" }).calculationVersions).toEqual([PERSONAL_CALCULATION_VERSION]);
    expect(base({ scope: "combined" }).calculationVersions).toEqual([GROUP_CALCULATION_VERSION, PERSONAL_CALCULATION_VERSION, COMBINED_CALCULATION_VERSION]);
    expect(base({ replyAttributionVersion: "reply-attribution-1" }).calculationVersions).toEqual([GROUP_CALCULATION_VERSION, "reply-attribution-1"]);
  });

  it("dataCutoff = storedBy when asof given", () => {
    const stored = Date.UTC(2026, 9, 20, 5, 30);
    expect(base({ storedBy: stored }).dataCutoff).toBe(stored);
    expect(base().dataCutoff).toBe(base().generatedAt);
    expect(base({ storedBy: null }).dataCutoff).toBe(base().generatedAt);
  });

  it("carries the identity mode statement and splits attribution strength", () => {
    const meta = base();
    expect(meta.identityMode).toBe(IDENTITY_MODE_STATEMENT);
    expect(meta.identity).toMatchObject({ strong: 10, single: 7, linkedLogin: 5, unlinkedOperator: 2, conflicting: 2, pendingReattributions: 3 });
    expect(meta.collection).toMatchObject({ gaps: 2, incompleteGaps: 1, recoveredMessages: 7, daysTotal: 31 });
  });

  it("no line value is a percentage", () => {
    const counts = { ...emptyDataQualityCounts(), lateArriving: 4, loadedFromHistory: 2, revoked: 1, excludedSystem: 9, excludedNonConversation: 3, excludedOwnNumberChats: 1, excludedInternalChats: 2 };
    const values = [
      ...runMetadataLines(base({ scope: "combined" })).map((l) => l.value),
      ...dataQualityLines(counts, "GROUP", 3).map((l) => l.value),
      ...dataQualityLines(counts, "PERSONAL", 0).map((l) => l.value),
    ];
    expect(values.length).toBeGreaterThan(20);
    for (const value of values) expect(String(value)).not.toMatch(/%/);
    // Counts are numbers, not scores.
    for (const line of dataQualityLines(counts, "PERSONAL", 1)) expect(typeof line.value).toBe("number");
  });

  it("personal-only lines appear only for the personal scope; pending only when given", () => {
    const counts = emptyDataQualityCounts();
    expect(dataQualityLines(counts, "GROUP").map((l) => l.label)).not.toContain("Our own numbers' chats (not counted)");
    expect(dataQualityLines(counts, "PERSONAL").map((l) => l.label)).toContain("Our own numbers' chats (not counted)");
    expect(dataQualityLines(counts, "GROUP").map((l) => l.label)).not.toContain("Roster changes still being applied to history");
    expect(dataQualityLines(counts, "GROUP", 0).map((l) => l.label)).toContain("Roster changes still being applied to history");
    expect(new Set(dataQualityLines(counts, "PERSONAL", 1).map((l) => l.section))).toEqual(new Set(["Collection detail"]));
  });

  it("deterministic", () => {
    const scopes: ReportScope[] = ["group", "personal", "combined"];
    for (const scope of scopes) {
      expect(base({ scope })).toEqual(base({ scope }));
      expect(runMetadataLines(base({ scope }))).toEqual(runMetadataLines(base({ scope })));
    }
    expect(dataQualityLines(emptyDataQualityCounts(), "PERSONAL", 2)).toEqual(dataQualityLines(emptyDataQualityCounts(), "PERSONAL", 2));
  });
});

describe("countOperatorReplies", () => {
  it("splits dashboard replies into linked and unlinked, inside the period only", () => {
    const end = 1_000;
    const messages = [
      { ts: 10, actor: "OPERATOR", memberId: "m1" },
      { ts: 20, actor: "OPERATOR", memberId: "m2" },
      { ts: 30, actor: "OPERATOR", memberId: null },
      // After the period (the reply look-ahead): never part of it.
      { ts: 1_000, actor: "OPERATOR", memberId: "m1" },
      { ts: 1_500, actor: "OPERATOR", memberId: null },
      // Not dashboard replies.
      { ts: 40, actor: "MEMBER", memberId: "m1" },
      { ts: 50, actor: "AI", memberId: null },
      { ts: 60, memberId: null },
    ];
    expect(countOperatorReplies(messages, end)).toEqual({ linked: 2, unlinked: 1 });
    expect(countOperatorReplies([], end)).toEqual({ linked: 0, unlinked: 0 });
  });
});
