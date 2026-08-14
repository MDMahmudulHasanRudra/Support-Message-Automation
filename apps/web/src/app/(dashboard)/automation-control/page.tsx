/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { AutomationControlPanel } from "./AutomationControlPanel";

export default async function AutomationControlPage() {
  await requireSession();
  const [settings, pendingBroadcastCount] = await Promise.all([
    prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.outboundMessage.count({ where: { actionType: "GROUP_BROADCAST", status: "PENDING" } }),
  ]);

  return (
    <div>
      <PageHeader
        title="Automation Control"
        description="The global emergency switch and automation level."
        actions={
          <HelpButton moduleTitle="Automation Control">
            <HelpSection title="Kill Switch">
              <p>
                When paused: no new automatic replies are sent, and any pending Group Message Sender
                broadcasts are cancelled immediately. Incoming messages are still stored and the support
                team is still notified — pausing only stops the bot from replying to clients, it doesn't
                stop you from seeing what's happening. Notifications (Teams/WhatsApp alerts) also keep
                sending even while paused.
              </p>
            </HelpSection>
            <HelpSection title="Automation Mode">
              <p>
                <strong>Manual Only</strong> — detects and notifies only, never auto-replies.{" "}
                <strong>Safe Auto Reply (recommended)</strong> — only vetted acknowledgement-style rules
                may reply automatically; everything else just notifies.{" "}
                <strong>Full Rule Automation</strong> — every active rule's actions can run, still
                subject to the rate limits on the Settings page.
              </p>
            </HelpSection>
            <HelpSection title="Where the other numbers live">
              <p>
                This page is only the on/off switch and the mode. Rate limits, reply delays, and retry
                counts are configured on the <strong>Settings</strong> page — not here.
              </p>
            </HelpSection>
            <HelpSection title="Always visible">
              <p>
                The current enabled/paused state and mode also show at the bottom of the sidebar, so you
                can see automation's state from anywhere in the app without opening this page.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <AutomationControlPanel
        automationEnabled={settings.automationEnabled}
        mode={settings.mode}
        pendingBroadcastCount={pendingBroadcastCount}
      />
    </div>
  );
}
