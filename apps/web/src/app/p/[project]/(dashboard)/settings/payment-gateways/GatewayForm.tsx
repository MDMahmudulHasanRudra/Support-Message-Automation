"use client";

import { useActionState, useState } from "react";
import { gatewayCredentialFields, PAYMENT_PROVIDER_LABEL, type PaymentProviderValue } from "@support-automation/shared";
import { Alert, Badge, Button, Card, Field, Input, SwitchField } from "@/components/ui";
import { saveGateway, type GatewayFormState } from "@/server/actions/paymentLinks";

/** Where each provider hands out its details, in the provider's own words for the screen. */
const WHERE: Record<PaymentProviderValue, string> = {
  SSLCOMMERZ: "SSLCOMMERZ merchant panel → your store's Store ID and Store Password. For test mode, use the sandbox store you get at developer.sslcommerz.com.",
  BKASH: "bKash gives these when your merchant account is approved for online payments (Tokenized Checkout): app key, app secret, username and password.",
};

export function GatewayForm({ provider, saved }: { provider: PaymentProviderValue; saved: { mode: "SANDBOX" | "LIVE"; enabled: boolean } | null }) {
  const [state, action, pending] = useActionState<GatewayFormState, FormData>(saveGateway, {});
  // An account nobody set up stays one line until someone chooses it.
  const [open, setOpen] = useState(Boolean(saved));
  const [mode, setMode] = useState<"SANDBOX" | "LIVE">(saved?.mode ?? "SANDBOX");
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">{PAYMENT_PROVIDER_LABEL[provider]}</h2>
        {saved ? <Badge color={saved.enabled ? (saved.mode === "LIVE" ? "green" : "blue") : "gray"}>{saved.enabled ? (saved.mode === "LIVE" ? "Taking real payments" : "Test mode") : "Off"}</Badge> : <Badge color="gray">Not set up</Badge>}
      </div>
      {!open ? (
        <div className="mt-3">
          <Button type="button" onClick={() => setOpen(true)}>
            Set up {PAYMENT_PROVIDER_LABEL[provider]}
          </Button>
        </div>
      ) : (
        <form action={action} className="mt-3.5 space-y-3.5">
          <input type="hidden" name="provider" value={provider} />
          <input type="hidden" name="mode" value={mode} />
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Start with</p>
            <div className="inline-flex rounded-[var(--radius-md)] border border-[var(--color-border)] p-0.5" role="radiogroup" aria-label="Mode">
              {(["SANDBOX", "LIVE"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={`h-8 rounded-[calc(var(--radius-md)-2px)] px-3 text-[12.5px] font-medium ${mode === m ? "bg-[var(--color-accent-bg)] text-[color:var(--color-foreground)]" : "text-[color:var(--color-muted-foreground)]"}`}
                >
                  {m === "SANDBOX" ? "Test (no real money)" : "Real payments"}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">Where to find these: {WHERE[provider]}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {gatewayCredentialFields(provider).map((f) => (
              <Field key={f.key} label={f.label}>
                <Input name={f.key} type="password" autoComplete="new-password" placeholder={saved ? "Saved. Leave empty to keep." : ""} />
              </Field>
            ))}
          </div>
          {/* On by default for a first setup: saving details nobody can use is the usual way this goes wrong. */}
          <SwitchField name="enabled" defaultChecked={saved?.enabled ?? true} label="Offer this to customers" />
          {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
          {state.success ? <Alert tone="success">{state.success}</Alert> : null}
          <div className="flex justify-end gap-2">
            {!saved ? (
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
