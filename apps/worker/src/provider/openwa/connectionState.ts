import { decryptSecret, prisma } from "@support-automation/db";
import type { WhatsAppAccountStatus } from "@prisma/client";

/**
 * Fine-grained connection lifecycle, logged to SystemLog so the dashboard's
 * Logs page and `docker compose logs worker` both show exactly where a
 * connection attempt is / where it failed. This is intentionally NOT a new
 * database column — the existing WhatsAppAccountStatus enum (see
 * ARCHITECTURE.md; not touched in this phase) still drives the Accounts
 * page's status badge; these finer states are additive, via logs only.
 *
 * Honesty note, revised twice — and the second revision is the one that matters.
 *
 * It originally said that "QR scanned" was not observable through the public API, and that
 * AUTHENTICATING immediately before CONNECTED was the earliest boundary available. That was wrong,
 * and the gap it left was the one a person actually stands in front of.
 *
 * The first correction reached for the obvious candidate: 4.76.0 builds an
 * `EvEmitter(sessionId, 'AUTH')` in `dist/controllers/browser.js`, fired when the page requests
 * `_priority_components`. Structured, boolean, its own namespace. It also never fired once against
 * the WhatsApp Web build actually being served — traced end to end on a real connect. Reading
 * `dist/` establishes what a library CAN emit; only a trace establishes what it does, and the two
 * are not the same answer. `WHATSAPP_DEBUG_EVENTS` exists so the next person can settle it in one
 * reconnect instead of by inference.
 *
 * What the trace showed is that the library narrates the whole lifecycle on `STARTUP.<sessionId>`,
 * including the moment that matters: `QrManager.smartQr` emits "QR code scanned. Loading session..."
 * from the page's own `QR_CODE_SUCCESS` callback. That is a real signal wearing the clothes of a
 * terminal spinner, and AUTHENTICATED below is driven from it — matched exactly, in the provider
 * and nowhere else, degrading to no stage rather than to a wrong one. See
 * `ACCEPTED_STARTUP_MESSAGES` in OpenWAProvider.ts.
 *
 * Genuinely still not observable, and now known rather than assumed:
 *   - The boundary between "browser process launched" and "page finished loading WhatsApp Web" —
 *     the longest part of a cold start. `BROWSER_LAUNCHED`/`WHATSAPP_WEB_LOADING` below are
 *     declared and never written. STARTUP does narrate it ("Launching Browser", "Browser launched:
 *     4349ms"), but as timings rather than states, and the dialog already explains that wait.
 *   - A phone LINK CODE being accepted. `QrManager.linkCode` announces the code and then awaits
 *     `isInsideChat`, emitting nothing in between, so that method reaches CONNECTED with no
 *     intermediate stage. Not worked around: a fabricated "accepted" would be a claim nothing made.
 */
export const OPENWA_CONNECTION_STATES = [
  "STARTING",
  "BROWSER_LAUNCHED",
  "WHATSAPP_WEB_LOADING",
  "WAITING_FOR_QR",
  "QR_AVAILABLE",
  /**
   * WhatsApp accepted the scan (or the typed link code) — see the honesty note above for how this
   * is known rather than guessed. It sits before AUTHENTICATING because it is genuinely earlier:
   * this fires as the page authenticates, while AUTHENTICATING is recorded once `create()` has
   * resolved and the session is all but ready.
   */
  "AUTHENTICATED",
  "AUTHENTICATING",
  /**
   * A code was on screen for the whole linking window and nobody scanned it. Not an error: the
   * attempt did everything right and the person did not get to the phone. It used to be recorded as
   * ERROR, which put "Something went wrong — check System Logs" on the dialog at the one moment the
   * honest message is "time ran out, here is a fresh code" — and `connectWithRetry` starts the fresh
   * attempt a few seconds later on its own.
   */
  "QR_EXPIRED",
  "CONNECTED",
  "DISCONNECTED",
  "RECONNECTING",
  "AUTH_FAILED",
  "ERROR",
] as const;

