import { platformPrisma, prisma } from "../db.js";
import { withAccountProject } from "../project/context.js";
import type { WhatsAppAccount } from "@prisma/client";
import type { ProviderRegistry } from "./ProviderRegistry.js";
import { assignSessionForAccount, findConnectableAccounts, findUnprovisionedAccounts } from "./accountProvisioning.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { resyncAndCatchUpAfterConnect } from "../commands/commandProcessor.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";

/** Name this loop reports itself under in the per-loop liveness view. */
const LOOP_NAME = "account-registry-sync";

/**
 * How long to leave a dropped session alone before trying it again. Bounded retrying, in the same
 * spirit as ProviderRegistry's CONNECT_RETRY_DELAYS_MS: rebuilding a session means killing and
 * relaunching Chromium, and doing that every twenty seconds against a number WhatsApp is refusing
 * is worse for the account than being offline.
 */
const RECOVERY_COOLDOWN_MS = 5 * 60_000;

/**
 * States worth retrying without a human. Deliberately not AUTHENTICATION_REQUIRED or
 * SESSION_ERROR: both mean somebody has to scan a QR with the phone, and reconnecting in a loop
 * would spin forever while rotating a code nobody is looking at.
 */
const RECOVERABLE = new Set(["DISCONNECTED", "ERROR"]);

const lastRecoveryAttempt = new Map<string, number>();

/**
 * How often a CONNECTED session is asked whether WhatsApp is really still running inside it — see
 * `checkSessionHealth` in OpenWAProvider. Two failed checks trip it, so a dead page is handed to
 * recovery within about five minutes; the check itself is one line evaluated in the page.
 */
const HEALTH_CHECK_INTERVAL_MS = 2 * 60_000;
const lastHealthCheck = new Map<string, number>();

/**
 * Drops providers for accounts that no longer exist in the database.
 *
 * This is how a dashboard delete reaches the worker, and it has to be reconciliation rather than a
 * `WorkerCommand`: `WorkerCommand.accountId` is `onDelete: Cascade`, so a command announcing that
 * an account was deleted would be deleted along with it. The registry-sync loop already reads the
 * account table every pass, which makes the comparison free — the row is simply gone.
 *
 * Before this the registry only ever grew. Deleting an account cascaded its rows away and left the
 * worker holding a live provider and its Chromium until the process restarted, still listed by
 * `allAccountIds()` — which `pickSendingAccount` chooses from when it needs a number to raise a
 * collection alert through.
 *
 * Runs FIRST in the tick, before anything is connected: releasing a dead entry is quick and cannot
 * block, while the connect below deliberately returns after one account.
 */
export async function releaseDeletedAccounts(registry: ProviderRegistry): Promise<void> {
  const held = registry.allAccountIds();
  if (!held.length) return;

  // Across every project: the registry holds every project's sessions.
  // An account whose project was ARCHIVED is released the same way as a deleted one (§8):
  // disconnected, never logged out.
  const live = await platformPrisma.whatsAppAccount.findMany({
    where: { id: { in: held }, project: { status: { not: "ARCHIVED" } } },
    select: { id: true },
  });
  const liveIds = new Set(live.map((row) => row.id));

  for (const accountId of held) {
    if (liveIds.has(accountId)) continue;
    const released = await registry.disconnectAccount(accountId);
    // Its recovery cooldown is keyed by the same id and is never read again — small, but it is
    // the same class of leak this function exists to close.
    lastRecoveryAttempt.delete(accountId);
    if (!released) continue;
    console.log(`[registry] account ${accountId} no longer exists or its project is archived — released its session`);
    await logSystemEvent("INFO", "provider", "Released the session of a deleted account", { accountId }).catch(
      () => undefined,
    );
  }
}

/**
 * Picks up WhatsApp accounts the registry doesn't yet know about — a fresh "Add Account" from
 * the web UI, or (on worker restart) every account that was already connected before the
 * process died. Provisions a session identity for brand-new accounts, then connects anything
 * not already live, ONE AT A TIME (never concurrently — see ProviderRegistry's class doc
 * comment for why).
 *
 * It also checks on the ones it already knows, which it previously never did — see
 * `recoverIfDropped`.
 */
