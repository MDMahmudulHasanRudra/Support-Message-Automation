import { countMetric } from "./metrics.js";
import { prisma } from "@support-automation/db";
import type { ConnectionStatus } from "../provider/WhatsAppProvider.js";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { catchUpMissedMessages } from "../pipeline/catchUpMissedMessages.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { trackTick } from "../lifecycle.js";
import { raiseCollectionAlert } from "./collectionAlert.js";
import { recordLoopTick, registerLoop } from "./loopLiveness.js";

/** Name this loop reports itself under in the per-loop liveness view. */
const LOOP_NAME = "collection-watchdog";

/**
 * Answers the question nothing else in this system could: "we look healthy, so why is nothing
 * arriving?"
 *
 * This is the failure mode with no symptom. A session reporting CONNECTED, a worker heartbeating,
 * every queue draining — and not one incoming message being stored, because the listener is wired
 * to a browser that no longer exists. That really happened (see the listener fix in
 * `OpenWAProvider`), it was total, and it was invisible, because "no messages arriving" and "a
 * quiet afternoon" are the same observation.
 *
 * The trick is not to infer anything from silence. Silence alone is not evidence — a group can be
 * quiet for six hours at night and nothing is wrong. So when an account has been quiet for a while,
 * this asks the browser what IT has seen. If WhatsApp holds messages newer than the newest one we
 * stored, the two disagree, and that disagreement is proof rather than suspicion.
 *
 * And having proved it, it fixes it: the same catch-up sweep that fills a reconnect's gap recovers
 * exactly those messages. An alarm that only tells somebody to go and look would leave the
 * customers unanswered until they did.
 *
 * ---
 *
 * **What the 18 Sep 2026 outage added, and why it is not a bigger version of the same check.**
 *
 * The original was gated on `status: "CONNECTED"`, which is the one filter guaranteed to miss the
 * failure that actually happened. Messages stopped at 07:06 and nobody knew until 10:22, because
 * the account was not CONNECTED and not DISCONNECTED — it was RECONNECTING, which is an absorbing
 * state nothing recovers from and nothing watches, while the dashboard cheerfully said the worker
 * was bringing the session back up.
 *
 * So the selection is no longer a status. It is **every account that ought to be collecting** — one
 * that has connected before and has monitored groups to collect from — and the status is then
 * something this reads and reacts to rather than something it trusts. Two consequences worth
 * keeping:
 *
 * - **The status checks are not gated on silence.** They are claims about state, not inferences
 *   from quiet, so they run on every tick. Only the probe — the expensive part, a chat enumeration —
 *   waits for the quiet threshold.
 * - **A probe can now fail**, and failing is a finding rather than a skip. `fetchMessagesSince`
 *   catches its own enumeration error and returns `[]`, which meant a browser that could not be
 *   queried at all logged "quiet for 195m and WhatsApp agrees" — the watchdog's try/catch could
 *   never fire, because nothing ever threw. `probeCollection` reports that case, and
 *   `NOT_COLLECTING` and `UNREADABLE` are now different findings with different wording.
 */

const WATCHDOG_INTERVAL_MS = 15 * 60_000;

/**
 * The four thresholds below are read at CALL time, not module-load time, so a deployment can tune
 * one without a code change and a test can exercise a boundary without reloading the module.
 * Reading an env var per tick is free at a fifteen-minute interval.
 *
 * How long an account must have stored nothing before it is worth asking the browser about. Long
 * enough that an ordinary lull never triggers the check, since the check costs a chat enumeration.
 */
const quietThresholdMs = () => Number(process.env.COLLECTION_QUIET_THRESHOLD_MINUTES || 45) * 60_000;

/**
 * How long RECONNECTING is allowed to last before it is treated as stuck.
 *
 * Generous on purpose. A session with valid stored credentials goes OPENING → SYNCING → CONNECTED
 * in seconds, so anything approaching this is not a slow reconnect. The one genuinely slow path —
 * waiting on a QR scan — leaves RECONNECTING the moment a code is rendered (QR_AVAILABLE maps to
 * AUTHENTICATION_REQUIRED), and that raises its own alert, correctly, because it needs a person.
 */
