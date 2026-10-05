import { describe, expect, it } from "vitest";
import {
  formatOperationTarget,
  operationPollMs,
  sortOperations,
  summariseAddJob,
  summariseAdminJob,
  type AddJobInput,
  type AdminJobInput,
} from "../whatsappOperations.js";

const NOW = new Date("2026-10-04T10:00:00Z");
const addJob = (over: Partial<AddJobInput> = {}): AddJobInput => ({
  id: "a1",
  status: "RUNNING",
  phoneNumbers: ["8801700000001"],
  queuedCount: 850,
  accountLabel: "Primary",
  accountConnected: true,
  createdAt: new Date("2026-10-04T09:00:00Z"),
  completedAt: null,
  cancelledAt: null,
  byStatus: {},
  current: null,
  ...over,
});
const adminJob = (over: Partial<AdminJobInput> = {}): AdminJobInput => ({
  id: "m1",
  status: "RUNNING",
  statusReason: null,
  phoneNumber: "8801700000009",
  accountLabel: "Primary",
  totalGroups: 1850,
  adminGroups: 126,
  createdAt: new Date("2026-10-04T08:00:00Z"),
  completedAt: null,
  cancelledAt: null,
  counts: { checked: 342, promoted: 76, alreadyAdmin: 21, notMember: 25, failed: 0 },
  ...over,
});

describe("Add Number to Groups", () => {
  it("running: adds done of the adds queued, and the pair in flight", () => {
    const op = summariseAddJob(
      addJob({
        byStatus: { ADDED: 100, SKIPPED_ALREADY_MEMBER: 20, FAILED: 4, PENDING: 725, PROCESSING: 1, ALREADY_MEMBER: 1, NOT_SELECTED: 3 },
        current: { phoneNumber: "8801700000001", groupName: "Customer Support", processing: true, scheduledAt: NOW },
      }),
      NOW,
    );
    expect(op).toMatchObject({ state: "RUNNING", stateLabel: "Processing", processed: 124, total: 850, progressLabel: "Adds done" });
    expect(op.current).toBe("Adding +8801700000001 → Customer Support");
    // Already member counts the check's finding and the add-time skip together.
    expect(op.counts).toEqual([
      { label: "Added", value: 100, tone: "success" },
      { label: "Already member", value: 21, tone: "neutral" },
      { label: "Failed", value: 4, tone: "danger" },
    ]);
  });

  it("the next pair, with how long until it is due", () => {
    const op = summariseAddJob(
      addJob({ current: { phoneNumber: "8801700000001", groupName: "Billing", processing: false, scheduledAt: new Date(NOW.getTime() + 75_000) } }),
      NOW,
    );
    expect(op.current).toBe("Next in 1m 15s: +8801700000001 → Billing");
  });

  it("a disconnected account is a wait, with the position it will carry on from", () => {
    const op = summariseAddJob(addJob({ accountConnected: false, byStatus: { ADDED: 342, PENDING: 508 } }), NOW);
    expect(op.state).toBe("WAITING_ACCOUNT");
    expect(op.detail).toContain("carries on from 342 / 850");
    expect(op.current).toBeNull();
  });

  it("checking, then waiting for review — pairs checked of all pairs", () => {
    const checking = summariseAddJob(addJob({ status: "CHECKING", queuedCount: 0, byStatus: { PENDING_CHECK: 30, CHECKING: 10, READY: 50, ALREADY_MEMBER: 10 } }), NOW);
    expect(checking).toMatchObject({ state: "CHECKING", processed: 60, total: 100 });
    const review = summariseAddJob(addJob({ status: "AWAITING_REVIEW", queuedCount: 0, byStatus: { READY: 80, CANNOT_VERIFY: 5, ALREADY_MEMBER: 10, NO_PERMISSION: 5 } }), NOW);
    expect(review).toMatchObject({ state: "REVIEW", processed: 100, total: 100 });
    expect(review.counts.map((c) => [c.label, c.value])).toEqual([["Can be added", 85], ["Already member", 10], ["Cannot add", 5]]);
  });

  it("finished: completed, completed with failures, stopped, cancelled", () => {
    const done = new Date("2026-10-04T09:50:00Z");
    expect(summariseAddJob(addJob({ status: "COMPLETED", completedAt: done, byStatus: { ADDED: 850 } }), NOW)).toMatchObject({ state: "COMPLETED", finishedAt: done.toISOString() });
    expect(summariseAddJob(addJob({ status: "COMPLETED", completedAt: done, byStatus: { ADDED: 812, SKIPPED_ALREADY_MEMBER: 21, FAILED: 17 } }), NOW).state).toBe("PARTIAL");
    expect(summariseAddJob(addJob({ status: "STOPPED_KILL_SWITCH", cancelledAt: done }), NOW)).toMatchObject({ state: "STOPPED", finishedAt: done.toISOString() });
    expect(summariseAddJob(addJob({ status: "CANCELLED", cancelledAt: done }), NOW).state).toBe("CANCELLED");
  });
});