async function syncOnce(registry: ProviderRegistry): Promise<void> {
  await releaseDeletedAccounts(registry);

  const unprovisioned = await findUnprovisionedAccounts();
  for (const account of unprovisioned) {
    const assigned = await assignSessionForAccount(account);
    console.log(`[registry] assigned session identity to new account "${assigned.label}" (${assigned.id})`);
  }

  const connectable = await findConnectableAccounts();
  for (const account of connectable) {
    if (!account.sessionId || !account.sessionDataPath) continue; // just provisioned above; picked up next tick

    if (registry.has(account.id)) {
      await recoverIfDropped(registry, account);
      continue;
    }

    console.log(`[registry] connecting newly-discovered account "${account.label}" (${account.id})`);
    await registry.connectAccount({ id: account.id, sessionId: account.sessionId, sessionDataPath: account.sessionDataPath });

    // ONE account per pass, and this `return` is the whole point of it.
    //
    // `connectAccount` awaits `connectWithRetry` — three attempts, each of which can wait ten
    // minutes for a QR scan, plus a minute of backoff: about half an hour for a single number
    // nobody is scanning. For that entire time this loop was inside one iteration, so no other
    // account was discovered, no other account was connected, and — worst of all — no dropped
    // session was recovered, because `recoverIfDropped` is called from the same loop. A healthy
    // number that dropped at minute two waited behind the one that was never coming back.
    //
    // index.ts documents this hazard at length as FIXED: taking the connect loop off the startup
    // path is what let the heartbeat, the command processor and the outbound queue keep running
    // while an account waits. That was true and it was not the whole fix — the hazard was moved
    // into this loop, not removed, and here it blocks the one thing that could rescue the others.
    //
    // Returning costs nothing: the next tick is twenty seconds away and picks up where this left
    // off. It also keeps the never-two-concurrent-connects rule trivially true, since the overlap
    // guard already prevents a second pass starting while this one is still inside `connect()`.
    return;
  }
}

/**
 * Brings a session that has dropped back up, without waiting for somebody to notice.
 *
 * The registry holds a provider for the life of the process, so an account whose session died was
 * previously skipped forever by the loop above — `has()` was true, and nothing else ever looked at
 * whether it was still working. A number could sit disconnected for a day collecting nothing, with
 * the only remedy a human pressing Reconnect on a dashboard nobody had reason to open. Messages
 * arriving in that window are not delayed, they are gone: live delivery is a push.
 *
 * Whatever this recovers, the connect itself re-wires the message listener and the sweep below
 * fills what the gap swallowed.
 *
 * Only for a number that was genuinely working and stopped. `lastConnectedAt` rules out one that
 * has never been linked, and `phoneNumber` rules out one somebody deliberately logged out — LOGOUT
 * clears it. Without that second check this would relaunch Chromium every few minutes for a retired
 * spare number, rotating a QR code nobody is looking at, forever.
 */
async function recoverIfDropped(registry: ProviderRegistry, account: WhatsAppAccount): Promise<void> {
  // Everything below — the pending-command check, the log lines — is the account's own project's.
  return withAccountProject(account.id, () => recoverIfDroppedInProject(registry, account));
}

