import { prisma } from "@support-automation/db";
import { pageAccess } from "@/server/authorize";
import { PageHeader, ViewOnlyNotice } from "@/components/ui";
import { TeamsIntegrationSettingsForm } from "./TeamsIntegrationSettingsForm";

export default async function TeamsIntegrationSettingsPage() {
  const { canManage } = await pageAccess("teams_integration.view", "teams_integration.manage");
  const settings = await prisma.teamsIntegrationSettings.upsert({ where: { id: "global" }, update: {}, create: {} });

  return (
    <div>
      <PageHeader title="Teams Integration Settings" />

      {canManage ? null : <ViewOnlyNotice />}
      <TeamsIntegrationSettingsForm settings={settings} />
    </div>
  );
}
