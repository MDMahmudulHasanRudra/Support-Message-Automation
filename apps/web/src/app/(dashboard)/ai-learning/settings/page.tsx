import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { AiSettingsForm } from "./AiSettingsForm";

export default async function AiSettingsPage() {
  await requireSession();
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });

  return (
    <div>
      <PageHeader title="AI Settings" description="Master controls and learning thresholds for the AI Learning module." />
      <AiSettingsForm settings={settings} />
    </div>
  );
}