async function recoverIfDroppedInProject(registry: ProviderRegistry, account: WhatsAppAccount): Promise<void> {
  const accountId = account.id;
  const provider = registry.get(accountId);
  if (!provider) return;
  if (!account.lastConnectedAt || !account.phoneNumber) return;

  // A session can claim CONNECTED with no WhatsApp left in its page, and that raises no state
  // change for the check below to see. Asking now and then is what turns it into DISCONNECTED,
  // which this function already knows how to recover.
  if (provider.getConnectionStatus() === "CONNECTED" && provider.checkSessionHealth) {
    const lastChecked = lastHealthCheck.get(accountId) ?? 0;
    if (Date.now() - lastChecked >= HEALTH_CHECK_INTERVAL_MS) {
      lastHealthCheck.set(accountId, Date.now());
      await provider.checkSessionHealth().catch((err) =>
        console.error(`[registry] session health check errored for account ${accountId}`, err),
      );
    }
  }

  const status = provider.getConnectionStatus();
  if (!RECOVERABLE.has(status)) return;

  const lastAttempt = lastRecoveryAttempt.get(accountId) ?? 0;
  if (Date.now() - lastAttempt < RECOVERY_COOLDOWN_MS) return;

  // Leave it alone if somebody is already dealing with it from the dashboard. A queued RECONNECT
  // is about to do this anyway, and LOGOUT means a person is deliberately taking the session
  // somewhere — quietly reconnecting underneath them would undo it.
  const operatorAction = await prisma.workerCommand.findFirst({
    where: {
      accountId,
      status: { in: ["PENDING", "PROCESSING"] },
      type: { in: ["RECONNECT", "LOGOUT"] },
    },
    select: { id: true },
  });
  if (operatorAction) return;

  lastRecoveryAttempt.set(accountId, Date.now());

  console.log(`[registry] account "${account.label}" (${accountId}) is ${status} — attempting to bring it back`);
  await logSystemEvent("WARN", "provider", "Session dropped — reconnecting automatically", { accountId, status });

  try {
    await provider.disconnect();
    await provider.connect();
  } catch (err) {
    console.error(`[registry] automatic recovery failed for account ${accountId} — will retry after the cooldown`, err);
    await logSystemEvent("ERROR", "provider", "Automatic reconnect failed", {
      accountId,
      error: (err as Error).message,
    });
    return;
  }

  // What the attempt actually achieved, which was never recorded — only that one was made.
  //
  // That gap hides a trapdoor. A recovery attempt can move an account from DISCONNECTED, which
  // this loop retries, to AUTHENTICATION_REQUIRED, which it deliberately never will: WhatsApp
  // decided the stored session is no longer valid and wants a person with the phone. So the very
  // act of trying to fix it can take the account OUT of the recoverable set and into the one
  // nothing here will ever touch again — and the log said only "reconnecting automatically",
  // leaving somebody reading it later to assume recovery was still being attempted.
  //
  // The collection watchdog raises the alert for that state; this makes the transition itself
  // legible in the log, so the two readings agree about when it happened and why.
  const outcome = provider.getConnectionStatus();
  if (outcome === "CONNECTED") {
    await logSystemEvent("INFO", "provider", "Session recovered automatically", { accountId, status: outcome });
    // The roster can have changed while the session was down — groups joined, groups left — and
    // this path used to connect and stop. Same omission the RECONNECT command had: a recovered
    // account came back reporting CONNECTED against whatever group rows were last written, with
    // nothing scheduled to reconcile them. Not awaited, for the reason in the routine's own doc
    // comment; it also carries the catch-up sweep this function used to run inline below.
    resyncAndCatchUpAfterConnect(accountId, provider, "automatic drop recovery");
  } else {
    console.warn(`[registry] recovery attempt for account ${accountId} ended in ${outcome}`);
    await logSystemEvent(
      outcome === "AUTHENTICATION_REQUIRED" || outcome === "SESSION_ERROR" ? "ERROR" : "WARN",
      "provider",
      "Automatic reconnect did not restore the session",
      {
        accountId,
        status: outcome,
        // Named in the log rather than inferred from the status, because this is the one outcome
        // that silently ends automatic recovery for this account.
        needsAPerson: outcome === "AUTHENTICATION_REQUIRED" || outcome === "SESSION_ERROR",
      },
    );
  }

  // The catch-up sweep used to run here unconditionally, which had two problems now that the group
  // sync above exists. It duplicated the sweep for a recovery that SUCCEEDED, and it raced the sync
  // — filing a message from a group not yet in the database under no group. It also ran for a
  // recovery that failed, where `fetchMessagesSince` has no client and can only return nothing.
  // `resyncAndCatchUpAfterConnect` owns it for the one outcome where there is anything to recover.
}

/**
 * Starts the periodic account-discovery loop. Same overlap-guarded setInterval pattern as every
 * other loop in this worker — connecting a real WhatsApp session can take well over intervalMs
 * (QR scan wait, slow auth), so this must never let a second tick start a second connect() while
 * the first is still in flight.
 *
 * That guard is also what makes this the right owner of the INITIAL connect, which used to be a
 * blocking loop in `main()` ahead of every interval — see the comment there. `immediate` fires one
 * pass straight away so nothing waits for the first tick; it is deliberately not awaited by the
 * caller, because the entire fix is that booting no longer waits on a QR scan.
 */
export function startAccountRegistrySync(
  registry: ProviderRegistry,
  intervalMs = 20_000,
  options: { immediate?: boolean } = {},
): NodeJS.Timeout {
  // Declared before the first tick, so a loop that dies on its very first run shows as
  // "never ticked" rather than not appearing in the liveness view at all.
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;

  const tick = () => {
    if (processing) return;
    processing = true;
    syncOnce(registry)
      .catch((err) => {
        console.error("[registry] unexpected error syncing accounts", err);
      })
      .finally(() => {
        processing = false;
        // Stamped when the tick FINISHES, which is the only moment that proves the loop is not
        // wedged — a guard that never clears is exactly how one of these dies silently.
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  };

  if (options.immediate) tick();
  return setInterval(tick, intervalMs);
}
