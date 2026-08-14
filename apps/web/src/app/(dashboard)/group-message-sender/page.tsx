/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { History } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
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
          <>
            <HelpButton moduleTitle="Group Message Sender">
              <HelpSection title="What this does">
                <p>
                  Sends one custom text message to many WhatsApp groups at once. It's built entirely on
                  the same outbound queue as automated replies, so it obeys the same kill switch and rate
                  limits — this is not a separate, less-safe way to bulk-send.
                </p>
              </HelpSection>
              <HelpSection title="The 5 steps">
                <p>
                  Select Account → Select Groups (manually, or by importing an Excel file with a
                  "Group Name" column and an optional per-row "Message" column) → Review Selection →
                  Compose Message (the fallback text used for any group without its own Excel message) →
                  Preview, where you confirm before anything is queued.
                </p>
              </HelpSection>
              <HelpSection title="Excel import matching">
                <p>
                  Matching is exact (or whitespace/case-normalized) — never fuzzy. After upload you'll see
                  four buckets: Matched, Ambiguous (pick which group you meant), Unmatched (no synced group
                  has that name), and Duplicate rows (only the first occurrence of a repeated name is
                  queued). Nothing in the unmatched/ambiguous/duplicate buckets gets sent silently.
                </p>
              </HelpSection>
              <HelpSection title="Safety limits (why this is slow on purpose)">
                <p>
                  Each group gets a random 5–15 second delay from the last, capped at 6 sends per minute
                  per job, up to 200 groups per job, with up to 2 retries on failure and a 60-minute
                  duplicate-send guard per group. Right before sending, it double-checks live that the
                  account is actually still a member of that group — a stale sync alone never triggers a
                  blind send. These limits protect the WhatsApp account from being flagged; if you need
                  more than 200 groups, split it into multiple jobs.
                </p>
              </HelpSection>
              <HelpSection title="If automation is paused">
                <p>
                  You can still prepare and queue a job — it just won't actually send anything until the
                  kill switch is turned back on from Automation Control. If it's turned off mid-job, every
                  still-pending message is cancelled; anything already sent stays sent.
                </p>
              </HelpSection>
            </HelpButton>
            <Link href="/group-message-sender/history">
              <Button variant="secondary" size="sm">
                <History className="size-3.5" aria-hidden />
                Sending History
              </Button>
            </Link>
          </>
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
