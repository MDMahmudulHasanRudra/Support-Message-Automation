"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronUp, TriangleAlert } from "lucide-react";
import { Badge, Button, ConfirmDialog, EmptyState, Table, Td, Th, Tooltip } from "@/components/ui";
import { deleteRule, duplicateRule, setRuleStatus, updatePriority } from "@/server/actions/rules";

export interface RuleRow {
  id: string;
  name: string;
  type: string;
  trigger: string;
  actionsSummary: string;
  priority: number;
  status: string;
  executionCount: number;
  updatedAtLabel: string;
  hasPriorityConflict: boolean;
}

type DialogState = { kind: "delete" | "disable" | "duplicate"; rule: RuleRow } | null;

export function RulesTable({ rules }: { rules: RuleRow[] }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [isSubmitting, startSubmit] = useTransition();
  const [steppingId, setSteppingId] = useState<string | null>(null);
  const [isStepping, startStep] = useTransition();
  const [isEnabling, startEnable] = useTransition();
  const [enablingId, setEnablingId] = useState<string | null>(null);

  function step(id: string, nextPriority: number) {
    setSteppingId(id);
    startStep(async () => {
      await updatePriority(id, nextPriority);
      router.refresh();
    });
  }

  function enable(id: string) {
    setEnablingId(id);
    startEnable(async () => {
      await setRuleStatus(id, "ACTIVE");
      router.refresh();
    });
  }

  function confirmDialogAction() {
    if (!dialog) return;
    const { kind, rule } = dialog;
    startSubmit(async () => {
      if (kind === "delete") await deleteRule(rule.id);
      if (kind === "disable") await setRuleStatus(rule.id, "DISABLED");
      if (kind === "duplicate") await duplicateRule(rule.id);
      setDialog(null);
      router.refresh();
    });
  }

  if (rules.length === 0) {
    return <EmptyState>No automation rules yet. Create one to get started.</EmptyState>;
  }

  return (
    <div>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Type</Th>
            <Th>Trigger</Th>
            <Th>Actions</Th>
            <Th>Priority</Th>
            <Th>Status</Th>
            <Th>Executions</Th>
            <Th>Last Modified</Th>
            <Th>Manage</Th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <Td>{rule.name}</Td>
              <Td>{rule.type}</Td>
              <Td>{rule.trigger}</Td>
              <Td>{rule.actionsSummary}</Td>
              <Td>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isStepping && steppingId === rule.id}
                    onClick={() => step(rule.id, rule.priority + 10)}
                    aria-label="Increase priority by 10"
                    className="cursor-pointer text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] disabled:opacity-50"
                  >
                    <ChevronUp className="size-3.5" aria-hidden />
                  </button>
                  <span className="tabular-nums">{rule.priority}</span>
                  <button
                    type="button"
                    disabled={isStepping && steppingId === rule.id}
                    onClick={() => step(rule.id, rule.priority - 10)}
                    aria-label="Decrease priority by 10"
                    className="cursor-pointer text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] disabled:opacity-50"
                  >
                    <ChevronDown className="size-3.5" aria-hidden />
                  </button>
                  {rule.hasPriorityConflict ? (
                    <Tooltip content="Another rule shares this priority — ties are broken by database order.">
                      <TriangleAlert className="size-3.5 text-[color:var(--color-warning)]" aria-hidden />
                    </Tooltip>
                  ) : null}
                </div>
              </Td>
              <Td>
                <Badge color={rule.status === "ACTIVE" ? "green" : rule.status === "DRAFT" ? "yellow" : "gray"} dot>
                  {rule.status}
                </Badge>
              </Td>
              <Td className="tabular-nums">{rule.executionCount}</Td>
              <Td>{rule.updatedAtLabel}</Td>
              <Td>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/rules/${rule.id}/edit`}>
                    <Button variant="secondary" size="sm">
                      Edit
                    </Button>
                  </Link>
                  <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "duplicate", rule })}>
                    Duplicate
                  </Button>
                  {rule.status === "ACTIVE" ? (
                    <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "disable", rule })}>
                      Disable
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={isEnabling && enablingId === rule.id}
                      onClick={() => enable(rule.id)}
                    >
                      Enable
                    </Button>
                  )}
                  <Button variant="danger" size="sm" onClick={() => setDialog({ kind: "delete", rule })}>
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
        onConfirm={confirmDialogAction}
        loading={isSubmitting}
        tone={dialog?.kind === "delete" ? "danger" : "primary"}
        title={
          dialog?.kind === "delete"
            ? `Delete rule "${dialog.rule.name}"?`
            : dialog?.kind === "disable"
              ? `Disable rule "${dialog.rule.name}"?`
              : dialog?.kind === "duplicate"
                ? `Duplicate rule "${dialog.rule.name}"?`
                : ""
        }
        description={
          dialog?.kind === "delete"
            ? "This cannot be undone."
            : dialog?.kind === "disable"
              ? "The rule will stop being evaluated until re-enabled."
              : dialog?.kind === "duplicate"
                ? "Creates a copy as a new DRAFT rule."
                : undefined
        }
        confirmLabel={
          dialog?.kind === "delete" ? "Delete" : dialog?.kind === "disable" ? "Disable" : "Duplicate"
        }
      />
    </div>
  );
}