describe("Groups Admin Maker", () => {
  it("groups checked of all groups, with the eligible count once known", () => {
    const op = summariseAdminJob(adminJob());
    expect(op).toMatchObject({ state: "RUNNING", processed: 342, total: 1850, target: "+8801700000009" });
    expect(op.counts.map((c) => c.label)).toEqual(["Eligible", "Promoted", "Already admin", "Not a member", "Failed"]);
    expect(summariseAdminJob(adminJob({ status: "CHECKING", adminGroups: null })).counts[0]!.label).toBe("Promoted");
  });

  it("a pause says why and needs a person", () => {
    const op = summariseAdminJob(adminJob({ status: "PAUSED_DISCONNECTED", statusReason: "Reconnect the account, then press Resume." }));
    expect(op).toMatchObject({ state: "PAUSED", detail: "Reconnect the account, then press Resume." });
  });

  it("finished states", () => {
    expect(summariseAdminJob(adminJob({ status: "COMPLETED" })).state).toBe("COMPLETED");
    expect(summariseAdminJob(adminJob({ status: "COMPLETED", counts: { checked: 1850, promoted: 76, alreadyAdmin: 21, notMember: 25, failed: 4 } })).state).toBe("PARTIAL");
    expect(summariseAdminJob(adminJob({ status: "FAILED" })).state).toBe("FAILED");
    expect(summariseAdminJob(adminJob({ status: "CANCELLED" })).state).toBe("CANCELLED");
  });
});

describe("one view of every kind", () => {
  it("names the target, one number or several", () => {
    expect(formatOperationTarget(["8801700000001"])).toBe("+8801700000001");
    expect(formatOperationTarget(["8801700000001", "8801700000002", "8801700000003"])).toBe("+8801700000001 and 2 more");
  });

  it("active first in the order started, then finished newest first", () => {
    const running = summariseAdminJob(adminJob({ id: "run", createdAt: new Date("2026-10-04T08:00:00Z") }));
    const review = summariseAddJob(addJob({ id: "rev", status: "AWAITING_REVIEW", createdAt: new Date("2026-10-04T07:00:00Z") }), NOW);
    const oldDone = summariseAdminJob(adminJob({ id: "old", status: "COMPLETED", completedAt: new Date("2026-10-04T06:00:00Z") }));
    const newDone = summariseAddJob(addJob({ id: "new", status: "COMPLETED", completedAt: new Date("2026-10-04T09:00:00Z") }), NOW);
    expect(sortOperations([oldDone, running, newDone, review]).map((o) => o.id)).toEqual(["rev", "run", "new", "old"]);
  });

  it("polls fast only while the worker is moving something", () => {
    const working = summariseAdminJob(adminJob());
    const waiting = summariseAddJob(addJob({ status: "AWAITING_REVIEW" }), NOW);
    const done = summariseAdminJob(adminJob({ status: "COMPLETED" }));
    expect(operationPollMs([done, working])).toBe(3_000);
    expect(operationPollMs([done, waiting])).toBe(15_000);
    expect(operationPollMs([done])).toBe(30_000);
    expect(operationPollMs([])).toBe(30_000);
  });
});

describe("clearing an operation from one person's tracker", () => {
  it("is called Hide while the job still runs or waits for Resume, Clear once finished or ready for review", async () => {
    const { operationClearLabel } = await import("../whatsappOperations.js");
    expect(["CHECKING", "RUNNING", "WAITING_ACCOUNT", "PAUSED"].map((s) => operationClearLabel(s as never))).toEqual(["Hide", "Hide", "Hide", "Hide"]);
    expect(["REVIEW", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "STOPPED"].map((s) => operationClearLabel(s as never))).toEqual(Array(6).fill("Clear"));
  });

  it("holds while the state is the one it was cleared in, and lapses when the job moves on", async () => {
    const { isOperationCleared } = await import("../whatsappOperations.js");
    expect(isOperationCleared({ state: "REVIEW" }, { stateAtDismissal: "REVIEW" })).toBe(true);
    expect(isOperationCleared({ state: "RUNNING" }, { stateAtDismissal: "REVIEW" })).toBe(false);
    expect(isOperationCleared({ state: "COMPLETED" }, { stateAtDismissal: "RUNNING" })).toBe(false);
    expect(isOperationCleared({ state: "COMPLETED" }, undefined)).toBe(false);
  });
});
