"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, Field, Input, Select, Switch, useToast } from "@/components/ui";
import { EMAIL_TLS_LABELS, EMAIL_TLS_MODES } from "@support-automation/shared";
import { saveEmailSettings, sendTestEmail, setEmailEnabled, type EmailFormState } from "@/server/actions/emailSettings";
import type { EmailSettingsView } from "@/server/emailSettings";

/** The SMTP settings. The password is write-only: it is never filled in, and blank keeps the stored one. */
export function EmailSettingsForm({ settings }: { settings: EmailSettingsView }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, formAction, pending] = useActionState<EmailFormState, FormData>(saveEmailSettings, {});
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [busy, startTransition] = useTransition();
  useEffect(() => {
    if (!state.success) return;
    showToast({ tone: "success", title: state.message ?? "Saved" });
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per successful save
  }, [state]);

  const v = (key: string, fallback: string) => state.values?.[key] ?? fallback;

  function toggle(next: boolean) {
    startTransition(async () => {
      const r = await setEmailEnabled(next);
      setMessage({ tone: r.ok ? "info" : "danger", text: r.message });
      router.refresh();
    });
  }
  function test() {
    startTransition(async () => {
      const r = await sendTestEmail();
      setMessage({ tone: r.ok ? "info" : "danger", text: r.message });
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <form action={formAction} className="space-y-4">
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Mail server (host)" className="sm:col-span-2">
            <Input name="host" required placeholder="smtp.your-provider.com" defaultValue={v("host", settings.host)} autoComplete="off" />
          </Field>
          <Field label="Port">
            <Input name="port" inputMode="numeric" required defaultValue={v("port", String(settings.port))} />
          </Field>
          <Field label="Security">
            <Select name="tlsMode" defaultValue={v("tlsMode", settings.tlsMode)}>
              {EMAIL_TLS_MODES.map((m) => (
                <option key={m} value={m}>
                  {EMAIL_TLS_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Username">
            <Input name="username" required defaultValue={v("username", settings.username)} autoComplete="off" />
          </Field>
          <Field label={settings.passwordSet ? "Password (leave blank to keep the saved one)" : "Password"}>
            <Input name="password" type="password" autoComplete="new-password" placeholder={settings.passwordSet ? "Saved — hidden" : ""} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Sender name">
            <Input name="fromName" maxLength={100} placeholder="e.g. Support Team" defaultValue={v("fromName", settings.fromName)} />
          </Field>
          <Field label="Sender address">
            <Input name="fromAddress" type="email" required placeholder="support@your-domain.com" defaultValue={v("fromAddress", settings.fromAddress)} />
          </Field>
          <Field label="Reply-to (optional)">
            <Input name="replyTo" type="email" defaultValue={v("replyTo", settings.replyTo)} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Most per minute">
            <Input name="maxPerMinute" inputMode="numeric" defaultValue={v("maxPerMinute", String(settings.maxPerMinute))} />
          </Field>
          <Field label="Most per day">
            <Input name="maxPerDay" inputMode="numeric" defaultValue={v("maxPerDay", String(settings.maxPerDay))} />
          </Field>
          <p className="self-end text-xs text-[color:var(--color-muted-foreground)] sm:col-span-2">Set these to what your mail provider actually allows. The defaults are cautious guesses, not your provider&apos;s numbers.</p>
        </div>
        <Button type="submit" loading={pending}>
          Save settings
        </Button>
      </form>

      {settings.exists ? (
        <div className="flex flex-wrap items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <Button type="button" variant="secondary" disabled={busy} onClick={test}>
            Send a test message to me
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={settings.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} aria-label="Email on or off" />
            Email is {settings.enabled ? "on" : "off"}
          </label>
        </div>
      ) : null}
    </div>
  );
}
