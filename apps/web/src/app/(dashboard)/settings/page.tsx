/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { SettingsForm } from "./SettingsForm";

export default async function SettingsPage() {
  await requireSession();
  const [settings, groups] = await Promise.all([
    prisma.automationSettings.upsert({
      where: { id: "global" },
      update: {},
      create: { id: "global" },
    }),
    prisma.whatsAppGroup.findMany({
      where: { isActive: true },
      select: { whatsappGroupId: true, name: true, isMonitored: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Safety limits and notification destinations. The default configuration is conservative."
        actions={
          <HelpButton moduleTitle="Settings">
            <HelpSection title="Where things live, so you don't hunt for them">
              <p>
                This page = safety dials + destinations (Teams webhook, which WhatsApp groups receive
                alerts). The automation on/off switch and mode selector are on{" "}
                <strong>Automation Control</strong>, not here. Which WhatsApp account actually sends
                alerts/escalations is on <strong>Accounts → Routing</strong>, not here either.
              </p>
            </HelpSection>
            <HelpSection title="Per-Client Reply Limits vs. Global Rate Limiting">
              <p>
                Per-Client limits cap how many auto-replies any single client can receive per hour/day.
                Global limits cap the total across every client combined, per minute/hour/day. Both
                apply at the same time — whichever is hit first blocks the send.
              </p>
            </HelpSection>
            <HelpSection title="Reply Delay &amp; Retries">
              <p>
                The default random-wait range before sending an automatic reply (a rule can override
                this per-rule) — a small delay makes replies look human rather than instant. Max retry
                attempts applies when a send genuinely fails (e.g. a provider error), not to rate limits.
              </p>
            </HelpSection>
            <HelpSection title="WhatsApp support group(s) — avoid this trap">
              <p>
                Pick one or more already-synced groups here to receive automated alerts. If you select a
                group that's also marked Monitored (a client conversation the system watches), any alert
                sent there gets re-ingested as if a client sent it — creating a feedback loop. Prefer a
                dedicated internal-only group for alerts.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <SettingsForm settings={settings} groups={groups} />
    </div>
  );
}
