import { describe, expect, it } from "vitest";
import { decideBackupHealth, parseBackupStaleHours, sanitizeBackupReason } from "../backupHealth.js";

const NOW = new Date("2026-11-05T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const run = (id: string, status: "SUCCEEDED" | "FAILED", h: number) => ({ id, status, finishedAt: hoursAgo(h) });

describe("decideBackupHealth", () => {
  it("is NONE, with no alert, before any run was recorded", () => {
    expect(decideBackupHealth({ latest: null, latestSuccess: null, now: NOW, staleHours: 26 })).toEqual({ state: "NONE", alert: null, lastSuccessAt: null });
  });

  it("is OK after a recent success", () => {
    const ok = run("s1", "SUCCEEDED", 3);
    expect(decideBackupHealth({ latest: ok, latestSuccess: ok, now: NOW, staleHours: 26 }).state).toBe("OK");
  });

  it("alerts FAILED keyed by the last success, so repeated failures share one key and a new success opens another", () => {
    const good = run("s1", "SUCCEEDED", 30);
    const a = decideBackupHealth({ latest: run("f1", "FAILED", 2), latestSuccess: good, now: NOW, staleHours: 26 });
    const b = decideBackupHealth({ latest: run("f2", "FAILED", 1), latestSuccess: good, now: NOW, staleHours: 26 });
    expect(a.alert).toEqual({ kind: "FAILED", key: "FAILED:s1" });
    expect(b.alert).toEqual(a.alert);
    const after = decideBackupHealth({ latest: run("f3", "FAILED", 0), latestSuccess: run("s2", "SUCCEEDED", 1), now: NOW, staleHours: 26 });
    expect(after.alert?.key).toBe("FAILED:s2");
    expect(decideBackupHealth({ latest: run("f1", "FAILED", 1), latestSuccess: null, now: NOW, staleHours: 26 }).alert?.key).toBe("FAILED:never");
  });

  it("alerts STALE when the last success is older than the threshold, and never when the threshold is 0", () => {
    const old = run("s1", "SUCCEEDED", 30);
    expect(decideBackupHealth({ latest: old, latestSuccess: old, now: NOW, staleHours: 26 }).alert).toEqual({ kind: "STALE", key: "STALE:s1" });
    expect(decideBackupHealth({ latest: old, latestSuccess: old, now: NOW, staleHours: 0 }).state).toBe("OK");
  });
});

describe("parseBackupStaleHours", () => {
  it("defaults to 26, accepts whole hours and 0, and falls back on anything unreadable", () => {
    expect(parseBackupStaleHours(undefined)).toBe(26);
    expect(parseBackupStaleHours("48")).toBe(48);
    expect(parseBackupStaleHours("0")).toBe(0);
    expect(parseBackupStaleHours("two days")).toBe(26);
  });
});

describe("sanitizeBackupReason", () => {
  it("removes paths, connection strings and credentials", () => {
    const out = sanitizeBackupReason("only 12 MB free in /home/rudra/backups/get-assist, need 900 MB. postgresql://u:p@db:5432/x password=hunter2 C:\\backups\\x");
    expect(out).not.toMatch(/home|rudra|hunter2|postgresql|backups/);
    expect(out).toContain("[path]");
    expect(out).toContain("only 12 MB free in");
    expect(sanitizeBackupReason(null)).toBeNull();
    expect(sanitizeBackupReason("x".repeat(500))!.length).toBe(300);
  });
});

describe("backup alert retries", () => {
  it("back off 5 min, 15 min, 1 h, 3 h, 6 h, then stop", async () => {
    const { nextBackupAlertAttempt, BACKUP_ALERT_MAX_ATTEMPTS } = await import("../backupHealth.js");
    const t0 = new Date("2026-11-06T00:00:00Z");
    const mins = [1, 2, 3, 4, 5].map((a) => (nextBackupAlertAttempt(a, t0)!.getTime() - t0.getTime()) / 60_000);
    expect(mins).toEqual([5, 15, 60, 180, 360]);
    expect(nextBackupAlertAttempt(BACKUP_ALERT_MAX_ATTEMPTS, t0)).toBeNull();
  });

  it("retry only what certainly was not delivered", async () => {
    const { isConfirmedNonDelivery } = await import("../backupHealth.js");
    for (const kind of ["NOT_SENT", "TEMPORARY", "PERMANENT", "AUTH"] as const) expect(isConfirmedNonDelivery(kind)).toBe(true);
    expect(isConfirmedNonDelivery("UNKNOWN")).toBe(false);
  });
});
