"use client";

import { useMemo, useState, useTransition } from "react";
import { FAILED_REPLY_CATEGORY_LABELS, FAILED_REPLY_STATE_LABELS, type FailedReplyState } from "@support-automation/shared";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import { Alert, Badge, Button, Checkbox, ConfirmDialog, EmptyState, Field, Input, Table, Td, Th, useToast, type BadgeColor } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { closeFailedReplies, resolveFailedReplies, retryFailedReplies, selectAllFailedReplies, type FailedReplyItem } from "@/server/actions/failedReplies";
import type { FailedReplyRow } from "@/server/failedReplies";

const STATE_COLOR: Record<FailedReplyState, BadgeColor> = { FAILED: "red", RETRYING: "blue", RESOLVED: "green", CLOSED: "gray" };
const CHANNEL_LABEL: Record<string, string> = { WHATSAPP: "WhatsApp", MESSENGER: "Messenger", INSTAGRAM: "Instagram", TELEGRAM: "Telegram", WEBCHAT: "Website chat" };
const ACTION_LABEL: Record<string, string> = { AUTO_REPLY: "Automatic / AI", MANUAL_REPLY: "Typed by a person", AGENT: "Typed by a person", AI: "AI", SYSTEM: "Automatic" };

type Pending = { kind: "retry" | "resolve" | "close" } | null;
const keyOf = (r: { source: string; id: string }) => `${r.source}:${r.id}`;

