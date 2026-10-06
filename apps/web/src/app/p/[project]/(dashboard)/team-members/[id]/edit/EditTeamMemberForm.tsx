"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { updateTeamMember, type TeamMemberFormState } from "@/server/actions/teamMembers";
import { MemberSuggestionLists, TeamSelect, type MemberFormOptions } from "../../MemberFormFields";

/**
 * The edit form, as a client component so a refusal lands beside the fields rather than as the
 * error boundary. See AddTeamMemberForm for why the server-rendered version could not do that.
 *
 * This form matters more than it looks: for anybody added from message history, the stored "phone
 * number" is a WhatsApp id, and typing their real number here is the only way to make them
 * reachable for direct alerts. A clash with a colleague now says who, instead of crashing.
 */
export function EditTeamMemberForm({
  memberId,
  defaults,
  options,
  seenMessages = null,
}: {
  seenMessages?: number | null;
  memberId: string;
  defaults: {
    name: string;
    phoneNumber: string;
    whatsappId: string | null;
    role: string;
    department: string | null;
    teamId: string | null;
    status: string;
  };
  options: MemberFormOptions;
}) {
  const [state, formAction, pending] = useActionState<TeamMemberFormState, FormData>(
    updateTeamMember.bind(null, memberId),
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <MemberSuggestionLists options={options} />
      <Field label="Name" required>
        <Input name="name" defaultValue={defaults.name} required />
      </Field>
      <Field label="Phone Number" required>
        <Input name="phoneNumber" defaultValue={defaults.phoneNumber} inputMode="tel" required />
      </Field>
      <Field
        label="WhatsApp ID (optional)"
        hint="The long id WhatsApp shows for this person in groups. Open one of their messages in Messages — the Sender is this id when it is a long number. Keep the real phone number above as well."
      >
        <Input name="whatsappId" defaultValue={defaults.whatsappId ?? ""} inputMode="numeric" placeholder="e.g. 145938777669643" />
        {seenMessages !== null ? (
          <p className="mt-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">
            {seenMessages > 0
              ? `Verified: ${seenMessages.toLocaleString("en-US")} stored message${seenMessages === 1 ? "" : "s"} were sent from this id.`
              : "No stored message was sent from this id yet — check it against a message's Sender."}
          </p>
        ) : null}
      </Field>
      <Field
        label="Team"
        hint="Changing the team keeps their past work with the team they were in at the time; the Team Report counts it there."
      >
        <TeamSelect teams={options.teams} defaultValue={defaults.teamId} />
      </Field>
      <Field label="Department">
        <Input name="department" defaultValue={defaults.department ?? ""} list="member-departments" />
      </Field>
      <Field label="Designation" required>
        <Input name="role" defaultValue={defaults.role} list="member-designations" required />
      </Field>
      <Field label="Status">
        <Select name="status" defaultValue={defaults.status === "INACTIVE" ? "INACTIVE" : "ACTIVE"}>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Disabled</option>
        </Select>
      </Field>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" loading={pending}>
        Save
      </Button>
    </form>
  );
}
