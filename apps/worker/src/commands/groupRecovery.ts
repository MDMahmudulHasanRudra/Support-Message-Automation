import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { platformPrisma, prisma } from "../db.js";
import { projectIsOperating, withAccountProject } from "../project/context.js";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import type { BrowserUsage } from "../provider/WhatsAppProvider.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { trackTick } from "../lifecycle.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import {
  GROUP_ARRIVAL_SETTINGS,
  GroupSyncCancelledError,
  isGroupSyncRunning,
  runGroupRecoveryPass,
  type GroupRecoveryMode,
} from "./commandProcessor.js";

/**
 * Finishing a group list that never finished arriving (GROUP_SYNC.md section 8).
 *
 * The connect's own passes (`watchGroupListArrival`) read for at most twenty minutes and stop. If
 * WhatsApp had not delivered the whole list by then — or the sync failed under load, or the worker
 * restarted mid-sync — the account sat CONNECTED with `groupSyncStatus` FAILED/PARTIAL and nothing
 * ever read the list again: the groups stayed missing or inactive until somebody pressed Resync.
 * (Reproduced in the lab: a session recovered after the worker's own health check failed under CPU
 * load came back with 477 of 573 known groups, settled there and stopped.)
 *
 * What it does, and as much what it never does:
 *
 * - **ADD_ONLY, always** (`runGroupRecoveryPass`). It cannot deactivate a group and it cannot
 *   activate one WhatsApp does not list. The FULL sync and its sweep guard are untouched.
 * - **Two kinds of work, and the difference is the point.**
 *   - `RETRY` — the account's recorded sync status is FAILED or PARTIAL: a sync said "not finished".
 *     Re-read slowly and without a cap (2, 5, 10, 30 minutes, then every 6 hours) until no group
 *     that was ACTIVE is missing from the list. This is what "genuinely incomplete" means.
 *   - `VERIFY` — the sync says COMPLETED but the account holds inactive groups. Those are history
 *     (a group left long ago, or a logout's casualties) and are NOT pending work: they never change
 *     the status. They are checked a bounded number of times per connection (`verifyMaxReads`
 *     reads in a row that find nothing), only to catch a group WhatsApp lists late; a find starts
 *     the count over, and the account is left alone after that until it reconnects.
 * - **The need is read from the database, the schedule is not.** A restart loses only *when* to
 *   look. A reconnect (`lastConnectedAt` changes) starts a fresh schedule, as does a change of kind.
 * - **Never beside the connect's own passes.** An account connected less than the arrival window
 *   ago (plus a minute) belongs to the watcher; the first look after that waits the shortest delay.
 * - **At most one read per tick across all accounts, and none while the machine is busy.**
 * - **Only an account that is really there:** CONNECTED in the database AND in the provider, with a
 *   phone number (LOGOUT clears it, and a logged-out account's groups are inactive on purpose), in a
 *   project that is operating, and not already syncing. A logout or reconnect during the read
 *   cancels it through the sync generation.
 * - **A read that did not happen is not a result.** See `runGroupRecoveryPass`: an unavailable
 *   provider or an empty list is UNKNOWN, writes nothing, and only lengthens the wait.
 */

const LOOP_NAME = "group-recovery";

