"use client";

import { useActionState, useState, useTransition } from "react";
import { PROJECT_ACCESS_LEVEL_LABELS, type ProjectAccessLevelValue, type ProjectMemberActions } from "@support-automation/shared";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, Select, Table, Td, Th, useToast } from "@/components/ui";
import {
  removeProjectMember,
  resetProjectMemberPassword,
  setMemberProjectRole,
  setProjectMemberActive,
  type ProjectAdminState,
} from "@/server/actions/projectAdmin";

export interface MemberRow {
  userId: string;
  username: string;
  name: string;
  email: string | null;
  isActive: boolean;
  lastLoginLabel: string | null;
  isLead: boolean;
  isMainAdmin: boolean;
  level: ProjectAccessLevelValue;
  projectRoleId: string | null;
  globalRoleName: string | null;
  otherProjects: number;
  isSelf: boolean;
  can: ProjectMemberActions;
}

type RoleOption = { id: string; name: string };

export function AddProjectMemberForm({
  action,
  roles,
}: {
  action: (prev: ProjectAdminState, form: FormData) => Promise<ProjectAdminState>;
  roles: RoleOption[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Username" required hint="What they sign in with. Letters, numbers, dots and dashes.">
          <Input name="username" autoComplete="off" required />
        </Field>
        <Field label="Display name" required>
          <Input name="name" required />
        </Field>
        <Field label="Email" hint="Optional.">
          <Input name="email" type="email" autoComplete="off" />
        </Field>
        <Field label="Project role" required hint="Which modules they may open in this project, and whether they may change things.">
          <Select name="projectRoleId" defaultValue="" required>
            <option value="" disabled>
              Choose a role…
            </option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Password" required hint="At least 12 characters. Give it to them privately; nobody can read it back later.">
          <Input name="password" type="password" autoComplete="new-password" required />
        </Field>
        <Field label="Confirm password" required>
          <Input name="confirmPassword" type="password" autoComplete="new-password" required />
        </Field>
      </div>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" loading={pending}>
        Create member
      </Button>
    </form>
  );
}

function RoleCell({ row, roles }: { row: MemberRow; roles: RoleOption[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState(row.projectRoleId ?? "");
  if (row.isLead) return <span className="text-xs text-[color:var(--color-muted-foreground)]">Lead — every module here</span>;
  if (row.isMainAdmin) return <span className="text-xs text-[color:var(--color-muted-foreground)]">Main Admin — platform role</span>;
  const canClear = row.globalRoleName !== null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-48">
        <Select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!row.can.changeRole || pending} aria-label={`Project role of ${row.username}`}>
          {canClear || row.projectRoleId === null ? <option value="">{canClear ? `Global role (${row.globalRoleName})` : "None"}</option> : null}
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>
      {row.can.changeRole && choice !== (row.projectRoleId ?? "") ? (
        <Button
          size="sm"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await setMemberProjectRole(row.userId, choice);
              if (result.error) showToast({ tone: "danger", title: result.error });
              else {
                showToast({ tone: "success", title: result.success ?? "Saved" });
                router.refresh();
              }
            })
          }
        >
          Save
        </Button>
      ) : null}
    </div>
  );
}

