"use client";

import { useActionState } from "react";
import { Button, Card } from "@/components/ui";
import { updateSafetySettings, type SettingsFormState } from "@/server/actions/settings";
import type { AutomationSettings } from "@prisma/client";

const inputClass = "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export function SettingsForm({ settings }: { settings: AutomationSettings }) {
  const [state, formAction, pending] = useActionState<SettingsFormState, FormData>(updateSafetySettings, {});

  return (
    <form action={formAction} className="space-y-6">
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Per-Client Reply Limits</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Max replies per client per hour">
            <input name="maxRepliesPerClientPerHour" type="number" defaultValue={settings.maxRepliesPerClientPerHour} className={inputClass} />
          </Field>
          <Field label="Max replies per client per day">
            <input name="maxRepliesPerClientPerDay" type="number" defaultValue={settings.maxRepliesPerClientPerDay} className={inputClass} />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Global Rate Limiting</h2>
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" name="rateLimitingEnabled" defaultChecked={settings.rateLimitingEnabled} /> Rate limiting enabled
        </label>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Max per minute">
            <input name="globalMaxPerMinute" type="number" defaultValue={settings.globalMaxPerMinute} className={inputClass} />
          </Field>
          <Field label="Max per hour">
            <input name="globalMaxPerHour" type="number" defaultValue={settings.globalMaxPerHour} className={inputClass} />
          </Field>
          <Field label="Max per day">
            <input name="globalMaxPerDay" type="number" defaultValue={settings.globalMaxPerDay} className={inputClass} />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Reply Delay & Retries</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Default delay min (ms)">
            <input name="defaultReplyDelayMinMs" type="number" defaultValue={settings.defaultReplyDelayMinMs} className={inputClass} />
          </Field>
          <Field label="Default delay max (ms)">
            <input name="defaultReplyDelayMaxMs" type="number" defaultValue={settings.defaultReplyDelayMaxMs} className={inputClass} />
          </Field>
          <Field label="Max retry attempts">
            <input name="retryMaxAttempts" type="number" defaultValue={settings.retryMaxAttempts} className={inputClass} />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Notification Destinations</h2>
        <Field label="Microsoft Teams webhook URL">
          <input name="teamsWebhookUrl" defaultValue={settings.teamsWebhookUrl ?? ""} className={inputClass} />
        </Field>
        <Field label="WhatsApp support group chat id (optional)" className="mt-3">
          <input name="whatsappNotificationGroupId" defaultValue={settings.whatsappNotificationGroupId ?? ""} className={inputClass} />
        </Field>
      </Card>

      {state.success ? <p className="text-sm text-green-600">Settings saved.</p> : null}
      {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving..." : "Save Settings"}
      </Button>
    </form>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</label>
      {children}
    </div>
  );
}