const reconnectingGraceMs = () => Number(process.env.COLLECTION_RECONNECTING_GRACE_MINUTES || 20) * 60_000;

/**
 * How long a DISCONNECTED/ERROR account is left to `recoverIfDropped` before this says something.
 *
 * That loop retries on a 5-minute cooldown, so this is roughly six failed attempts. Raising sooner
 * would alert on every transient drop the system fixes by itself, which is how an alert channel
 * stops being read.
 */
const disconnectedGraceMs = () => Number(process.env.COLLECTION_DISCONNECTED_GRACE_MINUTES || 30) * 60_000;

/**
 * Consecutive failed probes before an unreadable session is reported.
 *
 * One is not enough: a single enumeration can fail while WhatsApp Web is mid-refresh, and the next
 * tick answers normally. Two consecutive failures, fifteen minutes apart, is a session that cannot
 * be read rather than one that was briefly busy.
 */
const UNKNOWN_STRIKES_BEFORE_ALERT = 2;

/** Enough to prove a disagreement exists. Recovering them is the sweep's job, not this one's. */
const PROBE_LIMIT = 5;

/**
 * What is wrong, in the terms somebody has to act on. Each maps to a different thing to do, which
 * is the whole reason they are separate rather than one "unhealthy".
 */
export type CollectionProblem =
  /** Reported CONNECTED, but WhatsApp holds messages that were never stored. The invisible one. */
  | "NOT_COLLECTING"
  /** Reported CONNECTED, and the session could not be read at all to find out. */
  | "UNREADABLE"
  /** Stuck mid-reconnect past every reasonable bound. Nothing will clear it but a restart or a person. */
  | "STUCK_RECONNECTING"
  /** Waiting for somebody with the phone. Never retried — correctly — so nothing else would say so. */
  | "NEEDS_HUMAN"
  /** Down, and automatic recovery has had long enough to fail. */
  | "DOWN";

export interface CollectionCheck {
  accountId: string;
  label: string;
  /** Null when this account has never stored a message — a number being set up, not one gone deaf. */
  quietForMinutes: number | null;
  /** Messages WhatsApp holds that we never stored. Only meaningful for NOT_COLLECTING. */
  missed: number;
  /** Null when this account is fine. */
  problem: CollectionProblem | null;
  /** Why, in plain language — what the alert and the log line both carry. */
  reason: string | null;
}

/**
 * Per-account memory between ticks. Lives in the process, like every other counter here — there is
 * nothing here worth a table, and a restart genuinely should start the clocks again.
 */
interface WatchState {
  /** Null when this account is currently fine. */
  problem: CollectionProblem | null;
  /** When `problem` began. Meaningless while `problem` is null. */
  since: number;
  /** Zero means this occurrence has not been alerted yet — which is exactly the transition test. */
  lastAlertAt: number;
  /**
   * Failed probes in a row. Deliberately independent of `problem`: it belongs to the probe, and
   * only a CONNECTED account probes, so a session that drops and comes back should not inherit
   * strikes from before — but a single tick that reads badly and then reads fine should not
   * either, which is what `resetStrikes` on a good read is for.
   */
  consecutiveUnknownProbes: number;
}

const watchStates = new Map<string, WatchState>();

/** Test seam: the state is what makes suppression work, so a test asserting it must start clean. */
export function resetWatchdogState(): void {
  watchStates.clear();
}

/**
 * How long before the same unresolved problem is raised again.
 *
 * Alerting on every tick would bury the alert under itself; alerting once and never again loses
 * the one that arrived at 3am. Hours, so an unresolved outage keeps saying so without becoming
 * noise.
 */
const repeatAlertMs = () => Number(process.env.COLLECTION_REPEAT_ALERT_HOURS || 4) * 3_600_000;

/**
 * Checks every account that ought to be collecting. Never throws — a watchdog that can take down
 * the thing it watches is worse than no watchdog.
 */
