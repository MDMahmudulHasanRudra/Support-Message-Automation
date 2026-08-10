import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { MessageList } from "@/components/MessageList";

export default async function MessagesPage() {
  await requireSession();
  const messages = await prisma.message.findMany({
    orderBy: { timestampWa: "desc" },
    take: 100,
  });

  return (
    <div>
      <PageHeader title="All Messages" description="Most recent 100 messages across every account." />
      <MessageList messages={messages} />
    </div>
  );
}
