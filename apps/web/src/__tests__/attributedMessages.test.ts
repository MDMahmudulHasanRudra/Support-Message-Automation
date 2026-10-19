import { describe, expect, it } from "vitest";
import { computeFirstResponseWaits, computeMemberWorkloads, median, type AttributedMessage } from "@/server/attributedMessages";

/**
 * Report accuracy audit (19 Oct 2026), Phase 2: Team Performance, availability, first response and
 * the Overview charts read the same classified messages as the Team Report and measure them with its
 * rules — one support-time timeline per person split at the idle gap AND at Dhaka midnight, and the
 * Team Report's wait.
 */

const DAY = Date.UTC(2025, 4, 14) - 6 * 3_600_000; // Dhaka midnight
const at = (h: number, m = 0) => DAY + h * 3_600_000 + m * 60_000;
const msg = (groupKey: string, ts: number, kind: AttributedMessage["kind"], memberId: string | null = null): AttributedMessage => ({
  groupKey,
  ts,
  kind,
  memberId,
  actor: kind === "MEMBER" ? (memberId ? "MEMBER" : "MEMBER_UNMAPPED") : kind === "BUSINESS" ? "BUSINESS_PHONE" : "CUSTOMER",
});

describe("member workload", () => {
  it("measures one timeline across groups, so working two groups at once is not counted twice", () => {
    const rows = computeMemberWorkloads(
      [msg("A", at(10), "MEMBER", "rakib"), msg("B", at(10, 30), "MEMBER", "rakib"), msg("A", at(11), "MEMBER", "rakib")],
      DAY,
      DAY + 86_400_000,
      2 * 3_600_000,
    );
    expect(rows).toEqual([expect.objectContaining({ memberId: "rakib", groupsHandled: 2, messageCount: 3, activeSeconds: 3600, sessionCount: 1 })]);
  });

  it("splits at Dhaka midnight, as the Team Report does", () => {
    const rows = computeMemberWorkloads([msg("A", at(23, 50), "MEMBER", "rakib"), msg("A", at(24, 10), "MEMBER", "rakib")], DAY, DAY + 2 * 86_400_000, 2 * 3_600_000);
    expect(rows[0]).toMatchObject({ sessionCount: 2, activeSeconds: 0 });
  });

  it("never credits a customer, the business number or an unidentified colleague to a person", () => {
    const rows = computeMemberWorkloads([msg("A", at(9), "CUSTOMER"), msg("A", at(9, 1), "BUSINESS"), msg("A", at(9, 2), "MEMBER", null)], DAY, DAY + 86_400_000, 3_600_000);
    expect(rows).toEqual([]);
  });
});

describe("first response waits", () => {
  it("measures a run of customer lines once, closed by the first reply of any kind but a customer's", () => {
    const waits = computeFirstResponseWaits(
      [msg("A", at(9), "CUSTOMER"), msg("A", at(9, 1), "CUSTOMER"), msg("A", at(9, 10), "MEMBER", null), msg("A", at(10), "CUSTOMER")],
      DAY,
      DAY + 86_400_000,
    );
    expect(waits).toEqual([
      { groupKey: "A", askedAt: at(9), repliedAt: at(9, 10) },
      { groupKey: "A", askedAt: at(10), repliedAt: null },
    ]);
  });

  it("does not open a second wait for a customer line continuing one begun before the period", () => {
    const waits = computeFirstResponseWaits([msg("A", at(-1), "CUSTOMER"), msg("A", at(1), "CUSTOMER"), msg("A", at(2), "BUSINESS")], DAY, DAY + 86_400_000);
    expect(waits).toEqual([]);
  });

  it("takes the median as the middle, or the mean of the two middle values", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
