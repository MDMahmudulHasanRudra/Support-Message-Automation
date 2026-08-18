import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { LearningSettingsForm } from "./LearningSettingsForm";

export default async function LearningSettingsPage() {
  await requireSession();
  const settings = await prisma.learningSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });

  return (
    <div>
      <PageHeader
        title="Conversation Settings"
        description="Thresholds, weights, and the auto-approval policy for Conversation Learning."
        actions={
          <HelpButton moduleTitle="Conversation Settings">
            <HelpSection title="Off by default, safe to leave off">
              <p>
                Conversation Learning only ever reads messages that already went through the real
                automation pipeline — turning it off (or leaving it off) has zero effect on existing
                WhatsApp automation. The Pattern Review Floor is a hard requirement, not a suggestion:
                a pattern can never become a candidate from a single conversation, no matter how it
                would score.
              </p>
            </HelpSection>
            <HelpSection title="Auto-approval still isn&apos;t &quot;live&quot;">
              <p>
                Even with auto-approval on, a qualifying pattern only creates a Draft automation rule
                automatically — it still requires a separate, manual activation on the Rules page
                before it can affect a real conversation.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <LearningSettingsForm settings={settings} />
    </div>
  );
}
