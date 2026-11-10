"use client";

import { useActionState } from "react";
import { gatewayCredentialFields, PAYMENT_PROVIDER_LABEL, type PaymentProviderValue } from "@support-automation/shared";
import { Alert, Badge, Button, Card, Field, Input, Select, SwitchField } from "@/components/ui";
import { saveGateway, type GatewayFormState } from "@/server/actions/paymentLinks";

export function GatewayForm({ provider, saved }: { provider: PaymentProviderValue; saved: { mode: "SANDBOX" | "LIVE"; enabled: boolean } | null }) {
  const [state, action, pending] = useActionState<GatewayFormState, FormData>(saveGateway, {});
  return (
    <Card className="p-5">
      <form action={action} className="space-y-3.5">
        <input type="hidden" name="provider" value={provider} />
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold">{PAYMENT_PROVIDER_LABEL[provider]}</h2>
          {saved ? <Badge color={saved.enabled ? (saved.mode === "LIVE" ? "green" : "blue") : "gray"}>{saved.enabled ? (saved.mode === "LIVE" ? "Taking real payments" : "Test mode") : "Off"}</Badge> : <Badge color="gray">Not set up</Badge>}
        </div>
        <SwitchField name="enabled" defaultChecked={saved?.enabled ?? false} label="Offer this to customers" />
        <Field label="Mode" hint="Test mode moves no real money. Use your sandbox details with it.">
          <Select name="mode" defaultValue={saved?.mode ?? "SANDBOX"}>
            <option value="SANDBOX">Test</option>
            <option value="LIVE">Real payments</option>
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {gatewayCredentialFields(provider).map((f) => (
            <Field key={f.key} label={f.label}>
              <Input name={f.key} type="password" autoComplete="new-password" placeholder={saved ? "Saved. Leave empty to keep." : ""} />
            </Field>
          ))}
        </div>
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        {state.success ? <Alert tone="success">{state.success}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
