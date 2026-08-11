"use client";

import { useActionState, useEffect } from "react";
import { Button, Card, Checkbox, Field, Input, SectionHeader, useToast } from "@/components/ui";
import { updateSafetySettings, type SettingsFormState } from "@/server/actions/settings";
import type { AutomationSettings } from "@prisma/client";

export function SettingsForm({ settings }: { settings: AutomationSettings }) {
  const [state, formAction, pending] = useActionState<SettingsFormState, FormData>(updateSafetySettings, {});
  const { showToast } = useToast();

  useEffect(() => {
    if (state.success) {
      showToast({ tone: "success", title: "Settings saved" });
    } else if (state.error) {
      showToast({ tone: "danger", title: "Could not save settings", description: state.error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="Per-Client Reply Limits" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Max replies per client per hour">
            <Input name="maxRepliesPerClientPerHour" type="number" defaultValue={settings.maxRepliesPerClientPerHour} />
          </Field>
          <Field label="Max replies per client per day">
            <Input name="maxRepliesPerClientPerDay" type="number" defaultValue={settings.maxRepliesPerClientPerDay} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Global Rate Limiting" />
        <label className="mb-4 flex items-center gap-2 text-sm text-[color:var(--color-foreground)]">
          <Checkbox name="rateLimitingEnabled" defaultChecked={settings.rateLimitingEnabled} /> Rate limiting enabled
        </label>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Max per minute">
            <Input name="globalMaxPerMinute" type="number" defaultValue={settings.globalMaxPerMinute} />
          </Field>
          <Field label="Max per hour">
            <Input name="globalMaxPerHour" type="number" defaultValue={settings.globalMaxPerHour} />
          </Field>
          <Field label="Max per day">
            <Input name="globalMaxPerDay" type="number" defaultValue={settings.globalMaxPerDay} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Reply Delay & Retries" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Default delay min (ms)">
            <Input name="defaultReplyDelayMinMs" type="number" defaultValue={settings.defaultReplyDelayMinMs} />
          </Field>
          <Field label="Default delay max (ms)">
            <Input name="defaultReplyDelayMaxMs" type="number" defaultValue={settings.defaultReplyDelayMaxMs} />
          </Field>
          <Field label="Max retry attempts">
            <Input name="retryMaxAttempts" type="number" defaultValue={settings.retryMaxAttempts} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Notification Destinations" />
        <Field label="Microsoft Teams webhook URL">
          <Input name="teamsWebhookUrl" defaultValue={settings.teamsWebhookUrl ?? ""} />
        </Field>
        <div className="mt-4">
          <Field label="WhatsApp support group chat id" hint="Optional.">
            <Input name="whatsappNotificationGroupId" defaultValue={settings.whatsappNotificationGroupId ?? ""} />
          </Field>
        </div>
      </Card>

      <Button type="submit" loading={pending}>
        Save Settings
      </Button>
    </form>
  );
}
