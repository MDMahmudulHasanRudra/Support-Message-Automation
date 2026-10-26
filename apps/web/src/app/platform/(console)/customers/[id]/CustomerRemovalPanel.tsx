"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { removeOrDeleteCustomer, restoreCustomer, type CustomerRemovalState } from "@/server/platform/actions/customers";

const MODES = [
  {
    value: "remove",
    label: "Remove — keep the data",
    detail:
      "The customer disappears from the list. Every workspace is archived, its WhatsApp numbers are released (not logged out), its addresses and logins are switched off and everyone is signed out. Nothing is erased, and Restore brings it all back.",
  },
  {
    value: "delete",
    label: "Delete permanently",
    detail:
      "Erases every workspace and all of its data: messages, clients, WhatsApp numbers, reports, files, logins, roles and addresses. It cannot be undone. The platform's own invoices and payments for this customer are kept.",
  },
] as const;

function useRefreshOnDone(state: CustomerRemovalState) {
  const router = useRouter();
  useEffect(() => {
    if (state.done) router.refresh();
  }, [state.done, router]);
}

/** Remove (restorable) or delete permanently: the operator chooses, types the name and their password. */
export function CustomerRemovalPanel({ customerId, customerName }: { customerId: string; customerName: string }) {
  const [mode, setMode] = useState<"remove" | "delete">("remove");
  const [state, action, pending] = useActionState(removeOrDeleteCustomer.bind(null, customerId), {} as CustomerRemovalState);
  useRefreshOnDone(state);
  return (
    <form action={action} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="sr-only">What should happen</legend>
        {MODES.map((m) => (
          <label
            key={m.value}
            className={`flex cursor-pointer items-start gap-3 rounded-[var(--radius-lg)] border p-3 text-sm ${
              mode === m.value ? (m.value === "delete" ? "border-[var(--color-danger)]" : "border-[var(--color-primary)]") : "border-[var(--color-border)]"
            }`}
          >
            <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} className="mt-0.5 accent-[var(--color-accent)]" />
            <span>
              <span className="font-medium">{m.label}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">{m.detail}</span>
            </span>
          </label>
        ))}
        {state.fieldErrors?.mode ? <p className="text-xs font-medium text-[color:var(--color-danger)]">{state.fieldErrors.mode}</p> : null}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Type the customer's name: ${customerName}`} htmlFor="cr-name" error={state.fieldErrors?.confirmName}>
          <Input id="cr-name" name="confirmName" autoComplete="off" spellCheck={false} required />
        </Field>
        <Field label="Your platform password" htmlFor="cr-pass" error={state.fieldErrors?.operatorPassword}>
          <Input id="cr-pass" name="operatorPassword" type="password" autoComplete="current-password" required />
        </Field>
      </div>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.done ? <Alert tone="success">{state.done}</Alert> : null}
      <div className="flex justify-end">
        <Button type="submit" variant="danger" loading={pending}>
          {mode === "delete" ? "Delete permanently" : "Remove customer"}
        </Button>
      </div>
    </form>
  );
}

/** A removed customer: bring it back, or go on to delete it permanently. */
export function RemovedCustomerPanel({ customerId, customerName }: { customerId: string; customerName: string }) {
  const [restoreState, restoreAction, restoring] = useActionState(restoreCustomer.bind(null, customerId), {} as CustomerRemovalState);
  const [deleteState, deleteAction, deleting] = useActionState(removeOrDeleteCustomer.bind(null, customerId), {} as CustomerRemovalState);
  useRefreshOnDone(restoreState);
  useRefreshOnDone(deleteState);
  return (
    <div className="space-y-4">
      <form action={restoreAction} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
        <p className="text-sm font-medium">Restore</p>
        <p className="text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
          Puts back the workspaces, addresses and logins exactly as they were. WhatsApp numbers reconnect by themselves. Invitations that were still pending stay cancelled.
        </p>
        <Field label="Your platform password" htmlFor="rs-pass" error={restoreState.fieldErrors?.operatorPassword}>
          <Input id="rs-pass" name="operatorPassword" type="password" autoComplete="current-password" required />
        </Field>
        {restoreState.error ? <Alert tone="danger">{restoreState.error}</Alert> : null}
        {restoreState.done ? <Alert tone="success">{restoreState.done}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" loading={restoring}>
            Restore customer
          </Button>
        </div>
      </form>

      <form action={deleteAction} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-danger)]/40 p-4">
        <input type="hidden" name="mode" value="delete" />
        <p className="text-sm font-medium text-[color:var(--color-danger)]">Delete permanently</p>
        <p className="text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">{MODES[1].detail}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Type the customer's name: ${customerName}`} htmlFor="dp-name" error={deleteState.fieldErrors?.confirmName}>
            <Input id="dp-name" name="confirmName" autoComplete="off" spellCheck={false} required />
          </Field>
          <Field label="Your platform password" htmlFor="dp-pass" error={deleteState.fieldErrors?.operatorPassword}>
            <Input id="dp-pass" name="operatorPassword" type="password" autoComplete="current-password" required />
          </Field>
        </div>
        {deleteState.error ? <Alert tone="danger">{deleteState.error}</Alert> : null}
        {deleteState.done ? <Alert tone="success">{deleteState.done}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" variant="danger" loading={deleting}>
            Delete permanently
          </Button>
        </div>
      </form>
    </div>
  );
}
