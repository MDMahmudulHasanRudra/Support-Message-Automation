"use client";

import { useActionState, useState } from "react";
import {
  PROJECT_ACCESS_LEVEL_DESCRIPTIONS,
  PROJECT_ACCESS_LEVEL_LABELS,
  PROJECT_ACCESS_LEVELS,
  PROJECT_STATUS_LABELS,
  type ProjectStatusValue,
} from "@support-automation/shared";
import { Alert, Button, Card, Field, Input, SectionHeader, Select } from "@/components/ui";
import { createUserFromAdmin } from "@/server/actions/adminUsers";

type Named = { id: string; name: string };

export function NewUserForm({
  roles,
  projects,
  canAccess,
  canEmployees,
  freeEmployees,
  departments,
  jobTitles,
}: {
  roles: Array<Named & { description: string | null }>;
  projects: Array<Named & { status: ProjectStatusValue }>;
  canAccess: boolean;
  canEmployees: boolean;
  freeEmployees: Array<{ id: string; employeeCode: string; fullName: string; email: string | null }>;
  departments: Named[];
  jobTitles: Named[];
}) {
  const [state, action, pending] = useActionState(createUserFromAdmin, {});
  const [mode, setMode] = useState<"none" | "existing" | "new">("none");

  return (
    <form action={action} className="space-y-5">
      <Card>
        <SectionHeader title="1. Employee" description="The person this login belongs to. Optional — a login can exist without an employee record, and one can be linked later." />
        {canEmployees ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-4 text-[13px]" role="radiogroup" aria-label="Employee">
              {(
                [
                  ["none", "No employee record"],
                  ["existing", "An existing employee"],
                  ["new", "Create a new employee"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2">
                  <input type="radio" name="employeeMode" value={value} checked={mode === value} onChange={() => setMode(value)} />
                  {label}
                </label>
              ))}
            </div>
            {mode === "existing" ? (
              freeEmployees.length === 0 ? (
                <p className="text-xs text-[color:var(--color-muted-foreground)]">Every active employee already has a login.</p>
              ) : (
                <Field label="Employee" required>
                  <Select name="employeeId" defaultValue="">
                    <option value="">Choose…</option>
                    {freeEmployees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.employeeCode} — {e.fullName}
                        {e.email ? ` (${e.email})` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
              )
            ) : null}
            {mode === "new" ? (
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Full name" hint="Leave empty to use the display name below.">
                  <Input name="emp_fullName" maxLength={150} />
                </Field>
                <Field label="Employee email" hint="Optional.">
                  <Input name="emp_email" type="email" maxLength={200} />
                </Field>
                <Field label="Phone" hint="Optional.">
                  <Input name="emp_phone" maxLength={40} />
                </Field>
                <Field label="Joined on" hint="Optional.">
                  <Input name="emp_joinedOn" type="date" />
                </Field>
                <Field label="Department">
                  <Select name="emp_departmentId" defaultValue="">
                    <option value="">None</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Job title">
                  <Select name="emp_jobTitleId" defaultValue="">
                    <option value="">None</option>
                    {jobTitles.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <p className="text-xs text-[color:var(--color-muted-foreground)] md:col-span-2">The employee ID (EMP-…) is assigned when you save.</p>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Your role cannot record employees (Manage Departments, Job Titles &amp; Employees). The login is created without one; an employee can be linked later.
          </p>
        )}
      </Card>

      <Card>
        <SectionHeader title="2. Login" description="How they sign in." />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Username" required hint="Lowercase, used to log in. Cannot be changed later.">
            <Input name="username" required autoComplete="off" />
          </Field>
          <Field label="Display name" required>
            <Input name="name" required maxLength={150} />
          </Field>
          <Field label="Login email" hint="Optional.">
            <Input name="email" type="email" />
          </Field>
          <div />
          <Field label="Password" required hint="At least 12 characters.">
            <Input name="password" type="password" required minLength={12} autoComplete="new-password" />
          </Field>
          <Field label="Confirm password" required>
            <Input name="confirmPassword" type="password" required minLength={12} autoComplete="new-password" />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="3. Role" description="What they may do — the existing Permission Modules, the same in every project they can enter." />
        <div className="max-w-md">
          <Field label="Role">
            <Select name="permissionModuleId" defaultValue="">
              <option value="">No role (can sign in, can do nothing)</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="4. Project access"
          description="Which projects they may enter, and how much of their role they may use in each. A level only narrows the role; Full is the whole role and never more."
        />
        {canAccess ? (
          projects.length === 0 ? (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">There are no projects yet.</p>
          ) : (
            <>
              <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
                {projects.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1 text-[13px] font-medium">
                      {p.name}
                      {p.status !== "ACTIVE" ? <span className="ml-2 text-xs font-normal text-[color:var(--color-muted-foreground)]">{PROJECT_STATUS_LABELS[p.status]}</span> : null}
                    </span>
                    <div className="w-36">
                      <Select name={`access:${p.id}`} defaultValue="NONE" aria-label={`Access to ${p.name}`}>
                        <option value="NONE">No access</option>
                        {PROJECT_ACCESS_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {PROJECT_ACCESS_LEVEL_LABELS[level]}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </li>
                ))}
              </ul>
              <ul className="mt-3 space-y-1 text-xs text-[color:var(--color-muted-foreground)]">
                {PROJECT_ACCESS_LEVELS.map((level) => (
                  <li key={level}>
                    <span className="font-medium text-[color:var(--color-foreground)]">{PROJECT_ACCESS_LEVEL_LABELS[level]}:</span> {PROJECT_ACCESS_LEVEL_DESCRIPTIONS[level]}
                  </li>
                ))}
              </ul>
            </>
          )
        ) : (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Your role cannot give project access (Manage Projects and Project Access). The user is created with none; a Main Admin can add it.
          </p>
        )}
      </Card>

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" loading={pending}>
        Create user
      </Button>
    </form>
  );
}
