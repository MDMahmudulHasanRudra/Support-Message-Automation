import Link from "next/link";
import { History } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, PageHeader } from "@/components/ui";
import { GroupMessageSenderWizard, type WizardAccount } from "./GroupMessageSenderWizard";

const GROUP_SYNC_FRESHNESS_WINDOW_MS = 48 * 60 * 60 * 1000;

function isGroupSyncFresh(lastSyncedAt: Date | null): boolean {
  if (!lastSyncedAt) return false;
  return Date.now() - lastSyncedAt.getTime() < GROUP_SYNC_FRESHNESS_WINDOW_MS;
}

export default async function GroupMessageSenderPage() {
  await requireSession();

  const [accounts, settings, automationSettings] = await Promise.all([
    prisma.whatsAppAccount.findMany({
      where: { status: "CONNECTED" },
      include: { groups: { orderBy: { name: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.groupBroadcastSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
  ]);

  const wizardAccounts: WizardAccount[] = accounts.map((a) => ({
    id: a.id,
    label: a.label,
    status: a.status,
    groups: a.groups.map((g) => ({
      id: g.id,
      name: g.name,
      isMonitored: g.isMonitored,
      isFresh: isGroupSyncFresh(g.lastSyncedAt),
    })),
  }));

  return (
    <div>
      <PageHeader
        title="Group Message Sender"
        description="Send a custom message to selected WhatsApp groups — reuses the existing outbound queue, rate limiting, and kill switch. Never sends without explicit confirmation."
        actions={
          <Link href="/group-message-sender/history">
            <Button variant="secondary" size="sm">
              <History className="size-3.5" aria-hidden />
              Sending History
            </Button>
          </Link>
        }
      />
      <GroupMessageSenderWizard
        accounts={wizardAccounts}
        maxPerJob={settings.maxPerJob}
        automationEnabled={automationSettings.automationEnabled}
      />
    </div>
  );
}
