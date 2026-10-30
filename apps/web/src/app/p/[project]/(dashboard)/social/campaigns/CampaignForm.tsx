"use client";

import { useActionState, useEffect } from "react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { saveSocialCampaignAction, type SocialActionState } from "@/server/actions/social";

export interface CampaignFormValue {
  id?: string;
  name: string;
  description: string;
  color: string;
  startsOn: string;
  endsOn: string;
  leadId: string;
  status: "ACTIVE" | "ARCHIVED";
}

export function CampaignForm({ value, leads, onDone }: { value: CampaignFormValue; leads: Array<{ id: string; name: string }> | null; onDone?: () => void }) {
  const router = useProjectRouter();
  const [state, action, pending] = useActionState<SocialActionState, FormData>(saveSocialCampaignAction, {});
  useEffect(() => {
    if (state.success) {
      router.refresh();
      onDone?.();
    }
  }, [state.success, router, onDone]);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      {value.id ? <input type="hidden" name="id" value={value.id} /> : null}
      <Field label="Name" htmlFor={`name-${value.id ?? "new"}`} required>
        <Input id={`name-${value.id ?? "new"}`} name="name" defaultValue={value.name} maxLength={120} />
      </Field>
      <Field label="Colour" htmlFor={`color-${value.id ?? "new"}`} hint="Shown on the calendar.">
        <input id={`color-${value.id ?? "new"}`} name="color" type="color" defaultValue={value.color || "#4f46e5"} className="h-9.5 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]" />
      </Field>
      <Field label="Starts" htmlFor={`starts-${value.id ?? "new"}`}>
        <Input id={`starts-${value.id ?? "new"}`} name="startsOn" type="date" defaultValue={value.startsOn} />
      </Field>
      <Field label="Ends" htmlFor={`ends-${value.id ?? "new"}`}>
        <Input id={`ends-${value.id ?? "new"}`} name="endsOn" type="date" defaultValue={value.endsOn} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Description" htmlFor={`desc-${value.id ?? "new"}`}>
          <Textarea id={`desc-${value.id ?? "new"}`} name="description" rows={2} defaultValue={value.description} maxLength={1000} />
        </Field>
      </div>
      {leads ? (
        <Field label="Sales lead (optional)" htmlFor={`lead-${value.id ?? "new"}`} hint="Link the campaign to a lead in the sales pipeline.">
          <Select id={`lead-${value.id ?? "new"}`} name="leadId" defaultValue={value.leadId}>
            <option value="">None</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <input type="hidden" name="leadId" value={value.leadId} />
      )}
      {value.id ? (
        <Field label="Status" htmlFor={`status-${value.id}`}>
          <Select id={`status-${value.id}`} name="status" defaultValue={value.status}>
            <option value="ACTIVE">Active</option>
            <option value="ARCHIVED">Archived</option>
          </Select>
        </Field>
      ) : null}
      <div className="flex items-center gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" loading={pending}>
          {value.id ? "Save" : "Create campaign"}
        </Button>
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            Close
          </Button>
        ) : null}
      </div>
      {state.error ? (
        <div className="sm:col-span-2">
          <Alert tone="danger" title={state.error} />
        </div>
      ) : null}
    </form>
  );
}
