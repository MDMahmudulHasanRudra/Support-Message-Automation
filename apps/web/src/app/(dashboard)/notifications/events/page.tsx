/* eslint-disable react/no-unescaped-entities -- long-form Help prose reads better with real apostrophes */
import { prisma } from "@support-automation/db";
import type { NotificationEvent } from "@prisma/client";
import { pageAccess } from "@/server/authorize";
import { Alert, HelpButton, HelpSection, PageHeader, StatTile, ViewOnlyNotice } from "@/components/ui";
import { NOTIFICATION_EVENTS } from "@/lib/notificationEvents";
import { NotificationEventCard } from "./NotificationEventCard";

/**
 * The Notification Center: what this system can tell you about, and where each of those goes.
 *
 * Every alert used to land wherever the two global destination settings pointed, with no record of
 * why it was raised. So a team buried in unknown-pattern alerts had exactly one remedy — remove
 * the notification group — which also silenced escalations. Alerts have an event identity now, and
 * each one is routed and muted on its own.
 */

const EVENT_COPY: Record<
  NotificationEvent,
  { title: string; description: string; consequence: string }
> = {
  SUPPORT_ESCALATION: {
    title: "Support escalation",
    description: "A priority conversation crossed one of its SLA timers and nobody has replied yet.",
    consequence: "Muting this means an overdue customer goes unnoticed until someone opens the console.",
  },
  AI_HUMAN_FALLBACK: {
    title: "AI handed over to a human",
    description: "A customer asked something the AI could not answer safely, so it stopped and asked for a person.",
    consequence: "Muting this means those conversations wait until somebody happens to look at the inbox.",
  },
  RULE_NOTIFY_WHATSAPP: {
    title: "Rule alert — WhatsApp",
    description: "A rule with a 'notify WhatsApp' action matched an incoming message.",
    consequence: "Muting this affects every rule that notifies WhatsApp, not one of them.",
  },
  RULE_NOTIFY_TEAMS: {
    title: "Rule alert — Teams",
    description: "A rule with a 'notify Teams' action matched an incoming message.",
    consequence: "Muting this affects every rule that notifies Teams, not one of them.",
  },
  UNKNOWN_PATTERN: {
    title: "Unrecognised question pattern",
    description: "The same kind of question keeps arriving and no rule handles it yet — a suggestion to write one.",
    consequence: "Safe to mute: nothing is waiting on it, and the patterns are still listed under Conversation Learning.",
  },
  COLLECTION_BROKEN: {
    title: "A number has stopped collecting messages",
    description:
      "A WhatsApp number that should be receiving customer messages is not — stuck mid-reconnect, waiting to be linked from the phone, or reporting itself connected while WhatsApp says otherwise.",
    consequence:
      "The one alert here you should not mute. Every other event tells you about a customer; this one tells you that no customer is reaching you at all, and it is the only thing that would.",
  },
};

export default async function NotificationEventsPage() {
  const { canManage } = await pageAccess("notifications.view", "settings.edit");

  const [settings, automationSettings, groups, counts] = await Promise.all([
    prisma.notificationEventSetting.findMany(),
    prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    // No cap: the picker searches the whole roster and bounds what it DRAWS, so the previous
    // "first 300 alphabetically" made every destination past the letter M unselectable rather
    // than merely un-rendered. `isMonitored` rides along so the picker can warn that alerting
    // into a monitored group feeds the alert back in as a customer message.
    prisma.whatsAppGroup.findMany({
      where: { isActive: true },
      select: { whatsappGroupId: true, name: true, isMonitored: true },
      orderBy: { name: "asc" },
    }),
    prisma.notification.groupBy({ by: ["event"], _count: { _all: true } }),
  ]);

  const settingByEvent = new Map(settings.map((row) => [row.event, row]));
  const countByEvent = new Map(counts.map((row) => [row.event, row._count._all]));
  const untagged = countByEvent.get(null) ?? 0;
  const mutedCount = NOTIFICATION_EVENTS.filter((event) => settingByEvent.get(event)?.enabled === false).length;

  return (
    <div>
      <PageHeader
        title="Notification Center"
        description="Everything this system can alert you about, and where each alert goes."
        actions={
          <HelpButton moduleTitle="Notification Center">
            <HelpSection title="What this changes">
              <p>
                Alerts used to go wherever the two global destination settings pointed, all of them
                together. Each event is now routed and muted on its own, so you can silence the
                noisy one without losing the one that matters.
              </p>
            </HelpSection>
            <HelpSection title="Leave a destination empty to inherit">
              <p>
                An event with no groups of its own uses the global WhatsApp notification groups
                from Settings — the behaviour every deployment already had. Choose groups here only
                when that event should go somewhere different.
              </p>
            </HelpSection>
            <HelpSection title="Muting drops the alert, it does not queue it">
              <p>
                A muted event writes nothing at all. It will not appear in the delivery log and
                will not arrive later — that is the point, but it does mean a muted escalation is
                genuinely gone rather than delayed.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Event types" value={NOTIFICATION_EVENTS.length} hint="Everything the system can raise" />
        <StatTile
          label="Muted"
          value={mutedCount}
          hint={mutedCount > 0 ? "Raising nothing at all" : "All events are on"}
          tone={mutedCount > 0 ? "warning" : "neutral"}
        />
        <StatTile
          label="Global destinations"
          value={automationSettings.whatsappNotificationGroupIds.length}
          hint="Used by any event without its own"
        />
      </div>

      {automationSettings.whatsappNotificationGroupIds.length === 0 ? (
        <div className="mb-5">
          <Alert tone="warning">
            No global WhatsApp notification groups are configured, so any event without its own
            destination has nowhere to send. Set them on Settings, or give each event its own below.
          </Alert>
        </div>
      ) : null}

      {untagged > 0 ? (
        <div className="mb-5">
          <Alert tone="info">
            {untagged.toLocaleString()} older notification{untagged === 1 ? "" : "s"} predate this
            page and carry no event. They are left as they are — working out what each one was for
            after the fact would be a guess.
          </Alert>
        </div>
      ) : null}

      <div className="space-y-4">
        {NOTIFICATION_EVENTS.map((event) => (
          <NotificationEventCard
            key={event}
            event={event}
            copy={EVENT_COPY[event]}
            sentCount={countByEvent.get(event) ?? 0}
            groups={groups}
            globalGroupCount={automationSettings.whatsappNotificationGroupIds.length}
            setting={{
              enabled: settingByEvent.get(event)?.enabled ?? true,
              sendToTeams: settingByEvent.get(event)?.sendToTeams ?? true,
              sendToWhatsApp: settingByEvent.get(event)?.sendToWhatsApp ?? true,
              whatsappGroupIds: settingByEvent.get(event)?.whatsappGroupIds ?? [],
            }}
          />
        ))}
      </div>
    </div>
  );
}
