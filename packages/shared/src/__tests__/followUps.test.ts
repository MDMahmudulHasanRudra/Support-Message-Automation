import { describe, expect, it } from "vitest";
import {
  decideFollowUpAction,
  followUpAttentionCutoff,
  followUpBucket,
  followUpBucketRange,
  followUpPresetDue,
  formatDhakaDateTimeInput,
  formatFollowUpDue,
  parseDhakaDateTimeInput,
  readFollowUpFields,
} from "../followUps.js";

/** A Dhaka wall-clock time as the UTC instant it is (Dhaka = UTC+6, no DST). */
const dhaka = (s: string) => new Date(`${s}+06:00`);
const open = (dueAt: Date) => ({ status: "OPEN" as const, dueAt });

describe("followUpBucket — Dhaka day boundaries", () => {
  it("23:59 Dhaka: a 23:59:30 item is due today, 00:00 tomorrow is upcoming", () => {
    const now = dhaka("2026-11-07T23:59:00");
    expect(followUpBucket(open(dhaka("2026-11-07T23:59:30")), now)).toBe("DUE_TODAY");
    expect(followUpBucket(open(dhaka("2026-11-08T00:00:00")), now)).toBe("UPCOMING");
  });

  it("00:30 Dhaka (18:30 UTC the day before): today is the Dhaka day, not the UTC one", () => {
    const now = dhaka("2026-11-08T00:30:00"); // 2026-11-07T18:30Z
    expect(now.toISOString()).toBe("2026-11-07T18:30:00.000Z");
    // 20:00 UTC on the 7th is 02:00 Dhaka on the 8th: due today in Dhaka.
    expect(followUpBucket(open(new Date("2026-11-07T20:00:00Z")), now)).toBe("DUE_TODAY");
    // 23:00 Dhaka on the 8th is still today.
    expect(followUpBucket(open(dhaka("2026-11-08T23:00:00")), now)).toBe("DUE_TODAY");
    // 18:00 UTC on the 8th = 00:00 Dhaka on the 9th: upcoming.
    expect(followUpBucket(open(new Date("2026-11-08T18:00:00Z")), now)).toBe("UPCOMING");
  });

  it("a time already passed today is overdue, not due today", () => {
    const now = dhaka("2026-11-07T15:00:00");
    expect(followUpBucket(open(dhaka("2026-11-07T10:00:00")), now)).toBe("OVERDUE");
    expect(followUpBucket(open(dhaka("2026-11-06T23:00:00")), now)).toBe("OVERDUE");
  });

  it("closed follow-ups sit under their status, whatever the date", () => {
    const now = dhaka("2026-11-07T15:00:00");
    expect(followUpBucket({ status: "DONE", dueAt: dhaka("2026-11-01T10:00:00") }, now)).toBe("DONE");
    expect(followUpBucket({ status: "DISCARDED", dueAt: dhaka("2026-12-01T10:00:00") }, now)).toBe("DISCARDED");
  });

  it("the SQL-free ranges agree with the bucket for every instant around midnight", () => {
    const now = dhaka("2026-11-07T23:30:00");
    const inRange = (r: { gte?: Date; lt?: Date }, d: Date) => (!r.gte || d >= r.gte) && (!r.lt || d < r.lt);
    for (let m = -120; m <= 120; m += 7) {
      const due = new Date(now.getTime() + m * 60_000);
      const bucket = followUpBucket(open(due), now);
      for (const b of ["OVERDUE", "DUE_TODAY", "UPCOMING"] as const) expect(inRange(followUpBucketRange(b, now), due), `${m} ${b}`).toBe(bucket === b);
    }
    expect(followUpAttentionCutoff(now).toISOString()).toBe(dhaka("2026-11-08T00:00:00").toISOString());
  });
});

