/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { GroupParticipantAddWizard, type AdderAccount } from "./GroupParticipantAddWizard";

export default async function GroupParticipantAdderPage() {
  await requireSession();

  const [accounts, settings, automationSettings] = await Promise.all([
    prisma.whatsAppAccount.findMany({
      where: { status: "CONNECTED" },
      include: { groups: { where: { isActive: true }, orderBy: { name: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.groupParticipantAddSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
  ]);

  const wizardAccounts: AdderAccount[] = accounts.map((a) => ({
    id: a.id,
    label: a.label,
    status: a.status,
    groups: a.groups.map((g) => ({ id: g.id, name: g.name, isMonitored: g.isMonitored })),
  }));

  return (
    <div>
      <PageHeader
        title="Add Number to Groups"
        description="Add a phone number as a participant of every synchronized group, or a manual selection. Reuses the outbound queue's kill switch and its own dedicated throttling — adding participants is a stronger ban signal than messaging, so it's paced more conservatively."
        actions={
          <HelpButton moduleTitle="Add Number to Groups">
            <HelpSection title="What this does">
              <p>
                Adds one phone number as a participant to many WhatsApp groups at once — e.g. adding a
                new teammate or a bot number to every support group in one go. Enter the number with
                country code, digits only (no leading +), then pick target groups manually or select all.
              </p>
            </HelpSection>
            <HelpSection title="Why this is paced more conservatively than Group Message Sender">
              <p>
                WhatsApp treats bulk "add participant" actions as a stronger ban signal than bulk
                messaging, so this feature is deliberately slower and smaller-batch: a 10–30 second delay
                between adds (vs. 5–15s for messages), capped at 3 per minute (vs. 6), up to 100 groups per
                job (vs. 200), and only 1 retry on failure (vs. 2) — the app biases toward account safety
                over speed here.
              </p>
            </HelpSection>
            <HelpSection title="Before every add">
              <p>
                The worker double-checks live that the account is still actually a member of the target
                group before attempting to add — it never relies blindly on possibly-stale synced data.
              </p>
            </HelpSection>
            <HelpSection title="If automation is paused">
              <p>
                You can still prepare and queue a job — nothing is actually added until the kill switch is
                turned back on. If it's paused mid-job, still-pending groups are cancelled; numbers already
                added stay added.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <GroupParticipantAddWizard
        accounts={wizardAccounts}
        maxPerJob={settings.maxPerJob}
        automationEnabled={automationSettings.automationEnabled}
      />
    </div>
  );
}
