import { describe, expect, it } from "vitest";
import { computeDataHealth, formatDhakaSpan, gapIsIncomplete, groupDataConfidence, type CollectionGapInput } from "../dataHealth.js";

const H = 3_600_000;
// 1 Oct 2026 00:00 Dhaka = 30 Sep 18:00 UTC.
const OCT1 = Date.UTC(2026, 8, 30, 18, 0);
const period = { periodStart: OCT1, periodEnd: OCT1 + 7 * 24 * H, now: OCT1 + 10 * 24 * H };
const gap = (over: Partial<CollectionGapInput> = {}): CollectionGapInput => ({
  accountId: "a1",
  accountLabel: "Primary",
  cause: "DISCONNECTED",
  startedAt: OCT1 + 2 * 24 * H + 14 * H + 20 * 60_000, // 3 Oct 14:20 Dhaka
  endedAt: OCT1 + 2 * 24 * H + 15 * H + 5 * 60_000, // 3 Oct 15:05
  recoveryStatus: "RECOVERED",
  recoveredCount: 4,
  recoveryNote: null,
  ...over,
});
const verified = { verifiedFrom: OCT1 - 24 * H };

describe("status", () => {
  it("HEALTHY: verified from before the period, no gap", () => {
    const h = computeDataHealth({ ...period, ...verified, gaps: [] });
    expect(h).toMatchObject({ status: "HEALTHY", unverified: null, warnings: [] });
  });

  it("WARNING: a pause that was fully recovered", () => {
    const h = computeDataHealth({ ...period, ...verified, gaps: [gap()] });
    expect(h.status).toBe("WARNING");
    expect(h.warnings[0]).toBe("Collection paused between 3 Oct 2026, 14:20 – 15:05 (Primary: disconnected); the messages sent meanwhile were recovered afterwards (4).");
  });

  it("DATA_GAP: open, failed, partial, never swept — each may have lost messages", () => {
    for (const over of [{ endedAt: null }, { recoveryStatus: "FAILED" }, { recoveryStatus: "PARTIAL" }, { recoveryStatus: "NOT_ATTEMPTED" }, { recoveryStatus: null }]) {
      expect(computeDataHealth({ ...period, ...verified, gaps: [gap(over)] }).status).toBe("DATA_GAP");
    }
    const failed = computeDataHealth({ ...period, ...verified, gaps: [gap({ recoveryStatus: "FAILED", recoveryNote: "The session could not be read: Target closed" })] });
    expect(failed.warnings[0]).toBe(
      "Reporting data may be incomplete between 3 Oct 2026, 14:20 – 15:05 — Primary: disconnected; recovery failed. The session could not be read: Target closed",
    );
    expect(failed.headline).toContain('"no communication" here means "none recorded"');
  });

  it("an open gap is measured to now and says it is ongoing", () => {
    const h = computeDataHealth({ ...period, ...verified, gaps: [gap({ startedAt: period.periodEnd + H, endedAt: null })] });
    expect(h.status).toBe("HEALTHY"); // starts after the period ends: not this period's problem
    const ongoing = computeDataHealth({ ...period, ...verified, gaps: [gap({ startedAt: period.periodStart - 24 * H, endedAt: null })] });
    expect(ongoing.warnings[0]).toContain("(still ongoing)");
  });

  it("UNVERIFIED_HISTORY: nothing verified yet, or the period starts before verified-from", () => {
    const never = computeDataHealth({ ...period, verifiedFrom: null, gaps: [] });
    expect(never).toMatchObject({ status: "UNVERIFIED_HISTORY", unverified: { from: period.periodStart, to: period.periodEnd } });
    const part = computeDataHealth({ ...period, verifiedFrom: OCT1 + 3 * 24 * H, gaps: [] });
    expect(part).toMatchObject({ status: "UNVERIFIED_HISTORY", unverified: { from: period.periodStart, to: OCT1 + 3 * 24 * H } });
    expect(part.warnings[0]).toBe("Before 4 Oct 2026, 00:00 this period is historical / unverified: collection health was not recorded, so missing messages cannot be ruled out.");
  });

  it("a data gap outranks unverified history; unverified outranks a recovered pause", () => {
    expect(computeDataHealth({ ...period, verifiedFrom: null, gaps: [gap({ recoveryStatus: "FAILED" })] }).status).toBe("DATA_GAP");
    expect(computeDataHealth({ ...period, verifiedFrom: null, gaps: [gap()] }).status).toBe("UNVERIFIED_HISTORY");
  });

  it("gaps outside the period are ignored", () => {
    const before = gap({ startedAt: OCT1 - 5 * H, endedAt: OCT1 - 4 * H, recoveryStatus: "FAILED" });
    expect(computeDataHealth({ ...period, ...verified, gaps: [before] }).status).toBe("HEALTHY");
  });
});

describe("per group", () => {
  it("only the group's own accounts' incomplete gaps make it DATA_GAP", () => {
    const h = computeDataHealth({ ...period, ...verified, gaps: [gap({ accountId: "a2", recoveryStatus: "FAILED" })] });
    expect(groupDataConfidence(h, ["a1"])).toBe("VERIFIED");
    expect(groupDataConfidence(h, ["a1", "a2"])).toBe("DATA_GAP");
    expect(groupDataConfidence(computeDataHealth({ ...period, verifiedFrom: null, gaps: [] }), ["a1"])).toBe("HISTORICAL_UNVERIFIED");
  });
});

describe("helpers", () => {
  it("a span across Dhaka days names both dates", () => {
    expect(formatDhakaSpan(OCT1 + 23 * H, OCT1 + 25 * H)).toBe("1 Oct 2026, 23:00 – 2 Oct 2026, 01:00");
  });
  it("recovered and closed is the only complete gap", () => {
    expect(gapIsIncomplete({ endedAt: 1, recoveryStatus: "RECOVERED" })).toBe(false);
    expect(gapIsIncomplete({ endedAt: null, recoveryStatus: "RECOVERED" })).toBe(true);
  });
});
