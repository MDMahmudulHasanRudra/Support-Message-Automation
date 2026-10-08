"use client";

import { useActionState } from "react";
import { Alert, Button, Card, Field, Input, SectionHeader } from "@/components/ui";
import {
  updateGroupParticipantAddSettings,
  type ParticipantAddSettingsState,
} from "@/server/actions/groupParticipantAddSettings";

export interface ParticipantAddSettingsValues {
  delayMinMs: number;
  delayMaxMs: number;
  maxPerMinute: number;
  maxPerJob: number;
  retryMaxAttempts: number;
}

const initialState: ParticipantAddSettingsState = {};

/**
 * Delays are entered in seconds and stored in milliseconds — the same boundary conversion the
 * broadcast limits use, for the same reason: nobody thinks about a pause in thousandths, and
 * typing 15000 invites the one-digit slip that turns fifteen seconds into fifteen milliseconds.
 */
export function ParticipantAddSettingsForm({ settings }: { settings: ParticipantAddSettingsValues }) {
  const [state, formAction, pending] = useActionState(updateGroupParticipantAddSettings, initialState);

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.saved && !state.error ? <Alert tone="success">Limits saved.</Alert> : null}

      <Card>
        <SectionHeader
          title="Pace"
          description="How quickly a job works through its adds. This is the setting that protects the account — the job size below only decides how long it runs."
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Shortest gap (seconds)" hint="Between 5 and 300.">
            <Input
              name="delayMinSeconds"
              type="number"
              min={5}
              max={300}
              defaultValue={Math.round(settings.delayMinMs / 1000)}
            />
          </Field>
          <Field label="Longest gap (seconds)" hint="Must not be shorter than the shortest gap.">
            <Input
              name="delayMaxSeconds"
              type="number"
              min={5}
              max={300}
              defaultValue={Math.round(settings.delayMaxMs / 1000)}
            />
          </Field>
          <Field
            label="Adds per minute"
            hint="Across every running job, not per job. Between 1 and 10. Three is the tested default."
          >
            <Input name="maxPerMinute" type="number" min={1} max={10} defaultValue={settings.maxPerMinute} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Size and retries"
          description="One job counts every number against every group: 5 people across 500 groups is 2,500 adds."
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Maximum adds per job"
            hint="Between 1 and 5000. The wizard refuses more. A large job is not faster — it just runs longer."
          >
            <Input name="maxPerJob" type="number" min={1} max={5000} defaultValue={settings.maxPerJob} />
          </Field>
          <Field label="Retries per add" hint="How many times one failed add is tried again. 0 to 3.">
            <Input
              name="retryMaxAttempts"
              type="number"
              min={0}
              max={3}
              defaultValue={settings.retryMaxAttempts}
            />
          </Field>
        </div>
      </Card>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save limits"}
        </Button>
      </div>
    </form>
  );
}
