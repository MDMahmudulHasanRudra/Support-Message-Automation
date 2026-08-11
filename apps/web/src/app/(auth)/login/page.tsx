"use client";

import { useActionState } from "react";
import { Button, Card, Field, Input } from "@/components/ui";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-background)]">
      <Card className="w-full max-w-sm">
        <form action={formAction} className="space-y-4">
          <div>
            <h1 className="text-xl font-semibold text-[color:var(--color-foreground)]">
              Support Message Automation
            </h1>
            <p className="text-sm text-[color:var(--color-muted-foreground)]">Sign in to the admin dashboard.</p>
          </div>

          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" required autoComplete="username" />
          </Field>

          <Field label="Password" htmlFor="password">
            <Input id="password" name="password" type="password" required autoComplete="current-password" />
          </Field>

          {state.error ? <p className="text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}

          <Button type="submit" loading={pending} className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
    </main>
  );
}