export function ProjectMembersTable({ rows, roles }: { rows: MemberRow[]; roles: RoleOption[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null);
  const [toggleTarget, setToggleTarget] = useState<MemberRow | null>(null);
  const [resetTarget, setResetTarget] = useState<MemberRow | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);
  const [pending, startTransition] = useTransition();

  const finish = (result: ProjectAdminState, close: () => void) => {
    if (result.error) {
      setDialogError(result.error);
      return;
    }
    setDialogError(null);
    close();
    showToast({ tone: "success", title: result.success ?? "Saved" });
    router.refresh();
  };

  if (rows.length === 0) return <EmptyState>Nobody can enter this project yet.</EmptyState>;

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>Member</Th>
            <Th>Project role</Th>
            <Th>Access</Th>
            <Th>Last sign-in</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.userId}>
              <Td>
                <div className="font-medium">
                  {row.name}
                  {row.isSelf ? <span className="ml-1 text-xs font-normal text-[color:var(--color-muted-foreground)]">(you)</span> : null}
                </div>
                <div className="text-xs text-[color:var(--color-muted-foreground)]">
                  @{row.username}
                  {row.otherProjects > 0 ? ` · also in ${row.otherProjects} other project${row.otherProjects === 1 ? "" : "s"}` : ""}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {row.isLead ? <Badge color="blue">Lead</Badge> : null}
                  {row.isMainAdmin ? <Badge color="cyan">Main Admin</Badge> : null}
                  {!row.isActive ? <Badge color="gray">Deactivated</Badge> : null}
                </div>
              </Td>
              <Td>
                <RoleCell row={row} roles={roles} />
              </Td>
              <Td>{PROJECT_ACCESS_LEVEL_LABELS[row.level]}</Td>
              <Td>{row.lastLoginLabel ?? <span className="text-[color:var(--color-muted-foreground)]">Never</span>}</Td>
              <Td>
                <div className="flex flex-wrap gap-1.5">
                  {row.can.resetPassword ? (
                    <Button size="sm" variant="secondary" onClick={() => {
                        setResetTarget(row);
                        setNewPassword("");
                        setResetDone(false);
                        setDialogError(null);
                      }}>
                      Reset password
                    </Button>
                  ) : null}
                  {row.can.setActive ? (
                    <Button size="sm" variant="secondary" onClick={() => {
                        setToggleTarget(row);
                        setDialogError(null);
                      }}>
                      {row.isActive ? "Deactivate" : "Activate"}
                    </Button>
                  ) : null}
                  {row.can.remove ? (
                    <Button size="sm" variant="ghost" onClick={() => {
                        setRemoveTarget(row);
                        setDialogError(null);
                      }}>
                      Remove
                    </Button>
                  ) : null}
                  {!row.can.changeRole && !row.can.remove && !row.isSelf ? (
                    <span className="text-xs text-[color:var(--color-muted-foreground)]">Managed by a Main Admin</span>
                  ) : null}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => startTransition(async () => finish(await removeProjectMember(removeTarget!.userId), () => setRemoveTarget(null)))}
        loading={pending}
        tone="danger"
        title={`Remove "${removeTarget?.username}" from this project?`}
        description="They can no longer enter this project. Their login, and any other project they belong to, are untouched."
        confirmLabel="Remove"
      >
        {dialogError ? <Alert tone="danger">{dialogError}</Alert> : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        onConfirm={() =>
          startTransition(async () => finish(await setProjectMemberActive(toggleTarget!.userId, !toggleTarget!.isActive), () => setToggleTarget(null)))
        }
        loading={pending}
        tone={toggleTarget?.isActive ? "danger" : "primary"}
        title={`${toggleTarget?.isActive ? "Deactivate" : "Activate"} "${toggleTarget?.username}"?`}
        description={
          toggleTarget?.isActive
            ? "This signs them out of every device and blocks sign-in until reactivated. Their history is kept."
            : "They will be able to sign in again immediately."
        }
        confirmLabel={toggleTarget?.isActive ? "Deactivate" : "Activate"}
      >
        {dialogError ? <Alert tone="danger">{dialogError}</Alert> : null}
      </ConfirmDialog>

      <Dialog
        open={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        title={`Reset password for "${resetTarget?.username}"`}
        description={resetDone ? undefined : "This immediately signs them out of every device; they sign in again with the new password."}
        footer={
          resetDone ? (
            <Button onClick={() => setResetTarget(null)}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setResetTarget(null)} disabled={pending}>
                Cancel
              </Button>
              <Button
                loading={pending}
                disabled={newPassword.length < 12}
                onClick={() =>
                  startTransition(async () => {
                    const result = await resetProjectMemberPassword(resetTarget!.userId, newPassword);
                    if (result.error) setDialogError(result.error);
                    else {
                      setDialogError(null);
                      setResetDone(true);
                    }
                  })
                }
              >
                Reset password
              </Button>
            </>
          )
        }
      >
        {resetDone ? (
          <Alert tone="success">Password reset. Every existing session for this member has been signed out.</Alert>
        ) : (
          <div className="space-y-3">
            {dialogError ? <Alert tone="danger">{dialogError}</Alert> : null}
            <Field label="New password" hint="At least 12 characters.">
              <Input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </Field>
          </div>
        )}
      </Dialog>
    </>
  );
}
