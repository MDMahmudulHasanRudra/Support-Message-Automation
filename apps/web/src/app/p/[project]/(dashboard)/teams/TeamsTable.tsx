"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useState, useTransition } from "react";
import Link from "@/components/ProjectLink";

import { Badge, Button, ButtonLink, ConfirmDialog, EmptyState, Table, Td, Th, useToast } from "@/components/ui";
import { deleteTeam, setTeamStatus } from "@/server/actions/teams";

export interface TeamRow {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  status: string;
  memberCount: number;
}

type DialogState = { kind: "delete" | "toggle"; team: TeamRow } | null;

export function TeamsTable({ teams, canManage }: { teams: TeamRow[]; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    if (!dialog) return;
    const { kind, team } = dialog;
    startTransition(async () => {
      const result =
        kind === "delete" ? await deleteTeam(team.id) : await setTeamStatus(team.id, team.status === "ACTIVE" ? "DISABLED" : "ACTIVE");
      showToast({ tone: result.ok ? "success" : "danger", title: result.ok ? "Done" : "Not deleted", description: result.message });
      setDialog(null);
      router.refresh();
    });
  }

  if (teams.length === 0) {
    return <EmptyState>No teams yet. Add your first one above — for example Support Team or Billing Team.</EmptyState>;
  }

  return (
    <div>
      <Table>
        <thead>
          <tr>
            <Th>Team</Th>
            <Th>Code</Th>
            <Th>Members</Th>
            <Th>Description</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {teams.map((team) => (
            <tr key={team.id}>
              <Td>
                <Link className="link font-medium" href={`/teams/${team.id}`}>
                  {team.name}
                </Link>
              </Td>
              <Td className="font-[family-name:var(--font-mono)] text-xs">{team.code ?? "—"}</Td>
              <Td className="tabular">{team.memberCount}</Td>
              <Td className="max-w-[28rem] text-[color:var(--color-muted-foreground)]">{team.description ?? "—"}</Td>
              <Td>
                <Badge color={team.status === "ACTIVE" ? "green" : "gray"} dot>
                  {team.status}
                </Badge>
              </Td>
              <Td>
                <div className="flex gap-2">
                  <ButtonLink href={`/teams/${team.id}`}>View</ButtonLink>
                  {canManage ? (
                    <>
                      <ButtonLink href={`/teams/${team.id}/edit`}>Edit</ButtonLink>
                      <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "toggle", team })}>
                        {team.status === "ACTIVE" ? "Disable" : "Enable"}
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => setDialog({ kind: "delete", team })}>
                        Delete
                      </Button>
                    </>
                  ) : null}
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
        loading={pending}
        tone={dialog?.kind === "delete" ? "danger" : "primary"}
        title={
          dialog?.kind === "delete"
            ? `Delete ${dialog.team.name}?`
            : dialog
              ? `${dialog.team.status === "ACTIVE" ? "Disable" : "Enable"} ${dialog.team.name}?`
              : ""
        }
        description={
          dialog?.kind === "delete"
            ? dialog.team.memberCount > 0
              ? `This team has ${dialog.team.memberCount} assigned member${dialog.team.memberCount === 1 ? "" : "s"}. Reassign or remove the members before deleting this team.`
              : "The team is removed permanently. A team that ever had members cannot be deleted — disable it instead."
            : dialog?.team.status === "ACTIVE"
              ? "It stops being offered when adding or editing members. Its members keep it, and reports can still show it."
              : "It is offered again when adding or editing members."
        }
        confirmLabel={dialog?.kind === "delete" ? "Delete" : dialog?.team.status === "ACTIVE" ? "Disable" : "Enable"}
        confirmDisabled={dialog?.kind === "delete" && dialog.team.memberCount > 0}
      />
    </div>
  );
}
