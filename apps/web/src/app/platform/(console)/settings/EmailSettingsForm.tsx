"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { requestPlatformTestEmail, savePlatformEmailSettings, type EmailSettingsState } from "@/server/platform/actions/settings";

interface Initial {
  enabled: boolean;
  host: string;
  port: number;
  tlsMode: string;
  username: string;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  testPending: boolean;
}

export function EmailSettingsForm({ initial }: { initial: Initial }) {
  const [state, action, pending] = useActionState<EmailSettingsState, FormData>(savePlatformEmailSettings, {});
  const [testState, testAction, testing] = useActionState<EmailSettingsState, FormData>(requestPlatformTestEmail, {});
  const e = state.fieldErrors ?? {};
  return (
    <div className="space-y-6">
      <form action={action} className="space-y-4">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={initial.enabled} className="mt-1" />
          <span className="font-medium">Send platform email</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Mail server" htmlFor="pe-host" error={e.host}>
            <Input id="pe-host" name="host" defaultValue={initial.host} placeholder="smtp.example.com" />
          </Field>
          <Field label="Port" htmlFor="pe-port" error={e.port}>
            <Input id="pe-port" name="port" type="number" defaultValue={initial.port} />
          </Field>
          <Field label="Encryption" htmlFor="pe-tls">
            <Select id="pe-tls" name="tlsMode" defaultValue={initial.tlsMode}>
              <option value="STARTTLS">STARTTLS (usually port 587)</option>
              <option value="TLS">TLS (usually port 465)</option>
            </Select>
          </Field>
          <Field label="Username" htmlFor="pe-user">
            <Input id="pe-user" name="username" defaultValue={initial.username} autoComplete="off" />
          </Field>
          <Field label="Password" htmlFor="pe-pass" hint={initial.hasPassword ? "Saved. Leave empty to keep it." : undefined}>
            <Input id="pe-pass" name="password" type="password" autoComplete="new-password" />
          </Field>
          <div />
          <Field label="From address" htmlFor="pe-from" error={e.fromAddress}>
            <Input id="pe-from" name="fromAddress" type="email" defaultValue={initial.fromAddress} />
          </Field>
          <Field label="From name" htmlFor="pe-name">
            <Input id="pe-name" name="fromName" defaultValue={initial.fromName} placeholder="RELQIVO Billing" />
          </Field>
        </div>
        <Field label="Your platform password" htmlFor="pe-confirm">
          <Input id="pe-confirm" name="operatorPassword" type="password" autoComplete="current-password" required className="max-w-xs" />
        </Field>
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        {state.success ? <Alert tone="success">{state.success}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            Save email settings
          </Button>
        </div>
      </form>

      <form action={testAction} className="space-y-3 border-t border-[var(--color-border)] pt-5">
        <p className="text-sm font-medium">Send a test email</p>
        {initial.lastTestAt ? (
          <Alert tone={initial.lastTestOk ? "success" : "danger"}>
            Last test {new Date(initial.lastTestAt).toLocaleString()}: {initial.lastTestOk ? "accepted by the mail server." : initial.lastTestMessage ?? "failed."}
          </Alert>
        ) : null}
        {initial.testPending ? <Alert tone="info">A test is waiting for the worker.</Alert> : null}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="To" htmlFor="pe-to" error={testState.fieldErrors?.to}>
            <Input id="pe-to" name="to" type="email" className="w-72" />
          </Field>
          <Button type="submit" variant="secondary" loading={testing}>
            Send test
          </Button>
        </div>
        {testState.error ? <Alert tone="danger">{testState.error}</Alert> : null}
        {testState.success ? <Alert tone="success">{testState.success}</Alert> : null}
      </form>
    </div>
  );
}
