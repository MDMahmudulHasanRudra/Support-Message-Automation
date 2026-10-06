"use client";

import { MessageSquareText } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { formatResponseDuration } from "@support-automation/shared";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import { Button, Checkbox, ConfirmDialog, EmptyState, Field, Input, Table, Td, Th, useToast } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { assignSupportCases, cancelSupportCases } from "@/server/actions/supportAssignment";
import type { AssignableMember, AssignmentRow } from "@/server/supportAssignment";
import { AssignDialog } from "./AssignDialog";
import { AssignmentBadge } from "./AssignmentBadge";

/** Waiting time gets louder the longer it gets — an hour unanswered should not look like a minute. */
function waitTone(seconds: number): string {
  if (seconds >= 60 * 60) return "text-[color:var(--color-danger-fg)] font-semibold";
  if (seconds >= 15 * 60) return "text-[color:var(--color-warning-fg)] font-medium";
  return "";
}

const seconds = (fromIso: string, toMs: number) => Math.max(0, Math.round((toMs - new Date(fromIso).getTime()) / 1000));

/** The SLA cell: a countdown while assigned, how late once overdue, the outcome once closed. */
function SlaCell({ row, nowMs }: { row: AssignmentRow; nowMs: number }) {
  if (row.status === "ASSIGNED" && row.dueAt) {
    const left = Math.round((new Date(row.dueAt).getTime() - nowMs) / 1000);
    return left > 0 ? (
      <span className={left < 5 * 60 ? "text-[color:var(--color-warning-fg)] font-medium" : ""}>Due in {formatResponseDuration(left)}</span>
    ) : (
      <span className="text-[color:var(--color-warning-fg)] font-medium">Due now</span>
    );
  }
  if (row.status === "OVERDUE" && row.dueAt) {
    return (
      <span className="font-semibold text-[color:var(--color-danger-fg)]">
        Overdue {formatResponseDuration(seconds(row.dueAt, nowMs))}
        {row.escalated ? " · escalated" : ""}
      </span>
    );
  }
  if (row.status === "COMPLETED" && row.completedAt && row.dueAt) {
    const late = new Date(row.completedAt) > new Date(row.dueAt);
    return (
      <span className={late ? "text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-success-fg)]"}>
        {formatResponseDuration(row.responseSeconds)} · {late ? "late" : "on time"}
      </span>
    );
  }
  return <span className="text-[color:var(--color-muted-foreground)]">—</span>;
}

type Pending = { kind: "assign"; ids: string[]; assignedCount: number } | { kind: "cancel"; ids: string[] } | null;

