import type { WhatsAppProvider } from "./WhatsAppProvider.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";

/**
 * Bounded, matching the spec's "safe retry policy" spirit — not unlimited.
 *
 * The gaps are deliberately short. This retries an attempt that produced NOTHING — no QR, no link
 * code — so nobody is waiting on a screen during the pause; making somebody wait a minute for a
 * second chance at a code that never arrived would be the wrong kind of caution.
 */
const DEFAULT_CONNECT_RETRY_DELAYS_MS = [15_000, 45_000];

/**
 * Overridable so a test can prove the retry happens without sitting out a real minute of backoff.
 * Same shape as the other timing overrides on this path (`WHATSAPP_CONNECT_WATCHDOG_MS`,
 * `COMMAND_STUCK_TIMEOUT_MINUTES`). A malformed or empty value keeps the real schedule rather than
 * silently becoming "retry immediately", which against WhatsApp is the dangerous direction.
 */
function retryDelays(): number[] {
  const raw = process.env.WHATSAPP_CONNECT_RETRY_DELAYS_MS;
  if (!raw) return DEFAULT_CONNECT_RETRY_DELAYS_MS;
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length > 0 ? parsed : DEFAULT_CONNECT_RETRY_DELAYS_MS;
}

/**
 * Connecting, with the retries a single transient failure deserves.
 *
 * Lives in its own module rather than in `ProviderRegistry`, where it began, purely to break an
 * import cycle: `ProviderRegistry` imports the group sync from `commandProcessor`, and the
 * RECONNECT handler in `commandProcessor` needs this. Importing it back from the registry would
 * close that loop at runtime, and this codebase has already lost a production outage to two
 * modules disagreeing about how an import resolves — not a risk worth taking for a convenience.
 *
 * After these are exhausted the account is left in ERROR, and a manual RECONNECT or a worker
 * restart is required. That ceiling is the point: an unbounded retry against WhatsApp is how an
 * account gets itself banned.
 */
export async function connectWithRetry(provider: WhatsAppProvider, accountId: string): Promise<boolean> {
  const delays = retryDelays();
  const attempts = delays.length + 1;
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
      if (isLastAttempt) {
        // Never allowed to change the outcome: recording the state is a courtesy to the dashboard.
        await provider.recordLinkingGaveUp?.().catch(() => undefined);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
    }
  }
  return false;
}
