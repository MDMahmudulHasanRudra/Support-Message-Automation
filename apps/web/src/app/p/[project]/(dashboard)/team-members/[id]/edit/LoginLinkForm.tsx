"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Select } from "@/components/ui";
import { linkTeamMemberLogin, type LoginLinkState } from "@/server/actions/teamMembers";

const initialState: LoginLinkState = {};

/** Which dashboard login this person uses — what Support Assignment → My assignments reads. */
export function LoginLinkForm({
  memberId,
  currentUserId,
  logins,
}: {
  memberId: string;
  currentUserId: string | null;
  logins: { id: string; name: string; username: string }[];
}) {
  const [state, formAction, pending] = useActionState(linkTeamMemberLogin.bind(null, memberId), initialState);
  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.saved && !state.error ? <Alert tone="success">Login link saved.</Alert> : null}
      <Field label="Dashboard login" hint="Grants no permission and changes no message matching; only “My assignments” uses it.">
        <Select name="userId" defaultValue={currentUserId ?? ""}>
          <option value="">Not linked</option>
          {logins.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.username})
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" loading={pending}>
        Save login link
      </Button>
    </form>
  );
}
