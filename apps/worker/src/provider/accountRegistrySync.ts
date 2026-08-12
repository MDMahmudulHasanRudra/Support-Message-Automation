import type { ProviderRegistry } from "./ProviderRegistry.js";
import { assignSessionForAccount, findConnectableAccounts, findUnprovisionedAccounts } from "./accountProvisioning.js";

/**
 * Picks up WhatsApp accounts the registry doesn't yet know about — a fresh "Add Account" from
 * the web UI, or (on worker restart) every account that was already connected before the
 * process died. Provisions a session identity for brand-new accounts, then connects anything
 * not already live, ONE AT A TIME (never concurrently — see ProviderRegistry's class doc
 * comment for why).
 */
async function syncOnce(registry: ProviderRegistry): Promise<void> {
  const unprovisioned = await findUnprovisionedAccounts();
  for (const account of unprovisioned) {
    const assigned = await assignSessionForAccount(account);
    console.log(`[registry] assigned session identity to new account "${assigned.label}" (${assigned.id})`);
  }

  const connectable = await findConnectableAccounts();
  for (const account of connectable) {
    if (registry.has(account.id)) continue;
    if (!account.sessionId || !account.sessionDataPath) continue; // just provisioned above; picked up next tick
    console.log(`[registry] connecting newly-discovered account "${account.label}" (${account.id})`);
    await registry.connectAccount({ id: account.id, sessionId: account.sessionId, sessionDataPath: account.sessionDataPath });
  }
}

/**
 * Starts the periodic account-discovery loop. Same overlap-guarded setInterval pattern as every
 * other loop in this worker — connecting a real WhatsApp session can take well over intervalMs
 * (QR scan wait, slow auth), so this must never let a second tick start a second connect() while
 * the first is still in flight.
 */
export function startAccountRegistrySync(registry: ProviderRegistry, intervalMs = 20_000): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    syncOnce(registry)
      .catch((err) => {
        console.error("[registry] unexpected error syncing accounts", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
