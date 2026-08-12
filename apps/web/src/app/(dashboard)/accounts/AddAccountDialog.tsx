"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Button, Dialog, Field, Input, useToast } from "@/components/ui";
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
        <form action={handleSubmit}>
          <Field
            label="Label"
            htmlFor="label"
            required
            error={error}
            hint={error ? undefined : "A short name to tell accounts apart, e.g. “Sales” or “Support”."}
          >
            <Input id="label" name="label" placeholder="Sales" required autoFocus />
          </Field>
          <div className="mt-4 flex justify-end gap-2">
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
