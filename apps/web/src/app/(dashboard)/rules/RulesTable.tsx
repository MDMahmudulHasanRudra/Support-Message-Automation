"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronUp, Clock, Download, Upload, TriangleAlert } from "lucide-react";
import { Alert, Badge, Button, ButtonLink, Checkbox, ConfirmDialog, EmptyState, Table, Td, Th, Tooltip } from "@/components/ui";
import { deleteRule, duplicateRule, setRuleStatus, updatePriority } from "@/server/actions/rules";
import { bulkDeleteRules, bulkSetRuleStatus, type BulkDeleteRulesResult, type BulkRuleStatusResult } from "@/server/actions/rulesBulk";
import { RuleImportDialog } from "./RuleImportDialog";

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
  hasSchedule: boolean;
}

export interface RuleFilters {
  search: string;
  status?: string;
  type?: string;
}

type DialogState = { kind: "delete" | "disable" | "duplicate"; rule: RuleRow } | null;
type BulkAction = "activate" | "disable" | "delete" | null;
type BulkResult = (BulkRuleStatusResult & { kind: "activate" | "disable" }) | (BulkDeleteRulesResult & { kind: "delete" });

function buildFilterQueryString(filters: RuleFilters): string {
  const qs = new URLSearchParams();
  if (filters.search) qs.set("search", filters.search);
  if (filters.status) qs.set("status", filters.status);
  if (filters.type) qs.set("type", filters.type);
  return qs.toString();
}

