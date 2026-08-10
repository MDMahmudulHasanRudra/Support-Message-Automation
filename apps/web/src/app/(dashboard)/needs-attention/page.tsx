import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { MessageList } from "@/components/MessageList";

export default async function NeedsAttentionPage() {
  await requireSession();
  const messages = await prisma.message.findMany({
    where: { executions: { some: { decision: "SUPPORT_REQUIRED" } } },
    orderBy: { timestampWa: "desc" },
    take: 100,
  });

  return (
    <div>
      <PageHeader
        title="Needs Attention"
        description="Messages the rule engine marked SUPPORT_REQUIRED — a support executive should contact these clients."
      />
      <MessageList messages={messages} />
    </div>
  );
}
