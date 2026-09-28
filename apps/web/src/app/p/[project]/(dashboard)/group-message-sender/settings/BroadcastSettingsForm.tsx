"use client";

import { useActionState } from "react";
import { Alert, Button, Card, Field, Input, SectionHeader } from "@/components/ui";
import {
  updateGroupBroadcastSettings,
  type BroadcastSettingsState,
} from "@/server/actions/groupBroadcastSettings";

export interface BroadcastSettingsValues {
  delayMinMs: number;
  delayMaxMs: number;
  maxPerMinute: number;
  maxPerJob: number;
  retryMaxAttempts: number;
  duplicateGroupCooldownMinutes: number;
}

const initialState: BroadcastSettingsState = {};

/**
 * Delays are entered in seconds and stored in milliseconds. Nobody thinks about a pause between
 * messages in thousandths of a second, and asking them to type 15000 invites a slip of one digit
 * that turns a fifteen-second gap into a fifteen-millisecond one.
 */
export function BroadcastSettingsForm({ settings }: { settings: BroadcastSettingsValues }) {
  const [state, formAction, pending] = useActionState(updateGroupBroadcastSettings, initialState);

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.saved && !state.error ? <Alert tone="success">Limits saved.</Alert> : null}

      <Card>
        <SectionHeader
          title="Pace"
          description="How quickly a broadcast works through its groups. The gap between each send is random within this range, so the pattern does not look automated."
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Shortest gap (seconds)" hint="Between 1 and 120.">
            <Input
              name="delayMinSeconds"
              type="number"
              min={1}
              max={120}
              defaultValue={Math.round(settings.delayMinMs / 1000)}
            />
          </Field>
          <Field label="Longest gap (seconds)" hint="Must not be shorter than the shortest gap.">
            <Input
              name="delayMaxSeconds"
              type="number"
              min={1}
              max={120}
              defaultValue={Math.round(settings.delayMaxMs / 1000)}
            />
          </Field>
          <Field label="Messages per minute" hint="Across all running broadcasts. Between 1 and 30.">
            <Input name="maxPerMinute" type="number" min={1} max={30} defaultValue={settings.maxPerMinute} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Size and repetition"
          description="How large one broadcast may be, and how soon the same group may be included in another."
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Maximum groups per broadcast" hint="The send wizard refuses more than this. Between 1 and 2000.">
            <Input name="maxPerJob" type="number" min={1} max={2000} defaultValue={settings.maxPerJob} />
          </Field>
          <Field label="Retries per group" hint="How many times one failed group is tried again. 0 to 5.">
            <Input name="retryMaxAttempts" type="number" min={0} max={5} defaultValue={settings.retryMaxAttempts} />
          </Field>
          <Field
            label="Repeat cooldown (minutes)"
            hint="How long before the same group can be included in another broadcast. 0 disables it."
          >
            <Input
              name="duplicateGroupCooldownMinutes"
              type="number"
              min={0}
              max={10080}
              defaultValue={settings.duplicateGroupCooldownMinutes}
            />
          </Field>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          Save limits
        </Button>
      </div>
    </form>
  );
}
