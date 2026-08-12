"use client";

import { useActionState, useEffect } from "react";
import { Button, Card, Field, Input, SectionHeader, useToast } from "@/components/ui";
import { updatePriorityPolicy, type PolicyFormState } from "@/server/actions/supportEscalation";
import type { SupportPriority } from "@prisma/client";

export interface PolicyDefaults {
  firstAlertMinutes: number;
  secondAlertMinutes: number;
  memberEscalationMinutes: number;
  adminEscalationMinutes: number;
  followUpIntervalMinutes: number;
  maxEscalations: number;
}

export function PolicyForm({ priority, defaults, label }: { priority: SupportPriority; defaults: PolicyDefaults; label: string }) {
  const action = updatePriorityPolicy.bind(null, priority);
  const [state, formAction, pending] = useActionState<PolicyFormState, FormData>(action, {});
  const { showToast } = useToast();

  useEffect(() => {
    if (state.success) showToast({ tone: "success", title: `${priority} policy saved` });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  return (
    <Card>
      <SectionHeader title={label} />
      <form action={formAction} className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Field label="First alert (min)" hint="0 = immediately.">
          <Input name="firstAlertMinutes" type="number" min={0} defaultValue={defaults.firstAlertMinutes} />
        </Field>
        <Field label="Second alert (min)">
          <Input name="secondAlertMinutes" type="number" min={0} defaultValue={defaults.secondAlertMinutes} />
        </Field>
        <Field label="Member escalation (min)">
          <Input name="memberEscalationMinutes" type="number" min={0} defaultValue={defaults.memberEscalationMinutes} />
        </Field>
        <Field label="Admin escalation (min)">
          <Input name="adminEscalationMinutes" type="number" min={0} defaultValue={defaults.adminEscalationMinutes} />
        </Field>
        <Field label="Follow-up interval (min)">
          <Input name="followUpIntervalMinutes" type="number" min={0} defaultValue={defaults.followUpIntervalMinutes} />
        </Field>
        <Field label="Max escalations" hint="Caps total notifications, including follow-ups.">
          <Input name="maxEscalations" type="number" min={1} defaultValue={defaults.maxEscalations} />
        </Field>
        <div className="col-span-full">
          <Button type="submit" size="sm" loading={pending}>
            Save {priority}
          </Button>
        </div>
      </form>
    </Card>
  );
}
