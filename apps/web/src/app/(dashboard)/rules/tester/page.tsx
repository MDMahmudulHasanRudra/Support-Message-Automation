import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { RuleTesterForm } from "./RuleTesterForm";

export default async function RuleTesterPage() {
  await requireSession();
  const groups = await prisma.whatsAppGroup.findMany({ select: { id: true, name: true } });

  return (
    <div>
      <PageHeader
        title="Rule Tester"
        description="Simulates a message against the current active rules. This never sends a real message or notification."
      />
      <RuleTesterForm groups={groups} />
    </div>
  );
}
