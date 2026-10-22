"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { platformLogin, type PlatformLoginState } from "./actions";

export function PlatformLoginForm() {
  const [state, action, pending] = useActionState<PlatformLoginState, FormData>(platformLogin, {});
  return (
    <form action={action} className="space-y-4">
      <Field label="Username" htmlFor="pl-user">
        <Input id="pl-user" name="username" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="pl-pass">
        <Input id="pl-pass" name="password" type="password" autoComplete="current-password" required />
      </Field>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" loading={pending} className="w-full">
        Sign in
      </Button>
    </form>
  );
}
