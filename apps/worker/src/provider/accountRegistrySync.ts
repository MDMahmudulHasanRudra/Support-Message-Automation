import { prisma } from "@support-automation/db";
import type { WhatsAppAccount } from "@prisma/client";
import type { ProviderRegistry } from "./ProviderRegistry.js";
import { assignSessionForAccount, findConnectableAccounts, findUnprovisionedAccounts } from "./accountProvisioning.js";
import { catchUpMissedMessages } from "../pipeline/catchUpMissedMessages.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";

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
  const accountId = account.id;
  const provider = registry.get(accountId);
  if (!provider) return;
  if (!account.lastConnectedAt || !account.phoneNumber) return;

  const status = provider.getConnectionStatus();
  if (!RECOVERABLE.has(status)) return;

  const lastAttempt = lastRecoveryAttempt.get(accountId) ?? 0;
  if (Date.now() - lastAttempt < RECOVERY_COOLDOWN_MS) return;

  // Leave it alone if somebody is already dealing with it from the dashboard. A queued RECONNECT
  // is about to do this anyway, and LOGOUT/GET_QR mean a person is deliberately taking the session
  // somewhere — quietly reconnecting underneath them would undo it.
  const operatorAction = await prisma.workerCommand.findFirst({
    where: {
      accountId,
      status: { in: ["PENDING", "PROCESSING"] },
      type: { in: ["RECONNECT", "LOGOUT", "GET_QR"] },
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

  await catchUpMissedMessages(accountId, provider);
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
      });
  };

  if (options.immediate) tick();
  return setInterval(tick, intervalMs);
}
