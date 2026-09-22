/**
 * What to tell somebody who is watching a WhatsApp account connect.
 *
 * `WhatsAppAccount.connectionStage` carries the provider's fine-grained lifecycle state, written
 * by the worker on every transition. The coarse `status` column collapses most of that window into
 * a single `RECONNECTING`, which is right for everything that branches on it and useless for the
 * one person actually standing in front of the screen: before scanning a code and after scanning
 * it, the badge says the same word.
 *
 * **Unknown values are tolerated on purpose.** The vocabulary is defined in the worker
 * (`OPENWA_CONNECTION_STATES` in apps/worker/src/provider/openwa/connectionState.ts) and a copy
 * here can fall behind it. A stage this file has never heard of returns null and the caller shows
 * its ordinary waiting copy — the same fail-open shape the notification templates use, and the
 * reason this is not a shared enum: a new stage arriving early is a missing sentence, while a
 * mismatched enum across two packages is a build that will not run.
 */

export interface ConnectionStageCopy {
  /** Short enough to sit on one line beside a spinner or a tick. */
  title: string;
  /** What is happening, in the words somebody waiting would use. */
  detail: string;
  /** Whether WhatsApp has accepted the pairing — the moment worth celebrating before it finishes. */
  accepted: boolean;
}

const STAGE_COPY: Record<string, ConnectionStageCopy> = {
  STARTING: {
    title: "Starting the session",
    detail: "Opening a browser for this account. This is the slowest part of a cold start.",
    accepted: false,
  },
  WAITING_FOR_QR: {
    title: "Loading WhatsApp Web",
    detail: "Waiting for WhatsApp to hand over a code to show you.",
    accepted: false,
  },
  QR_AVAILABLE: {
    title: "Waiting for your phone",
    detail: "The code below is live. It refreshes on its own until it is used.",
    accepted: false,
  },
  // The one this whole mechanism exists for. Until the worker started reporting it there was
  // nothing to say between "here is a code" and "connected", so a successful scan looked exactly
  // like a dead one for as long as the session took to finish loading.
  AUTHENTICATED: {
    title: "Accepted — linking now",
    detail: "WhatsApp accepted it. Getting the session ready; this takes a few seconds.",
    accepted: true,
  },
  AUTHENTICATING: {
    title: "Almost there",
    detail: "The session is up and the last checks are running.",
    accepted: true,
  },
  CONNECTED: {
    title: "Connected",
    detail: "Sending and receiving normally.",
    accepted: true,
  },
  RECONNECTING: {
    title: "Reconnecting",
    detail: "Bringing the session back up.",
    accepted: false,
  },
  DISCONNECTED: {
    title: "Not connected",
    detail: "No session is running for this account.",
    accepted: false,
  },
  AUTH_FAILED: {
    title: "The link failed",
    detail: "WhatsApp rejected the session. Ask for a new code, and log out first if it repeats.",
    accepted: false,
  },
  ERROR: {
    title: "Something went wrong",
    detail: "Check System Logs for what the worker reported.",
    accepted: false,
  },
};

export function describeConnectionStage(stage: string | null | undefined): ConnectionStageCopy | null {
  if (!stage) return null;
  return STAGE_COPY[stage] ?? null;
}

/**
 * Whether this stage means WhatsApp has already accepted the pairing.
 *
 * Read by the dialog to swap a spinner for a tick the instant a scan lands, rather than waiting
 * for the session to finish loading. Answers false for an unknown stage, which is the safe
 * direction: claiming a link succeeded when nothing said so is the one mistake here that would
 * send somebody away from a screen they still need to be at.
 */
export function isPairingAccepted(stage: string | null | undefined): boolean {
  return describeConnectionStage(stage)?.accepted ?? false;
}