describe("status moves", () => {
  it("done and discard only from open; reopen only from closed", () => {
    expect(decideFollowUpAction("OPEN", "DONE")).toEqual({ to: "DONE", event: "DONE" });
    expect(decideFollowUpAction("OPEN", "DISCARD")).toEqual({ to: "DISCARDED", event: "DISCARDED" });
    expect(decideFollowUpAction("DONE", "DONE")).toBeNull();
    expect(decideFollowUpAction("DISCARDED", "DONE")).toBeNull();
    expect(decideFollowUpAction("OPEN", "REOPEN")).toBeNull();
    expect(decideFollowUpAction("DONE", "REOPEN")).toEqual({ to: "OPEN", event: "REOPENED" });
    expect(decideFollowUpAction("DISCARDED", "REOPEN")).toEqual({ to: "OPEN", event: "REOPENED" });
  });
});

describe("due time input", () => {
  it("presets: in one hour, and 10:00 on the next DHAKA day (also just after Dhaka midnight)", () => {
    const now = dhaka("2026-11-07T23:50:00");
    expect(followUpPresetDue("IN_1_HOUR", now).toISOString()).toBe(dhaka("2026-11-08T00:50:00").toISOString());
    expect(followUpPresetDue("TOMORROW_10", now).toISOString()).toBe(dhaka("2026-11-08T10:00:00").toISOString());
    expect(followUpPresetDue("TOMORROW_10", dhaka("2026-11-08T00:10:00")).toISOString()).toBe(dhaka("2026-11-09T10:00:00").toISOString());
  });

  it("datetime-local is read as Dhaka wall clock and round-trips; impossible dates are refused", () => {
    expect(parseDhakaDateTimeInput("2026-11-08T10:00")?.toISOString()).toBe("2026-11-08T04:00:00.000Z");
    expect(formatDhakaDateTimeInput(new Date("2026-11-08T04:00:00Z"))).toBe("2026-11-08T10:00");
    expect(parseDhakaDateTimeInput("2026-02-31T10:00")).toBeNull();
    expect(parseDhakaDateTimeInput("2026-11-08T24:00")).toBeNull();
    expect(parseDhakaDateTimeInput("tomorrow")).toBeNull();
    expect(parseDhakaDateTimeInput(42)).toBeNull();
  });

  it("validates the form", () => {
    const now = dhaka("2026-11-07T12:00:00");
    expect(readFollowUpFields({ title: "  Call   back  ", due: "IN_1_HOUR" }, now)).toEqual({ title: "Call back", note: null, dueAt: dhaka("2026-11-07T13:00:00"), priority: "NONE" });
    expect(readFollowUpFields({ title: "", due: "IN_1_HOUR" }, now)).toEqual({ error: expect.stringMatching(/what needs/) });
    expect(readFollowUpFields({ title: "x".repeat(201), due: "IN_1_HOUR" }, now)).toEqual({ error: expect.stringMatching(/200/) });
    expect(readFollowUpFields({ title: "x", due: "" }, now)).toEqual({ error: expect.stringMatching(/when/) });
    expect(readFollowUpFields({ title: "x", due: "2036-01-01T10:00" }, now)).toEqual({ error: expect.stringMatching(/year/) });
    expect(readFollowUpFields({ title: "x", due: "IN_1_HOUR", priority: "BOGUS" }, now)).toEqual({ error: expect.stringMatching(/priority/) });
    expect(readFollowUpFields({ title: "x", due: "IN_1_HOUR", priority: "URGENT", note: " visit " }, now)).toMatchObject({ priority: "URGENT", note: "visit" });
  });

  it("formats due times in Dhaka", () => {
    const now = dhaka("2026-11-07T12:00:00");
    expect(formatFollowUpDue(dhaka("2026-11-07T15:30:00"), now)).toBe("Today 15:30");
    expect(formatFollowUpDue(dhaka("2026-11-08T10:00:00"), now)).toBe("Tomorrow 10:00");
    expect(formatFollowUpDue(dhaka("2026-11-06T09:05:00"), now)).toBe("Yesterday 09:05");
    expect(formatFollowUpDue(dhaka("2026-11-13T09:00:00"), now)).toBe("Fri 13 Nov, 09:00");
    expect(formatFollowUpDue(dhaka("2027-01-04T09:00:00"), now)).toBe("Mon 4 Jan 2027, 09:00");
  });
});
