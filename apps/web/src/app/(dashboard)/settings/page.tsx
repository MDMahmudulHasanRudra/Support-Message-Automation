import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { SettingsForm } from "./SettingsForm";

export default async function SettingsPage() {
  await requireSession();
  const settings = await prisma.automationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  return (
    <div>
      <PageHeader title="Settings" description="Safety limits and notification destinations. The default configuration is conservative." />
      <SettingsForm settings={settings} />
    </div>
  );
}
