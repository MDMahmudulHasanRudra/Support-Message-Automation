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
import { Badge, Button, ConfirmDialog, Select, Switch, useToast } from "@/components/ui";
import { resetUserTwoStep, setUserAccessLevel, setUserEmployee, setUserLead, setUserRole, type AdminUserFormState } from "@/server/actions/adminUsers";

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

export function TwoStepReset({ userId, enabled, canEdit }: { userId: string; enabled: boolean; canEdit: boolean }) {
  const { run, pending } = useRun();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {enabled ? <Badge color="green">On</Badge> : <Badge color="gray">Off</Badge>}
      {enabled && canEdit ? (
        <Button size="sm" variant="secondary" loading={pending} onClick={() => setConfirming(true)}>
          Reset two-step sign-in
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          run(() => resetUserTwoStep(userId));
        }}
        title="Reset two-step sign-in?"
        description="Their authenticator app and recovery codes stop working, they are signed out everywhere, and their password alone will sign them in until they turn it on again. Confirm who is asking before you do this."
        confirmLabel="Reset"
        tone="danger"
      />
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

type MatrixRow = {
  projectId: string;
  name: string;
  slug: string;
  status: ProjectStatusValue;
  level: ProjectAccessLevelValue | null;
  isLead: boolean;
  projectRoleName: string | null;
};

/** A change that takes something away, held until it is confirmed. */
type PendingChange = { kind: "remove"; row: MatrixRow } | { kind: "lead"; row: MatrixRow; makeLead: boolean };

const LEAD_DESCRIPTION = "The Lead runs this project: its app users, its project roles and each member's modules.";

export function AccessMatrix({
  userId,
  rows,
  canEdit,
}: {
  userId: string;
  rows: MatrixRow[];
  canEdit: boolean;
}) {
  const { run, pending } = useRun();
  const [confirming, setConfirming] = useState<PendingChange | null>(null);
  if (rows.length === 0) return <p className="text-xs text-[color:var(--color-muted-foreground)]">There are no projects.</p>;

  function confirm() {
    const change = confirming;
    setConfirming(null);
    if (!change) return;
    if (change.kind === "remove") run(() => setUserAccessLevel(userId, change.row.projectId, "NONE"));
    else run(() => setUserLead(userId, change.row.projectId, change.makeLead));
  }

  return (
    <>
      <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
        {rows.map((row) => (
          <li key={row.projectId} className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-project={row.slug}>
            <span className="min-w-0 flex-1 text-[13px] font-medium">
              {row.name}
              {row.status !== "ACTIVE" ? <span className="ml-2 text-xs font-normal text-[color:var(--color-muted-foreground)]">{PROJECT_STATUS_LABELS[row.status]}</span> : null}
              {row.isLead ? (
                <span className="ml-2">
                  <Badge color="blue">Lead</Badge>
                </span>
              ) : null}
              {row.projectRoleName ? <span className="ml-2 text-xs font-normal text-[color:var(--color-muted-foreground)]">Project role: {row.projectRoleName}</span> : null}
              <span className="mt-0.5 block text-xs font-normal text-[color:var(--color-muted-foreground)]">
                {row.level ? PROJECT_ACCESS_LEVEL_DESCRIPTIONS[row.level] : "May not enter this project."}
              </span>
            </span>
            <label className="flex items-center gap-2 text-xs text-[color:var(--color-muted-foreground)]" title={LEAD_DESCRIPTION}>
              <Switch
                checked={row.isLead}
                disabled={!canEdit || pending || row.status === "ARCHIVED"}
                onChange={(e) => setConfirming({ kind: "lead", row, makeLead: e.target.checked })}
                aria-label={`Lead of ${row.name}`}
              />
              Lead
            </label>
            <div className="w-36">
              <Select
                aria-label={`Access to ${row.name}`}
                value={row.level ?? "NONE"}
                disabled={!canEdit || pending}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === "NONE") setConfirming({ kind: "remove", row });
                  else run(() => setUserAccessLevel(userId, row.projectId, value));
                }}
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
        <li>
          <span className="font-medium text-[color:var(--color-foreground)]">Lead:</span> {LEAD_DESCRIPTION}
        </li>
      </ul>
      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={confirm}
        title={
          !confirming
            ? ""
            : confirming.kind === "remove"
              ? `Remove access to ${confirming.row.name}?`
              : confirming.makeLead
                ? `Make them Lead of ${confirming.row.name}?`
                : `Remove them as Lead of ${confirming.row.name}?`
        }
        description={
          !confirming
            ? undefined
            : confirming.kind === "remove"
              ? `They can no longer enter ${confirming.row.name}, from their next request.${confirming.row.isLead || confirming.row.projectRoleName ? " Their Lead status and project role there are removed too; giving access back later starts from their global role." : ""} Nothing they did there is deleted, and access can be given back at any time.`
              : confirming.makeLead
                ? `They get Full access to ${confirming.row.name} and run it: they can create its app users, create its project roles and choose each member's modules.`
                : `They stop running ${confirming.row.name}: they can no longer manage its members or project roles. Their access to the project itself is unchanged.`
        }
        confirmLabel={!confirming ? undefined : confirming.kind === "remove" ? "Remove access" : confirming.makeLead ? "Make Lead" : "Remove as Lead"}
        tone={confirming?.kind === "lead" && confirming.makeLead ? "primary" : "danger"}
        loading={pending}
      />
    </>
  );
}
