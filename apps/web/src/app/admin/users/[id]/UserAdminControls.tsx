"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  PROJECT_ACCESS_LEVEL_DESCRIPTIONS,
  PROJECT_ACCESS_LEVEL_LABELS,
  PROJECT_ACCESS_LEVELS,
  PROJECT_STATUS_LABELS,
  type ProjectAccessLevelValue,
  type ProjectStatusValue,
} from "@support-automation/shared";
import { Button, Select, useToast } from "@/components/ui";
import { setUserAccessLevel, setUserEmployee, setUserRole, type AdminUserFormState } from "@/server/actions/adminUsers";

function useRun() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<AdminUserFormState>) =>
    startTransition(async () => {
      const result = await action();
      if (result.error) showToast({ tone: "danger", title: result.error });
      else {
        showToast({ tone: "success", title: result.success ?? "Saved" });
        router.refresh();
      }
    });
  return { run, pending };
}

export function RoleControl({ userId, current, roles, canEdit }: { userId: string; current: string | null; roles: Array<{ id: string; name: string }>; canEdit: boolean }) {
  const { run, pending } = useRun();
  const [choice, setChoice] = useState(current ?? "");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-64">
        <Select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!canEdit || pending} aria-label="Role">
          <option value="">No role</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>
      {canEdit ? (
        <Button size="sm" disabled={choice === (current ?? "")} loading={pending} onClick={() => run(() => setUserRole(userId, choice))}>
          Save role
        </Button>
      ) : null}
    </div>
  );
}

export function EmployeeLink({
  userId,
  linked,
  freeEmployees,
}: {
  userId: string;
  linked: string | null;
  freeEmployees: Array<{ id: string; employeeCode: string; fullName: string }>;
}) {
  const { run, pending } = useRun();
  const [choice, setChoice] = useState("");
  if (linked) {
    return (
      <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => setUserEmployee(userId, null))}>
        Unlink employee
      </Button>
    );
  }
  if (freeEmployees.length === 0) return <p className="text-xs text-[color:var(--color-muted-foreground)]">No active employee is without a login. Add one under Configuration → Employees.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-72">
        <Select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Employee to link">
          <option value="">Choose an employee…</option>
          {freeEmployees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.employeeCode} — {e.fullName}
            </option>
          ))}
        </Select>
      </div>
      <Button size="sm" disabled={!choice} loading={pending} onClick={() => run(() => setUserEmployee(userId, choice))}>
        Link employee
      </Button>
    </div>
  );
}

export function AccessMatrix({
  userId,
  rows,
  canEdit,
}: {
  userId: string;
  rows: Array<{ projectId: string; name: string; slug: string; status: ProjectStatusValue; level: ProjectAccessLevelValue | null }>;
  canEdit: boolean;
}) {
  const { run, pending } = useRun();
  if (rows.length === 0) return <p className="text-xs text-[color:var(--color-muted-foreground)]">There are no projects.</p>;
  return (
    <>
      <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
        {rows.map((row) => (
          <li key={row.projectId} className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-project={row.slug}>
            <span className="min-w-0 flex-1 text-[13px] font-medium">
              {row.name}
              {row.status !== "ACTIVE" ? <span className="ml-2 text-xs font-normal text-[color:var(--color-muted-foreground)]">{PROJECT_STATUS_LABELS[row.status]}</span> : null}
            </span>
            <div className="w-36">
              <Select
                aria-label={`Access to ${row.name}`}
                value={row.level ?? "NONE"}
                disabled={!canEdit || pending}
                onChange={(e) => run(() => setUserAccessLevel(userId, row.projectId, e.target.value))}
                title={row.level ? PROJECT_ACCESS_LEVEL_DESCRIPTIONS[row.level] : "May not enter this project"}
              >
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
  );
}
