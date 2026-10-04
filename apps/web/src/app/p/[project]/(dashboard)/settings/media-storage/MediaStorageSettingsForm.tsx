"use client";

import { Lock } from "lucide-react";
import { useActionState, useState } from "react";
import {
  MEDIA_RETENTION_MAX_DAYS,
  MEDIA_RETENTION_MIN_DAYS,
  MEDIA_RETENTION_PRESETS,
  MEDIA_SIZE_LIMIT_BYTES,
  MESSAGE_MEDIA_SETTING_FIELD,
  MESSAGE_MEDIA_TYPE_HINTS,
  MESSAGE_MEDIA_TYPE_LABELS,
  MESSAGE_MEDIA_TYPES,
  formatMediaBytes,
} from "@support-automation/shared";
import { Alert, Button, Card, Field, Input, SectionHeader, Select, SwitchField } from "@/components/ui";
import { saveMediaStorageSettings, type MediaStorageSettingsState } from "@/server/actions/mediaStorage";
import type { MediaStorageSettingsView } from "@/server/mediaStorageReports";

const initialState: MediaStorageSettingsState = {};

function retentionChoice(days: number | null): string {
  if (days === null) return "never";
  return MEDIA_RETENTION_PRESETS.some((p) => p.days === days) ? String(days) : "custom";
}

export function MediaStorageSettingsForm({ settings, canManage }: { settings: MediaStorageSettingsView; canManage: boolean }) {
  const [state, formAction, pending] = useActionState(saveMediaStorageSettings, initialState);
  const [choice, setChoice] = useState(retentionChoice(settings.retentionDays));

  return (
    <form action={formAction} className="mb-5 space-y-5">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.saved && !state.error ? <Alert tone="success">Media storage settings saved.</Alert> : null}
      {state.retentionNote ? <Alert tone="info">{state.retentionNote}</Alert> : null}

      <Card>
        <SectionHeader
          title="What is stored"
          description="Each switch affects attachments that arrive from now on. Turning one off deletes nothing already stored; turning one on cannot recover anything that arrived while it was off."
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex items-start justify-between gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-4">
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-[color:var(--color-foreground)]">Messages</span>
              <span className="mt-1 block text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
                The text of every message, and a record of every attachment. Always stored — there is no switch.
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-success-fg)]">
              <Lock className="size-3" aria-hidden />
              Always stored
            </span>
          </div>
          {MESSAGE_MEDIA_TYPES.map((type) => {
            const field = MESSAGE_MEDIA_SETTING_FIELD[type];
            return (
              <SwitchField
                key={type}
                name={field}
                label={MESSAGE_MEDIA_TYPE_LABELS[type]}
                description={`${MESSAGE_MEDIA_TYPE_HINTS[type]} Up to ${formatMediaBytes(MEDIA_SIZE_LIMIT_BYTES[type])} per file.`}
                defaultChecked={settings[field]}
                disabled={!canManage}
              />
            );
          })}
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Media retention"
          description="Stored files older than this are removed in the background, in small batches. Message text is never removed, and removed files cannot be restored."
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Keep stored media">
            <Select name="retention" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!canManage}>
              {MEDIA_RETENTION_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.days === null ? "never" : String(preset.days)}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom number of days…</option>
            </Select>
          </Field>
          {choice === "custom" ? (
            <Field label="Keep the last (days)" hint={`Between ${MEDIA_RETENTION_MIN_DAYS} and ${MEDIA_RETENTION_MAX_DAYS}.`}>
              <Input
                name="retentionCustomDays"
                type="number"
                min={MEDIA_RETENTION_MIN_DAYS}
                max={MEDIA_RETENTION_MAX_DAYS}
                defaultValue={settings.retentionDays && retentionChoice(settings.retentionDays) === "custom" ? settings.retentionDays : 30}
                disabled={!canManage}
              />
            </Field>
          ) : null}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
          Choosing a period schedules a background cleanup — nothing is deleted while you wait on this page. Switching back to
          &ldquo;keep everything&rdquo; stops any scheduled retention cleanup at once.
        </p>
      </Card>

      {canManage ? (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
