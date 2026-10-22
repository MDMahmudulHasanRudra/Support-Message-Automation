"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useState, useTransition } from "react";

import Link from "@/components/ProjectLink";
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, Table, Td, Th } from "@/components/ui";
import { deleteUser, setUserActive, resetUserPassword } from "@/server/actions/users";

export interface UserRow {
  id: string;
  username: string;
  name: string;
  email: string | null;
  permissionModuleName: string | null;
  isActive: boolean;
  lastLoginAtLabel: string | null;
  isCurrentUser: boolean;
  /** Administrator-level role (Main Admin or project-administration keys): never deletable. */
  isAdministrator: boolean;
  /** The viewer may delete this login (a Main Admin, and the row is a lower user). */
  canDelete: boolean;
}

export function UsersTable({ users }: { users: UserRow[] }) {
  const router = useRouter();
  const [toggleTarget, setToggleTarget] = useState<UserRow | null>(null);
  const [isToggling, startToggle] = useTransition();
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [isResetting, startReset] = useTransition();
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [typed, setTyped] = useState("");
  const [isDeleting, startDelete] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function closeDelete() {
    setDeleteTarget(null);
    setTyped("");
    setDeleteError(null);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    startDelete(async () => {
      const result = await deleteUser(deleteTarget.id, typed);
      if (result.error) {
        setDeleteError(result.error);
        return;
      }
      closeDelete();
      router.refresh();
    });
  }

  function confirmToggle() {
    if (!toggleTarget) return;
    startToggle(async () => {
      const result = await setUserActive(toggleTarget.id, !toggleTarget.isActive);
      if (result.error) {
        setToggleError(result.error);
        return;
      }
      setToggleTarget(null);
      setToggleError(null);
      router.refresh();
    });
  }

  function submitReset() {
    if (!resetTarget) return;
    startReset(async () => {
      const result = await resetUserPassword(resetTarget.id, newPassword);
      if (result.error) {
        setResetError(result.error);
        return;
      }
      setResetError(null);
      setResetDone(true);
    });
  }

  function closeResetDialog() {
    setResetTarget(null);
    setNewPassword("");
    setResetError(null);
    setResetDone(false);
  }

  if (users.length === 0) {
    return <EmptyState>No App Users yet. Create one to get started.</EmptyState>;
  }

  return (
    <div>
      <Table>
        <thead>
          <tr>
            <Th>Username</Th>
            <Th>Display Name</Th>
            <Th>Permission Module</Th>
            <Th>Status</Th>
            <Th>Last Login</Th>
            <Th>Manage</Th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <Td>{u.username}</Td>
              <Td>
                {u.name}
                {u.isCurrentUser ? <span className="ml-1.5 text-xs text-[color:var(--color-muted-foreground)]">(you)</span> : null}
              </Td>
              <Td>
                {u.permissionModuleName ?? <span className="text-[color:var(--color-muted-foreground)]">None assigned</span>}
                {u.isAdministrator ? (
                  <span className="ml-2">
                    <Badge color="blue">Administrator</Badge>
                  </span>
                ) : null}
              </Td>
              <Td>
                <Badge color={u.isActive ? "green" : "gray"} dot>
                  {u.isActive ? "Active" : "Inactive"}
                </Badge>
              </Td>
              <Td>{u.lastLoginAtLabel ?? <span className="text-[color:var(--color-muted-foreground)]">Never</span>}</Td>
              <Td>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/users/${u.id}/edit`}>
                    <Button variant="secondary" size="sm">
                      Edit
                    </Button>
                  </Link>
                  <Link href={`/users/${u.id}/sessions`}>
                    <Button variant="secondary" size="sm">
                      Sessions
                    </Button>
                  </Link>
                  <Button variant="secondary" size="sm" onClick={() => setResetTarget(u)}>
                    Reset Password
                  </Button>
                  <Button
                    variant={u.isActive ? "danger" : "secondary"}
                    size="sm"
                    disabled={u.isCurrentUser && u.isActive}
                    onClick={() => setToggleTarget(u)}
                  >
                    {u.isActive ? "Deactivate" : "Activate"}
                  </Button>
                  {u.canDelete ? (
                    <Button variant="danger" size="sm" onClick={() => setDeleteTarget(u)}>
                      Delete
                    </Button>
                  ) : null}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => {
          setToggleTarget(null);
          setToggleError(null);
        }}
        onConfirm={confirmToggle}
        loading={isToggling}
        tone={toggleTarget?.isActive ? "danger" : "primary"}
        title={`${toggleTarget?.isActive ? "Deactivate" : "Activate"} "${toggleTarget?.username}"?`}
        description={
          toggleTarget?.isActive
            ? "This immediately signs them out of every device and blocks future logins until reactivated."
            : "This user will be able to log in again immediately."
        }
        confirmLabel={toggleTarget?.isActive ? "Deactivate" : "Activate"}
      >
        {toggleError ? <Alert tone="danger">{toggleError}</Alert> : null}
      </ConfirmDialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={closeDelete}
        title={`Delete "${deleteTarget?.username}" permanently?`}
        description="The login is removed for good and they are signed out everywhere. What they did stays in the records without their name; the System Log keeps who was deleted. This cannot be undone — Deactivate instead if they may come back."
        footer={
          <>
            <Button variant="secondary" onClick={closeDelete} disabled={isDeleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} loading={isDeleting} disabled={typed.trim() !== deleteTarget?.username}>
              Delete user
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {deleteError ? <Alert tone="danger">{deleteError}</Alert> : null}
          <Field label={`Type ${deleteTarget?.username ?? ""} to confirm`}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={resetTarget !== null}
        onClose={closeResetDialog}
        title={`Reset password for "${resetTarget?.username}"`}
        description={resetDone ? undefined : "This immediately signs them out of every device — they must log in again with the new password."}
        footer={
          resetDone ? (
            <Button onClick={closeResetDialog}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={closeResetDialog} disabled={isResetting}>
                Cancel
              </Button>
              <Button onClick={submitReset} loading={isResetting} disabled={newPassword.length < 12}>
                Reset Password
              </Button>
            </>
          )
        }
      >
        {resetDone ? (
          <Alert tone="success">Password reset. Every existing session for this user has been signed out.</Alert>
        ) : (
          <div className="space-y-3">
            {resetError ? <Alert tone="danger">{resetError}</Alert> : null}
            <Field label="New Password" hint="At least 12 characters.">
              <Input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}