export function FailedRepliesTable({
  rows,
  total,
  query,
  canWhatsApp,
  canChannels,
}: {
  rows: FailedReplyRow[];
  total: number;
  query: Record<string, string>;
  canWhatsApp: boolean;
  canChannels: boolean;
}) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [selected, setSelected] = useState<Map<string, FailedReplyItem>>(new Map());
  const [allMatching, setAllMatching] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [note, setNote] = useState("");
  const [busy, startTransition] = useTransition();
  const canAct = canWhatsApp || canChannels;
  const mayAct = (r: FailedReplyRow) => (r.source === "WHATSAPP" ? canWhatsApp : canChannels);

  const pageKeys = useMemo(() => rows.filter(mayAct).map(keyOf), [rows, canWhatsApp, canChannels]); // eslint-disable-line react-hooks/exhaustive-deps
  const allPageSelected = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  const somePageSelected = pageKeys.some((k) => selected.has(k));

  function toggle(r: FailedReplyRow) {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(keyOf(r))) next.delete(keyOf(r));
      else next.set(keyOf(r), { source: r.source, id: r.id });
      return next;
    });
  }
  function togglePage() {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Map(prev);
      if (allPageSelected) for (const k of pageKeys) next.delete(k);
      else for (const r of rows) if (mayAct(r)) next.set(keyOf(r), { source: r.source, id: r.id });
      return next;
    });
  }
  function selectAll() {
    startTransition(async () => {
      const result = await selectAllFailedReplies(query);
      setSelected(new Map(result.items.map((i) => [keyOf(i), i])));
      setAllMatching(true);
      if (result.truncated) showToast({ tone: "info", title: `Selected the first ${result.items.length}`, description: "Narrow the filters to act on the rest." });
    });
  }
  const clear = () => (setSelected(new Map()), setAllMatching(false));

  function confirm() {
    const target = pending;
    if (!target) return;
    const items = [...selected.values()];
    startTransition(async () => {
      const result =
        target.kind === "retry" ? await retryFailedReplies({ items, note }) : target.kind === "resolve" ? await resolveFailedReplies({ items, note }) : await closeFailedReplies({ items, note });
      if (result.error) {
        showToast({ tone: "danger", title: "Nothing was changed", description: result.error });
        return;
      }
      setPending(null);
      setNote("");
      const verb = target.kind === "retry" ? "Queued again" : target.kind === "resolve" ? "Resolved" : "Closed";
      showToast({
        tone: result.done ? "success" : "info",
        title: `${verb}: ${result.done ?? 0}`,
        description: result.skipped
          ? `${result.skipped} left as they are${target.kind === "retry" ? " — uncertain, already retrying, not eligible, or the account is not connected. Open one to see why." : " — they were not in a state this applies to."}`
          : undefined,
      });
      clear();
      router.refresh();
    });
  }

  const count = selected.size;
  return (
    <div>
      {canAct ? (
        <div className="sticky top-0 z-20 -mx-5 mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-background)]/95 px-5 py-2 backdrop-blur-sm sm:-mx-8 sm:px-8">
          <div className="flex items-center gap-3 text-xs text-[color:var(--color-muted-foreground)]">
            <span>
              <span className="tabular font-medium text-[color:var(--color-foreground)]">{count.toLocaleString("en-US")}</span> selected{allMatching ? " (everything matching these filters)" : ""}
            </span>
            {allPageSelected && !allMatching && total > rows.length ? (
              <Button variant="ghost" size="sm" onClick={selectAll} disabled={busy}>
                Select all {total.toLocaleString("en-US")} matching
              </Button>
            ) : null}
            {count > 0 ? (
              <Button variant="ghost" size="sm" onClick={clear} disabled={busy}>
                Deselect
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy || count === 0} onClick={() => setPending({ kind: "retry" })}>
              Retry selected
            </Button>
            <Button variant="secondary" size="sm" disabled={busy || count === 0} onClick={() => setPending({ kind: "resolve" })}>
              Mark resolved
            </Button>
            <Button variant="secondary" size="sm" disabled={busy || count === 0} onClick={() => setPending({ kind: "close" })}>
              Close
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState>No customer reply matching these filters failed. Replies that fail are listed here with what went wrong.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              {canAct ? (
                <Th>
                  <Checkbox aria-label="Select this page" checked={allPageSelected} indeterminate={!allPageSelected && somePageSelected} onChange={togglePage} />
                </Th>
              ) : null}
              <Th>Customer</Th>
              <Th>Reply</Th>
              <Th>What happened</Th>
              <Th>Attempts</Th>
              <Th>State</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={keyOf(r)}>
                {canAct ? (
                  <Td className="w-8">{mayAct(r) ? <Checkbox aria-label={`Select reply to ${r.chatName}`} checked={selected.has(keyOf(r))} onChange={() => toggle(r)} /> : null}</Td>
                ) : null}
                <Td>
                  <div className="font-medium text-[color:var(--color-foreground)]">{r.chatName}</div>
                  <div className="text-[11px] text-[color:var(--color-muted-foreground)]">
                    {CHANNEL_LABEL[r.channelType] ?? r.channelType} · {r.accountLabel}
                  </div>
                </Td>
                <Td className="max-w-[20rem]">
                  <div className="truncate text-[13px]" title={r.text}>
                    {r.text || "—"}
                  </div>
                  <div className="text-[11px] text-[color:var(--color-muted-foreground)]">
                    {ACTION_LABEL[r.actionType] ?? r.actionType} · {formatDateTime(new Date(r.createdAt))}
                  </div>
                </Td>
                <Td className="max-w-[18rem]">
                  <div className="flex items-center gap-1.5">
                    {r.category === "DELIVERY_UNCERTAIN" ? (
                      <Badge color="yellow" dot>
                        Delivery uncertain
                      </Badge>
                    ) : (
                      <span className="text-[13px] font-medium">{FAILED_REPLY_CATEGORY_LABELS[r.category]}</span>
                    )}
                  </div>
                  {r.failureReason ? (
                    <div className="mt-0.5 truncate text-[11px] text-[color:var(--color-muted-foreground)]" title={r.failureReason}>
                      {r.failureReason}
                    </div>
                  ) : null}
                </Td>
                <Td className="tabular whitespace-nowrap text-[13px]">
                  {r.attempts}
                  {r.manualRetryCount ? <span className="text-[11px] text-[color:var(--color-muted-foreground)]"> · {r.manualRetryCount} retried</span> : null}
                  {r.lastAttemptAt ? <div className="text-[11px] text-[color:var(--color-muted-foreground)]">{formatDateTime(new Date(r.lastAttemptAt))}</div> : null}
                </Td>
                <Td>
                  <Badge color={STATE_COLOR[r.state]}>{FAILED_REPLY_STATE_LABELS[r.state]}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <Link href={`/messages/failed-replies/${r.source.toLowerCase()}/${r.id}`} className="rounded-[var(--radius-sm)] px-2 py-1 text-[12px] text-[color:var(--color-accent)] hover:bg-[var(--color-neutral-bg)]">
                    Details
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {canAct ? (
        <ConfirmDialog
          open={pending !== null}
          onClose={() => (setPending(null), setNote(""))}
          onConfirm={confirm}
          title={pending?.kind === "retry" ? "Send these replies again?" : pending?.kind === "resolve" ? "Mark these replies resolved?" : "Close these replies?"}
          description={
            pending?.kind === "retry"
              ? `${count} selected. Each is queued again as the same message and passes every safety check at send time. Replies whose delivery is uncertain are skipped — open each one, check the chat, and retry it there.`
              : pending?.kind === "resolve"
                ? `${count} selected. Use this when the customer was answered another way or the message did arrive. Nothing is sent.`
                : `${count} selected. They will not be sent. Nothing is deleted, and each can be reopened later.`
          }
          confirmLabel={pending?.kind === "retry" ? "Retry" : pending?.kind === "resolve" ? "Mark resolved" : "Close"}
          tone={pending?.kind === "close" ? "danger" : "primary"}
          loading={busy}
          confirmDisabled={pending?.kind === "close" && note.trim() === ""}
        >
          <Field label={pending?.kind === "close" ? "Reason (required)" : "Note (optional)"} hint="Kept in each reply's history with your name.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={pending?.kind === "close" ? "e.g. Customer no longer needs it" : "e.g. Answered by phone"} />
          </Field>
          {pending?.kind === "retry" ? (
            <div className="mt-3">
              <Alert tone="warning">Automatic replies are cancelled at send time while automation is paused.</Alert>
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