export async function checkCollectionHealth(registry: ProviderRegistry): Promise<CollectionCheck[]> {
  const findings: CollectionCheck[] = [];

  // Not "which accounts are CONNECTED" — that question is what missed the outage. This one is
  // about obligation rather than state: a number that has connected before (so it is genuinely
  // linked, not one mid-setup) and is in groups (so it has something to collect) is supposed to be
  // receiving messages, whatever it currently claims.
  //
  // ACTIVE groups, not MONITORED ones. Monitoring decides whether automation may answer; it says
  // nothing about whether messages must be collected — the inbox, Team Performance and "waiting
  // for a reply" all read every stored message. On 24 Sep 2026 production ran with zero monitored
  // groups, used purely as an inbox, and this selection skipped it entirely while its page had
  // lost WhatsApp for hours. A spare number in no groups at all still stays silent.
  const accounts = await prisma.whatsAppAccount.findMany({
    where: {
      lastConnectedAt: { not: null },
      groups: { some: { isActive: true } },
    },
    select: { id: true, label: true },
  });

  const liveAccountIds = new Set(accounts.map((a) => a.id));
  for (const accountId of watchStates.keys()) {
    // An account that stopped qualifying — unmonitored, or logged out — must not keep its strike
    // count, or it would alert on its first bad tick if it ever came back.
    if (!liveAccountIds.has(accountId)) watchStates.delete(accountId);
  }

  for (const account of accounts) {
    try {
      const finding = await checkOneAccount(registry, account);
      if (finding) findings.push(finding);
    } catch (err) {
      // One account's check failing must not stop the others being checked — the whole point is
      // that this runs when things are already going wrong.
      console.error(`[watchdog] check failed for account ${account.id}`, err);
    }
  }

  return findings;
}

