"use client";

import { MessageSquareText } from "lucide-react";
import { formatResponseDuration } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Alert, Button, Checkbox, EmptyState, SelectAllMatchingNotice, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import type { ResponseRow } from "@/server/supportResponse";
import { ExportButtons, useEpisodeSelection } from "../supportResponseSelection";

/** Fast stays quiet; slow is marked, so the eye goes to the ones worth asking about. */
function responseTone(seconds: number): string {
  if (seconds >= 60 * 60) return "bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]";
  if (seconds >= 15 * 60) return "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]";
  return "bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)]";
}

export function ResponseTimeTable({ rows, total, query }: { rows: ResponseRow[]; total: number; query: Record<string, string> }) {
  const sel = useEpisodeSelection(
    rows.map((r) => r.id),
    "response-time",
    query,
  );

  return (
    <div>
      <div className="sticky top-0 z-20 -mx-5 mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-background)]/95 px-5 py-2 backdrop-blur-sm sm:-mx-8 sm:px-8">
        <div className="flex items-center gap-3">
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            <span className="tabular font-medium text-[color:var(--color-foreground)]">{sel.selected.size.toLocaleString("en-US")}</span> selected{" "}
            {sel.allMatching ? "(everything matching these filters)" : `(of ${rows.length} on this page)`}
          </span>
          {sel.selected.size > 0 ? (
            <Button variant="ghost" size="sm" onClick={sel.clear}>
              Deselect
            </Button>
          ) : null}
        </div>
        <ExportButtons tab="response-time" query={query} selectedIds={[...sel.selected]} total={total} />
      </div>

      <SelectAllMatchingNotice
        pageSelectedCount={sel.pageSelectedCount}
        pageCount={rows.length}
        totalMatching={total}
        allMatchingSelected={sel.allMatching}
        onSelectAllMatching={sel.selectAllMatching}
        onClear={sel.clear}
        loading={sel.widening}
        noun={{ singular: "response", plural: "responses" }}
      />
      {sel.notice ? (
        <div className="mb-3">
          <Alert tone="warning">{sel.notice}</Alert>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState>No Support Team responses match these filters yet. A group appears here when a Support Team member answers it.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>
                <Checkbox aria-label="Select this page" checked={sel.allPageSelected} indeterminate={!sel.allPageSelected && sel.somePageSelected} onChange={sel.togglePage} />
              </Th>
              <Th>Group</Th>
              <Th>Customer wrote</Th>
              <Th>Support replied</Th>
              <Th>Response time</Th>
              <Th>Replied by</Th>
              <Th>Messages</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
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
                <Td className="whitespace-nowrap text-[13px]">{formatDateTime(new Date(r.firstIncomingAt))}</Td>
                <Td className="whitespace-nowrap text-[13px]">{formatDateTime(new Date(r.supportRepliedAt))}</Td>
                <Td>
                  <span className={`tabular inline-flex rounded-[var(--radius-sm)] px-2 py-0.5 text-[12.5px] font-semibold ${responseTone(r.responseSeconds)}`}>
                    {formatResponseDuration(r.responseSeconds)}
                  </span>
                </Td>
                <Td className="text-[13px]">
                  <div className="font-medium">{r.memberName ?? "Removed member"}</div>
                  {r.teamName ? <div className="text-[11px] text-[color:var(--color-muted-foreground)]">{r.teamName}</div> : null}
                </Td>
                <Td className="tabular text-[13px]">{r.messageCount.toLocaleString("en-US")}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Link href={`/chat/${r.groupId}`} className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[12px] text-[color:var(--color-accent)] hover:bg-[var(--color-neutral-bg)]">
                    <MessageSquareText className="size-3.5" aria-hidden />
                    Open chat
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
