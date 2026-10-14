"use client";

import { useActionState, useState } from "react";
import { isReadOnlyKey, PROJECT_ASSIGNABLE_PERMISSIONS } from "@support-automation/shared";
import { Alert, Badge, Button, Card, Checkbox, Field, Input, SectionHeader, Textarea } from "@/components/ui";
import type { ProjectAdminState } from "@/server/actions/projectAdmin";

/**
 * A project role: a name, and which modules of THIS project it opens, each split into what it lets a
 * member see (Read) and what it lets them change (Write). Only project-scoped keys are offered —
 * nothing of the Main Admin Portal or the platform's user management can be put in a project role,
 * and the server filters again whatever is submitted.
 */

const MODULES = Array.from(new Set(PROJECT_ASSIGNABLE_PERMISSIONS.map((p) => p.category)));

export function ProjectRoleForm({
  action,
  defaults = {},
  submitLabel,
}: {
  action: (prev: ProjectAdminState, form: FormData) => Promise<ProjectAdminState>;
  defaults?: { name?: string; description?: string | null; permissionKeys?: string[] };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [checked, setChecked] = useState<Set<string>>(() => new Set(defaults.permissionKeys ?? []));

  const setMany = (keys: string[], on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="Role" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" required hint="Unique in this project, e.g. Support Agent, Billing Officer.">
            <Input name="name" defaultValue={defaults.name} maxLength={80} required />
          </Field>
          <Field label="Description">
            <Textarea name="description" defaultValue={defaults.description ?? ""} rows={1} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader
          title={`Modules (${checked.size} permission${checked.size === 1 ? "" : "s"} chosen)`}
          description="Read lets a member open and look; Write lets them change things. A module the Main Admin has switched off for this project stays off whatever is chosen here."
        />
        <div className="space-y-5">
          {MODULES.map((module) => {
            const perms = PROJECT_ASSIGNABLE_PERMISSIONS.filter((p) => p.category === module);
            const readKeys = perms.filter((p) => isReadOnlyKey(p.key)).map((p) => p.key);
            const allKeys = perms.map((p) => p.key);
            const allOn = allKeys.every((k) => checked.has(k));
            return (
              <div key={module} className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">{module}</span>
                  <span className="flex-1" />
                  {readKeys.length > 0 ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setMany(readKeys, true)}>
                      Read only
                    </Button>
                  ) : null}
                  <Button type="button" size="sm" variant="ghost" onClick={() => setMany(allKeys, !allOn)}>
                    {allOn ? "Clear" : "Full"}
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                  {perms.map((p) => (
                    <label key={p.key} className="flex items-center gap-2 text-sm">
                      <Checkbox name="permissionKeys" value={p.key} checked={checked.has(p.key)} onChange={() => setMany([p.key], !checked.has(p.key))} />
                      <span className="min-w-0 flex-1">{p.label}</span>
                      <Badge color={isReadOnlyKey(p.key) ? "gray" : "yellow"}>{isReadOnlyKey(p.key) ? "Read" : "Write"}</Badge>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