export const GROUP_RECOVERY_SETTINGS = {
  tickMs: Number(process.env.WHATSAPP_GROUP_RECOVERY_TICK_MS) || 60_000,
  /** Wait before the next look: first sighting, then each look that found nothing new. The last repeats. */
  backoffMs: [2, 5, 10, 30, 6 * 60].map((minutes) => minutes * 60_000),
  /** A VERIFY account is left alone after this many reads in a row that found nothing. */
  verifyMaxReads: 4,
  /** The connect's own arrival passes run this long (plus the follow-up sync); recovery stays out of their way. */
  afterConnectQuietMs: GROUP_ARRIVAL_SETTINGS.maxMs + 60_000,
  /**
   * "Busy" thresholds. Not derived from measurement of a production incident — they are starting
   * values, overridable without a code change, and the real protection is the read's own timeout
   * plus the backoff, which a busy page lengthens by itself. Note that load per CPU tops out near 1
   * on a fully saturated host, so a value above that can never trigger.
   */
  maxLoadPerCpu: Number(process.env.WHATSAPP_GROUP_RECOVERY_MAX_LOAD_PER_CPU) || 1.5,
  maxEventLoopDelayMs: Number(process.env.WHATSAPP_GROUP_RECOVERY_MAX_EVENT_LOOP_DELAY_MS) || 250,
  /**
   * Deferring for load is bounded: after this many busy ticks in a row (30 = about half an hour at
   * the 60 s tick) the next due read goes ahead anyway. A host that is saturated for hours is the
   * host this recovery exists for, and one read — itself time-limited, and followed by the backoff —
   * is a bounded cost; an indefinite deferral is not a safety property, it is the outage continuing.
   */
  maxDeferredTicks: Number(process.env.WHATSAPP_GROUP_RECOVERY_MAX_DEFERRED_TICKS) || 30,
  /**
   * The browser's own CPU (`WhatsAppProvider.getBrowserUsage`: this process tree plus Chromium),
   * as cores busy per available CPU. **0 = off, and off is the default**: it is always measured and
   * written to the pass's System Log entry (`browser`), but it only defers a read once somebody has
   * chosen a number from those measurements. A threshold picked without them would be a guess.
   * Deferral is bounded by `maxDeferredTicks` like the other load signals.
   */
  maxBrowserLoadPerCpu: Number(process.env.WHATSAPP_GROUP_RECOVERY_MAX_BROWSER_LOAD_PER_CPU) || 0,
};

interface RecoveryState {
  kind: GroupRecoveryMode;
  /** Index into `backoffMs` of the wait that applies after the next unsuccessful look. */
  step: number;
  nextAt: number;
  /** VERIFY only: reads in a row that found nothing. */
  noGrowthReads: number;
  /** VERIFY only: the budget is spent; stays until the account reconnects or changes kind. */
  done: boolean;
  /** `lastConnectedAt` this schedule belongs to. A different one means a new connection. */
  connectedAt: number;
}

/** Only the schedule. What needs recovering is always re-derived from the database. */
const states = new Map<string, RecoveryState>();

/** Test seam, and what a restart amounts to: the schedule is forgotten, the database is not. */
export function resetGroupRecoveryState(): void {
  states.clear();
  busyStreak = 0;
  browserBusyStreak = 0;
}

/** Consecutive ticks skipped for load. Only the policy's own bookkeeping; not persisted. */
let busyStreak = 0;
/** The same, for the browser-CPU signal (checked per account, just before its read). */
let browserBusyStreak = 0;

/** Read-only view of an account's schedule, for tests and diagnostics. */
export function groupRecoverySchedule(accountId: string): { step: number; nextAt: number; kind: GroupRecoveryMode; done: boolean } | null {
  const state = states.get(accountId);
  return state ? { step: state.step, nextAt: state.nextAt, kind: state.kind, done: state.done } : null;
}

export function backoffAfter(step: number, backoffMs: readonly number[] = GROUP_RECOVERY_SETTINGS.backoffMs): number {
  return backoffMs[Math.min(step, backoffMs.length - 1)]!;
}

export interface MachineLoad {
  loadPerCpu: number;
  eventLoopDelayMs: number;
}

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
let loopDelayEnabled = false;

/**
 * Load since the last call. `os.loadavg()` is the host VM's in Docker, which is the pressure that
 * matters here; it is `[0, 0, 0]` on Windows and a missing or non-finite figure reads as "not busy"
 * — recovery is bounded by its backoff either way, so an unreadable metric must not stop it.
 */
export function readMachineLoad(): MachineLoad {
  const load = os.loadavg()[0]! / os.availableParallelism();
  const loadPerCpu = Number.isFinite(load) ? load : 0;
  if (!loopDelayEnabled) {
    loopDelay.enable();
    loopDelayEnabled = true;
    return { loadPerCpu, eventLoopDelayMs: 0 };
  }
  const p99 = loopDelay.percentile(99) / 1e6;
  loopDelay.reset();
  return { loadPerCpu, eventLoopDelayMs: Number.isFinite(p99) ? p99 : 0 };
}

