"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AiKnowledgeStatus } from "@prisma/client";
import { Alert, Badge, type BadgeColor, Button, Checkbox, ConfirmDialog, EmptyState, Table, Td, Th } from "@/components/ui";
import {
  bulkDeleteKnowledge,
  bulkSetKnowledgeStatus,
  type BulkKnowledgeResult,
} from "@/server/actions/aiKnowledge";

export interface KnowledgeRow {
  id: string;
  title: string;
  category: string;
  module: string | null;
  status: string;
  currentVersion: number;
  aiGenerated: boolean;
  humanVerified: boolean;
  /** Set when the knowledge builder distilled this from a group conversation. */
  sourceGroupName: string | null;
  /** An import's own name — a file name, a page address, or whatever the operator called it. */
  sourceLabel: string | null;
  /** Set only for an entry read out of a fetched web page. */
  sourceUrl: string | null;
  updatedAtLabel: string;
}

type BulkAction = "ACTIVATE" | "DEACTIVATE" | "ARCHIVE" | "DELETE";

/** Each action says exactly what it does — a shared "update" wording would hide that Delete is the
 *  one that cannot be undone, and Archive is not it. */
const BULK_COPY: Record<BulkAction, { title: string; description: string; confirmLabel: string; tone?: "danger" }> = {
  ACTIVATE: {
    title: "Set entries to Active?",
    description: "They become eligible to answer customers immediately if also verified. Nothing is deleted.",
    confirmLabel: "Set Active",
  },
  DEACTIVATE: {
    title: "Set entries to Inactive?",
    description: "They stop being used to answer customers until switched back to Active. Nothing is deleted.",
    confirmLabel: "Set Inactive",
  },
  ARCHIVE: {
    title: "Archive entries?",
    description:
      "Archived entries are excluded from answers and hidden from the default view — find them again under the Archived filter. Nothing is deleted.",
    confirmLabel: "Archive",
  },
  DELETE: {
    title: "Permanently delete entries?",
    description:
      "This cannot be undone — the entry and its whole version history are removed. If you might want this back, Archive instead.",
    confirmLabel: "Delete Permanently",
    tone: "danger",
  },
};

export function KnowledgeTable({ items, filtered = false }: { items: KnowledgeRow[]; filtered?: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<BulkKnowledgeResult | null>(null);

  const allSelected = useMemo(
    () => items.length > 0 && items.every((item) => selected.has(item.id)),
    [items, selected],
  );

  if (items.length === 0) {
    return (
      <EmptyState>
        {filtered
          ? "No knowledge matches these filters."
          : "No knowledge yet. Add an entry, or import your own documentation."}
      </EmptyState>
    );
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        items.forEach((item) => next.delete(item.id));
        return next;
      }
      const next = new Set(prev);
      items.forEach((item) => next.add(item.id));
      return next;
    });
  }

  async function confirmBulk() {
    if (!pendingAction) return;
    const ids = [...selected];
    setBusy(true);
    try {
      const result =
        pendingAction === "DELETE"
          ? await bulkDeleteKnowledge(ids)
          : await bulkSetKnowledgeStatus(ids, STATUS_FOR_ACTION[pendingAction]);
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
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3.5 py-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[color:var(--color-foreground)]">
          <Checkbox checked={allSelected} onChange={toggleAll} aria-label="Select every entry on this page" />
          Select all on this page
        </label>
        <span className="tabular text-[11px] text-[color:var(--color-muted-foreground)]">
          {selected.size} selected
        </span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => setPendingAction("ACTIVATE")}
          >
            Bulk Active
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => setPendingAction("DEACTIVATE")}
          >
            Bulk Inactive
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => setPendingAction("ARCHIVE")}
          >
            Bulk Archive
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => setPendingAction("DELETE")}
          >
            Bulk Delete
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
                <li>{lastResult.updated} updated successfully</li>
                {lastResult.alreadyInTargetState ? (
                  <li>{lastResult.alreadyInTargetState} already in the requested state</li>
                ) : null}
                {lastResult.notFound ? (
                  <li>{lastResult.notFound} not found (may have been removed already)</li>
                ) : null}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>{null}</Th>
            <Th>Title</Th>
            <Th>Category</Th>
            <Th>Source</Th>
            <Th>Checked</Th>
            <Th>Version</Th>
            <Th>Status</Th>
            <Th>Updated</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <Td>
                <Checkbox
                  checked={selected.has(item.id)}
                  onChange={() => toggleOne(item.id)}
                  aria-label={`Select "${item.title}"`}
                />
              </Td>
              <Td>
                <Link
                  href={`/ai-learning/knowledge-base/${item.id}`}
                  className="underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-foreground)]"
                >
                  {item.title}
                </Link>
                {item.module ? (
                  <span className="mt-0.5 block text-[10px] text-[color:var(--color-muted-foreground)]">
                    {item.module}
                  </span>
                ) : null}
              </Td>
              <Td>{item.category.replace(/_/g, " ")}</Td>
              <Td>
                <Provenance item={item} />
              </Td>
              <Td>
                {/* Anything the knowledge builder or an importer wrote arrives unverified — a
                    model's reading of a chat log or a manual is evidence, not fact — so the review
                    state has to be visible in the list, not buried on the detail page. */}
                {item.humanVerified ? (
                  <Badge color="green" dot>
                    Verified
                  </Badge>
                ) : (
                  <Badge color="yellow" dot>
                    Needs review
                  </Badge>
                )}
              </Td>
              <Td className="tabular-nums">{item.currentVersion}</Td>
              <Td>
                <Badge color={statusColor(item.status)} dot>
                  {item.status}
                </Badge>
              </Td>
              <Td>{item.updatedAtLabel}</Td>
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
        description={pendingAction ? `${BULK_COPY[pendingAction].description} (${selected.size} selected.)` : undefined}
        confirmLabel={pendingAction ? BULK_COPY[pendingAction].confirmLabel : ""}
        tone={pendingAction ? BULK_COPY[pendingAction].tone : undefined}
      />
    </div>
  );
}

const STATUS_FOR_ACTION: Record<Exclude<BulkAction, "DELETE">, AiKnowledgeStatus> = {
  ACTIVATE: "ACTIVE",
  DEACTIVATE: "INACTIVE",
  ARCHIVE: "ARCHIVED",
};

/**
 * Where the entry came from, most specific first. A fetched page is shown as a real link: when a
 * documentation page changes, the only way to find the entries it affects is to be able to see
 * and follow the address that produced them.
 */
function Provenance({ item }: { item: KnowledgeRow }) {
  if (item.sourceGroupName) {
    return (
      <span className="text-xs">
        <span className="text-[color:var(--color-muted-foreground)]">Learned from </span>
        {item.sourceGroupName}
      </span>
    );
  }
  if (item.sourceUrl) {
    return (
      <a
        href={item.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="link block max-w-56 truncate text-xs"
        title={item.sourceUrl}
      >
        {item.sourceUrl.replace(/^https?:\/\//, "")}
      </a>
    );
  }
  if (item.sourceLabel) {
    return (
      <span className="block max-w-56 truncate text-xs" title={item.sourceLabel}>
        <span className="text-[color:var(--color-muted-foreground)]">Imported from </span>
        {item.sourceLabel}
      </span>
    );
  }
  return <span className="text-xs">{item.aiGenerated ? "AI generated" : "Manual"}</span>;
}

function statusColor(status: string): BadgeColor {
  if (status === "ACTIVE") return "green";
  if (status === "ARCHIVED") return "gray";
  return "yellow";
}
