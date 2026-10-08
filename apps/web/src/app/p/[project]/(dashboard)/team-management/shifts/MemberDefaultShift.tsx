"use client";

import { useTransition } from "react";
import { EmptyState, Select, Table, Td, Th, useToast } from "@/components/ui";
import { setMemberDefaultShift } from "@/server/actions/teamManagement";

/**
 * Each active member's default shift, changed in place.
 *
 * A select that saves on change rather than a form with a Save button: there is one field per row,
 * the change is reversible, and a page of twenty rows each needing its own submit is the kind of
 * form people stop filling in.
 */
export function MemberDefaultShift({
  members,
  templates,
}: {
  members: { id: string; name: string; role: string; defaultShiftTemplateId: string | null }[];
  templates: { id: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function handleChange(memberId: string, name: string, value: string) {
    startTransition(async () => {
      const result = await setMemberDefaultShift(memberId, value === "" ? null : value);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      if (result.updated) showToast({ tone: "success", title: `Default shift saved for ${name}` });
    });
  }

  if (members.length === 0) {
    return <EmptyState>No active team members yet.</EmptyState>;
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Team member</Th>
          <Th>Role</Th>
          <Th>Default shift</Th>
        </tr>
      </thead>
      <tbody>
        {members.map((member) => (
          <tr key={member.id}>
            <Td className="font-medium">{member.name}</Td>
            <Td className="text-[color:var(--color-muted-foreground)]">{member.role}</Td>
            <Td>
              <Select
                aria-label={`Default shift for ${member.name}`}
                defaultValue={member.defaultShiftTemplateId ?? ""}
                disabled={pending}
                onChange={(event) => handleChange(member.id, member.name, event.target.value)}
                className="max-w-56"
              >
                <option value="">No default</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
