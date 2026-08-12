import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
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
      <PageHeader title="Settings" description="Safety limits and notification destinations. The default configuration is conservative." />
      <SettingsForm settings={settings} groups={groups} />
    </div>
  );
}
