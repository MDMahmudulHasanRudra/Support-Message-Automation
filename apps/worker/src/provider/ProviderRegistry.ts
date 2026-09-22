import { countMetric } from "../health/metrics.js";
import { OpenWAProvider } from "./openwa/OpenWAProvider.js";
import type { WhatsAppProvider } from "./WhatsAppProvider.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { syncGroupsWithTimeoutAndRetry } from "../commands/commandProcessor.js";
import { catchUpMissedMessages } from "../pipeline/catchUpMissedMessages.js";
import { countDroppedMessage } from "../pipeline/dropCounter.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
// Moved to its own module to break the ProviderRegistry <-> commandProcessor import cycle; still
// re-exported here so existing callers and tests are unaffected by where it lives.
import { connectWithRetry } from "./connectWithRetry.js";
export { connectWithRetry };

/**
 * Owns every connected WhatsApp session in this process — one `OpenWAProvider` (one Chromium
 * browser) per account, keyed by accountId. `OpenWAProvider` was already instance-scoped before
 * multi-account support (constructor takes accountId/sessionId/sessionDataPath, no module-level
 * singleton state — see its own class doc comment), so nothing about the provider itself changed
 * here; this class just holds however many of them are currently live.
 *
 * The one rule every caller of `connectAccount` must follow: never call it for two accounts
 * concurrently. `OpenWAProvider.connect()` does a process-global `process.chdir()` before
 * anything else — two overlapping `connect()` calls could change the cwd out from under each
 * other mid-connect. Every call site in this codebase (the startup loop, the account-sync
 * poller) awaits one account's `connectAccount()` to fully settle before starting the next —
 * intentionally, not by accident.
 */
export class ProviderRegistry {
  // Typed against the WhatsAppProvider interface, not the concrete OpenWAProvider — matches this
  // codebase's existing rule that everything above the provider layer depends only on the
  // abstraction (see WhatsAppProvider.ts's own doc comment), and lets tests register a
  // MockProvider via registerForTesting() without needing a real OpenWA/Puppeteer session.
  private readonly providers = new Map<string, WhatsAppProvider>();

  get(accountId: string): WhatsAppProvider | undefined {
    return this.providers.get(accountId);
  }

  has(accountId: string): boolean {
    return this.providers.has(accountId);
  }

  allAccountIds(): string[] {
    return [...this.providers.keys()];
  }

  /** Test-only seam: registers a provider directly, skipping connectAccount's real connect()/subscribe/sync wiring. */
  registerForTesting(accountId: string, provider: WhatsAppProvider): void {
    this.providers.set(accountId, provider);
  }

