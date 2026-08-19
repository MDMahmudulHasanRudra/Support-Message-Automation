"use client";

import { useActionState, useState } from "react";
import { PERMISSIONS } from "@support-automation/shared";
import { Button, Card, Checkbox, Field, Input, SectionHeader, Textarea } from "@/components/ui";
import type { PermissionModuleFormState } from "@/server/actions/permissionModules";

export interface PermissionModuleFormDefaults {
  name?: string;
  description?: string;
  permissionKeys?: string[];
  isSystem?: boolean;
}

const CATEGORIES = Array.from(new Set(PERMISSIONS.map((p) => p.category)));

export function PermissionModuleForm({
  action,
  defaults = {},
  submitLabel = "Save",
}: {
  action: (prevState: PermissionModuleFormState, formData: FormData) => Promise<PermissionModuleFormState>;
  defaults?: PermissionModuleFormDefaults;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [checked, setChecked] = useState<Set<string>>(() => new Set(defaults.permissionKeys ?? []));

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleCategory(category: string, keys: string[]) {
    setChecked((prev) => {
      const next = new Set(prev);
      const allChecked = keys.every((k) => next.has(k));
      for (const k of keys) {
        if (allChecked) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="Permission Module" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" required hint={defaults.isSystem ? "Default modules cannot be renamed." : undefined}>
            <Input name="name" defaultValue={defaults.name} disabled={defaults.isSystem} required />
          </Field>
          <Field label="Description">
            <Textarea name="description" defaultValue={defaults.description} rows={1} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Permissions" />
        <div className="space-y-4">
          {CATEGORIES.map((category) => {
            const keysInCategory = PERMISSIONS.filter((p) => p.category === category).map((p) => p.key);
            const allChecked = keysInCategory.every((k) => checked.has(k));
            return (
              <div key={category}>
                <button
                  type="button"
                  onClick={() => toggleCategory(category, keysInCategory)}
                  className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                >
                  {category} {allChecked ? "(clear all)" : "(select all)"}
                </button>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                  {PERMISSIONS.filter((p) => p.category === category).map((p) => (
                    <label key={p.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        name="permissionKeys"
                        value={p.key}
                        checked={checked.has(p.key)}
                        onChange={() => toggle(p.key)}
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {state.error ? <p className="text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}

      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
