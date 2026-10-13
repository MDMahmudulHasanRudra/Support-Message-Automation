"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Badge, Button, Field, Input } from "@/components/ui";
import { addBillingCurrency, setBillingCurrencyEnabled, type DueFormState } from "@/server/actions/clientBilling";

/** The currencies staff may pick on a due. Empty until somebody adds one; no currency is assumed. */
export function CurrencyPanel({ currencies, canEdit }: { currencies: Array<{ code: string; enabled: boolean }>; canEdit: boolean }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<DueFormState, FormData>(addBillingCurrency, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  useEffect(() => {
    if (!state.success) return;
    formRef.current?.reset();
    router.refresh();
  }, [state, router]);

  function toggle(code: string, enabled: boolean) {
    startTransition(async () => {
      const r = await setBillingCurrencyEnabled(code, enabled);
      setMessage(r.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
        A due with an amount needs one of these. Turning one off only stops it being offered on new dues; dues that already use it are unchanged.
      </p>
      {message ? <Alert tone="info">{message}</Alert> : null}
      {currencies.length === 0 ? <p className="text-sm text-[color:var(--color-muted-foreground)]">No currency listed yet. Dues can still be saved without an amount.</p> : null}
      <ul className="flex flex-wrap gap-2">
        {currencies.map((c) => (
          <li key={c.code} className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-sm">
            <span className="font-medium">{c.code}</span>
            {c.enabled ? <Badge color="green">Offered</Badge> : <Badge color="gray">Off</Badge>}
            {canEdit ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle(c.code, !c.enabled)}>
                {c.enabled ? "Turn off" : "Turn on"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-2">
          <Field label="Add a currency">
            <Input name="code" maxLength={3} placeholder="Three-letter code" defaultValue={state.values?.code ?? ""} />
          </Field>
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            Add
          </Button>
          {state.error ? <span className="text-sm text-[color:var(--color-danger)]">{state.error}</span> : null}
        </form>
      ) : null}
    </div>
  );
}
