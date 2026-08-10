import { prisma } from "@support-automation/db";
import type { WhatsAppAccountStatus } from "@prisma/client";

/**
 * Fine-grained connection lifecycle, logged to SystemLog so the dashboard's
 * Logs page and `docker compose logs worker` both show exactly where a
 * connection attempt is / where it failed. This is intentionally NOT a new
 * database column — the existing WhatsAppAccountStatus enum (see
 * ARCHITECTURE.md; not touched in this phase) still drives the Accounts
 * page's status badge; these finer states are additive, via logs only.
 *
 * Honesty note: OpenWA's public API (the `create()` promise, the `qr.**`
 * event, and `onStateChanged`) does not expose a distinct callback between
 * "browser process launched" and "page finished loading WhatsApp Web", nor
 * between "QR scanned" and "fully connected" — those two pairs are only
 * observable as spinner/console output inside the library, not as events we
 * can subscribe to without patching further. STARTING/WAITING_FOR_QR are
 * logged at the call boundaries we do control; AUTHENTICATING is logged
 * immediately before CONNECTED at the point `create()` resolves, since that
 * promise only resolves after a successful scan+auth — there is no earlier
 * observable boundary between those two states via the public API.
 */
export const OPENWA_CONNECTION_STATES = [
  "STARTING",
  "BROWSER_LAUNCHED",
  "WHATSAPP_WEB_LOADING",
  "WAITING_FOR_QR",
  "QR_AVAILABLE",
  "AUTHENTICATING",
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
    case "AUTHENTICATING":
    case "RECONNECTING":
      return "RECONNECTING";
    case "QR_AVAILABLE":
      return "AUTHENTICATION_REQUIRED";
    case "CONNECTED":
      return "CONNECTED";
    case "DISCONNECTED":
      return "DISCONNECTED";
    case "AUTH_FAILED":
      return "SESSION_ERROR";
    case "ERROR":
      return "ERROR";
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
        lastHeartbeatAt: new Date(),
        ...(state === "CONNECTED" ? { lastConnectedAt: new Date(), qrCode: null } : {}),
        ...(state === "QR_AVAILABLE" && qrCode ? { qrCode, qrUpdatedAt: new Date() } : {}),
      },
    });
  } catch (err) {
    console.error("[openwa] failed to record connection state", state, err);
  }
}
