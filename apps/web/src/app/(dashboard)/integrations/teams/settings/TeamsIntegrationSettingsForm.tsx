"use client";

import { useActionState } from "react";
import type { TeamsIntegrationSettings } from "@prisma/client";
import { Button, Card, Field, Input, SectionHeader, SwitchField, Textarea } from "@/components/ui";
import { saveTeamsIntegrationSettings, type TeamsIntegrationSettingsFormState } from "@/server/actions/teamsIntegration";

export function TeamsIntegrationSettingsForm({ settings }: { settings: TeamsIntegrationSettings }) {
  const [state, formAction, pending] = useActionState<TeamsIntegrationSettingsFormState, FormData>(saveTeamsIntegrationSettings, {});

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="Resolution Detection" description="The kill switch for evaluating Teams messages against Resolution Rules." />
        <SwitchField name="enableResolutionDetection" label="Enable resolution detection" defaultChecked={settings.enableResolutionDetection} />
      </Card>

      <Card>
        <SectionHeader
          title="Customer Notification"
          description="Off by default — an admin must explicitly opt in before this system ever sends a WhatsApp message to a real customer based on Teams-side developer activity alone."
        />
        <SwitchField
          name="enableCustomerNotification"
          label="Notify the customer automatically on a resolution match"
          defaultChecked={settings.enableCustomerNotification}
        />
        <div className="mt-4">
          <Field
            label="Notification Message Template"
            hint="Supports {{customerName}}, {{issueId}}, and {{executiveName}} placeholders."
          >
            <Textarea name="notificationTemplate" defaultValue={settings.notificationTemplate} rows={3} required />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Sync" description="How often the worker polls Microsoft Graph for new messages in linked channels." />
        <div className="max-w-xs">
          <Field label="Polling Interval (minutes)">
            <Input name="pollingIntervalMinutes" type="number" min={1} defaultValue={settings.pollingIntervalMinutes} required />
          </Field>
        </div>
      </Card>

      {state.error ? <p className="text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-[color:var(--color-success-fg)]">Settings saved.</p> : null}

      <Button type="submit" loading={pending}>
        Save
      </Button>
    </form>
  );
}
