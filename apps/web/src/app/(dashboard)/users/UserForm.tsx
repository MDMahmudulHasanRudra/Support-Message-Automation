"use client";

import { useActionState } from "react";
import { Button, Card, Field, Input, SectionHeader, Select } from "@/components/ui";
import type { UserFormState } from "@/server/actions/users";

export interface PermissionModuleOption {
  id: string;
  name: string;
}

export interface UserFormDefaults {
  username?: string;
  name?: string;
  email?: string;
  permissionModuleId?: string;
}

export function UserForm({
  action,
  defaults = {},
  permissionModules,
  mode,
  submitLabel = "Save",
}: {
  action: (prevState: UserFormState, formData: FormData) => Promise<UserFormState>;
  defaults?: UserFormDefaults;
  permissionModules: PermissionModuleOption[];
  mode: "create" | "edit";
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="App User" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Username" required hint={mode === "edit" ? "Usernames cannot be changed after creation." : "Lowercase, used to log in."}>
            <Input name="username" defaultValue={defaults.username} disabled={mode === "edit"} required={mode === "create"} />
          </Field>
          <Field label="Display Name" required>
            <Input name="name" defaultValue={defaults.name} required />
          </Field>
          <Field label="Email" hint="Optional.">
            <Input name="email" type="email" defaultValue={defaults.email} />
          </Field>
          <Field label="Permission Module" hint="Determines what this user can access.">
            <Select name="permissionModuleId" defaultValue={defaults.permissionModuleId ?? ""}>
              <option value="">None assigned</option>
              {permissionModules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {mode === "create" ? (
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Password" required hint="At least 12 characters.">
              <Input name="password" type="password" autoComplete="new-password" required />
            </Field>
            <Field label="Confirm Password" required>
              <Input name="confirmPassword" type="password" autoComplete="new-password" required />
            </Field>
          </div>
        ) : null}
      </Card>

      {state.error ? <p className="text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}

      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
