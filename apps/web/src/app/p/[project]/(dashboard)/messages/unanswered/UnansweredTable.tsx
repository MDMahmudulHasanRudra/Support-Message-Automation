"use client";

import { MessageSquareText } from "lucide-react";
import { useState, useTransition } from "react";
import { formatResponseDuration } from "@support-automation/shared";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import { Alert, Badge, Button, Checkbox, ConfirmDialog, EmptyState, Field, Input, SelectAllMatchingNotice, Table, Td, Th, useToast } from "@/components/ui";
import { formatDateTime, formatTime } from "@/lib/date";
import { clearAllUnanswered, clearUnansweredEpisodes } from "@/server/actions/supportResponse";
import type { UnansweredRow } from "@/server/supportResponse";
import { ExportButtons, useEpisodeSelection } from "../supportResponseSelection";

type PendingClear = { kind: "selected" } | { kind: "all" } | { kind: "one"; row: UnansweredRow } | null;

/** Waiting time gets louder the longer it gets — an hour unanswered should not look like a minute. */
function waitTone(seconds: number): string {
  if (seconds >= 60 * 60) return "text-[color:var(--color-danger-fg)] font-semibold";
  if (seconds >= 15 * 60) return "text-[color:var(--color-warning-fg)] font-medium";
  return "text-[color:var(--color-foreground)]";
}

