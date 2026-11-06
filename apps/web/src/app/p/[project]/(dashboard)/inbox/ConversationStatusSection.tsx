"use client";

import { useState, useTransition } from "react";
import { AlarmClock, CheckCircle2, Hourglass, RotateCcw } from "lucide-react";
import { CONVERSATION_STATUS_LABELS, type ConversationRef, type ConversationStatus } from "@support-automation/shared";
import { useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { setConversationStatus } from "@/server/actions/inboxLifecycle";

/**
 * Inbox V3: the conversation's status, and the moves a person can make from it (conversationLifecycle.ts).
 * The server decides every move again; this only offers the ones that make sense from where it is.
 */

const TONE: Record<ConversationStatus, string> = {
  OPEN: "bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)]",
  PENDING: "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]",
  SNOOZED: "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)]",
  RESOLVED: "bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)]",
};

/** Snooze choices, computed in the viewer's own time zone. */
function snoozeChoices(now: Date): { label: string; until: Date }[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const nextMonday = (() => {
    const d = at(1, 9);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    return d;
  })();
  return [
    { label: "1 hour", until: new Date(now.getTime() + 60 * 60_000) },
    { label: "4 hours", until: new Date(now.getTime() + 4 * 60 * 60_000) },
    { label: "Tomorrow 9:00", until: at(1, 9) },
    { label: "Next Monday 9:00", until: nextMonday },
  ];
}

export function ConversationStatusSection({
  conversationRef,
  status,
  snoozedUntil,
  readOnly,
}: {
  conversationRef: ConversationRef;
  status: ConversationStatus;
  snoozedUntil: string | null;
  readOnly: boolean;
}) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [busy, start] = useTransition();
  const [shown, setShown] = useState<ConversationStatus | null>(null);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState("");
  const current = shown ?? status;

  const move = (to: ConversationStatus, until?: Date, resolutionNote?: string) =>
    start(async () => {
      setShown(to);
      const r = await setConversationStatus(conversationRef, { to, until: until?.toISOString(), note: resolutionNote });
      if ("error" in r) {
        setShown(null);
        showToast({ tone: "danger", title: r.error });
        return;
      }
      setSnoozeOpen(false);
      setResolving(false);
      setNote("");
      router.refresh();
    });

  const button = "inline-flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-[12px] font-medium ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50";

  return (
    <section>
      <h3 className="mb-2 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">Status</h3>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium ${TONE[current]}`}>{CONVERSATION_STATUS_LABELS[current]}</span>
        {current === "SNOOZED" && snoozedUntil && shown === null ? (
          <span className="text-[11.5px] text-[color:var(--color-muted-foreground)]">until {new Date(snoozedUntil).toLocaleString()}</span>
        ) : null}
      </div>

      {!readOnly ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {current !== "OPEN" ? (
            <button type="button" className={button} disabled={busy} onClick={() => move("OPEN")}>
              <RotateCcw className="size-3.5" aria-hidden />
              {current === "SNOOZED" ? "Unsnooze" : "Reopen"}
            </button>
          ) : null}
          {current === "OPEN" ? (
            <button type="button" className={button} disabled={busy} onClick={() => move("PENDING")}>
              <Hourglass className="size-3.5" aria-hidden />
              Pending
            </button>
          ) : null}
          {current !== "RESOLVED" ? (
            <button type="button" className={button} disabled={busy} onClick={() => setSnoozeOpen((v) => !v)} aria-expanded={snoozeOpen}>
              <AlarmClock className="size-3.5" aria-hidden />
              Snooze
            </button>
          ) : null}
          {current !== "RESOLVED" ? (
            <button type="button" className={button} disabled={busy} onClick={() => setResolving((v) => !v)} aria-expanded={resolving}>
              <CheckCircle2 className="size-3.5" aria-hidden />
              Resolve
            </button>
          ) : null}
        </div>
      ) : null}

      {snoozeOpen && !readOnly ? (
        <div className="mt-2 space-y-1.5 rounded-[var(--radius-md)] p-2 ring-1 ring-[var(--color-border)]">
          <div className="flex flex-wrap gap-1.5">
            {snoozeChoices(new Date()).map((c) => (
              <button key={c.label} type="button" className={button} disabled={busy} onClick={() => move("SNOOZED", c.until)}>
                {c.label}
              </button>
            ))}
          </div>
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (custom) move("SNOOZED", new Date(custom));
            }}
          >
            <input
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              aria-label="Snooze until"
              className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px]"
            />
            <button type="submit" className={button} disabled={busy || !custom}>
              Snooze
            </button>
          </form>
          <p className="text-[11px] text-[color:var(--color-subtle-foreground)]">It reopens by itself then, or earlier if the customer writes (Settings → Inbox status).</p>
        </div>
      ) : null}

      {resolving && !readOnly ? (
        <form
          className="mt-2 space-y-1.5 rounded-[var(--radius-md)] p-2 ring-1 ring-[var(--color-border)]"
          onSubmit={(e) => {
            e.preventDefault();
            move("RESOLVED", undefined, note);
          }}
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Resolution note (optional, internal)"
            aria-label="Resolution note"
            className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px]"
          />
          <button type="submit" className={button} disabled={busy}>
            <CheckCircle2 className="size-3.5" aria-hidden />
            Mark resolved
          </button>
        </form>
      ) : null}
    </section>
  );
}
