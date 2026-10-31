"use client";

import { useState, useTransition } from "react";
import { Check, Copy, PencilLine } from "lucide-react";
import { Button, Field, Input, useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { changeClientCode } from "@/server/actions/clients";

/**
 * The client code on Add / Edit Client (CLIENT_CODES.md §Manual codes). A new client gets the project's next code;
 * only someone who manages the client settings may type one instead. An existing client's code is shown, not edited
 * with the other fields: changing it is its own logged step that keeps the old code searchable.
 */
export function ClientCodeField({
  mode,
  clientId,
  code,
  nextCode,
  canChoose,
}: {
  mode: "create" | "edit";
  clientId?: string;
  code: string;
  /** The code the project would give next — a preview, never a reservation. */
  nextCode: string | null;
  canChoose: boolean;
}) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState(code);
  const [pending, startTransition] = useTransition();

  if (mode === "create") {
    return canChoose ? (
      <Field label="Client code" hint={`Leave empty for the project's next code${nextCode ? ` (${nextCode})` : ""}. A code you choose must be free in this project.`}>
        <Input name="code" defaultValue={code} maxLength={40} placeholder={nextCode ? `Automatic: ${nextCode}` : "Automatic if blank"} className="font-mono" autoComplete="off" />
      </Field>
    ) : (
      <Field label="Client code" hint="Given automatically when the client is saved.">
        <p className="flex h-9.5 items-center rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 font-mono text-[13px] text-[color:var(--color-muted-foreground)]">
          {nextCode ? `Next: ${nextCode}` : "Automatic"}
        </p>
      </Field>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast({ tone: "danger", title: "Copying is not available in this browser." });
    }
  };
  const save = () =>
    startTransition(async () => {
      const result = await changeClientCode(clientId ?? "", draft);
      showToast({ tone: result.ok ? "success" : "danger", title: result.message });
      if (result.ok) {
        setChanging(false);
        router.refresh();
      }
    });

  return (
    <Field label="Client code" hint={changing ? "The old code stays searchable and still finds this client. Issued invoices and receipts keep the code they were issued with." : "Not edited with the other fields."}>
      {changing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="New client code" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={40} className="w-44 font-mono" autoComplete="off" />
          <Button size="sm" type="button" onClick={save} loading={pending} disabled={!draft.trim() || draft.trim() === code}>
            Save code
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => (setChanging(false), setDraft(code))}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[14px] font-semibold tabular" data-client-code>
            {code}
          </span>
          <Button size="sm" type="button" variant="ghost" onClick={copy} aria-label={`Copy client code ${code}`}>
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          </Button>
          {canChoose ? (
            <Button size="sm" type="button" variant="ghost" onClick={() => setChanging(true)}>
              <PencilLine className="size-3.5" aria-hidden /> Change code
            </Button>
          ) : null}
        </div>
      )}
    </Field>
  );
}
