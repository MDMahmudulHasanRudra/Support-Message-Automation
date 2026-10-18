import { countMetric } from "../health/metrics.js";
import { OpenWAProvider } from "./openwa/OpenWAProvider.js";
import type { WhatsAppProvider } from "./WhatsAppProvider.js";
import { processWithRetry } from "../pipeline/retryFailedMessage.js";
import { processIncomingMessage, storeMissedMessage } from "../pipeline/processIncomingMessage.js";
import { shouldAutomateRecoveredMessage } from "../pipeline/catchUpMissedMessages.js";
import { recordCollection } from "../health/collectionByKind.js";
import type { RawIncomingMessage } from "../pipeline/types.js";
import { resyncAndCatchUpAfterConnect } from "../commands/commandProcessor.js";
import { catchUpMissedMessages } from "../pipeline/catchUpMissedMessages.js";
import { countDroppedMessage } from "../pipeline/dropCounter.js";
import { recordMessageAck, recordMessageRevoked } from "../pipeline/messageUpdates.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
// Moved to its own module to break the ProviderRegistry <-> commandProcessor import cycle; still
// re-exported here so existing callers and tests are unaffected by where it lives.
import { connectWithRetry } from "./connectWithRetry.js";
export { connectWithRetry };

/**
 * A message the provider hands over after its arrival (`deliveredLate`: WhatsApp decrypted it late)
 * follows the catch-up's rule, not the live one: inside the automation window it is processed as
 * usual; older, it is stored and counted but runs no rules — a reply to a question from an hour ago
 * is worse than none, exactly as for a message recovered after a gap.
 */
async function processLateMessage(raw: RawIncomingMessage): Promise<void> {
  if (shouldAutomateRecoveredMessage(raw.timestampWa, Date.now())) await processIncomingMessage(raw);
  else await storeMissedMessage(raw);
}

/** What the registry needs to know to bring one account's session up. */
export interface AccountSession {
  id: string;
  sessionId: string;
  sessionDataPath: string;
}

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

  /** How a provider is built for an account. Replaceable by a test, which must never launch Chromium. */
  constructor(
    private readonly createProvider: (account: AccountSession) => WhatsAppProvider = (account) =>
      new OpenWAProvider(account.id, account.sessionId, account.sessionDataPath),
  ) {}

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

  /** The pipeline's handlers on one provider: messages, unreadable messages, receipts and deletions. */
  private wireHandlers(accountId: string, provider: WhatsAppProvider): void {
    // A message the provider could not even convert never reaches the handler below, so it is
    // counted here: what this number answers is "how many messages went wrong", and an over-count
    // that makes somebody look is better than an under-count that lets a shape change pass quietly.
    provider.onMessageConversionError = (err) => {
      countDroppedMessage(accountId, "PIPELINE_ERROR");
      logSystemEvent("ERROR", "pipeline", "Could not read an incoming message", {
        error: (err as Error)?.message ?? String(err),
        accountId,
      }).catch(() => undefined);
    };

    provider.subscribeToMessages((message) => {
      // Counted here rather than after storing: the question this answers is whether the provider
      // is still handing anything over at all, and a message dropped by a later filter still
      // proves it was. A message handed over late (decrypted after it arrived) was counted when it
      // arrived, as `undecrypted`, so it is not counted again here.
      countMetric("received");
      if (!message.deliveredLate) recordCollection(accountId, message.chatId, "received");
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
      // A failure is retried a few times before it is counted as a drop (retryFailedMessage.ts); the
      // count and the System Logs entry it always produced are written when every chance is used.
      void processWithRetry(message, message.deliveredLate ? processLateMessage : undefined);
    });

    // Receipts and deletions on messages already seen (CHAT_RICH_MESSAGING.md). Facts only: each sets
    // a column on a stored row and starts nothing. Both writers swallow their own errors.
    provider.subscribeToMessageUpdates?.((update) => {
      if (update.kind === "ACK") void recordMessageAck(update.accountId, update.whatsappMessageId, update.ackLevel);
      else void recordMessageRevoked(update.accountId, update.whatsappMessageId);
    });
  }

  /**
   * Connects one account and wires it into the message pipeline exactly as index.ts used to do
   * for the single account it owned. Awaited fully by every caller before moving to the next
   * account — see the class doc comment for why that matters here specifically.
   */
  async connectAccount(account: AccountSession): Promise<boolean> {
    const provider = this.createProvider(account);
    this.providers.set(account.id, provider);

    // Wired BEFORE the connect, never after it. When this connect gives up (a QR nobody scanned at
    // boot, or an operator's Connect abandoning this attempt so it runs out of tries first) the
    // provider stays registered and this method is never called for the account again — so the
    // RECONNECT or drop recovery that later connects it reaches a provider that must already hold
    // its handlers. Wiring them only after success left exactly that session CONNECTED and deaf:
    // nothing pushed in, and only the ten-minute reconcile sweep brought messages in, late.
    // `connect()` attaches whatever handlers the provider holds, every time it succeeds.
    this.wireHandlers(account.id, provider);

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

    // Deliberately NOT awaited — a slow/failed group sync must never delay this account's message
    // processing (wired before the connect) or the next account's connectAccount() call. Shared with the
    // other two connect paths, which each used to omit it; see the routine's own doc comment.
    resyncAndCatchUpAfterConnect(account.id, provider, "the registry's initial connect");

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