export function isOverloaded(load: MachineLoad, settings = GROUP_RECOVERY_SETTINGS): boolean {
  return load.loadPerCpu > settings.maxLoadPerCpu || load.eventLoopDelayMs > settings.maxEventLoopDelayMs;
}

/** Browser CPU as cores busy per available CPU; null when the provider cannot say. */
export function browserLoadPerCpu(usage: BrowserUsage | null): number | null {
  if (!usage || !Number.isFinite(usage.cpuPercent)) return null;
  return usage.cpuPercent / 100 / os.availableParallelism();
}

export interface RecoveryDeps {
  now?: () => number;
  load?: () => MachineLoad;
}

export type RecoveryTickReport =
  | { ran: false; reason: "OVERLOADED" | "NOTHING_DUE" }
  | { ran: true; accountId: string; result: "RECOVERED" | "NO_CHANGE" | "UNKNOWN" | "ERROR" | "SKIPPED"; pending?: number };

/** What an account's stored state says about its group list; null means nothing to do. */
async function recoveryKind(accountId: string, groupSyncStatus: string | null): Promise<GroupRecoveryMode | null> {
  if (groupSyncStatus === "FAILED" || groupSyncStatus === "PARTIAL") return "RETRY";
  const hasInactive = await withAccountProject(accountId, async () => (await prisma.whatsAppGroup.count({ where: { accountId, isActive: false } })) > 0);
  return hasInactive ? "VERIFY" : null;
}

function firstSighting(kind: GroupRecoveryMode, connectedAt: number, now: number): RecoveryState {
  return { kind, step: 1, nextAt: now + backoffAfter(0), noGrowthReads: 0, done: false, connectedAt };
}

/**
 * One tick: look at every account, run at most ONE recovery read. Exported for tests and for the
 * loop below; it never throws for an account's own failure.
 */
