import { CHANNELS, isChannelType } from "@support-automation/shared";
import { isResolutionError, resolveWhatsAppAccount } from "@support-automation/db";
import { prisma } from "../db.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";
import { getEventDelivery, resolveWhatsAppDestinations } from "../notifications/eventSettings.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";

/**
 * "A messaging channel needs reconnecting" (Meta expansion A3, docs/meta-expansion/09).
 *
 * A Messenger, Instagram or Telegram connection reaches NEEDS_RECONNECT from several places — the
 * health check, a send Meta refused for its token, a deauthorize callback from Meta — and every one of
 * them was silent: the status changed on Settings → Messaging Channels and nobody was told, so a
 * channel could stop receiving customers for days. Rather than hook each of those writers (and every
 * future one), this sweep reads the STATE: a NEEDS_RECONNECT connection not yet announced is announced
 * once, and a connection that is no longer NEEDS_RECONNECT is made announceable again.
 *
 * Inside a project (the caller runs it per project). Once per breakage: the stamp is claimed with a
 * conditional update before anything is queued, so two ticks or two workers cannot both announce it.
 * Delivery is the Notification Center's, through `enqueueNotification` like every other alert — muting,
 * per-event groups and members' direct-message opt-ins apply unchanged.
 */

const MAX_PER_TICK = 20;

export async function sweepReconnectAlerts(now: Date = new Date()): Promise<number> {
  // Fixed, or disconnected on purpose: the next breakage is news again.
  await prisma.channelConnection.updateMany({ where: { reconnectAlertedAt: { not: null }, status: { not: "NEEDS_RECONNECT" } }, data: { reconnectAlertedAt: null } });

  const due = await prisma.channelConnection.findMany({
    where: { status: "NEEDS_RECONNECT", reconnectAlertedAt: null },
    orderBy: [{ lastErrorAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: MAX_PER_TICK,
    select: { id: true, name: true, type: true, authMode: true, lastError: true },
  });
  let announced = 0;
  for (const c of due) {
    const claimed = await prisma.channelConnection.updateMany({ where: { id: c.id, status: "NEEDS_RECONNECT", reconnectAlertedAt: null }, data: { reconnectAlertedAt: now } });
    if (claimed.count !== 1) continue;
    const queued = await announce(c);
    if (queued === 0) {
      // Nobody could be told (no destination configured, or the event is muted). Recorded rather than
      // retried every tick: a muted event is a decision, and an unconfigured one shows on the page.
      await logSystemEvent("WARN", "channels", `${c.name} needs reconnecting; no notification could be queued`, { connectionId: c.id }, { targetType: "ChannelConnection", targetId: c.id }).catch(() => undefined);
    }
    announced++;
  }
  return announced;
}

type Connection = { id: string; name: string; type: string; authMode: "MANUAL" | "PLATFORM"; lastError: string | null };

/** Queues the alert on every channel the Notification Center allows. Returns how many rows were written. */
async function announce(c: Connection): Promise<number> {
  const payload = {
    alertKind: "CHANNEL_NEEDS_RECONNECT",
    connectionId: c.id,
    connectionName: c.name,
    channel: isChannelType(c.type) ? CHANNELS[c.type].label : c.type,
    // The recorded reason is our own sentence (connection health and send errors are worded here);
    // capped so a long provider message cannot swamp the alert.
    reason: (c.lastError ?? "It is no longer accepted.").slice(0, 300),
    action:
      c.type === "TELEGRAM"
        ? "Open Settings → Messaging Channels and enter the bot token again."
        : c.authMode === "PLATFORM"
          ? "Open Settings → Messaging Channels and press Reconnect with Facebook."
          : "Open Settings → Messaging Channels and enter this connection's credentials again.",
  };
  const settings = await getAutomationSettings();
  const delivery = await getEventDelivery("CHANNEL_NEEDS_RECONNECT");
  let queued = 0;

  const destinations = resolveWhatsAppDestinations(delivery, settings.whatsappNotificationGroupIds);
  if (destinations.length > 0) {
    const account = await resolveWhatsAppAccount("NOTIFY_WHATSAPP", prisma);
    if (!isResolutionError(account)) {
      for (const destination of destinations) {
        const sent = await enqueueNotification({ type: "WHATSAPP", event: "CHANNEL_NEEDS_RECONNECT", destination, accountId: account.accountId, payload });
        if (!sent.suppressed) queued++;
      }
    }
  }
  if (settings.teamsWebhookUrl) {
    const sent = await enqueueNotification({ type: "TEAMS", event: "CHANNEL_NEEDS_RECONNECT", destination: settings.teamsWebhookUrl, payload });
    if (!sent.suppressed) queued++;
  }
  return queued;
}