async function checkOneAccount(
  registry: ProviderRegistry,
  account: { id: string; label: string },
): Promise<CollectionCheck | null> {
  const provider = registry.get(account.id);
  const status: ConnectionStatus = provider?.getConnectionStatus() ?? "DISCONNECTED";

  const newest = await prisma.message.findFirst({
    where: { accountId: account.id },
    orderBy: { timestampWa: "desc" },
    select: { timestampWa: true },
  });
  const quietForMs = newest ? Date.now() - newest.timestampWa.getTime() : null;
  const quietForMinutes = quietForMs === null ? null : Math.round(quietForMs / 60_000);

  const base = { accountId: account.id, label: account.label, quietForMinutes, missed: 0 };

  // --- Status checks. Not gated on silence: these are claims about state, and an account stuck
  // --- mid-reconnect is just as stuck during a busy hour as during a quiet one.

  if (status === "AUTHENTICATION_REQUIRED" || status === "SESSION_ERROR") {
    // Never retried, and that is right — both need somebody holding the phone, and reconnecting in
    // a loop would rotate a QR code nobody is looking at forever. The missing half was that
    // nothing told anyone. This is that half; it does not touch the retry rule.
    if (await operatorIsHandlingIt(account.id)) {
      // Not a problem while somebody is mid-link, and the clock must not keep running underneath
      // them either — otherwise finishing a link would be followed by an alert about it.
      clearProblem(account.id);
      return null;
    }
    enterProblem(account.id, "NEEDS_HUMAN");
    return report(registry, {
      ...base,
      problem: "NEEDS_HUMAN",
      reason:
        status === "AUTHENTICATION_REQUIRED"
          ? "This number is waiting for somebody to scan a QR code or enter a pairing code. It will not reconnect on its own."
          : "This number's saved session was rejected by WhatsApp. It has to be linked again from the phone.",
    });
  }

  if (status === "RECONNECTING") {
    const stuckFor = enterProblem(account.id, "STUCK_RECONNECTING");
    if (stuckFor < reconnectingGraceMs()) return null;
    return report(registry, {
      ...base,
      problem: "STUCK_RECONNECTING",
      reason: `Stuck mid-reconnect for ${Math.round(stuckFor / 60_000)} minutes. Nothing clears this state by itself — the dashboard will keep saying the worker is bringing the session back up.`,
    });
  }

  if (status === "DISCONNECTED" || status === "ERROR") {
    // `recoverIfDropped` owns this one and retries every five minutes. Only worth reporting once
    // it has plainly not worked.
    const downFor = enterProblem(account.id, "DOWN");
    if (downFor < disconnectedGraceMs()) return null;
    return report(registry, {
      ...base,
      problem: "DOWN",
      reason: `Offline for ${Math.round(downFor / 60_000)} minutes. Automatic reconnection has been retrying every five minutes and has not brought it back.`,
    });
  }

  // --- CONNECTED. Everything below is the original check: prove a disagreement rather than infer
  // --- one from silence.

  // Deliberately NOT cleared up front. A session that is still not collecting on this tick is the
  // same unresolved problem as last tick, and clearing first would restart its suppression clock
  // every fifteen minutes — turning the four-hour repeat into a four-hour flood. The state is
  // cleared only where health is positively established, which is the two returns below and the
  // agreement case further down.

  // Never stored anything at all: a number still being set up, not a number that went deaf.
  if (quietForMs === null) {
    clearProblem(account.id);
    return null;
  }
  if (quietForMs < quietThresholdMs()) {
    // A message arrived recently, which is the strongest possible evidence that collection works.
    clearProblem(account.id);
    resetStrikes(account.id);
    return null;
  }

  const probe = await provider!.probeCollection(newest!.timestampWa, PROBE_LIMIT);

  if (!probe.ok) {
    // The distinction this whole phase turns on. An unreadable session is NOT agreement — it is
    // the single most likely shape of the failure being hunted, and it used to be logged as
    // "WhatsApp agrees".
    const strikes = countStrike(account.id);
    if (strikes < UNKNOWN_STRIKES_BEFORE_ALERT) {
      console.warn(
        `[watchdog] account "${account.label}" quiet for ${quietForMinutes}m and could not be read (${probe.reason}) — strike ${strikes}/${UNKNOWN_STRIKES_BEFORE_ALERT}`,
      );
      return null;
    }
    enterProblem(account.id, "UNREADABLE");
    return report(registry, {
      ...base,
      problem: "UNREADABLE",
      reason: `Reports itself connected, has stored nothing for ${quietForMinutes} minutes, and the session could not be read to find out why. ${probe.reason}`,
    });
  }

  resetStrikes(account.id);
  const missed = probe.messages.length;

  if (missed === 0) {
    // Genuinely quiet, and genuinely checked. Worth one INFO line so a long silence is on the
    // record as CHECKED rather than merely unreported — the difference matters when somebody asks
    // later. It can be trusted now in a way it could not before: the probe was able to fail, and
    // did not.
    clearProblem(account.id);
    console.log(`[watchdog] account "${account.label}" quiet for ${quietForMinutes}m and WhatsApp agrees`);
    return null;
  }

  countMetric("collectionBreaks");
  enterProblem(account.id, "NOT_COLLECTING");
  const finding = await report(registry, {
    ...base,
    missed,
    problem: "NOT_COLLECTING",
    reason: `Reports itself connected, but WhatsApp is holding ${missed} message(s) newer than anything stored here. Messages are arriving and being dropped.`,
  });

  // Prove it, then fix it. The sweep dedups against what is already stored, so running it here
  // costs nothing when the disagreement turns out to be a single straggler.
  await catchUpMissedMessages(account.id, provider!);

  return finding;
}

/**
 * Records the finding: log line, SystemLog row, and — on a transition or a slow repeat — an alert.
 *
 * Suppression lives here rather than at each branch so no new problem type can forget it.
 */
