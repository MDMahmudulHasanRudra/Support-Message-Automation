"use client";

import type { SupportActivitySettings } from "@prisma/client";
import { Button, Card, Checkbox, Field, SectionHeader, Select } from "@/components/ui";
import { updateSupportActivitySettings } from "@/server/actions/supportActivitySettings";

export function SupportActivitySettingsForm({ settings }: { settings: SupportActivitySettings }) {
  return (
    <form action={updateSupportActivitySettings} className="space-y-4">
      <Card>
        <SectionHeader
          title="Support Activity Tracking"
          description="The master switch — off by default. No existing WhatsApp automation is affected either way."
        />
        <label className="flex items-center gap-2 text-sm text-[color:var(--color-foreground)]">
          <Checkbox name="enabled" defaultChecked={settings.enabled} />
          Enable Support Activity Tracking
        </label>
      </Card>

      <Card>
        <SectionHeader
          title="Counting"
          description="Counts are always computed from the raw activity history, so changing this retroactively reinterprets past data too."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Counting Mode"
            hint="UNIQUE_GROUP: each group counts once per period. EVERY_ACTIVITY: every match counts. PER_TEAM_MEMBER: totals broken down per member."
          >
            <Select name="countingMode" defaultValue={settings.countingMode}>
              <option value="UNIQUE_GROUP">Unique Group</option>
              <option value="EVERY_ACTIVITY">Every Activity</option>
              <option value="PER_TEAM_MEMBER">Per Team Member</option>
            </Select>
          </Field>
          <Field label="Counting Period" hint="Which window the Activity and Team pages report against.">
            <Select name="countingPeriod" defaultValue={settings.countingPeriod}>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly (Sun-Sat)</option>
              <option value="MONTHLY">Monthly</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Button type="submit">Save</Button>
    </form>
  );
}
