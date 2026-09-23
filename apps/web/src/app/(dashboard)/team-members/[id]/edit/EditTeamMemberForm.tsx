"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { updateTeamMember, type TeamMemberFormState } from "@/server/actions/teamMembers";

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
}: {
  memberId: string;
  defaults: { name: string; phoneNumber: string; role: string; department: string | null };
}) {
  const [state, formAction, pending] = useActionState<TeamMemberFormState, FormData>(
    updateTeamMember.bind(null, memberId),
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <Field label="Name" required>
        <Input name="name" defaultValue={defaults.name} required />
      </Field>
      <Field label="Phone Number" required>
        <Input name="phoneNumber" defaultValue={defaults.phoneNumber} inputMode="tel" required />
      </Field>
      <Field label="Role" required>
        <Input name="role" defaultValue={defaults.role} required />
      </Field>
      <Field label="Department">
        <Input name="department" defaultValue={defaults.department ?? ""} />
      </Field>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" loading={pending}>
        Save
      </Button>
    </form>
  );
}
