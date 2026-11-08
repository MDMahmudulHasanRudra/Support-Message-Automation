"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Alert, Button, Dialog, Field, Input, Textarea } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { PasteValues, usePastedValues } from "@/components/contacts/contactDisplay";
import { createContact } from "@/server/actions/contacts";

export function NewContactButton() {
  const router = useProjectRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const paste = usePastedValues();
  const name = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) name.current?.focus();
  }, [open]);

  const submit = (form: FormData) =>
    start(async () => {
      const result = await createContact({ name: form.get("name"), company: form.get("company"), code: form.get("code"), tags: form.get("tags"), notes: form.get("notes"), values: paste.values });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.push(`/contacts/${result.id}`);
    });

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        New contact
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New contact" description="Only a name or a number is needed. You get a serial number by yourself.">
        <form action={submit} className="space-y-3.5">
          <Field label="Name">
            <Input ref={name} name="name" maxLength={200} />
          </Field>
          <Field label="Numbers, emails, social links" hint="Paste as many as you have.">
            <PasteValues paste={paste} placeholder="01711 000000, name@example.com, facebook.com/name" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Company (optional)">
              <Input name="company" maxLength={200} />
            </Field>
            <Field label="Your own code (optional)">
              <Input name="code" maxLength={40} />
            </Field>
          </div>
          <Field label="Tags (optional)" hint="Separate with commas.">
            <Input name="tags" />
          </Field>
          <Field label="Notes (optional)">
            <Textarea name="notes" rows={2} maxLength={10000} />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save contact"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
