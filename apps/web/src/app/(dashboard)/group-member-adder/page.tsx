import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
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
      />
      <GroupParticipantAddWizard
        accounts={wizardAccounts}
        maxPerJob={settings.maxPerJob}
        automationEnabled={automationSettings.automationEnabled}
      />
    </div>
  );
}
