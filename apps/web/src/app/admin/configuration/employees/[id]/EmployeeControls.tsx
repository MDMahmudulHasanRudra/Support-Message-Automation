"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, ConfirmDialog, Select, useToast } from "@/components/ui";
import { linkEmployeeLogin, toggleEmployee, type ConfigFormState } from "@/server/actions/configuration";

function useRun() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<ConfigFormState>) =>
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

export function EmployeeStatusControl({
  employeeId,
  employeeName,
  hasLogin,
  active,
}: {
  employeeId: string;
  employeeName: string;
  hasLogin: boolean;
  active: boolean;
}) {
  const { run, pending } = useRun();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button variant="secondary" loading={pending} onClick={() => (active ? setConfirming(true) : run(() => toggleEmployee(employeeId, true)))}>
        {active ? "Deactivate employee" : "Reactivate employee"}
      </Button>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          run(() => toggleEmployee(employeeId, false));
        }}
        title={`Deactivate ${employeeName}?`}
        description={`${employeeName} is marked inactive and is no longer offered when linking logins. The record and its history are kept, and you can reactivate it at any time.`}
        confirmLabel="Deactivate employee"
        tone="danger"
        loading={pending}
      >
        {hasLogin ? (
          <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
            Their app login is not touched and can still sign in. If they have left, deactivate the login separately under Users &amp; Permissions.
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

export function EmployeeLoginControl({
  employeeId,
  linkedUserId,
  freeLogins,
}: {
  employeeId: string;
  linkedUserId: string | null;
  freeLogins: Array<{ id: string; username: string; name: string }>;
}) {
  const { run, pending } = useRun();
  const [choice, setChoice] = useState("");
  if (linkedUserId) {
    return (
      <Button variant="secondary" size="sm" loading={pending} onClick={() => run(() => linkEmployeeLogin(employeeId, null))}>
        Unlink login
      </Button>
    );
  }
  if (freeLogins.length === 0) {
    return <p className="text-xs text-[color:var(--color-muted-foreground)]">Every login is already linked to someone. Create a login under Users &amp; Permissions.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-64">
        <Select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Login to link">
          <option value="">Choose a login…</option>
          {freeLogins.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} (@{u.username})
            </option>
          ))}
        </Select>
      </div>
      <Button size="sm" disabled={!choice} loading={pending} onClick={() => run(() => linkEmployeeLogin(employeeId, choice))}>
        Link login
      </Button>
    </div>
  );
}
