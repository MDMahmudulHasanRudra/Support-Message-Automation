import { isMood, MOOD_ACTION_LABELS, MOOD_LABELS, MOOD_SIGNAL_LABELS, type MoodAction } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { Badge, Card, EmptyState, HelpButton, HelpSection, PageHeader, SectionHeader, StatTile, ViewOnlyNotice } from "@/components/ui";
import { MoodBadge } from "@/components/MoodBadge";
import ProjectLink from "@/components/ProjectLink";
import { formatDateTime } from "@/lib/date";
import { getMoodReadingCounts, getMoodSettingsView, getRecentMoodAlerts } from "@/server/moodDetectionReports";
import { MoodDetectionForm } from "./MoodDetectionForm";

/**
 * Settings → Support → Mood Detection (MOOD_DETECTION.md).
 *
 * Detection is separate from action: this page decides which moods count, how sure the detection
 * must be, and what each mood is allowed to do. Below the form, the alerts it has raised and what
 * each action actually did — so a setting is never configured blind.
 */
const ACTION_STATUS_COLOR = { DONE: "green", SKIPPED: "gray", FAILED: "red", PENDING: "blue", PROCESSING: "blue" } as const;

export default async function MoodDetectionSettingsPage() {
  const { canManage } = await pageAccess("settings.view", "settings.edit");
  const [settings, groups, alerts, counts] = await Promise.all([
    getMoodSettingsView(),
    prisma.whatsAppGroup.findMany({
      where: { isActive: true },
      select: { whatsappGroupId: true, name: true, isMonitored: true },
      orderBy: { name: "asc" },
      distinct: ["whatsappGroupId"],
    }),
    getRecentMoodAlerts(25),
    getMoodReadingCounts(7),
  ]);

  return (
    <div>
      <PageHeader
        title="Mood Detection"
        description="Notice when a customer is getting angry, frustrated or urgent — and decide exactly what happens next."
        actions={
          <HelpButton moduleTitle="Mood Detection">
            <HelpSection title="How it decides">
              <p>
                Each customer message is read for emotional signals — words and phrases in English, Bangla and Banglish, emoji,
                repeated complaints, capitals, bursts of messages — and the customer&apos;s earlier moods in the same group. Most
                messages carry no signal and nothing is recorded. When it is unsure and you allow it, the AI is asked about that one
                message, with names and numbers removed.
              </p>
              <p>
                Every mood is an <strong>inference</strong> with a confidence, never a fact. The reasons shown are the structured
                signals that produced it, never AI explanations.
              </p>
            </HelpSection>
            <HelpSection title="Who it watches">
              <p>
                Only customers, in monitored groups. A team member&apos;s message never triggers anything, and the internal
                escalation group itself is never read.
              </p>
            </HelpSection>
            <HelpSection title="Alerts and cooldown">
              <p>
                One alert per escalation, per customer, per group. Further angry messages inside the cooldown attach to the open
                alert. If the customer gets worse (angry → very angry) inside it, the alert is raised again at the new priority. The
                message to the customer, when on, is sent at most once per alert.
              </p>
              <p>
                Muting &ldquo;Customer upset&rdquo; in Notification Center silences both the team alert and the internal group alert.
                Each action is retried on its own, so a WhatsApp problem never stops the AI pause.
              </p>
            </HelpSection>
            <HelpSection title="Pausing AI">
              <p>
                Pausing uses the same switch as a team member taking over a conversation. Rules keep running. When a team member
                replies, the ordinary human-takeover window takes over.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Status" value={settings.enabled ? "On" : "Off"} tone={settings.enabled ? "accent" : "neutral"} hint={settings.updatedAt ? `Saved ${formatDateTime(settings.updatedAt)}${settings.updatedByName ? ` by ${settings.updatedByName}` : ""}` : "Never configured"} />
        <StatTile label="Readings, 7 days" value={counts.total.toLocaleString("en-US")} hint="Messages that carried an emotional signal" />
        <StatTile label="Triggered, 7 days" value={counts.triggered.toLocaleString("en-US")} hint="Readings that passed the threshold for a trigger mood" />
        <StatTile
          label="Most common"
          value={counts.byMood[0] && isMood(counts.byMood[0].mood) ? MOOD_LABELS[counts.byMood[0].mood] : "—"}
          hint={counts.byMood[0] ? `${counts.byMood[0].count.toLocaleString("en-US")} reading(s)` : "Nothing recorded yet"}
        />
      </div>

      <MoodDetectionForm settings={settings} groups={groups} canManage={canManage} />

      <Card className="mt-6">
        <SectionHeader title="Recent mood alerts" description="Newest first, with what each action did. Times are when the alert opened." />
        {alerts.length === 0 ? (
          <EmptyState>{settings.enabled ? "No mood alerts yet — nothing has passed the threshold for a trigger mood." : "No mood alerts. Mood Detection is off."}</EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {alerts.map((alert) => (
              <li key={alert.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {isMood(alert.mood) ? <MoodBadge mood={alert.mood} confidence={alert.confidence} signals={alert.signals} /> : <Badge>{alert.mood}</Badge>}
                  <Badge color={alert.priority === "CRITICAL" || alert.priority === "HIGH" ? "red" : "gray"}>{alert.priority}</Badge>
                  <ProjectLink href={`/chat/${alert.groupId}`} className="text-[13px] font-medium text-[color:var(--color-foreground)] hover:underline">
                    {alert.groupName}
                  </ProjectLink>
                  <span className="text-xs text-[color:var(--color-muted-foreground)]">
                    {alert.customer} · {formatDateTime(alert.openedAt)}
                    {alert.triggerCount > 1 ? ` · ${alert.triggerCount} messages` : ""}
                  </span>
                </div>
                {alert.message ? <p className="mt-1.5 line-clamp-2 text-[13px] text-[color:var(--color-muted-foreground)]">&ldquo;{alert.message}&rdquo;</p> : null}
                <p className="mt-1 text-xs text-[color:var(--color-subtle-foreground)]">
                  Why (detected): {alert.signals.map((s) => MOOD_SIGNAL_LABELS[s]).join(", ") || "—"}
                </p>
                {alert.actions.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {alert.actions.map((a) => (
                      <span key={a.action} title={a.lastError ?? a.detail ?? undefined}>
                        <Badge color={ACTION_STATUS_COLOR[a.status as keyof typeof ACTION_STATUS_COLOR] ?? "gray"}>
                          {MOOD_ACTION_LABELS[a.action as MoodAction] ?? a.action}: {a.status.toLowerCase()}
                        </Badge>
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
