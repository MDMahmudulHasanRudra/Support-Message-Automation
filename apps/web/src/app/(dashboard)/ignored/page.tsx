import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { MessageList } from "@/components/MessageList";

export default async function IgnoredMessagesPage() {
  await requireSession();
  const messages = await prisma.message.findMany({
    where: { processingStatus: "IGNORED" },
    orderBy: { timestampWa: "desc" },
    take: 100,
  });

  return (
    <div>
      <PageHeader title="Ignored Messages" description="Messages that matched a default-ignore, team-filter, or last-sender rule." />
      <MessageList messages={messages} />
    </div>
  );
}