export async function checkGroupRecovery(registry: ProviderRegistry, deps: RecoveryDeps = {}): Promise<RecoveryTickReport> {
  const now = deps.now ?? Date.now;
  const load = (deps.load ?? readMachineLoad)();
  if (isOverloaded(load)) {
    busyStreak += 1;
    if (busyStreak <= GROUP_RECOVERY_SETTINGS.maxDeferredTicks) return { ran: false, reason: "OVERLOADED" };
    busyStreak = 0; // deferred long enough: let this tick's due read (if any) through
  } else {
    busyStreak = 0;
  }

  const accounts = await platformPrisma.whatsAppAccount.findMany({
    where: { status: "CONNECTED", phoneNumber: { not: null }, lastConnectedAt: { not: null } },
    select: { id: true, projectId: true, groupSyncStatus: true, lastConnectedAt: true },
    orderBy: { createdAt: "asc" },
  });
  // Forget accounts that no longer qualify as present at all (deleted, disconnected, logged out).
  const present = new Set(accounts.map((account) => account.id));
  for (const id of [...states.keys()]) if (!present.has(id)) states.delete(id);

  for (const account of accounts) {
    if (!(await projectIsOperating(account.projectId))) continue;
    const provider = registry.get(account.id);
    if (!provider || provider.getConnectionStatus() !== "CONNECTED") continue;
    if (isGroupSyncRunning(account.id)) continue;

    const connectedAt = account.lastConnectedAt!.getTime();
    // The connect's own arrival passes read this account for a while yet.
    if (now() - connectedAt < GROUP_RECOVERY_SETTINGS.afterConnectQuietMs) {
      states.delete(account.id);
      continue;
    }

    // A VERIFY account whose budget is spent for this connection costs nothing: not even the count.
    const prior = states.get(account.id);
    const statusIsIncomplete = account.groupSyncStatus === "FAILED" || account.groupSyncStatus === "PARTIAL";
    if (prior?.done && prior.connectedAt === connectedAt && !statusIsIncomplete) continue;

    const kind = await recoveryKind(account.id, account.groupSyncStatus);
    if (!kind) {
      states.delete(account.id); // nothing is pending any more
      continue;
    }
    if (!prior || prior.kind !== kind || prior.connectedAt !== connectedAt) {
      // First sighting, a restart, a reconnect or a change of kind: wait the shortest delay first.
      states.set(account.id, firstSighting(kind, connectedAt, now()));
      continue;
    }
    if (prior.done || now() < prior.nextAt) continue;
    const step = prior.step;

    // The browser's own CPU: always measured (it goes into the pass's log so a threshold can be
    // chosen from real numbers), and only acted on when a threshold has been set. Unknown = not busy.
    const usage = (await provider.getBrowserUsage?.().catch(() => null)) ?? null;
    const perCpu = browserLoadPerCpu(usage);
    if (GROUP_RECOVERY_SETTINGS.maxBrowserLoadPerCpu > 0 && perCpu !== null && perCpu > GROUP_RECOVERY_SETTINGS.maxBrowserLoadPerCpu) {
      browserBusyStreak += 1;
      if (browserBusyStreak <= GROUP_RECOVERY_SETTINGS.maxDeferredTicks) return { ran: false, reason: "OVERLOADED" };
      browserBusyStreak = 0; // deferred long enough: this read goes ahead
    } else {
      browserBusyStreak = 0;
    }
    const browser = usage
      ? { cpuPercent: Math.round(usage.cpuPercent), memoryMb: Math.round(usage.memoryBytes / 1_048_576), processes: usage.processes }
      : null;

    try {
      const result = await runGroupRecoveryPass(account.id, provider, kind, { browser });
      if (!result) return { ran: true, accountId: account.id, result: "SKIPPED" };

      if (result.kind === "UNKNOWN") {
        // Nothing was learned: wait longer, and do not spend a VERIFY read on it.
        states.set(account.id, { ...prior, step: step + 1, nextAt: now() + backoffAfter(step) });
        return { ran: true, accountId: account.id, result: "UNKNOWN" };
      }

      if (kind === "RETRY") {
        if (result.pending === 0) {
          states.delete(account.id);
          return { ran: true, accountId: account.id, result: "RECOVERED", pending: 0 };
        }
        states.set(account.id, result.grew ? firstSighting(kind, connectedAt, now()) : { ...prior, step: step + 1, nextAt: now() + backoffAfter(step) });
        return { ran: true, accountId: account.id, result: result.grew ? "RECOVERED" : "NO_CHANGE", pending: result.pending };
      }

      // VERIFY: a find starts the count over; enough empty-handed reads end it for this connection.
      if (result.grew) {
        states.set(account.id, firstSighting(kind, connectedAt, now()));
        return { ran: true, accountId: account.id, result: "RECOVERED", pending: result.pending };
      }
      const noGrowthReads = prior.noGrowthReads + 1;
      states.set(account.id, {
        ...prior,
        noGrowthReads,
        done: noGrowthReads >= GROUP_RECOVERY_SETTINGS.verifyMaxReads,
        step: step + 1,
        nextAt: now() + backoffAfter(step),
      });
      return { ran: true, accountId: account.id, result: "NO_CHANGE", pending: result.pending };
    } catch (err) {
      if (err instanceof GroupSyncCancelledError) {
        states.delete(account.id); // a logout or reconnect owns the account now
        return { ran: true, accountId: account.id, result: "SKIPPED" };
      }
      // Still loading, session not ready, timeout, a failed write: a longer wait, never a loop.
      states.set(account.id, { ...prior, step: step + 1, nextAt: now() + backoffAfter(step) });
      console.warn(`[groupsync] GROUP_RECOVERY_FAILED account ${account.id}: ${(err as Error).message.slice(0, 200)}`);
      await withAccountProject(account.id, () =>
        logSystemEvent("WARN", "provider", "GROUP_RECOVERY_FAILED", { accountId: account.id, error: (err as Error).message.slice(0, 300), nextWaitMs: backoffAfter(step) }),
      ).catch(() => undefined);
      return { ran: true, accountId: account.id, result: "ERROR" };
    }
  }
  return { ran: false, reason: "NOTHING_DUE" };
}

export function startGroupRecoveryProcessor(registry: ProviderRegistry, intervalMs = GROUP_RECOVERY_SETTINGS.tickMs): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void trackTick(() => checkGroupRecovery(registry))
      .catch((err) => console.error("[groupsync] group recovery tick failed", err))
      .finally(() => {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
