"use client";

import type { SupportActivitySettings } from "@prisma/client";
import {
  Button,
  Card,
  Field,
  Input,
  SectionHeader,
  Select,
  SwitchField,
} from "@/components/ui";
import { updateSupportActivitySettings } from "@/server/actions/supportActivitySettings";

export function SupportActivitySettingsForm({ settings }: { settings: SupportActivitySettings }) {
  return (
    <form action={updateSupportActivitySettings} className="space-y-4">
      <Card>
        <SectionHeader
          title="Support Activity Tracking"
          description="The master switch — off by default. No existing WhatsApp automation is affected either way."
        />
        <SwitchField name="enabled" label="Enable Support Activity Tracking" defaultChecked={settings.enabled} />
      </Card>

      <Card>
        <SectionHeader
          title="Counting"
          description="Counts are always computed from the raw activity history, so changing this retroactively reinterprets past data too."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* There was a "Counting Mode" here offering Unique Group / Every Activity / Per Team
              Member. Nothing read it — every number on every page was identical whichever you
              picked — and it was redundant besides: the Activity Feed shows unique groups and total
              activities as separate tiles, and per-member totals are their own table on Team
              Performance. It was removed rather than wired up, because wiring it in would have
              meant hiding one of two numbers people can already see. */}
          <Field label="Counting Period" hint="Which window the Activity and Team pages report against.">
            <Select name="countingPeriod" defaultValue={settings.countingPeriod}>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly (Sun-Sat)</option>
              <option value="MONTHLY">Monthly</option>
            </Select>
          </Field>
          <Field
            label="Offline after (minutes)"
            hint="An executive is online from the moment they message any group. Go this long without messaging and they count as offline; message again and they are online again. The same gap splits one stretch of work from the next. Between 5 minutes and 24 hours."
          >
            <Input
              name="offlineAfterMinutes"
              type="number"
              min={5}
              max={1440}
              defaultValue={settings.offlineAfterMinutes}
            />
          </Field>
          <Field
            label="Missed after (minutes)"
            hint="Team Report: a customer who waits longer than this for a reply counts as Missed — and as Recall if somebody answers later. Groups with a support priority use their escalation policy's first alert instead. Between 1 minute and 24 hours."
          >
            <Input
              name="missedReplyAfterMinutes"
              type="number"
              min={1}
              max={1440}
              defaultValue={settings.missedReplyAfterMinutes}
            />
          </Field>
        </div>
      </Card>

      <Button type="submit">Save</Button>
    </form>
  );
}