export type OpenWAConnectionState = (typeof OPENWA_CONNECTION_STATES)[number];

function toAccountStatus(state: OpenWAConnectionState): WhatsAppAccountStatus {
  switch (state) {
    case "STARTING":
    case "BROWSER_LAUNCHED":
    case "WHATSAPP_WEB_LOADING":
    case "WAITING_FOR_QR":
    // Deliberately NOT a new WhatsAppAccountStatus member. An accepted scan is a session that
    // still cannot carry a message, so every loop that gates on status must keep treating it
    // exactly as it treats the rest of the connecting window — and a seventh status value would
    // be a seventh thing for each of those `status: { in: [...] }` filters to have been told
    // about, which is the shape of the 18 Sep 2026 outage. The progress lives in
    // `connectionStage`, which nothing branches on.
    case "AUTHENTICATED":
    case "AUTHENTICATING":
    case "RECONNECTING":
      return "RECONNECTING";
    case "QR_AVAILABLE":
      return "AUTHENTICATION_REQUIRED";
    case "CONNECTED":
      return "CONNECTED";
    case "DISCONNECTED":
    // DISCONNECTED rather than ERROR: there is no session and nothing broke. It is also a status
    // `recoverIfDropped` understands, so an account whose retries are all used up rests somewhere
    // recoverable rather than in RECONNECTING, the state the 18 Sep 2026 outage was traced to.
    case "QR_EXPIRED":
      return "DISCONNECTED";
    case "AUTH_FAILED":
      return "SESSION_ERROR";
    case "ERROR":
      return "ERROR";
  }
}

/** Every state after which nobody needs to be told how long they have left to scan. */
const LINK_WINDOW_CLOSED_BY = new Set<OpenWAConnectionState>([
  "AUTHENTICATED",
  "AUTHENTICATING",
  "CONNECTED",
  "DISCONNECTED",
  "QR_EXPIRED",
  "AUTH_FAILED",
  "ERROR",
]);

/**
 * States that END an attempt without a session. The code on file belongs to that attempt, whose
 * browser is killed as it unwinds (`orphanBrowsers.ts`), so from here it cannot link anything.
 *
 * Left in place it stayed "usable" in the dialog until it aged past the 60s staleness check —
 * a minute in which somebody could scan a code with nothing behind it. The boot reconcile already
 * clears every QR for exactly this reason; this is the same rule applied when an attempt ends
 * rather than when the process does.
 */
const QR_DISCARDED_BY = new Set<OpenWAConnectionState>(["DISCONNECTED", "QR_EXPIRED", "AUTH_FAILED", "ERROR"]);

/**
 * Opens the linking window: the moment the current attempt will stop waiting for a scan.
 *
 * Separate from `recordConnectionState` because it is not a state transition — the attempt is still
 * WAITING_FOR_QR when it is written — and the deadline is the worker's own watchdog, which only the
 * worker knows. Never throws, for the same reason that one does not: a failed write here must not
 * take down the connection attempt it describes.
 */
export async function recordLinkWindow(accountId: string, expiresAt: Date): Promise<void> {
  try {
    await prisma.whatsAppAccount.update({ where: { id: accountId }, data: { linkExpiresAt: expiresAt } });
  } catch (err) {
    console.error("[openwa] could not record the linking window — the dialog will show no countdown", err);
  }
}

function logLevelFor(state: OpenWAConnectionState): "INFO" | "WARN" | "ERROR" {
  if (state === "ERROR" || state === "AUTH_FAILED") return "ERROR";
  if (state === "DISCONNECTED") return "WARN";
  return "INFO";
}

/**
 * Records a lifecycle transition: writes a SystemLog row (for the Logs
 * page / `docker compose logs`) and updates the account's coarse status.
 * Never throws — logging must not be able to take down the connection
 * attempt it's describing.
 */