export function UnansweredTable({
  rows,
  total,
  query,
  nowMs,
  canClear,
  showingCleared,
}: {
  rows: UnansweredRow[];
  total: number;
  query: Record<string, string>;
  /** The server's clock for this render, so every waiting time on the page is from one instant. */
  nowMs: number;
  canClear: boolean;
  showingCleared: boolean;
}) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const sel = useEpisodeSelection(
    rows.map((r) => r.id),
    "unanswered",
    query,
  );
  const [pending, setPending] = useState<PendingClear>(null);
  const [reason, setReason] = useState("");
  const [busy, startTransition] = useTransition();

  function confirmClear() {
    const target = pending;
    if (!target) return;
    startTransition(async () => {
      const result =
        target.kind === "all"
          ? await clearAllUnanswered({ query, reason })
          : await clearUnansweredEpisodes({ ids: target.kind === "one" ? [target.row.id] : [...sel.selected], query, reason });
      setPending(null);
      setReason("");
      if (result.error) {
        showToast({ tone: "danger", title: "Nothing was cleared", description: result.error });
        return;
      }
      showToast({
        tone: "success",
        title: `Cleared ${result.cleared} group(s)`,
        description: result.skipped ? `${result.skipped} had already been answered or cleared and were left as they are.` : "Messages were not touched.",
      });
      sel.clear();
      router.refresh();
    });
  }

  const describe =
    pending?.kind === "all"
      ? `all ${total.toLocaleString("en-US")} unanswered group(s) matching these filters`
      : pending?.kind === "one"
        ? `"${pending.row.groupName}"`
        : `${sel.selected.size.toLocaleString("en-US")} selected group(s)`;

  return (
    <div>
      <div className="sticky top-0 z-20 -mx-5 mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-background)]/95 px-5 py-2 backdrop-blur-sm sm:-mx-8 sm:px-8">
        <div className="flex items-center gap-3">
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            <span className="tabular font-medium text-[color:var(--color-foreground)]">{sel.selected.size.toLocaleString("en-US")}</span> selected{" "}
            {sel.allMatching ? "(everything matching these filters)" : `(of ${rows.length} on this page)`}
          </span>
          {sel.selected.size > 0 ? (
            <Button variant="ghost" size="sm" onClick={sel.clear} disabled={busy}>
              Deselect
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canClear && !showingCleared ? (
            <>
              <Button variant="secondary" size="sm" disabled={busy || sel.selected.size === 0} onClick={() => setPending({ kind: "selected" })}>
                Clear selected
              </Button>
              <Button variant="secondary" size="sm" disabled={busy || total === 0} onClick={() => setPending({ kind: "all" })}>
                Clear all {total.toLocaleString("en-US")}
              </Button>
            </>
          ) : null}
          <ExportButtons tab="unanswered" query={query} selectedIds={[...sel.selected]} total={total} />
        </div>
      </div>

      <SelectAllMatchingNotice
        pageSelectedCount={sel.pageSelectedCount}
        pageCount={rows.length}
        totalMatching={total}
        allMatchingSelected={sel.allMatching}
        onSelectAllMatching={sel.selectAllMatching}
        onClear={sel.clear}
        loading={sel.widening}
        noun={{ singular: "group", plural: "groups" }}
      />
      {sel.notice ? (
        <div className="mb-3">
          <Alert tone="warning">{sel.notice}</Alert>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState>
          {showingCleared ? "Nothing matching these filters has been cleared." : "No group is waiting for Support: every customer message matching these filters has had a Support Team reply."}
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>
                <Checkbox aria-label="Select this page" checked={sel.allPageSelected} indeterminate={!sel.allPageSelected && sel.somePageSelected} onChange={sel.togglePage} />
              </Th>
              <Th>Group</Th>
              <Th>Latest message</Th>
              <Th>First unanswered</Th>
              <Th>{showingCleared ? "Waited" : "Waiting"}</Th>
              <Th>Messages</Th>
              <Th>Status</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const end = r.status === "CLEARED" && r.clearedAt ? new Date(r.clearedAt).getTime() : nowMs;
              const waited = Math.max(0, Math.round((end - new Date(r.firstIncomingAt).getTime()) / 1000));
              return (
                <tr key={r.id}>
                  <Td className="w-8">
                    <Checkbox aria-label={`Select ${r.groupName}`} checked={sel.selected.has(r.id)} onChange={() => sel.toggle(r.id)} />
                  </Td>
                  <Td>
                    <Link href={`/chat/${r.groupId}`} className="font-medium text-[color:var(--color-foreground)] hover:underline">
                      {r.groupName}
                    </Link>
                    <div className="text-[11px] text-[color:var(--color-muted-foreground)]">{r.accountLabel}</div>
                  </Td>
                  <Td className="max-w-[22rem]">
                    <div className="truncate text-[13px]" title={r.latestMessage ?? undefined}>
                      {r.latestMessage ?? "—"}
                    </div>
                    <div className="text-[11px] text-[color:var(--color-muted-foreground)]">
                      {r.latestSender ?? "Unknown sender"} · {formatTime(new Date(r.latestIncomingAt))}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-[13px]" >
                    <span title={formatDateTime(new Date(r.firstIncomingAt))}>{formatDateTime(new Date(r.firstIncomingAt))}</span>
                  </Td>
                  <Td className={`tabular whitespace-nowrap text-[13px] ${showingCleared ? "" : waitTone(waited)}`}>{formatResponseDuration(waited)}</Td>
                  <Td className="tabular text-[13px]">{r.messageCount.toLocaleString("en-US")}</Td>
                  <Td>
                    {r.status === "CLEARED" ? (
                      <div>
                        <Badge color="gray">Cleared</Badge>
                        <div className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
                          {r.clearedBy ?? "Unknown"} · {r.clearedAt ? formatDateTime(new Date(r.clearedAt)) : ""}
                          {r.clearReason ? <div className="max-w-[14rem] truncate" title={r.clearReason}>“{r.clearReason}”</div> : null}
                        </div>
                      </div>
                    ) : (
                      <Badge color="red" dot>
                        Unanswered
                      </Badge>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <span className="inline-flex items-center gap-1">
                      <Link href={`/chat/${r.groupId}`} className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[12px] text-[color:var(--color-accent)] hover:bg-[var(--color-neutral-bg)]">
                        <MessageSquareText className="size-3.5" aria-hidden />
                        Open chat
                      </Link>
                      {canClear && r.status === "UNANSWERED" ? (
                        <Button variant="ghost" size="sm" onClick={() => setPending({ kind: "one", row: r })} disabled={busy}>
                          Clear
                        </Button>
                      ) : null}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {canClear ? (
      <ConfirmDialog
        open={pending !== null}
        onClose={() => (setPending(null), setReason(""))}
        onConfirm={confirmClear}
        title="Clear from Unanswered Groups?"
        description={`This dismisses ${describe} from this list. No message, group or chat history is deleted, and nothing changes in WhatsApp. If the customer writes again, the group comes back.`}
        confirmLabel="Clear"
        loading={busy}
      >
        <Field label="Reason (optional)" hint="Kept with the record of who cleared it.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Answered by phone" />
        </Field>
      </ConfirmDialog>
      ) : null}
    </div>
  );
}
