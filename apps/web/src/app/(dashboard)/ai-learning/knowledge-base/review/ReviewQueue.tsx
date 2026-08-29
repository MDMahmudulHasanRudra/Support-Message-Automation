"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { setKnowledgeStatus, setKnowledgeVerified } from "@/server/actions/aiKnowledge";

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

/**
 * The queue where AI-structured knowledge becomes usable — or doesn't.
 *
 * Everything the importer and the conversation builder produce arrives here unverified, and only
 * a verified entry is ever retrieved to answer a customer. That makes this page the trust
 * boundary of the whole knowledge system, so the two decisions are deliberately one click each
 * and the full answer is readable without leaving the page: a reviewer who has to open twenty
 * detail pages will stop reviewing.
 */
export function ReviewQueue({ rows }: { rows: ReviewRow[] }) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(rows[0]?.id ?? null);
  const [busyId, setBusyId] = useState<string | null>(null);
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

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const expanded = expandedId === row.id;
        const busy = pending && busyId === row.id;
        return (
          <Card key={row.id} className="p-0">
            <div className="flex items-start gap-3 p-4">
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
    </div>
  );
}
