"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link from "@/components/ProjectLink";

import { useState, useTransition } from "react";
import { Check, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState } from "@/components/ui";
import {
  bulkArchiveKnowledge,
  bulkSetKnowledgeVerified,
  setKnowledgeStatus,
  setKnowledgeVerified,
  type BulkKnowledgeResult,
} from "@/server/actions/aiKnowledge";

export interface ReviewRow {
  id: string;
  title: string;
  category: string;
  module: string | null;
  question: string | null;
  answer: string;
  confidence: number | null;
  sourceLabel: string | null;
  createdAtLabel: string;
}

type BulkKind = "verify" | "discard";

/**
 * The queue where AI-structured knowledge becomes usable — or doesn't.
 *
 * Everything the importer and the conversation builder produce arrives here unverified, and only
 * a verified entry is ever retrieved to answer a customer. That makes this page the trust
 * boundary of the whole knowledge system, so the two decisions are deliberately one click each
 * and the full answer is readable without leaving the page: a reviewer who has to open twenty
 * detail pages will stop reviewing.
 *
 * The bulk controls exist for the same reason and stop short of the same line. An import can
 * produce a hundred entries at once, so clearing a page has to be possible in one action — but
 * both bulk actions ask for confirmation and name the count, because the difference between
 * reading a page and waving it through is the only thing this queue is protecting.
 */
export function ReviewQueue({ rows }: { rows: ReviewRow[] }) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(rows[0]?.id ?? null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<BulkKind | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkKnowledgeResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Check className="size-5" aria-hidden />}>
          Nothing waiting for review. Everything the AI has produced has been checked.
        </EmptyState>
      </Card>
    );
  }

  const allSelected = selected.length === rows.length;

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }

  function toggleAll() {
    setSelected(allSelected ? [] : rows.map((row) => row.id));
  }

  function verify(id: string) {
    setBusyId(id);
    startTransition(async () => {
      await setKnowledgeVerified(id, true);
      router.refresh();
    });
  }

  function discard(id: string) {
    setBusyId(id);
    startTransition(async () => {
      // Archived, never deleted: what the AI got wrong is itself useful evidence, and this
      // codebase soft-deletes anything with historical value.
      await setKnowledgeStatus(id, "ARCHIVED");
      router.refresh();
    });
  }

  function runBulk(kind: BulkKind) {
    const ids = selected;
    setConfirming(null);
    setBulkResult(null);
    startTransition(async () => {
      const result: BulkKnowledgeResult =
        kind === "verify" ? await bulkSetKnowledgeVerified(ids) : await bulkArchiveKnowledge(ids);
      setBulkResult(result);
      if (result.error) return;
      setSelected([]);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3.5 py-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[color:var(--color-foreground)]">
          <Checkbox
            checked={allSelected}
            indeterminate={!allSelected && selected.length > 0}
            onChange={toggleAll}
            aria-label="Select every entry on this page"
          />
          Select all on this page
        </label>
        <span className="tabular text-[11px] text-[color:var(--color-muted-foreground)]">
          {selected.length} selected
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" disabled={selected.length === 0 || pending} onClick={() => setConfirming("verify")}>
            <Check className="size-3.5" aria-hidden />
            Verify selected
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={selected.length === 0 || pending}
            onClick={() => setConfirming("discard")}
          >
            <Trash2 className="size-3.5" aria-hidden />
            Discard selected
          </Button>
        </div>
      </div>

      {/* The `where` on both bulk actions silently skips rows that are already verified or already
          archived, so a bare refresh could leave "verify 20" having verified fourteen with nothing
          on screen saying so. */}
      {bulkResult ? (
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
          ) : (
            <ul className="space-y-0.5">
              <li>{bulkResult.updated} updated successfully</li>
              {bulkResult.alreadyInTargetState ? (
                <li>{bulkResult.alreadyInTargetState} already in the requested state</li>
              ) : null}
              {bulkResult.skippedArchived ? (
                <li>{bulkResult.skippedArchived} left alone — already discarded</li>
              ) : null}
              {bulkResult.notFound ? <li>{bulkResult.notFound} not found (may have been removed already)</li> : null}
            </ul>
          )}
        </Alert>
      ) : null}

      {rows.map((row) => {
        const expanded = expandedId === row.id;
        const busy = pending && busyId === row.id;
        return (
          <Card key={row.id} className="p-0">
            <div className="flex items-start gap-3 p-4">
              <Checkbox
                className="mt-1"
                checked={selected.includes(row.id)}
                onChange={() => toggle(row.id)}
                aria-label={`Select "${row.title}"`}
              />
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : row.id)}
                aria-expanded={expanded}
                className="mt-0.5 flex cursor-pointer items-center text-[color:var(--color-muted-foreground)]"
                aria-label={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
              </button>

              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-[color:var(--color-foreground)]">{row.title}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[color:var(--color-muted-foreground)]">
                  <Badge color="gray">{row.category.replace(/_/g, " ")}</Badge>
                  {row.module ? <Badge color="blue">{row.module}</Badge> : null}
                  {row.confidence !== null ? <span className="tabular">{row.confidence}% confident</span> : null}
                  {row.sourceLabel ? <span className="truncate">from {row.sourceLabel}</span> : null}
                </p>

                {expanded ? (
                  <div className="mt-3 space-y-3">
                    {row.question ? (
                      <div>
                        <p className="text-[11px] font-medium text-[color:var(--color-muted-foreground)]">Question</p>
                        <p className="mt-0.5 text-[13px] leading-relaxed">{row.question}</p>
                      </div>
                    ) : null}
                    <div>
                      <p className="text-[11px] font-medium text-[color:var(--color-muted-foreground)]">Answer</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed">{row.answer}</p>
                    </div>
                    <Link href={`/ai-learning/knowledge-base/${row.id}/edit`} className="link text-xs">
                      Edit before verifying
                    </Link>
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 flex-col gap-1.5">
                <Button size="sm" loading={busy} onClick={() => verify(row.id)}>
                  <Check className="size-3.5" aria-hidden />
                  Verify
                </Button>
                <Button variant="ghost" size="sm" loading={busy} onClick={() => discard(row.id)}>
                  <Trash2 className="size-3.5" aria-hidden />
                  Discard
                </Button>
              </div>
            </div>
          </Card>
        );
      })}

      <ConfirmDialog
        open={confirming === "verify"}
        onClose={() => setConfirming(null)}
        onConfirm={() => runBulk("verify")}
        title={`Verify ${selected.length} ${selected.length === 1 ? "entry" : "entries"}?`}
        description="Verified entries can be used to answer customers immediately. Only verify what you have read."
        confirmLabel="Verify"
        loading={pending}
      />
      <ConfirmDialog
        open={confirming === "discard"}
        onClose={() => setConfirming(null)}
        onConfirm={() => runBulk("discard")}
        title={`Discard ${selected.length} ${selected.length === 1 ? "entry" : "entries"}?`}
        description="They are archived, not deleted — you can still find them under the Archived filter on the Knowledge Base page."
        confirmLabel="Discard"
        tone="danger"
        loading={pending}
      />
    </div>
  );
}
