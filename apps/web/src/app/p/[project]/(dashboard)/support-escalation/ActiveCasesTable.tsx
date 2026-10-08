"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link from "@/components/ProjectLink";
import { useMemo, useState } from "react";

import { Check, OctagonX } from "lucide-react";
import {
  Alert,
  Badge,
  type BadgeColor,
  Button,
  Checkbox,
  ConfirmDialog,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { bulkResolveCases, bulkStopEscalation, type BulkCaseResult } from "@/server/actions/supportEscalation";

export interface ActiveCaseRow {
  id: string;
  groupName: string;
  priority: string;
  status: string;
  waitingSinceLabel: string;
  escalationLevel: number;
  assignedName: string | null;
}

type BulkKind = "resolve" | "stop";

/**
 * Each action says what it actually claims about the conversation.
 *
 * Resolving asserts the customer was dealt with; stopping asserts only that this system should
 * stop chasing it. Collapsing them into one "close" would quietly record dozens of unanswered
 * customers as handled, which is the number this whole module exists to be honest about.
 */
const BULK_COPY: Record<BulkKind, { title: string; description: string; confirmLabel: string }> = {
  resolve: {
    title: "Mark cases resolved?",
    description:
      "This records each one as genuinely handled, with an audit event naming you. Use it once the customers have actually been dealt with.",
    confirmLabel: "Mark resolved",
  },
  stop: {
    title: "Stop escalating these cases?",
    description:
      "Escalation stops and no further alerts go out — without claiming anybody replied. The customer may still be waiting.",
    confirmLabel: "Stop escalation",
  },
};

export function ActiveCasesTable({ cases }: { cases: ActiveCaseRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<BulkKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<BulkCaseResult | null>(null);

  const allSelected = useMemo(
    () => cases.length > 0 && cases.every((c) => selected.has(c.id)),
    [cases, selected],
  );

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(cases.map((c) => c.id)));
  }

  async function confirmBulk() {
    if (!pendingAction) return;
    const ids = [...selected];
    setBusy(true);
    try {
      const result = pendingAction === "resolve" ? await bulkResolveCases(ids) : await bulkStopEscalation(ids);
      setLastResult(result);
      setPendingAction(null);
      if (!result.error) {
        setSelected(new Set());
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* Pinned, because the queue is read top-down and the decision to clear a batch is usually
          made after reading to the bottom of it. */}
      <div className="sticky top-0 z-20 mb-2 -mx-5 flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-background)]/95 px-5 py-2 backdrop-blur-sm sm:-mx-8 sm:px-8">
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[color:var(--color-foreground)]">
          <Checkbox
            checked={allSelected}
            indeterminate={!allSelected && cases.some((c) => selected.has(c.id))}
            onChange={toggleAll}
            aria-label="Select every case shown"
          />
          Select all shown
        </label>
        <span className="tabular text-[11px] text-[color:var(--color-muted-foreground)]">
          {selected.size} selected
        </span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => setPendingAction("resolve")}
          >
            <Check className="size-3.5" aria-hidden />
            Mark resolved
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => setPendingAction("stop")}
          >
            <OctagonX className="size-3.5" aria-hidden />
            Stop escalation
          </Button>
        </div>
      </div>

      {lastResult ? (
        <div className="mb-3">
          <Alert
            tone={lastResult.error ? "danger" : "success"}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setLastResult(null)}>
                Dismiss
              </Button>
            }
          >
            {lastResult.error ? (
              lastResult.error
            ) : (
              <ul className="space-y-0.5">
                <li>{lastResult.changed} updated successfully</li>
                {lastResult.alreadyClosed ? (
                  <li>{lastResult.alreadyClosed} left alone — already closed, or a human replied meanwhile</li>
                ) : null}
                {lastResult.notFound ? <li>{lastResult.notFound} not found</li> : null}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>{null}</Th>
            <Th>Group</Th>
            <Th>Priority</Th>
            <Th>Status</Th>
            <Th>Waiting Since</Th>
            <Th>Escalation Level</Th>
            <Th>Assigned</Th>
            <Th>{null}</Th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <Td>
                <Checkbox
                  checked={selected.has(c.id)}
                  onChange={() => toggleOne(c.id)}
                  aria-label={`Select the case for ${c.groupName}`}
                />
              </Td>
              <Td>{c.groupName}</Td>
              <Td>
                <Badge color={c.priority === "P1" ? "red" : c.priority === "P2" ? "yellow" : "blue"} dot>
                  {c.priority}
                </Badge>
              </Td>
              <Td>
                <Badge color={statusColor(c.status)} dot>
                  {c.status}
                </Badge>
              </Td>
              <Td>{c.waitingSinceLabel}</Td>
              <Td className="tabular-nums">{c.escalationLevel}</Td>
              <Td>{c.assignedName ?? "—"}</Td>
              <Td>
                <Link href={`/support-escalation/cases/${c.id}`}>
                  <Button variant="secondary" size="sm">
                    View
                  </Button>
                </Link>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmDialog
        open={pendingAction !== null}
        onClose={() => setPendingAction(null)}
        onConfirm={confirmBulk}
        loading={busy}
        title={pendingAction ? BULK_COPY[pendingAction].title : ""}
        description={
          pendingAction ? `${BULK_COPY[pendingAction].description} (${selected.size} selected.)` : undefined
        }
        confirmLabel={pendingAction ? BULK_COPY[pendingAction].confirmLabel : ""}
      />
    </div>
  );
}

function statusColor(status: string): BadgeColor {
  if (status === "NEW" || status === "MONITORING") return "gray";
  if (status === "WAITING_FOR_HUMAN") return "yellow";
  return "red";
}