async function report(registry: ProviderRegistry, finding: CollectionCheck): Promise<CollectionCheck> {
  const problem = finding.problem!;
  // Every caller has already gone through `enterProblem`, which is what owns the transition and
  // the clocks. This only decides whether to make a noise about the state it finds.
  enterProblem(finding.accountId, problem);
  const state = stateFor(finding.accountId);

  console.error(`[watchdog] account "${finding.label}" — ${problem}: ${finding.reason}`);
  await logSystemEvent("ERROR", "provider", "A WhatsApp number has stopped collecting messages", {
    accountId: finding.accountId,
    label: finding.label,
    problem,
    reason: finding.reason,
    quietForMinutes: finding.quietForMinutes,
    missed: finding.missed,
  }).catch(() => undefined);

  // `lastAlertAt === 0` is the transition: `enterProblem` zeroes it whenever the problem changes,
  // so a first sighting and a four-hour-old unresolved one are the two cases that speak.
  const firstTime = state.lastAlertAt === 0;
  const dueForRepeat = Date.now() - state.lastAlertAt >= repeatAlertMs();
  if (firstTime || dueForRepeat) {
    state.lastAlertAt = Date.now();
    // Never allowed to throw: an alerting failure must not stop the catch-up sweep that runs after
    // it, and must not take down the check for every other account.
    await raiseCollectionAlert(registry, finding).catch((err) =>
      console.error("[watchdog] could not raise the collection alert", err),
    );
  }

  return finding;
}

const freshState = (): WatchState => ({ problem: null, since: Date.now(), lastAlertAt: 0, consecutiveUnknownProbes: 0 });

function stateFor(accountId: string): WatchState {
  const existing = watchStates.get(accountId);
  if (existing) return existing;
  const created = freshState();
  watchStates.set(accountId, created);
  return created;
}

/**
 * Marks this account as being in `problem` and returns how long it has been there.
 *
 * Entering a problem it was not already in restarts both clocks — the grace timer and the
 * suppression one — so a different failure is never silenced by an earlier one's recent alert.
 * Returns 0 on that first sighting, which is what makes the grace-period branches read as
 * "it has only just started".
 */
function enterProblem(accountId: string, problem: CollectionProblem): number {
  const state = stateFor(accountId);
  if (state.problem === problem) return Date.now() - state.since;
  state.problem = problem;
  state.since = Date.now();
  state.lastAlertAt = 0;
  return 0;
}

/** This account is fine. Keeps the strike count, which only a probe may change. */
function clearProblem(accountId: string): void {
  const state = watchStates.get(accountId);
  if (!state || state.problem === null) return;
  state.problem = null;
  state.lastAlertAt = 0;
}

function countStrike(accountId: string): number {
  const state = stateFor(accountId);
  state.consecutiveUnknownProbes += 1;
  return state.consecutiveUnknownProbes;
}

function resetStrikes(accountId: string): void {
  const state = watchStates.get(accountId);
  if (state) state.consecutiveUnknownProbes = 0;
}

/**
 * True when somebody is already dealing with this number from the dashboard.
 *
 * Same check `recoverIfDropped` makes, and for the same reason: an operator linking a new number
 * or deliberately logging one out produces exactly the states this alerts on, and telling them
 * their number needs attention while they are the one giving it to it is how an alert channel
 * teaches people to ignore it.
 */
async function operatorIsHandlingIt(accountId: string): Promise<boolean> {
  try {
    const pending = await prisma.workerCommand.findFirst({
      where: {
        accountId,
        status: { in: ["PENDING", "PROCESSING"] },
        type: { in: ["RECONNECT", "LOGOUT"] },
      },
      select: { id: true },
    });
    return Boolean(pending);
  } catch {
    // Fail open — an unreadable command table must not swallow the alert.
    return false;
  }
}

export function startCollectionWatchdog(
  registry: ProviderRegistry,
  intervalMs = WATCHDOG_INTERVAL_MS,
): NodeJS.Timeout {
  // Declared before the first tick, so a loop that dies on its very first run shows as
  // "never ticked" rather than not appearing in the liveness view at all.
  registerLoop(LOOP_NAME, intervalMs);
  let checking = false;
  return setInterval(() => {
    if (checking) return;
    checking = true;
    void trackTick(() => checkCollectionHealth(registry))
      .catch((err) => console.error("[watchdog] collection health check failed", err))
      .finally(() => {
        checking = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
