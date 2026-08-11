"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge, Button, ConfirmDialog, EmptyState, Table, Td, Th } from "@/components/ui";
import { deleteTeamMember, toggleTeamMemberStatus } from "@/server/actions/teamMembers";

export interface TeamMemberRow {
  id: string;
  name: string;
  phoneNumber: string;
  role: string;
  department: string | null;
  status: string;
}

type DialogState = { kind: "delete" | "toggle"; member: TeamMemberRow } | null;

export function TeamMembersTable({ members }: { members: TeamMemberRow[] }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    if (!dialog) return;
    const { kind, member } = dialog;
    startTransition(async () => {
      if (kind === "delete") await deleteTeamMember(member.id);
      if (kind === "toggle") await toggleTeamMemberStatus(member.id);
      setDialog(null);
      router.refresh();
    });
  }

  if (members.length === 0) {
    return <EmptyState>No team members yet — add one above.</EmptyState>;
  }

  return (
    <div>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Phone</Th>
            <Th>Role</Th>
            <Th>Department</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <Td>{m.name}</Td>
              <Td className="font-[family-name:var(--font-mono)] text-xs">{m.phoneNumber}</Td>
              <Td>{m.role}</Td>
              <Td>{m.department ?? "—"}</Td>
              <Td>
                <Badge color={m.status === "ACTIVE" ? "green" : "gray"} dot>
                  {m.status}
                </Badge>
              </Td>
              <Td>
                <div className="flex gap-2">
                  <Link href={`/team-members/${m.id}/edit`}>
                    <Button variant="secondary" size="sm">
                      Edit
                    </Button>
                  </Link>
                  <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "toggle", member: m })}>
                    {m.status === "ACTIVE" ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setDialog({ kind: "delete", member: m })}>
                    Delete
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
        loading={isPending}
        tone={dialog?.kind === "delete" ? "danger" : "primary"}
        title={
          dialog?.kind === "delete"
            ? `Delete ${dialog.member.name}?`
            : dialog?.kind === "toggle"
              ? `${dialog.member.status === "ACTIVE" ? "Disable" : "Enable"} ${dialog.member.name}?`
              : ""
        }
        description={
          dialog?.kind === "delete"
            ? "This permanently removes the team member record. This cannot be undone."
            : dialog?.kind === "toggle" && dialog.member.status === "ACTIVE"
              ? "Their messages will no longer be treated as internal team member messages by automation."
              : undefined
        }
        confirmLabel={dialog?.kind === "delete" ? "Delete" : dialog?.member.status === "ACTIVE" ? "Disable" : "Enable"}
      />
    </div>
  );
}
