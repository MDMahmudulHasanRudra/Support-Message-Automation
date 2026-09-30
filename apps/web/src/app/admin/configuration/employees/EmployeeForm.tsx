"use client";

import { useActionState } from "react";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import { saveEmployee } from "@/server/actions/configuration";

export interface Option {
  id: string;
  name: string;
  isActive: boolean;
}

export interface EmployeeDefaults {
  id?: string;
  employeeCode?: string;
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  departmentId?: string | null;
  jobTitleId?: string | null;
  joinedOn?: string | null;
}

/** Create or edit one employee. The employee ID is assigned on create and shown, never edited. */
export function EmployeeForm({
  defaults = {},
  departments,
  jobTitles,
  canManage,
}: {
  defaults?: EmployeeDefaults;
  departments: Option[];
  jobTitles: Option[];
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState(saveEmployee, {});
  // An inactive department or title stays selectable only if it is already this person's.
  const offer = (options: Option[], current?: string | null) => options.filter((o) => o.isActive || o.id === current);
  return (
    <form action={action}>
      <Card>
        {defaults.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
        <fieldset disabled={!canManage} className="grid gap-4 md:grid-cols-2">
          <Field
            label="Employee ID"
            hint={defaults.employeeCode ? "Assigned once; it never changes." : "Assigned automatically when you save (EMP-000001, EMP-000002…)."}
          >
            <Input value={defaults.employeeCode ?? "Assigned on save"} readOnly disabled className="font-mono" />
          </Field>
          <Field label="Full name" required>
            <Input name="fullName" defaultValue={defaults.fullName} required maxLength={150} />
          </Field>
          <Field label="Email" hint="Optional. Unique per employee.">
            <Input name="email" type="email" defaultValue={defaults.email ?? ""} maxLength={200} />
          </Field>
          <Field label="Phone" hint="Optional.">
            <Input name="phone" defaultValue={defaults.phone ?? ""} maxLength={40} />
          </Field>
          <Field label="Department">
            <Select name="departmentId" defaultValue={defaults.departmentId ?? ""}>
              <option value="">None</option>
              {offer(departments, defaults.departmentId).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.isActive ? "" : " (inactive)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Job title">
            <Select name="jobTitleId" defaultValue={defaults.jobTitleId ?? ""}>
              <option value="">None</option>
              {offer(jobTitles, defaults.jobTitleId).map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                  {j.isActive ? "" : " (inactive)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Joined on" hint="Optional.">
            <Input name="joinedOn" type="date" defaultValue={defaults.joinedOn ?? ""} />
          </Field>
        </fieldset>
        {state.error ? (
          <div className="mt-4">
            <Alert tone="danger">{state.error}</Alert>
          </div>
        ) : null}
        {canManage ? (
          <div className="mt-4">
            <Button type="submit" loading={pending}>
              {defaults.id ? "Save employee" : "Add employee"}
            </Button>
          </div>
        ) : null}
      </Card>
    </form>
  );
}