/**
 * PHASE 5.2 — getAccountInfo() already existed but nothing ever called it, so
 * phoneNumber stayed null even on a real, confirmed CONNECTED session. Called
 * once, right after `create()` resolves (see OpenWAProvider.connect()) — i.e.
 * only once genuinely authenticated, never speculatively.
 */
export async function recordAccountMetadata(
  accountId: string,
  info: { phoneNumber: string | null; pushName: string | null },
): Promise<void> {
  // Only write fields OpenWA actually returned a value for — a transient
  // WAPI hiccup returning null here must not blank out a previously known,
  // valid phoneNumber.
  const data: Record<string, unknown> = {};
  if (info.phoneNumber) data.phoneNumber = info.phoneNumber;

  if (Object.keys(data).length === 0) {
    console.warn(
      `[openwa] account metadata retrieval returned nothing usable for account ${accountId} (pushName=${info.pushName ?? "none"}) — leaving existing record untouched`,
    );
    return;
  }

  try {
    await prisma.whatsAppAccount.update({ where: { id: accountId }, data });
    // pushName has no dedicated column (see schema) — logged only, not persisted.
    console.log(`[openwa] persisted account metadata`, { ...data, pushName: info.pushName ?? undefined });
  } catch (err) {
    console.error("[openwa] failed to persist account metadata", err);
  }
}

export async function recordConnectionState(
  accountId: string,
  state: OpenWAConnectionState,
  metadata?: Record<string, unknown>,
  // Kept out of `metadata`/SystemLog on purpose: the QR data URL is tens of
  // KB and WhatsApp Web regenerates it every ~20-30s (see accounts/page.tsx),
  // so logging it to SystemLog on every refresh would bloat that table fast.
  qrCode?: string,
): Promise<void> {
  const message = `WhatsApp connection: ${state}`;
  console.log(`[openwa] [${state}] ${JSON.stringify(metadata ?? {})}`);
  try {
    await prisma.systemLog.create({
      data: {
        level: logLevelFor(state),
        scope: "provider",
        message,
        metadata: { state, ...metadata } as any,
      },
    });
    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: {
        status: toAccountStatus(state),
        connectionStage: state,
        // The countdown ends the moment the attempt stops waiting on a person — an accepted scan
        // included, since from then on only the library's own sync is running and a timer ticking
        // down beside "Scan accepted" would invite a second scan of a spent code.
        ...(LINK_WINDOW_CLOSED_BY.has(state) ? { linkExpiresAt: null } : {}),
        lastHeartbeatAt: new Date(),
        ...(state === "CONNECTED" ? { lastConnectedAt: new Date(), qrCode: null } : {}),
        ...(QR_DISCARDED_BY.has(state) ? { qrCode: null } : {}),
        ...(state === "QR_AVAILABLE" && qrCode ? { qrCode, qrUpdatedAt: new Date() } : {}),
      },
    });
  } catch (err) {
    // Console-only, and this one is worse than it looks. Everything that decides whether an
    // account is healthy — the dashboard badge, the outbound queue's own checks, the Overview's
    // collection entry — reads the `status` column this write maintains. A failure here does not
    // lose one log line: it freezes the account's reported state at whatever it last managed to
    // write, for the lifetime of the process, while the session goes on changing underneath. A
    // dead session keeps reporting CONNECTED and nothing anywhere contradicts it.
    //
    // Best effort by necessity — the write that just failed was to the same database this is
    // trying to write to — but the attempt costs nothing and succeeds whenever the failure was
    // specific to that row rather than to the connection.
    console.error("[openwa] failed to record connection state", state, err);
    await prisma.systemLog
      .create({
        data: {
          level: "ERROR",
          scope: "provider",
          message: "Could not record a connection state change — this account's reported status is now stale",
          metadata: { accountId, state, error: (err as Error).message } as any,
        },
      })
      .catch(() => undefined);
  }
}

