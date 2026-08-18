"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Field, Select, Switch } from "@/components/ui";
import { setGroupPriority } from "@/server/actions/groups";
import type { GroupRow } from "./GroupsTable";

export interface TeamMemberOption {
  id: string;
  name: string;
}

export function GroupPriorityDialog({
  group,
  teamMembers,
  onClose,
}: {
  group: GroupRow;
  teamMembers: TeamMemberOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [priority, setPriority] = useState(group.priority ?? "");
  const [assignedTeamMemberId, setAssignedTeamMemberId] = useState(group.assignedTeamMemberId ?? "");
  const [escalationMonitoringEnabled, setEscalationMonitoringEnabled] = useState(group.escalationMonitoringEnabled);

  function save() {
    const formData = new FormData();
    formData.set("priority", priority);
    formData.set("assignedTeamMemberId", assignedTeamMemberId);
    if (escalationMonitoringEnabled) formData.set("escalationMonitoringEnabled", "on");
    startTransition(async () => {
      await setGroupPriority(group.id, formData);
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Priority Support: ${group.name}`}
      description="Null priority means this group is never monitored for escalation — the feature stays entirely opt-in."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} loading={pending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">None (not monitored)</option>
            <option value="P1">P1 — Highest</option>
            <option value="P2">P2 — Medium</option>
            <option value="P3">P3 — Normal</option>
          </Select>
        </Field>
        <Field label="Assigned team member" hint="Optional — escalates here before the admin tier.">
          <Select value={assignedTeamMemberId} onChange={(e) => setAssignedTeamMemberId(e.target.value)}>
            <option value="">Unassigned</option>
            {teamMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm text-[color:var(--color-foreground)]">
          <Switch
            checked={escalationMonitoringEnabled}
            onChange={(e) => setEscalationMonitoringEnabled(e.target.checked)}
          />
          Escalation monitoring enabled
        </label>
      </div>
    </Dialog>
  );
}
