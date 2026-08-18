"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge, Button, ConfirmDialog, EmptyState, Table, Td, Th } from "@/components/ui";
import { deleteSupportRule, toggleSupportRuleActive } from "@/server/actions/supportRules";

export interface SupportRuleRow {
  id: string;
  name: string;
  isActive: boolean;
  triggerType: string;
  keywordsSummary: string;
  groupsSummary: string;
  teamMembersSummary: string;
}

const TRIGGER_TYPE_LABEL: Record<string, string> = {
  KEYWORD_MATCH: "Keyword Match",
  REPLY_TO_CUSTOMER: "Reply to Customer",
  MENTION: "Mention",
};

type DialogState = { kind: "delete" | "toggle"; rule: SupportRuleRow } | null;

export function SupportRulesTable({ rules }: { rules: SupportRuleRow[] }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    if (!dialog) return;
    const { kind, rule } = dialog;
    startTransition(async () => {
      if (kind === "delete") await deleteSupportRule(rule.id);
      if (kind === "toggle") await toggleSupportRuleActive(rule.id);
      setDialog(null);
      router.refresh();
    });
  }

  if (rules.length === 0) {
    return <EmptyState>No support rules yet — create one to start detecting activity.</EmptyState>;
  }

  return (
    <div>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Trigger</Th>
            <Th>Keywords</Th>
            <Th>Groups</Th>
            <Th>Team Members</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <Td className="font-medium">{r.name}</Td>
              <Td>
                <Badge color="blue">{TRIGGER_TYPE_LABEL[r.triggerType] ?? r.triggerType}</Badge>
              </Td>
              <Td className="max-w-xs truncate">{r.keywordsSummary}</Td>
              <Td>{r.groupsSummary}</Td>
              <Td>{r.teamMembersSummary}</Td>
              <Td>
                <Badge color={r.isActive ? "green" : "gray"} dot>
                  {r.isActive ? "ACTIVE" : "DISABLED"}
                </Badge>
              </Td>
              <Td>
                <div className="flex gap-2">
                  <Link href={`/support-activity/rules/${r.id}/edit`}>
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
