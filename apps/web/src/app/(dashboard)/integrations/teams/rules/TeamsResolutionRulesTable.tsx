"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge, Button, ConfirmDialog, EmptyState, Table, Td, Th } from "@/components/ui";
import { deleteTeamsResolutionRule, toggleTeamsResolutionRuleActive } from "@/server/actions/teamsResolutionRules";

export interface TeamsResolutionRuleRow {
  id: string;
  name: string;
  isActive: boolean;
  keywordsSummary: string;
}

type DialogState = { kind: "delete" | "toggle"; rule: TeamsResolutionRuleRow } | null;

export function TeamsResolutionRulesTable({ rules }: { rules: TeamsResolutionRuleRow[] }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    if (!dialog) return;
    const { kind, rule } = dialog;
    startTransition(async () => {
      if (kind === "delete") await deleteTeamsResolutionRule(rule.id);
      if (kind === "toggle") await toggleTeamsResolutionRuleActive(rule.id);
      setDialog(null);
      router.refresh();
    });
  }

  if (rules.length === 0) {
    return <EmptyState>No resolution rules yet — create one to start detecting resolved issues.</EmptyState>;
  }

  return (
    <div>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Keywords</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <Td className="font-medium">{r.name}</Td>
              <Td className="max-w-xs truncate">{r.keywordsSummary}</Td>
              <Td>
                <Badge color={r.isActive ? "green" : "gray"} dot>
                  {r.isActive ? "ACTIVE" : "DISABLED"}
                </Badge>
              </Td>
              <Td>
                <div className="flex gap-2">
                  <Link href={`/integrations/teams/rules/${r.id}/edit`}>
                    <Button variant="secondary" size="sm">
                      Edit
                    </Button>
                  </Link>
                  <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "toggle", rule: r })}>
                    {r.isActive ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setDialog({ kind: "delete", rule: r })}>
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
            ? `Delete "${dialog.rule.name}"?`
            : dialog
              ? `${dialog.rule.isActive ? "Disable" : "Enable"} "${dialog.rule.name}"?`
              : ""
        }
        description={dialog?.kind === "delete" ? "This permanently removes the rule. This cannot be undone." : undefined}
        confirmLabel={dialog?.kind === "delete" ? "Delete" : dialog?.rule.isActive ? "Disable" : "Enable"}
      />
    </div>
  );
}
