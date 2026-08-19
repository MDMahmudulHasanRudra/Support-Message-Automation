"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, Table, Td, Th } from "@/components/ui";
import { setUserActive, resetUserPassword } from "@/server/actions/users";

export interface UserRow {
  id: string;
  username: string;
  name: string;
  email: string | null;
  permissionModuleName: string | null;
  isActive: boolean;
  lastLoginAtLabel: string | null;
  isCurrentUser: boolean;
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
              <Td>{u.permissionModuleName ?? <span className="text-[color:var(--color-muted-foreground)]">None assigned</span>}</Td>
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
