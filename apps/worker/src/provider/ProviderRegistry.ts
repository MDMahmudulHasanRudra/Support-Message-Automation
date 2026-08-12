import { OpenWAProvider } from "./openwa/OpenWAProvider.js";
import type { WhatsAppProvider } from "./WhatsAppProvider.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { syncGroupsWithTimeoutAndRetry } from "../commands/commandProcessor.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";

const CONNECT_RETRY_DELAYS_MS = [15_000, 45_000]; // bounded, matching the spec's "safe retry policy" spirit — not unlimited

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
    if (!connected) {
      console.error(`[registry] account ${account.id} failed to connect after all retries`);
      await logSystemEvent("ERROR", "provider", "Failed to connect to WhatsApp after all retries", {
        accountId: account.id,
      });
      return false;
    }

    provider.subscribeToMessages((message) => {
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
      });

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

/**
 * A single transient failure (e.g. WhatsApp Web taking longer than usual to bootstrap) shouldn't
 * require a manual RECONNECT command. Bounded retries only — after these are exhausted, the
 * account is left in ERROR and a manual RECONNECT (or a worker restart) is required.
 */
export async function connectWithRetry(provider: WhatsAppProvider, accountId: string): Promise<boolean> {
  const attempts = CONNECT_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await provider.connect();
      return true;
    } catch (err) {
      const isLastAttempt = attempt === attempts;
      console.error(
        `[worker] account ${accountId} connect attempt ${attempt}/${attempts} failed${isLastAttempt ? "" : " — will retry"}`,
        err,
      );
      await logSystemEvent("ERROR", "provider", `Connect attempt ${attempt}/${attempts} failed`, {
        accountId,
        error: (err as Error).message,
      });
      if (isLastAttempt) return false;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[attempt - 1]));
    }
  }
  return false;
}