/**
 * How this account should ask WhatsApp to link it, read fresh at every connection attempt.
 *
 * Read here rather than passed in because `connect()` has four callers — the registry sync's
 * initial pass, the dashboard's RECONNECT command, automatic drop recovery, and the re-entrant
 * join — and only one of them is an operator pressing a button. Reading the stored preference
 * means a worker restart in the middle of a pairing resumes the method the operator chose instead
 * of silently reverting to a QR code nobody is standing in front of.
 *
 * FAILS OVER TO QR, deliberately and loudly. `PHONE_CODE` without a usable number would make the
 * library request a link code for nothing, and an account that cannot produce any way to link is
 * worse than one that produces the method the operator did not pick — a QR on screen can still be
 * scanned. The log line is what turns that into something fixable rather than confusing.
 */
export async function readPairingPreference(
  accountId: string,
): Promise<{ method: "QR_CODE" | "PHONE_CODE"; linkCodeNumber?: string }> {
  try {
    const account = await prisma.whatsAppAccount.findUnique({
      where: { id: accountId },
      select: { pairingMethod: true, pairingPhoneNumber: true },
    });
    if (account?.pairingMethod !== "PHONE_CODE") return { method: "QR_CODE" };

    // Digits only, which is the shape `ConfigObject.linkCode` documents ("1234567890"). A stored
    // "+8801…" would otherwise be handed to WhatsApp verbatim.
    const digits = (account.pairingPhoneNumber ?? "").replace(/\D/g, "");
    // Eight is the shortest national number in real use; a shorter value is a typo, and asking
    // WhatsApp to pair with a typo burns the attempt.
    if (digits.length < 8) {
      console.warn(
        `[openwa] account ${accountId} is set to pair by phone code but has no usable number — falling back to a QR code`,
      );
      return { method: "QR_CODE" };
    }
    return { method: "PHONE_CODE", linkCodeNumber: digits };
  } catch (err) {
    console.error(`[openwa] could not read the pairing preference for ${accountId}; using a QR code`, err);
    return { method: "QR_CODE" };
  }
}

/**
 * The proxy this account should connect through, or null for a direct connection — read fresh at
 * every attempt, for the same reason `readPairingPreference` is: `connect()` has several callers
 * and none of them carry a live copy of the account row.
 *
 * FAILS OVER TO NO PROXY. A misconfigured or now-unreachable proxy should not permanently block an
 * account from connecting at all — every account already connects directly today, so "no proxy" is
 * always a safe fallback, unlike the pairing method, where the two fallbacks are not equivalent.
 */
export async function readProxyConfig(
  accountId: string,
): Promise<{ address: string; protocol?: string; username?: string; password?: string } | null> {
  try {
    const account = await prisma.whatsAppAccount.findUnique({
      where: { id: accountId },
      select: { proxyAddress: true, proxyProtocol: true, proxyUsername: true, proxyPasswordCiphertext: true },
    });
    if (!account?.proxyAddress) return null;

    let password: string | undefined;
    if (account.proxyPasswordCiphertext) {
      try {
        password = decryptSecret(account.proxyPasswordCiphertext);
      } catch (err) {
        // A password that fails to decrypt (a rotated encryption key, corrupted storage) is worse
        // to send than to omit — many proxies work anonymously, and a garbled password is more
        // likely to be REJECTED than silently accepted, which would strand every connection
        // attempt behind a credential nobody can fix without first noticing this log line.
        console.error(`[openwa] could not decrypt the stored proxy password for account ${accountId}`, err);
      }
    }

    return {
      address: account.proxyAddress,
      protocol: account.proxyProtocol ?? undefined,
      username: account.proxyUsername ?? undefined,
      password,
    };
  } catch (err) {
    console.error(`[openwa] could not read the proxy configuration for ${accountId}; connecting directly`, err);
    return null;
  }
}
