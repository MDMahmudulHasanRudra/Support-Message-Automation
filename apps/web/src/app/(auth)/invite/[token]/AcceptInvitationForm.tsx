"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { acceptInvitation, type InviteState } from "./actions";

export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<InviteState, FormData>(acceptInvitation.bind(null, token), {});
  return (
    <form action={formAction} className="space-y-4">
      <Field label="Username" htmlFor="inv-username" required hint="Lower-case letters, digits, dots, dashes or underscores.">
        <Input id="inv-username" name="username" autoComplete="username" required maxLength={60} />
      </Field>
      <Field label="Password" htmlFor="inv-password" required hint="At least 12 characters.">
        <Input id="inv-password" name="password" type="password" autoComplete="new-password" required />
      </Field>
      <Field label="Confirm password" htmlFor="inv-confirm" required>
        <Input id="inv-confirm" name="confirmPassword" type="password" autoComplete="new-password" required />
      </Field>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" loading={pending} className="w-full">
        Create my login
      </Button>
    </form>
  );
}
