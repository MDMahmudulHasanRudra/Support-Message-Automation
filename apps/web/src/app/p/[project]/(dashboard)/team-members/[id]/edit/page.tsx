import { prisma } from "@/server/db";
import { notFound } from "next/navigation";

import { requireAccess } from "@/server/authorize";
import { Alert, Button, Card, Checkbox, PageHeader, SectionHeader } from "@/components/ui";
import { NOTIFICATION_EVENTS } from "@/lib/notificationEvents";
import { hasReachablePhoneNumber } from "@support-automation/shared";
import { EditTeamMemberForm } from "./EditTeamMemberForm";
import { loadMemberFormOptions } from "../../memberFormOptions";
import { updateMemberNotificationPreferences } from "@/server/actions/notificationEvents";

const EVENT_LABELS: Record<string, string> = {
  SUPPORT_ESCALATION: "Support escalation — a priority case is overdue",
  AI_HUMAN_FALLBACK: "AI handed a conversation to a human",
  RULE_NOTIFY_WHATSAPP: "A rule raised a WhatsApp alert",
  RULE_NOTIFY_TEAMS: "A rule raised a Teams alert",
  UNKNOWN_PATTERN: "An unrecognised question keeps coming up",
};

export default async function EditTeamMemberPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess("whatsapp.manage");
  const { id } = await params;
  const [member, options] = await Promise.all([
    prisma.internalTeamMember.findUnique({ where: { id } }),
    loadMemberFormOptions(),
  ]);
  if (!member) notFound();

  const preferences = await prisma.teamMemberNotificationPreference.findMany({
    where: { teamMemberId: member.id },
    select: { event: true },
  });
  const chosen = new Set(preferences.map((row) => row.event));
  const reachable = hasReachablePhoneNumber(member);

  const updatePreferences = updateMemberNotificationPreferences.bind(null, member.id);

  return (
    <div>
      <PageHeader title={`Edit ${member.name}`} />
      <Card className="max-w-lg">
        <EditTeamMemberForm
          memberId={member.id}
          options={options}
          defaults={{
            name: member.name,
            phoneNumber: member.phoneNumber,
            role: member.role,
            department: member.department,
            teamId: member.teamId,
            status: member.status,
          }}
        />
      </Card>

      <Card className="mt-5 max-w-lg">
        <SectionHeader
          title="Alert this person directly"
          description="These arrive as a WhatsApp message to them, in addition to whichever shared group the alert already goes to."
        />

        {!reachable ? (
          <Alert tone="warning">
            This person was added from message history, so what is stored is a WhatsApp id rather
            than a phone number. They are recognised in groups, but cannot receive a direct message
            until a real number is entered above.
          </Alert>
        ) : null}

        <form action={updatePreferences} className="mt-4 space-y-3">
          <div className="space-y-2">
            {NOTIFICATION_EVENTS.map((event) => (
              <label
                key={event}
                className="flex cursor-pointer items-center gap-2.5 text-[13px] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
              >
                <Checkbox name="events" value={event} defaultChecked={chosen.has(event)} disabled={!reachable} />
                <span>{EVENT_LABELS[event]}</span>
              </label>
            ))}
          </div>
          <Button type="submit" disabled={!reachable}>
            Save alert preferences
          </Button>
        </form>
      </Card>
    </div>
  );
}