  /**
   * Connects one account and wires it into the message pipeline exactly as index.ts used to do
   * for the single account it owned. Awaited fully by every caller before moving to the next
   * account — see the class doc comment for why that matters here specifically.
   */
  async connectAccount(account: { id: string; sessionId: string; sessionDataPath: string }): Promise<boolean> {
    const provider = new OpenWAProvider(account.id, account.sessionId, account.sessionDataPath);
    this.providers.set(account.id, provider);

    const connected = await connectWithRetry(provider, account.id);

    // The account can be removed while this is waiting. `connectWithRetry` is up to three attempts
    // with backoff and a QR wait, so the window is minutes, not milliseconds — long enough for an
    // operator to delete the number in the dashboard and for the next reconciliation pass to drop
    // it. Identity rather than `has()`: a reconnect may already have replaced this entry with a
    // NEWER provider, and tearing that one down would kill a session somebody else just built.
    if (this.providers.get(account.id) !== provider) {
      console.log(`[registry] account ${account.id} was removed while connecting — abandoning this attempt`);
      await provider.disconnect().catch((err) => {
        console.error(`[registry] error releasing an abandoned connect for account ${account.id}`, err);
      });
      return false;
    }

    if (!connected) {
      console.error(`[registry] account ${account.id} failed to connect after all retries`);
      await logSystemEvent("ERROR", "provider", "Failed to connect to WhatsApp after all retries", {
        accountId: account.id,
      });
      return false;
    }

    provider.subscribeToMessages((message) => {
      // Counted here rather than after storing: the question this answers is whether the provider
      // is still handing anything over at all, and a message dropped by a later filter still
      // proves it was.
      countMetric("received");
      // PHASE 6.1: the exact OpenWA -> worker event handoff point — logged here, not inside the
      // provider, since this is the provider-agnostic boundary any future provider implementation
      // would call through identically.
      console.log(
        `[pipeline] [${message.accountId}:${message.whatsappMessageId}] MESSAGE_RECEIVED`,
        JSON.stringify({
          chatId: message.chatId,
          senderPhone: message.senderPhone,
          direction: message.direction,
          isGroup: Boolean(message.whatsappGroupId),
        }),
      );
      processIncomingMessage(message).catch((err) => {
        console.error("[worker] error processing incoming message", err);
        // The message may have been stored before the throw or not at all, and from here there is
        // no way to tell. Counting it either way is the honest choice: what this number answers is
        // "how many messages went wrong", and an over-count that makes somebody look is far better
        // than an under-count that lets a shape change pass as a quiet afternoon.
        countDroppedMessage(message.accountId, "PIPELINE_ERROR");
        logSystemEvent("ERROR", "pipeline", "Error processing incoming message", {
          error: (err as Error).message,
          accountId: message.accountId,
        });
      });
    });

    // Deliberately NOT awaited — a slow/failed group sync must never delay this account's message
    // processing (already wired above) or the next account's connectAccount() call.
    syncGroupsWithTimeoutAndRetry(account.id, provider)
      .then((groupCount) => {
        console.log(`[worker] synced ${groupCount} group(s) for account ${account.id}`);
      })
      .catch((err) => {
        console.error(`[worker] group sync failed after retries for account ${account.id} — connection remains active`, err);
      })
      // Then fill whatever arrived while this account was not listening. After the group sync
      // rather than beside it: a recovered message resolves to a WhatsAppGroup row, and racing the
      // sync would file messages from a newly-joined group under no group at all.
      .then(() => catchUpMissedMessages(account.id, provider));

    return true;
  }

  /**
   * Releases ONE account: its registry entry, its provider and the Chromium behind it.
   *
   * There was no way to do this. The registry only ever grew — `accountRegistrySync` adds an
   * account it does not already hold and never removes one — so deleting an account in the
   * dashboard left the worker holding a live `OpenWAProvider` and a 300-500MB browser for the rest
   * of the process lifetime. `allAccountIds()` went on reporting it too, and `pickSendingAccount`
   * chooses from that list, so a collection alert could be routed through a number the database no
   * longer knows about.
   *
   * The Map entry goes FIRST and the browser second, which is the order that matters: removing it
   * is what stops anything new reaching this provider, and the teardown below can take as long as
   * it takes without a caller picking the account up in the meantime. `disconnect()` is itself
   * bounded and already tolerates having nothing to close, so calling this on an account that is
   * not connected — or calling it twice — is a no-op rather than an error.
   *
   * Returns whether an entry was actually held, so a reconciling caller can log the ones it really
   * released rather than every account it considered.
   */
  async disconnectAccount(accountId: string): Promise<boolean> {
    const provider = this.providers.get(accountId);
    if (!provider) return false;

    this.providers.delete(accountId);

    // Never rethrows. The entry is already gone, so the caller has got what it asked for; a browser
    // that will not close is a leak to report, not a reason to fail the sweep that is trying to
    // clean up after it — and an unhandled rejection here would take the whole worker down.
    try {
      await provider.disconnect();
    } catch (err) {
      console.error(`[registry] error tearing down provider for account ${accountId}`, err);
      await logSystemEvent("ERROR", "provider", "Provider teardown failed after account removal", {
        accountId,
        error: (err as Error).message,
      }).catch(() => undefined);
    }
    return true;
  }

  async disconnectAll(): Promise<void> {
    for (const [accountId, provider] of this.providers) {
      await provider.disconnect().catch((err) => {
        console.error(`[registry] error disconnecting account ${accountId}`, err);
      });
    }
  }
}

