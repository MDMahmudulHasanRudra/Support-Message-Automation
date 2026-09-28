"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useMemo, useState, useTransition } from "react";

import { Alert, Badge, Button, Checkbox, ConfirmDialog, Table, Td, Th, useToast } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { closeSupportSessionsBulk, type BulkCloseSupportSessionsResult } from "@/server/actions/supportSessions";
import { CloseSessionButton } from "./CloseSessionButton";

export interface SupportSessionRow {
  id: string;
  groupName: string;
  startedByName: string | null;
  startedAtIso: string;
  status: string;
  isStale: boolean;
  /** Pre-formatted for the Duration column ("In progress · 12m", "3m", ...) — computed
   *  server-side the same way the page always has, just handed down as text. */
  durationLabel: string;
  completedByLabel: string | null;
}

/**
 * Support Sessions can carry dozens of OPEN rows at once — a team member who resolved a request
 * without ever sending the configured completion keyword. `CloseSessionButton` already closes one
 * at a time with its own confirm dialog; this adds row selection plus a single "Close Selected"
 * action so that doesn't mean dozens of individual clicks. Only OPEN rows get a checkbox — a
 * COMPLETED session has nothing to close, and offering one would just be a dead control.
 */
export function SupportSessionsTable({ sessions }: { sessions: SupportSessionRow[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [lastResult, setLastResult] = useState<BulkCloseSupportSessionsResult | null>(null);

  const openSessions = useMemo(() => sessions.filter((s) => s.status === "OPEN"), [sessions]);
  const allOpenSelected = openSessions.length > 0 && openSessions.every((s) => selected.has(s.id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllOpen() {
    setSelected((prev) => {
      if (allOpenSelected) {
        const next = new Set(prev);
        openSessions.forEach((s) => next.delete(s.id));
        return next;
      }
      const next = new Set(prev);
      openSessions.forEach((s) => next.add(s.id));
      return next;
    });
  }

  function confirmBulkClose() {
    startTransition(async () => {
      try {
        const result = await closeSupportSessionsBulk([...selected]);
        setLastResult(result);
        setConfirmOpen(false);
        if (!result.error) {
          setSelected(new Set());
          router.refresh();
        }
      } catch {
        setConfirmOpen(false);
        showToast({
          tone: "danger",
          title: "Couldn't close the selected sessions",
          description: "Please refresh the page and try again.",
        });
      }
    });
  }

  return (
    <div>
      {openSessions.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[color:var(--color-muted-foreground)]">
            <Checkbox checked={allOpenSelected} onChange={toggleAllOpen} />
            {selected.size > 0 ? `${selected.size} selected` : `Select all open (${openSessions.length})`}
          </label>
          <Button
            variant="secondary"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => setConfirmOpen(true)}
          >
            Bulk Close ({selected.size})
          </Button>
        </div>
      ) : null}

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
                <li>{lastResult.closed} session(s) closed</li>
                {lastResult.alreadyClosed > 0 ? <li>{lastResult.alreadyClosed} already completed</li> : null}
                {lastResult.notFound > 0 ? <li>{lastResult.notFound} not found (may have been removed)</li> : null}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th> </Th>
            <Th>Group</Th>
            <Th>Started By</Th>
            <Th>Started</Th>
            <Th>Duration</Th>
            <Th>Status</Th>
            <Th>Completed By</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <Td>
                {s.status === "OPEN" ? (
                  <Checkbox checked={selected.has(s.id)} onChange={() => toggleOne(s.id)} />
                ) : null}
              </Td>
              <Td className="font-medium">{s.groupName}</Td>
              <Td>{s.startedByName ?? "—"}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(new Date(s.startedAtIso))}</Td>
              <Td className="tabular-nums whitespace-nowrap">{s.durationLabel}</Td>
              <Td>
                {s.status === "OPEN" ? (
                  <Badge color={s.isStale ? "yellow" : "blue"} dot pulse={!s.isStale}>
                    {s.isStale ? "Needs attention" : "Open"}
                  </Badge>
                ) : (
                  <Badge color="green">Completed</Badge>
                )}
              </Td>
              <Td>{s.completedByLabel ?? "—"}</Td>
              <Td>
                {s.status === "OPEN" ? (
                  <CloseSessionButton sessionId={s.id} groupName={s.groupName} startedAtIso={s.startedAtIso} />
                ) : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={confirmBulkClose}
        loading={isPending}
        tone="primary"
        title="Close selected support sessions?"
        description={`This marks ${selected.size} open session(s) as completed. Use this when a team member resolved the request but never sent a configured completion keyword.`}
        confirmLabel="Close Selected"
      />
    </div>
  );
}