export function CaseTable({
  rows,
  nowMs,
  canAssign,
  members,
  closedView = false,
  emptyMessage,
}: {
  rows: AssignmentRow[];
  /** The server's clock for this render, so every time on the page is from one instant. */
  nowMs: number;
  canAssign: boolean;
  members: AssignableMember[];
  closedView?: boolean;
  emptyMessage: string;
}) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [busy, startTransition] = useTransition();

  const selectable = canAssign && !closedView;
  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  // Rows that left the page (answered, refreshed away) drop out of the selection by themselves.
  const live = useMemo(() => new Set([...selected].filter((id) => pageIds.includes(id))), [selected, pageIds]);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => live.has(id));
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openAssign = (ids: string[]) =>
    setPending({ kind: "assign", ids, assignedCount: ids.filter((id) => byId.get(id)?.status !== "UNASSIGNED").length });

  function confirmAssign(memberId: string, reassign: boolean) {
    if (pending?.kind !== "assign") return;
    const ids = pending.ids;
    startTransition(async () => {
      const result = await assignSupportCases({ ids, memberId, reassign });
      setPending(null);
      if (result.error) {
        showToast({ tone: "danger", title: "Nothing was assigned", description: result.error });
        return;
      }
      const done = (result.assigned ?? 0) + (result.reassigned ?? 0);
      const notes = [
        result.reassigned ? `${result.reassigned} reassigned` : null,
        result.skipped?.length ? `${result.skipped.length} left as they were (${result.skipped[0]!.reason}${result.skipped.length > 1 ? " …" : ""})` : null,
        result.notifySkipped ? `${result.notifySkipped} WhatsApp notification(s) could not be queued — see the case history` : null,
      ].filter(Boolean);
      showToast({
        tone: done > 0 ? "success" : "info",
        title: done > 0 ? `Assigned ${done} case${done === 1 ? "" : "s"}` : "Nothing was assigned",
        description: notes.join(". ") || undefined,
      });
      setSelected(new Set());
      router.refresh();
    });
  }

  function confirmCancel() {
    if (pending?.kind !== "cancel") return;
    const ids = pending.ids;
    startTransition(async () => {
      const result = await cancelSupportCases({ ids, reason });
      setPending(null);
      setReason("");
      if (result.error) {
        showToast({ tone: "danger", title: "Nothing was cancelled", description: result.error });
        return;
      }
      showToast({
        tone: "success",
        title: `Cancelled ${result.cancelled} case${result.cancelled === 1 ? "" : "s"}`,
        description: result.skipped ? `${result.skipped} had already finished and were left as they are.` : "The conversation was not touched.",
      });
      setSelected(new Set());
      router.refresh();
    });
  }

  if (rows.length === 0) return <EmptyState>{emptyMessage}</EmptyState>;

  return (
    <div>
      {selectable ? (
        <div className="sticky top-0 z-20 -mx-5 mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-background)]/95 px-5 py-2 backdrop-blur-sm sm:-mx-8 sm:px-8">
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            <span className="tabular font-medium text-[color:var(--color-foreground)]">{live.size}</span> selected (of {rows.length} on this page)
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {live.size > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={busy}>
                Deselect
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" disabled={busy || live.size === 0} onClick={() => setPending({ kind: "cancel", ids: [...live] })}>
              Cancel selected
            </Button>
            <Button size="sm" disabled={busy || live.size === 0} onClick={() => openAssign([...live])}>
              Assign selected
            </Button>
          </div>
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            {selectable ? (
              <Th>
                <Checkbox
                  aria-label="Select this page"
                  checked={allSelected}
                  indeterminate={!allSelected && live.size > 0}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(pageIds))}
                />
              </Th>
            ) : null}
            <Th>Status</Th>
            <Th>Group</Th>
            <Th>Customer &amp; message</Th>
            <Th>Received</Th>
            <Th>{closedView ? "Closed" : "Waiting"}</Th>
            <Th>{closedView ? "Assigned · answered by" : "Assigned to"}</Th>
            <Th>SLA</Th>
            <Th> </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const waited = seconds(r.receivedAt, nowMs);
            return (
              <tr key={r.id}>
                {selectable ? (
                  <Td className="w-8">
                    <Checkbox aria-label={`Select ${r.groupName}`} checked={live.has(r.id)} onChange={() => toggle(r.id)} />
                  </Td>
                ) : null}
                <Td>
                  <AssignmentBadge status={r.status} />
                </Td>
                <Td>
                  <Link href={`/support-assignment/${r.id}`} className="font-medium text-[color:var(--color-foreground)] hover:underline">
                    {r.groupName}
                  </Link>
                  <div className="text-[11px] text-[color:var(--color-muted-foreground)]">{r.accountLabel}</div>
                </Td>
                <Td className="max-w-[22rem]">
                  <div className="truncate text-[13px]" title={r.message ?? undefined}>
                    {r.message ?? (r.status === "IGNORED" ? `${r.ignoredMessageCount} filtered message(s)` : "(attachment)")}
                  </div>
                  <div className="truncate text-[11px] text-[color:var(--color-muted-foreground)]">{r.customer ?? "Unknown sender"}</div>
                </Td>
                <Td className="whitespace-nowrap text-[13px]">{formatDateTime(new Date(r.receivedAt))}</Td>
                <Td className={`tabular whitespace-nowrap text-[13px] ${closedView ? "" : waitTone(waited)}`}>
                  {closedView ? (r.closedAt ? formatDateTime(new Date(r.closedAt)) : "—") : formatResponseDuration(waited)}
                </Td>
                <Td className="text-[13px]">
                  {r.assignedTo ? r.assignedTo.name : <span className="text-[color:var(--color-muted-foreground)]">—</span>}
                  {closedView && r.answeredBy && r.answeredBy.id !== r.assignedTo?.id ? (
                    <div className="text-[11px] text-[color:var(--color-muted-foreground)]">answered by {r.answeredBy.name}</div>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap text-[13px]">
                  <SlaCell row={r} nowMs={nowMs} />
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <span className="inline-flex items-center gap-1">
                    <Link
                      href={`/chat/${r.groupId}`}
                      className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[12px] text-[color:var(--color-accent)] hover:bg-[var(--color-neutral-bg)]"
                    >
                      <MessageSquareText className="size-3.5" aria-hidden />
                      Chat
                    </Link>
                    {selectable ? (
                      <Button variant="ghost" size="sm" onClick={() => openAssign([r.id])} disabled={busy}>
                        {r.status === "UNASSIGNED" ? "Assign" : "Reassign"}
                      </Button>
                    ) : null}
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      {selectable ? (
        <>
          <AssignDialog
            key={pending?.kind === "assign" ? pending.ids.join(",") : "closed"}
            open={pending?.kind === "assign"}
            onClose={() => setPending(null)}
            onConfirm={confirmAssign}
            members={members}
            caseCount={pending?.kind === "assign" ? pending.ids.length : 0}
            assignedCount={pending?.kind === "assign" ? pending.assignedCount : 0}
            busy={busy}
          />
          <ConfirmDialog
            open={pending?.kind === "cancel"}
            onClose={() => (setPending(null), setReason(""))}
            onConfirm={confirmCancel}
            title="Cancel these cases?"
            description={`This closes ${pending?.kind === "cancel" ? pending.ids.length : 0} case(s) as not needing support. No message or chat history changes, nobody is notified, and if the customer writes again a new case opens.`}
            confirmLabel="Cancel cases"
            tone="danger"
            loading={busy}
          >
            <Field label="Reason (optional)" hint="Kept in each case's history.">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Not a support question" />
            </Field>
          </ConfirmDialog>
        </>
      ) : null}
    </div>
  );
}
