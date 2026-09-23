/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireAccess } from "@/server/authorize";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { hasReachablePhoneNumber } from "@support-automation/shared";
import {
  GroupParticipantAddWizard,
  type AdderAccount,
  type AdderTeamMember,
} from "./GroupParticipantAddWizard";

export default async function GroupParticipantAdderPage() {
  await requireAccess("bulk_messaging.manage");

  const [accounts, settings, automationSettings, roster, savedGroupSets] = await Promise.all([
    prisma.whatsAppAccount.findMany({
      where: { status: "CONNECTED" },
      include: {
        groups: {
          where: { isActive: true },
          orderBy: { name: "asc" },
          include: { chatCategory: { select: { id: true, name: true, color: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.groupParticipantAddSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.internalTeamMember.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, phoneNumber: true, whatsappId: true, role: true },
      orderBy: { name: "asc" },
    }),
    prisma.savedGroupSet.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, groupIds: true } }),
  ]);

  // Anyone mapped from message history has a WhatsApp id where their number should be, and WhatsApp
  // cannot add a participant by that — the add would fail for every group in the job. Left out of
  // the picker entirely rather than offered and then failing hundreds of times; Team Members is
  // where that gets fixed, and it already flags them.
  const teamMembers: AdderTeamMember[] = roster
    .filter(hasReachablePhoneNumber)
    .map((member) => ({
      id: member.id,
      name: member.name,
      phoneNumber: member.phoneNumber,
      role: member.role,
    }));

  const wizardAccounts: AdderAccount[] = accounts.map((a) => ({
    id: a.id,
    label: a.label,
    status: a.status,
    groups: a.groups.map((g) => ({
      id: g.id,
      name: g.name,
      isMonitored: g.isMonitored,
      // The chat inbox's categories and pins, reused rather than given a second parallel taxonomy.
      categoryId: g.chatCategoryId,
      categoryName: g.chatCategory?.name ?? null,
      categoryColor: g.chatCategory?.color ?? null,
      isPinned: g.chatPinnedAt !== null,
    })),
  }));

  const savedSets = savedGroupSets.map((set) => ({
    id: set.id,
    name: set.name,
    // The saved size, not the resolvable one — resolving every set on page load would be a query
    // per set for a number that only matters once somebody loads one.
    count: set.groupIds.length,
  }));

  return (
    <div>
      <PageHeader
        title="Add Number to Groups"
        description="Add one or more people to many WhatsApp groups at once. Queue it and leave — it works through the list on its own, paced to keep the account safe."
        actions={
          <HelpButton moduleTitle="Add Number to Groups">
            <HelpSection title="What this does">
              <p>
                Adds people as participants to many WhatsApp groups at once — a new teammate across
                every support group, or your whole roster across a set of new ones. Pick team members
                from the list, type other numbers, or both; everyone chosen is added to every group
                you select.
              </p>
              <p>
                Anyone already in a group is skipped without an add being attempted, so re-running
                the same roster over a wider set of groups is safe and only does the new work.
              </p>
            </HelpSection>
            <HelpSection title="Queue it once and leave it">
              <p>
                One job covers every number against every group, so five people across five hundred
                groups is 2,500 adds — the wizard shows the count and a time estimate before you
                confirm. It runs in the background at a fixed pace, survives a restart, and needs
                nobody watching. A large job is not slower per add; it simply has more to do.
              </p>
            </HelpSection>
            <HelpSection title="Why this is paced more conservatively than Group Message Sender">
              <p>
                WhatsApp treats bulk "add participant" actions as a stronger ban signal than bulk
                messaging, so this is deliberately slower: a 10–30 second gap between adds (vs. 5–15s
                for messages) and 3 per minute (vs. 6). That per-minute cap applies across every
                running job, not to each one separately — which is what makes a large job safe, and
                what makes splitting one into several pointless.
              </p>
              <p>
                Change any of it on <strong>Add-to-Groups Limits</strong>.
              </p>
            </HelpSection>
            <HelpSection title="Before every add">
              <p>
                The worker double-checks live that the account is still actually a member of the target
                group before attempting to add — it never relies blindly on possibly-stale synced data.
              </p>
              <p>
                Team members whose stored number is really a WhatsApp id are left out of the picker
                entirely: WhatsApp cannot add a participant by that, so offering them would fail for
                every group in the job. Fix those on Internal Team Members, where they are flagged.
              </p>
            </HelpSection>
            <HelpSection title="If automation is paused">
              <p>
                You can still prepare and queue a job — nothing is actually added until the kill switch is
                turned back on. If it's paused mid-job, still-pending groups are cancelled; numbers already
                added stay added.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <GroupParticipantAddWizard
        accounts={wizardAccounts}
        teamMembers={teamMembers}
        maxPerJob={settings.maxPerJob}
        maxPerMinute={settings.maxPerMinute}
        automationEnabled={automationSettings.automationEnabled}
        savedSets={savedSets}
      />
    </div>
  );
}
