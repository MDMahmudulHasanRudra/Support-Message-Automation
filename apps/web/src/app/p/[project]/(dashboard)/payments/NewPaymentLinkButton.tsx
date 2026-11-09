"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Alert, Button, Dialog, Field, Input } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { createPaymentLink } from "@/server/actions/paymentLinks";

export function NewPaymentLinkButton({ ready }: { ready: boolean }) {
  const router = useProjectRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = (form: FormData) =>
    start(async () => {
      const r = await createPaymentLink({ amount: form.get("amount"), description: form.get("description"), days: form.get("days") });
      if ("error" in r) setError(r.error);
      else router.push(`/payments/${r.id}`);
    });
  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={!ready} title={ready ? undefined : "Set up a payment account first"}>
        <Plus className="size-4" aria-hidden />
        New link
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New payment link">
        <form action={submit} className="space-y-3.5">
          <Field label="Amount (BDT)">
            <Input name="amount" required inputMode="decimal" placeholder="1500" />
          </Field>
          <Field label="What it is for (optional)">
            <Input name="description" maxLength={200} />
          </Field>
          <Field label="Works for (days)">
            <Input name="days" type="number" min={1} max={30} defaultValue={7} />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
