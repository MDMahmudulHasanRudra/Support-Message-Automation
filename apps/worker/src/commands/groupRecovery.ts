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
 * - **Four kinds of work, and the difference is the point.**
 *   - `RETRY` — the account's recorded sync status is FAILED or PARTIAL: a sync said "not finished".
 *     Re-read slowly and without a cap (2, 5, 10, 30 minutes, then every 6 hours) until no group
 *     that was ACTIVE is missing from the list. This is what "genuinely incomplete" means.
 *   - `FOLLOW` — the account connected within the last `followWindowMs` (24 h). A newly linked
 *     phone keeps sending chats for hours after the connect's own passes stop (twenty minutes), and
 *     the original worker collected those overnight only because nothing ever closed its browser
 *     and a later sync found them. So a recent connection is re-read slowly (2, 5, 10, then every
 *     30 minutes; a find starts over) until the window ends. Never writes the status: arriving
 *     groups are not a failure. GROUP_SYNC.md §10.
 *   - `VERIFY` — the sync says COMPLETED but the account holds inactive groups. Those are history
 *     (a group left long ago, or a logout's casualties) and are NOT pending work: they never change
 *     the status. They are checked a bounded number of times per connection (`verifyMaxReads`
 *     reads in a row that find nothing), only to catch a group WhatsApp lists late; a find starts
 *     the count over, and the account is left alone after that until it reconnects.
 *   - `DAILY` — none of the above: a settled account. Read once a day (`dailyCheckMs`, 24 h), ADD_ONLY,
 *     never writing the status. A sync can say COMPLETED with 500 of 1,800 groups when the phone
 *     delivered the rest after the 24 h FOLLOW window, and nothing else would ever look again until
 *     a message arrived from each missing group or somebody pressed Resync. One read of the chat
 *     store is seconds even for ~1,900 groups, so a day is a small price for that.
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
  /** How long after a connect the phone may still be delivering chats worth following (FOLLOW). */
  followWindowMs: (Number(process.env.WHATSAPP_GROUP_FOLLOW_WINDOW_HOURS) || 24) * 60 * 60_000,
  /** FOLLOW's own cadence: the same start, but it never slows past 30 minutes inside the window. */
  followBackoffMs: [2, 5, 10, 30].map((minutes) => minutes * 60_000),
  /** A VERIFY account is left alone after this many reads in a row that found nothing. */
  verifyMaxReads: 4,
  /**
   * DAILY: how long a settled account goes between add-only reads. `WHATSAPP_GROUP_DAILY_CHECK_HOURS=0`
   * switches it off (back to "a settled account is never read again"). Mutable for tests.
   */
  dailyCheckMs: (process.env.WHATSAPP_GROUP_DAILY_CHECK_HOURS === "0" ? 0 : Number(process.env.WHATSAPP_GROUP_DAILY_CHECK_HOURS) || 24) * 60 * 60_000,
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
  /** DAILY only: this connection's VERIFY budget was spent, so its inactive groups are not counted again. */
  verifySpent?: boolean;
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

/** The wait for one kind of work: FOLLOW keeps its own, shorter ceiling. */
export function backoffFor(kind: GroupRecoveryMode, step: number): number {
  return backoffAfter(step, kind === "FOLLOW" ? GROUP_RECOVERY_SETTINGS.followBackoffMs : GROUP_RECOVERY_SETTINGS.backoffMs);
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

/**
 * What an account's stored state says about its group list; null means nothing to do. A sync that
 * said "not finished" comes first, then a recent connection still worth following (its ADD_ONLY
 * read also brings back any inactive group WhatsApp lists), then inactive groups worth a check.
 */
async function recoveryKind(
  accountId: string,
  groupSyncStatus: string | null,
  sinceConnectMs: number,
  verifyDone: boolean,
): Promise<GroupRecoveryMode | null> {
  if (groupSyncStatus === "FAILED" || groupSyncStatus === "PARTIAL") return "RETRY";
  if (sinceConnectMs < GROUP_RECOVERY_SETTINGS.followWindowMs) return "FOLLOW";
  if (!verifyDone) {
    const hasInactive = await withAccountProject(accountId, async () => (await prisma.whatsAppGroup.count({ where: { accountId, isActive: false } })) > 0);
    if (hasInactive) return "VERIFY";
  }
  return GROUP_RECOVERY_SETTINGS.dailyCheckMs > 0 ? "DAILY" : null;
}

/**
 * When the first DAILY read is due: a day after the account's list was last read in full or followed
 * (the last completed sync, or the end of the FOLLOW window), and never sooner than the shortest wait.
 * The schedule is in memory, so a restart costs at most one early read — cheap, and never a missed one.
 */
function firstDailyAt(connectedAt: number, completedAt: number | null, now: number): number {
  const lastLooked = Math.max(completedAt ?? 0, connectedAt + GROUP_RECOVERY_SETTINGS.followWindowMs);
  return Math.max(now + backoffFor("DAILY", 0), lastLooked + GROUP_RECOVERY_SETTINGS.dailyCheckMs);
}

function firstSighting(kind: GroupRecoveryMode, connectedAt: number, now: number, completedAt: number | null = null): RecoveryState {
  const nextAt = kind === "DAILY" ? firstDailyAt(connectedAt, completedAt, now) : now + backoffFor(kind, 0);
  return { kind, step: 1, nextAt, noGrowthReads: 0, done: false, connectedAt };
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
    select: { id: true, projectId: true, groupSyncStatus: true, lastConnectedAt: true, groupSyncCompletedAt: true },
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

    // A VERIFY account whose budget is spent for this connection moves on to the DAILY read (no count).
    const prior = states.get(account.id);
    const verifyDone =
      prior?.connectedAt === connectedAt && (prior.kind === "VERIFY" ? prior.done : prior.verifySpent === true);
    const completedAt = account.groupSyncCompletedAt?.getTime() ?? null;
    // With the daily read off, a spent VERIFY is the end for this connection: keep the spent schedule
    // (forgetting it would start VERIFY over on the next tick) and cost nothing, not even the count.
    const statusIsIncomplete = account.groupSyncStatus === "FAILED" || account.groupSyncStatus === "PARTIAL";
    if (verifyDone && !statusIsIncomplete && GROUP_RECOVERY_SETTINGS.dailyCheckMs === 0) continue;

    const kind = await recoveryKind(account.id, account.groupSyncStatus, now() - connectedAt, verifyDone);
    if (!kind) {
      states.delete(account.id); // nothing is pending any more
      continue;
    }
    if (!prior || prior.kind !== kind || prior.connectedAt !== connectedAt) {
      // First sighting, a restart, a reconnect or a change of kind: wait the shortest delay first.
      // A spent VERIFY budget travels with the DAILY schedule, so its inactive groups are not re-verified.
      states.set(account.id, { ...firstSighting(kind, connectedAt, now(), completedAt), verifySpent: verifyDone && kind === "DAILY" });
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
        states.set(account.id, { ...prior, step: step + 1, nextAt: now() + backoffFor(kind, step) });
        return { ran: true, accountId: account.id, result: "UNKNOWN" };
      }

      if (kind === "RETRY") {
        if (result.pending === 0) {
          states.delete(account.id);
          return { ran: true, accountId: account.id, result: "RECOVERED", pending: 0 };
        }
        states.set(account.id, result.grew ? firstSighting(kind, connectedAt, now()) : { ...prior, step: step + 1, nextAt: now() + backoffFor(kind, step) });
        return { ran: true, accountId: account.id, result: result.grew ? "RECOVERED" : "NO_CHANGE", pending: result.pending };
      }

      // FOLLOW: a find starts the cadence over; nothing new waits longer, up to its 30-minute
      // ceiling. No budget: the window since the connect is what ends it.
      if (kind === "FOLLOW") {
        states.set(account.id, result.grew ? firstSighting(kind, connectedAt, now()) : { ...prior, step: step + 1, nextAt: now() + backoffFor(kind, step) });
        return { ran: true, accountId: account.id, result: result.grew ? "RECOVERED" : "NO_CHANGE", pending: result.pending };
      }

      // DAILY: once a day whatever it found; a find is logged by the pass itself.
      if (kind === "DAILY") {
        states.set(account.id, { ...prior, step: 1, nextAt: now() + GROUP_RECOVERY_SETTINGS.dailyCheckMs });
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
        nextAt: now() + backoffFor(kind, step),
      });
      return { ran: true, accountId: account.id, result: "NO_CHANGE", pending: result.pending };
    } catch (err) {
      if (err instanceof GroupSyncCancelledError) {
        states.delete(account.id); // a logout or reconnect owns the account now
        return { ran: true, accountId: account.id, result: "SKIPPED" };
      }
      // Still loading, session not ready, timeout, a failed write: a longer wait, never a loop.
      states.set(account.id, { ...prior, step: step + 1, nextAt: now() + backoffFor(kind, step) });
      console.warn(`[groupsync] GROUP_RECOVERY_FAILED account ${account.id}: ${(err as Error).message.slice(0, 200)}`);
      await withAccountProject(account.id, () =>
        logSystemEvent("WARN", "provider", "GROUP_RECOVERY_FAILED", { accountId: account.id, error: (err as Error).message.slice(0, 300), nextWaitMs: backoffFor(kind, step) }),
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
