import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
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
