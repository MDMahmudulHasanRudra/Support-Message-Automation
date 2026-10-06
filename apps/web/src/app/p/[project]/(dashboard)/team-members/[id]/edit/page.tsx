import { prisma } from "@/server/db";
import { notFound } from "next/navigation";

import { requireAccess } from "@/server/authorize";
import { Alert, Button, Card, Checkbox, PageHeader, SectionHeader } from "@/components/ui";
import { NOTIFICATION_EVENTS } from "@/lib/notificationEvents";
import { hasReachablePhoneNumber } from "@support-automation/shared";
import { EditTeamMemberForm } from "./EditTeamMemberForm";
import { loadMemberFormOptions } from "../../memberFormOptions";
import { updateMemberNotificationPreferences } from "@/server/actions/notificationEvents";
import { loginsForProject } from "@/server/projectLogins";
import { LoginLinkForm } from "./LoginLinkForm";

const EVENT_LABELS: Record<string, string> = {
  SUPPORT_ESCALATION: "Support escalation — a priority case is overdue",
  AI_HUMAN_FALLBACK: "AI handed a conversation to a human",
  RULE_NOTIFY_WHATSAPP: "A rule raised a WhatsApp alert",
  RULE_NOTIFY_TEAMS: "A rule raised a Teams alert",
  UNKNOWN_PATTERN: "An unrecognised question keeps coming up",
  COLLECTION_BROKEN: "A WhatsApp number has stopped collecting messages",
  MOOD_ALERT: "Mood Detection found an upset customer",
  SUPPORT_ASSIGNMENT: "Support Assignment — a case went overdue or was escalated",
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
  // Proof the stored id is real: how many messages we hold that came from exactly this sender.
  const seenMessages = member.whatsappId
    ? await prisma.message.count({ where: { senderPhone: member.whatsappId } })
    : null;

  const updatePreferences = updateMemberNotificationPreferences.bind(null, member.id);
  const logins = await loginsForProject();

  return (
    <div>
      <PageHeader title={`Edit ${member.name}`} />
      <Card className="max-w-lg">
        <EditTeamMemberForm
          memberId={member.id}
          options={options}
          seenMessages={seenMessages}
          defaults={{
            name: member.name,
            phoneNumber: member.phoneNumber,
            whatsappId: member.whatsappId,
            role: member.role,
            department: member.department,
            teamId: member.teamId,
            status: member.status,
          }}
        />
      </Card>

      <Card className="mt-5 max-w-lg">
        <SectionHeader
          title="Dashboard login"
          description="Link the login this person signs in with, so Support Assignment can show them their own cases under My assignments."
        />
        <LoginLinkForm memberId={member.id} currentUserId={member.userId} logins={logins} />
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
