/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@/server/db";
import Link from "@/components/ProjectLink";
import { History } from "lucide-react";

import { requireAccess } from "@/server/authorize";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { GroupMessageSenderWizard, type WizardAccount } from "./GroupMessageSenderWizard";

const GROUP_SYNC_FRESHNESS_WINDOW_MS = 48 * 60 * 60 * 1000;

function isGroupSyncFresh(lastSyncedAt: Date | null): boolean {
  if (!lastSyncedAt) return false;
  return Date.now() - lastSyncedAt.getTime() < GROUP_SYNC_FRESHNESS_WINDOW_MS;
}

export default async function GroupMessageSenderPage() {
  await requireAccess("bulk_messaging.manage");

  const [accounts, settings, automationSettings, savedGroupSets] = await Promise.all([
    prisma.whatsAppAccount.findMany({
      where: { status: "CONNECTED" },
      include: {
        groups: {
          // Inactive means a resync no longer found this account as a member, so a send here fails
          // membership verification at the queue and lands as a skip nobody can account for. The
          // adder already filtered these out; this side never did. Active ≠ monitored: this is
          // only the "are we still in it" half, and monitored groups stay offered as before.
          where: { isActive: true },
          orderBy: { name: "asc" },
          include: { chatCategory: { select: { id: true, name: true, color: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.groupBroadcastSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.savedGroupSet.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, groupIds: true } }),
  ]);

  const savedSets = savedGroupSets.map((set) => ({
    id: set.id,
    name: set.name,
    // The saved size, not the resolvable one. Resolving every set on page load would be a query
    // per set for a number that only matters once somebody loads one — and the load itself
    // reports what no longer resolves.
    count: set.groupIds.length,
  }));

  const wizardAccounts: WizardAccount[] = accounts.map((a) => ({
    id: a.id,
    label: a.label,
    status: a.status,
    groups: a.groups.map((g) => ({
      id: g.id,
      name: g.name,
      isMonitored: g.isMonitored,
      isFresh: isGroupSyncFresh(g.lastSyncedAt),
      // The categories and pins set in the chat inbox are reused here rather than given a second
      // parallel system. A group filed under "Premium" is Premium everywhere, which is the whole
      // point of having filed it — two independent taxonomies over the same 1,944 groups would be
      // two things to keep in step and one of them would always be wrong.
      categoryId: g.chatCategoryId,
      categoryName: g.chatCategory?.name ?? null,
      categoryColor: g.chatCategory?.color ?? null,
      isPinned: g.chatPinnedAt !== null,
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
        savedSets={savedSets}
      />
    </div>
  );
}
