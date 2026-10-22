"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { createFirstOperator, type SetupState } from "./actions";

export function SetupForm({ signedInAs }: { signedInAs: string }) {
  const [state, action, pending] = useActionState<SetupState, FormData>(createFirstOperator, {});
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4">
      <p className="text-xs text-[color:var(--color-muted-foreground)]">Allowed because you are signed in to the software as {signedInAs}, a Main Admin of the original installation. This page closes once an operator exists.</p>
      <Field label="Your name" htmlFor="ps-name" error={e.name}>
        <Input id="ps-name" name="name" required maxLength={120} />
      </Field>
      <Field label="Platform username" htmlFor="ps-user" error={e.username} hint="Separate from your software login.">
        <Input id="ps-user" name="username" required autoComplete="off" />
      </Field>
      <Field label="Password" htmlFor="ps-pass" error={e.password} hint="At least 12 characters.">
        <Input id="ps-pass" name="password" type="password" autoComplete="new-password" required />
      </Field>
      <Field label="Confirm password" htmlFor="ps-confirm" error={e.confirmPassword}>
        <Input id="ps-confirm" name="confirmPassword" type="password" autoComplete="new-password" required />
      </Field>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" loading={pending} className="w-full">
        Create operator and sign in
      </Button>
    </form>
  );
}
