"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input, Textarea } from "@/components/ui";
import { saveTicketSettings, type TicketSettingsState } from "@/server/actions/tickets";
import type { TicketConfig } from "@/server/tickets";

const TARGETS = [
  ["urgentHours", "Urgent"],
  ["highHours", "High"],
  ["normalHours", "Normal"],
  ["lowHours", "Low"],
] as const;

export function TicketSettingsForm({ config, canManage }: { config: TicketConfig; canManage: boolean }) {
  const [state, action, pending] = useActionState<TicketSettingsState, FormData>(saveTicketSettings, {});
  return (
    <form action={action} className="space-y-5 p-5">
      <fieldset disabled={!canManage} className="space-y-5">
        <div>
          <legend className="text-[14px] font-semibold">Hours to resolve</legend>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {TARGETS.map(([name, label]) => (
              <Field key={name} label={label}>
                <Input name={name} type="number" min={1} max={8760} step={1} required defaultValue={config[name]} />
              </Field>
            ))}
          </div>
        </div>
        <Field label="Categories" hint="One on each line.">
          <Textarea name="categories" rows={5} defaultValue={config.categories.join("\n")} />
        </Field>
      </fieldset>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}
      {canManage ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
