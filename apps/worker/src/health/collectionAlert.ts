import { prisma } from "../db.js";
import { resolveWhatsAppAccount } from "@support-automation/db";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import type { CollectionCheck, CollectionProblem } from "./collectionWatchdog.js";

/**
 * Tells somebody that a WhatsApp number has stopped collecting messages.
 *
 * Everything here goes through `enqueueNotification`, so the Notification Center's routing, muting
 * and per-member direct-message opt-ins apply to this exactly as they do to an escalation. There
 * is deliberately no second send path: a bespoke one would be the one nobody had configured, and
 * would also sidestep the dispatcher's own retry and delivery log.
 *
 * **Both channels, always, and Teams is not the afterthought.** The obvious flaw in alerting about
 * WhatsApp over WhatsApp is that the alert travels through the very registry being reported on. A
 * worker whose only account is the broken one cannot tell anybody over WhatsApp at all — the alert
 * would be queued, fail to send, and the delivery failure would itself be console-only. So Teams
 * is attempted whenever a webhook is configured, independently of whether the WhatsApp copy was
 * queued, and neither one's absence suppresses the other.
 *
 * And where WhatsApp *is* used, it is deliberately not sent from the account being reported on.
 */
export async function raiseCollectionAlert(registry: ProviderRegistry, finding: CollectionCheck): Promise<void> {
  const problem = finding.problem;
  if (!problem) return;

  const payload = {
    alertKind: "COLLECTION_BROKEN",
    accountId: finding.accountId,
    accountLabel: finding.label,
    problem: describeProblem(problem),
    detail: finding.reason ?? "",
    quietFor: describeQuietFor(finding.quietForMinutes),
    action: ACTION_BY_PROBLEM[problem],
    missed: finding.missed,
    problemCode: problem,
  };

  let delivered = 0;

  // --- WhatsApp, from a number that is not the broken one.
  try {
    delivered += await sendOverWhatsApp(registry, finding, payload);
  } catch (err) {
    console.error("[watchdog] WhatsApp collection alert failed", err);
  }

  // --- Teams. Not conditional on the above: the case this exists for is precisely the one where
  // --- WhatsApp cannot carry it.
  try {
    const settings = await getAutomationSettings();
    if (settings.teamsWebhookUrl) {
      const sent = await enqueueNotification({
        type: "TEAMS",
        event: "COLLECTION_BROKEN",
        destination: settings.teamsWebhookUrl,
        payload,
      });
      if (!sent.suppressed) delivered += 1;
    }
  } catch (err) {
    console.error("[watchdog] Teams collection alert failed", err);
  }

  if (delivered === 0) {
    // Worth its own record. "Nobody could be told" is a different and worse situation than the
    // outage itself, and it is the one a post-mortem needs to find — otherwise the absence of an
    // alert reads as the absence of a problem, which is how this incident started.
    console.error(`[watchdog] could not alert anybody about account "${finding.label}" — no reachable channel`);
    await logSystemEvent("ERROR", "provider", "Collection failure could not be alerted — no channel was reachable", {
      accountId: finding.accountId,
      label: finding.label,
      problem,
    }).catch(() => undefined);
  }
}

/**
 * Queues the WhatsApp copy through an account that is actually able to send it.
 *
 * `resolveWhatsAppAccount` answers "which account should notifications go out on", which is the
 * right question in general and the wrong one here in one specific case: when the answer is the
 * account that has stopped working. So the resolver is consulted first and then sanity-checked
 * against the registry, and any other live account is preferred over a confident answer that
 * cannot send.
 *
 * Returns how many notification rows were written, which is zero when there is no usable account
 * or no destination — either of which means the Teams lane is the only one left.
 */
async function sendOverWhatsApp(
  registry: ProviderRegistry,
  finding: CollectionCheck,
  payload: Record<string, unknown>,
): Promise<number> {
  const settings = await getAutomationSettings();
  if (settings.whatsappNotificationGroupIds.length === 0) return 0;

  const accountId = await pickSendingAccount(registry, finding.accountId);
  if (!accountId) {
    console.warn(
      `[watchdog] no connected WhatsApp account other than "${finding.label}" — the alert about it cannot go out over WhatsApp`,
    );
    return 0;
  }

  let queued = 0;
  for (const destination of settings.whatsappNotificationGroupIds) {
    const sent = await enqueueNotification({
      type: "WHATSAPP",
      event: "COLLECTION_BROKEN",
      destination,
      accountId,
      payload,
    });
    if (!sent.suppressed) queued += 1;
  }
  return queued;
}