export function RulesTable({ rules, filters }: { rules: RuleRow[]; filters: RuleFilters }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [isSubmitting, startSubmit] = useTransition();
  const [steppingId, setSteppingId] = useState<string | null>(null);
  const [isStepping, startStep] = useTransition();
  const [isEnabling, startEnable] = useTransition();
  const [enablingId, setEnablingId] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const allVisibleSelected = useMemo(
    () => rules.length > 0 && rules.every((r) => selected.has(r.id)),
    [rules, selected],
  );

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        rules.forEach((r) => next.delete(r.id));
      } else {
        rules.forEach((r) => next.add(r.id));
      }
      return next;
    });
  }

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

  async function confirmBulkAction() {
    if (!bulkAction) return;
    setBulkBusy(true);
    try {
      const ids = [...selected];
      if (bulkAction === "delete") {
        const result = await bulkDeleteRules(ids);
        setBulkResult({ ...result, kind: "delete" });
      } else {
        const result = await bulkSetRuleStatus(ids, bulkAction === "activate" ? "ACTIVE" : "DISABLED");
        setBulkResult({ ...result, kind: bulkAction });
      }
      setBulkAction(null);
      setSelected(new Set());
      router.refresh();
    } finally {
      setBulkBusy(false);
    }
  }

  const filterQs = buildFilterQueryString(filters);
  const selectedQs = [...selected].join(",");

  if (rules.length === 0) {
    return (
      <div>
        <BulkToolbar
          selectedCount={0}
          filterQs={filterQs}
          selectedQs=""
          onImport={() => setImportOpen(true)}
          onBulkAction={() => {}}
          disabled
        />
        <EmptyState>No automation rules match the current filters.</EmptyState>
        {importOpen ? <RuleImportDialog onClose={() => setImportOpen(false)} onImported={() => router.refresh()} /> : null}
      </div>
    );
  }

  return (
    <div>
      {bulkResult ? (
        <div className="mb-3">
          <Alert
            tone={bulkResult.error ? "danger" : "success"}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setBulkResult(null)}>
                Dismiss
              </Button>
            }
          >
            {bulkResult.error ? (
              bulkResult.error
            ) : bulkResult.kind === "delete" ? (
              <ul className="space-y-0.5">
                <li>{bulkResult.deleted} deleted</li>
                {bulkResult.notFound > 0 ? <li>{bulkResult.notFound} not found (may have already been deleted)</li> : null}
              </ul>
            ) : (
              <ul className="space-y-0.5">
                <li>{bulkResult.updated} updated successfully</li>
                {bulkResult.alreadyInTargetState > 0 ? (
                  <li>{bulkResult.alreadyInTargetState} already {bulkResult.kind === "activate" ? "active" : "disabled"}</li>
                ) : null}
                {bulkResult.notFound > 0 ? <li>{bulkResult.notFound} not found (may have been deleted)</li> : null}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      <BulkToolbar
        selectedCount={selected.size}
        filterQs={filterQs}
        selectedQs={selectedQs}
        onImport={() => setImportOpen(true)}
        onBulkAction={(action) => setBulkAction(action)}
        onClearSelection={() => setSelected(new Set())}
      />

      <Table>
        <thead>
          <tr>
            <Th>
              <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap font-normal normal-case">
                <Checkbox checked={allVisibleSelected} onChange={toggleAllVisible} />
                All visible
              </label>
            </Th>
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
              <Td>
                <Checkbox checked={selected.has(rule.id)} onChange={() => toggleOne(rule.id)} />
              </Td>
              <Td>{rule.name}</Td>
              <Td>{rule.type}</Td>
              <Td>
                <div className="flex items-center gap-1.5">
                  {rule.trigger}
                  {rule.hasSchedule ? (
                    <Tooltip content="Only active during a scheduled time window">
                      <Clock className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
                    </Tooltip>
                  ) : null}
                </div>
              </Td>
              <Td>{rule.actionsSummary}</Td>
              <Td>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={isStepping && steppingId === rule.id}
                    onClick={() => step(rule.id, rule.priority + 10)}
                    aria-label="Increase priority by 10"
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ChevronUp className="size-3.5" aria-hidden />
                  </button>
                  <span className="min-w-[2ch] text-center tabular-nums">{rule.priority}</span>
                  <button
                    type="button"
                    disabled={isStepping && steppingId === rule.id}
                    onClick={() => step(rule.id, rule.priority - 10)}
                    aria-label="Decrease priority by 10"
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ChevronDown className="size-3.5" aria-hidden />
                  </button>
                  {rule.hasPriorityConflict ? (
                    <Tooltip content="Another rule shares this priority — ties are broken by database order.">
                      <TriangleAlert className="size-3.5 shrink-0 text-[color:var(--color-warning)]" aria-hidden />
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

      <ConfirmDialog
        open={bulkAction !== null}
        onClose={() => setBulkAction(null)}
        onConfirm={confirmBulkAction}
        loading={bulkBusy}
        tone={bulkAction === "delete" ? "danger" : "primary"}
        title={
          bulkAction === "delete"
            ? `Permanently delete ${selected.size} automation rule(s)?`
            : bulkAction === "disable"
              ? `Disable ${selected.size} automation rule(s)?`
              : `Activate ${selected.size} automation rule(s)?`
        }
        description={
          bulkAction === "delete"
            ? "You are about to permanently delete these rules. This cannot be undone."
            : bulkAction === "disable"
              ? "Selected rules will stop being evaluated until re-enabled. Already-disabled rules are left as is."
              : "Selected rules become eligible to fire immediately. Already-active rules are left as is."
        }
        confirmLabel={bulkAction === "delete" ? "Delete Rules" : bulkAction === "disable" ? "Disable" : "Activate"}
      />

      {importOpen ? <RuleImportDialog onClose={() => setImportOpen(false)} onImported={() => router.refresh()} /> : null}
    </div>
  );
}

function BulkToolbar({
  selectedCount,
  filterQs,
  selectedQs,
  onImport,
  onBulkAction,
  onClearSelection,
  disabled = false,
}: {
  selectedCount: number;
  filterQs: string;
  selectedQs: string;
  onImport: () => void;
  onBulkAction: (action: "activate" | "disable" | "delete") => void;
  onClearSelection?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onImport} disabled={disabled}>
          <Upload className="size-3.5" aria-hidden />
          Import Excel
        </Button>
        <ButtonLink href="/api/automation-rules/import-template" variant="secondary" size="sm">
          <Download className="size-3.5" aria-hidden />
          Download Template
        </ButtonLink>
        <ButtonLink href={`/api/automation-rules/export${filterQs ? `?${filterQs}` : ""}`} variant="secondary" size="sm">
          <Download className="size-3.5" aria-hidden />
          Export Filtered
        </ButtonLink>
      </div>

      {selectedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-primary)]/30 bg-[var(--color-primary-soft)] px-3.5 py-2.5">
          <span className="text-sm font-medium text-[color:var(--color-foreground)]">
            {selectedCount} rule{selectedCount === 1 ? "" : "s"} selected
          </span>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => onBulkAction("activate")}>
              Activate
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onBulkAction("disable")}>
              Disable
            </Button>
            <ButtonLink href={`/api/automation-rules/export?ids=${selectedQs}`} variant="secondary" size="sm">
              Export Selected
            </ButtonLink>
            <Button variant="danger" size="sm" onClick={() => onBulkAction("delete")}>
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={onClearSelection}>
              Clear Selection
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
