/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { PolicyForm } from "./PolicyForm";
import { EscalationSettingsForm } from "./EscalationSettingsForm";

const PRIORITY_DEFAULTS = {
  P1: { firstAlertMinutes: 0, secondAlertMinutes: 5, memberEscalationMinutes: 10, adminEscalationMinutes: 15, followUpIntervalMinutes: 15, maxEscalations: 10 },
  P2: { firstAlertMinutes: 5, secondAlertMinutes: 10, memberEscalationMinutes: 20, adminEscalationMinutes: 30, followUpIntervalMinutes: 30, maxEscalations: 6 },
  P3: { firstAlertMinutes: 15, secondAlertMinutes: 30, memberEscalationMinutes: 60, adminEscalationMinutes: 120, followUpIntervalMinutes: 120, maxEscalations: 3 },
} as const;

export default async function SupportEscalationPoliciesPage() {
  await requireSession();

  const [policies, escalationSettings, teamMembers] = await Promise.all([
    Promise.all(
      (["P1", "P2", "P3"] as const).map((priority) =>
        prisma.supportPriorityPolicy.upsert({
          where: { priority },
          update: {},
          create: { priority, ...PRIORITY_DEFAULTS[priority] },
        }),
      ),
    ),
    prisma.supportEscalationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const labels: Record<string, string> = { P1: "P1 — Highest priority", P2: "P2 — Medium priority", P3: "P3 — Normal priority" };

  return (
    <div>
      <PageHeader
        title="Priority Support Policies"
        description="SLA timing per priority tier, and who the final escalation tier reaches. Changing these only affects cases opened afterward — an in-flight case keeps the policy it started with."
        actions={
          <HelpButton moduleTitle="Priority Support Policies">
            <HelpSection title="Important: changes aren't retroactive">
              <p>
                Each case snapshots its policy's minute values the moment it opens. Editing P1/P2/P3
                timing here only affects cases opened after you save — an already-open case keeps
                running on the numbers it started with.
              </p>
            </HelpSection>
            <HelpSection title="The escalation chain, in order">
              <p>
                <strong>First alert</strong> — minutes after the case opens before the first alert
                posts in your configured WhatsApp notification group(s) (0 = immediately).{" "}
                <strong>Second alert</strong> — minutes after that before a re-alert nudge, if still no
                reply. <strong>Member escalation</strong> — minutes after that before a direct DM to the
                group's assigned team member (skipped silently if none is assigned or they're inactive).
                {" "}<strong>Admin escalation</strong> — minutes after that before a DM to the
                Escalation Admin set below. <strong>Follow-up interval</strong> — once the admin tier
                has fired, how often it repeats the DM to that same admin, indefinitely.{" "}
                <strong>Max escalations</strong> caps the total notification count (including
                follow-ups) — once hit, the case just stops actively sending, it is not auto-resolved.
              </p>
            </HelpSection>
            <HelpSection title="Escalation Settings (top of page)">
              <p>
                "Priority escalation enabled" is a global kill switch for this entire feature — turning
                it off pauses every active case (nothing sent) without cancelling or resetting them;
                turning it back on lets them resume right where they left off. Escalation Admin is one
                person, org-wide, who receives every admin-tier DM and every follow-up for every P1/P2/P3
                case — not per-group.
              </p>
            </HelpSection>
            <HelpSection title="What stops the chain early">
              <p>
                Any message from a real person (not automation) in that chat immediately marks the case
                HUMAN_REPLIED and stops all further alerts, no matter which tier it was on.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <div className="space-y-4">
        <EscalationSettingsForm
          enabled={escalationSettings.enabled}
          escalationAdminId={escalationSettings.escalationAdminId}
          teamMembers={teamMembers}
        />
        {policies.map((p) => (
          <PolicyForm key={p.priority} priority={p.priority} label={labels[p.priority] ?? p.priority} defaults={p} />
        ))}
      </div>
    </div>
  );
}