/**
 * An account that can carry this alert, preferring one that is not the subject of it.
 *
 * Three steps, in descending order of how much they can be trusted:
 *
 * 1. **The configured notification account, if it is not the broken one.** Where the team already
 *    expects alerts to come from.
 * 2. **Any other connected account.** A message from an unexpected number is vastly better than
 *    no message.
 * 3. **The broken account itself, but only while it is still CONNECTED.** This is the deliberate
 *    concession, and it is what keeps the alert from being undeliverable on a single-account
 *    deployment — which is the common case, and the one this system actually runs as. A session
 *    that has stopped COLLECTING has a dead listener; sending is a different code path and very
 *    likely still works. A possible alert beats a guaranteed silence.
 *
 * A broken account that is not connected is not a channel, and pretending otherwise would queue a
 * row that fails quietly. That case returns null so Teams is left to carry it, and if Teams cannot
 * either, the caller records that nobody could be told — which is its own finding.
 */
async function pickSendingAccount(registry: ProviderRegistry, brokenAccountId: string): Promise<string | null> {
  const isConnected = (accountId: string): boolean => registry.get(accountId)?.getConnectionStatus() === "CONNECTED";
  const isPreferred = (accountId: string): boolean => accountId !== brokenAccountId && isConnected(accountId);

  try {
    const resolution = await resolveWhatsAppAccount("NOTIFY_WHATSAPP", prisma);
    if (!("error" in resolution) && isPreferred(resolution.accountId)) return resolution.accountId;
  } catch {
    // Fall through to the registry scan — an unreadable routing table must not cost the alert.
  }

  const other = registry.allAccountIds().find(isPreferred);
  if (other) return other;

  if (isConnected(brokenAccountId)) {
    console.warn(
      `[watchdog] no other connected account — sending this alert through the affected number itself, which can still send even when it has stopped receiving`,
    );
    return brokenAccountId;
  }

  return null;
}

/** The one-line headline. Short, because it is read on a phone among a hundred other messages. */
export function describeProblem(problem: CollectionProblem): string {
  switch (problem) {
    case "NOT_COLLECTING":
      return "Connected, but messages are arriving and not being stored";
    case "UNREADABLE":
      return "Connected, but the session cannot be read at all";
    case "STUCK_RECONNECTING":
      return "Stuck mid-reconnect and will not recover on its own";
    case "NEEDS_HUMAN":
      return "Waiting for somebody to link it from the phone";
    case "DOWN":
      return "Offline, and automatic reconnection has failed";
  }
}

/**
 * What to do, named as a place in the dashboard.
 *
 * Errors must be actionable rather than descriptive (see ENGINEERING_STANDARDS) — and the person
 * reading this is quite possibly on a phone at the weekend, so "check the worker" is not an
 * instruction.
 *
 * Exported because the Overview "needs attention" entry describes the same problems and must not
 * word them differently — two answers to "what do I do about this" is worse than one.
 */
export const ACTION_BY_PROBLEM: Record<CollectionProblem, string> = {
  NOT_COLLECTING:
    "The missed messages are being recovered automatically. If this repeats, restart the worker — the message listener is wired to a browser session that has gone.",
  UNREADABLE: "Open WhatsApp → Accounts and press Reconnect on this number. If that does not clear it, restart the worker.",
  STUCK_RECONNECTING: "Open WhatsApp → Accounts and press Reconnect. If it returns to this state, the worker needs restarting.",
  NEEDS_HUMAN: "Open WhatsApp → Accounts and link this number again — you will need the phone to scan the code.",
  DOWN: "Open WhatsApp → Accounts and press Reconnect. Check the System Logs for why it keeps dropping.",
};

function describeQuietFor(minutes: number | null): string {
  if (minutes === null) return "never";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursPart = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hoursPart : `${hoursPart} ${rest} minute${rest === 1 ? "" : "s"}`;
}
