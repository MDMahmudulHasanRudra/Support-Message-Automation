import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { AutomationControlPanel } from "./AutomationControlPanel";

export default async function AutomationControlPage() {
  await requireSession();
  const [settings, pendingBroadcastCount] = await Promise.all([
    prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.outboundMessage.count({ where: { actionType: "GROUP_BROADCAST", status: "PENDING" } }),
  ]);

  return (
    <div>
      <PageHeader title="Automation Control" description="The global emergency switch and automation level." />

      <AutomationControlPanel
        automationEnabled={settings.automationEnabled}
        mode={settings.mode}
        pendingBroadcastCount={pendingBroadcastCount}
      />
    </div>
  );
}
