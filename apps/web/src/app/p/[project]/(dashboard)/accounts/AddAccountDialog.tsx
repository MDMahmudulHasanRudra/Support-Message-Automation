"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Alert, Button, Dialog, Field, Input, useToast } from "@/components/ui";
import { addWhatsAppAccount } from "@/server/actions/accounts";

export function AddAccountDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const { showToast } = useToast();

  function close() {
    setOpen(false);
    setError(null);
  }

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await addWhatsAppAccount(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      close();
      showToast({
        tone: "success",
        title: "Account added",
        description: "The worker will pick it up and show a QR code shortly.",
      });
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        Add Account
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title="Add WhatsApp account"
        description="The worker will assign a session and show a QR code to scan once it picks this account up."
      >
        {/* The wrong turn is taken here, so the correction belongs here rather than in help text
            nobody opens. Adding an account to REPLACE a number silently strands everything: groups
            are per-account, so the old account keeps the monitoring and AI settings while the new
            one starts empty, and replies keep going out on whichever account received the message
            — which is still the old one. */}
        <Alert tone="info">
          This is for running a <strong>second</strong> number alongside your current one. To
          <strong> replace</strong> the number you already use, do not add an account — use{" "}
          <strong>Logout</strong> then <strong>Reconnect</strong> on the existing card and scan with
          the new phone. Its groups, monitoring and AI settings all carry over on their own.
        </Alert>

        <form action={handleSubmit} className="mt-4">
          <Field
            label="Label"
            htmlFor="label"
            required
            error={error}
            hint={error ? undefined : "A short name to tell accounts apart, e.g. “Sales” or “Support”."}
          >
            <Input id="label" name="label" placeholder="Sales" required autoFocus />
          </Field>
          <div className="mt-6 flex justify-end gap-2 border-t border-[var(--color-border)] pt-4">
            <Button type="button" variant="secondary" onClick={close} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={isPending}>
              Add Account
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
