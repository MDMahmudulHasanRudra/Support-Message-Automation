import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { TeamsIntegrationSettingsForm } from "./TeamsIntegrationSettingsForm";

export default async function TeamsIntegrationSettingsPage() {
  await requireSession();
  const settings = await prisma.teamsIntegrationSettings.upsert({ where: { id: "global" }, update: {}, create: {} });

  return (
    <div>
      <PageHeader title="Teams Integration Settings" />
      <TeamsIntegrationSettingsForm settings={settings} />
    </div>
  );
}
