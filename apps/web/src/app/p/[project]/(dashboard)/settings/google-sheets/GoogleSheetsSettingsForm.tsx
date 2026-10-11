"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input, SwitchField } from "@/components/ui";
import { MAX_INACTIVITY_MINUTES, MIN_INACTIVITY_MINUTES } from "@support-automation/shared";
import { saveGoogleSheetsSettingsAction, type SettingsActionResult } from "@/server/actions/googleSheetsSettings";

/** The module's two settings: the inactivity threshold (§7) and reading changes made in Google (Phase 8). */
export function GoogleSheetsSettingsForm({
  canManage,
  inactivityMinutes,
  externalActivityEnabled,
  updated,
}: {
  canManage: boolean;
  inactivityMinutes: number;
  externalActivityEnabled: boolean;
  updated: string | null;
}) {
  const [state, formAction, pending] = useActionState<SettingsActionResult, FormData>(saveGoogleSheetsSettingsAction, {});
  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="A pause starts after"
        htmlFor="gs-inactivity"
        hint="Minutes without any interaction on an open spreadsheet before the time stops counting. Time is counted only between signals that are closer than this; reading without touching anything for longer shows as a pause."
      >
        <div className="flex items-center gap-2">
          <Input
            id="gs-inactivity"
            name="inactivityMinutes"
            type="number"
            min={MIN_INACTIVITY_MINUTES}
            max={MAX_INACTIVITY_MINUTES}
            defaultValue={inactivityMinutes}
            disabled={!canManage}
            className="w-24"
          />
          <span className="text-[13px] text-[color:var(--color-muted-foreground)]">minutes</span>
        </div>
      </Field>
      <SwitchField
        name="externalActivityEnabled"
        defaultChecked={externalActivityEnabled}
        disabled={!canManage}
        label="Read changes made in Google directly"
        description="For monitored spreadsheets only, about every 15 minutes, through a connected account that allowed it. Google says when a change happened and sometimes which Google account made it — never which cells and never for how long, so these count as edits, never as work time."
      />
      {canManage ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={pending}>
            Save settings
          </Button>
          {updated ? <span className="text-[12px] text-[color:var(--color-muted-foreground)]">{updated}</span> : null}
        </div>
      ) : null}
      {state.error ? (
        <Alert tone="danger" title="Not saved">
          {state.error}
        </Alert>
      ) : state.success ? (
        <Alert tone="success" title={state.success} />
      ) : null}
    </form>
  );
}
