"use client";

import { useActionState, useEffect } from "react";
import { Button, Card, Field, SectionHeader, Select, SwitchField, useToast } from "@/components/ui";
import { updateEscalationSettings, type PolicyFormState } from "@/server/actions/supportEscalation";

export function EscalationSettingsForm({
  enabled,
  escalationAdminId,
  teamMembers,
}: {
  enabled: boolean;
  escalationAdminId: string | null;
  teamMembers: Array<{ id: string; name: string }>;
}) {
  const [state, formAction, pending] = useActionState<PolicyFormState, FormData>(updateEscalationSettings, {});
  const { showToast } = useToast();

  useEffect(() => {
    if (state.success) showToast({ tone: "success", title: "Escalation settings saved" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  return (
    <Card>
      <SectionHeader title="Escalation Settings" description="Master switch and who the final tier escalates to." />
      <form action={formAction} className="space-y-4">
        <SwitchField name="enabled" label="Priority escalation enabled" defaultChecked={enabled} />
        <Field label="Escalation admin" hint="Receives the final tier and every repeated follow-up.">
          <Select name="escalationAdminId" defaultValue={escalationAdminId ?? ""}>
            <option value="">Not configured</option>
            {teamMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" size="sm" loading={pending}>
          Save
        </Button>
      </form>
    </Card>
  );
}
