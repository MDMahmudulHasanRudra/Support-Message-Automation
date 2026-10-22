"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { Alert, Button, Field, Input, Textarea, useToast } from "@/components/ui";
import { updateCustomer, type CustomerFormState } from "@/server/platform/actions/customers";

export function CustomerDetailsForm({
  customerId,
  canManage,
  initial,
}: {
  customerId: string;
  canManage: boolean;
  initial: { name: string; contactName: string | null; contactEmail: string | null; contactPhone: string | null; notes: string | null };
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, formAction, pending] = useActionState<CustomerFormState, FormData>(updateCustomer.bind(null, customerId), {});
  const errors = state.fieldErrors ?? {};

  useEffect(() => {
    if (!state.savedAt) return;
    showToast({ tone: "success", title: "Customer saved", description: "" });
    router.refresh();
  }, [state.savedAt, showToast, router]);

  return (
    <form action={formAction} className="space-y-4">
      <fieldset disabled={!canManage} className="space-y-4">
        <Field label="Customer name" htmlFor="d-name" required error={errors.name}>
          <Input id="d-name" name="name" defaultValue={initial.name} maxLength={120} required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact person" htmlFor="d-contact">
            <Input id="d-contact" name="contactName" defaultValue={initial.contactName ?? ""} maxLength={120} />
          </Field>
          <Field label="Contact email" htmlFor="d-email" error={errors.contactEmail}>
            <Input id="d-email" name="contactEmail" type="email" defaultValue={initial.contactEmail ?? ""} maxLength={200} />
          </Field>
          <Field label="Contact phone" htmlFor="d-phone">
            <Input id="d-phone" name="contactPhone" defaultValue={initial.contactPhone ?? ""} maxLength={40} />
          </Field>
        </div>
        <Field label="Notes" htmlFor="d-notes">
          <Textarea id="d-notes" name="notes" rows={2} defaultValue={initial.notes ?? ""} maxLength={2000} />
        </Field>
      </fieldset>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {canManage ? (
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" loading={pending}>
            Save details
          </Button>
        </div>
      ) : null}
    </form>
  );
}
