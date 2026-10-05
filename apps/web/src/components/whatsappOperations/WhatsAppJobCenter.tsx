"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { CheckCircle2, ChevronDown, Loader2, Pause } from "lucide-react";
import { isFinishedOperationState, isWorkingOperationState } from "@support-automation/shared";
import { OperationSummary } from "./OperationSummary";
import { ClearOperationButton } from "./ClearOperationButton";
import { refreshWhatsAppOperations, useWhatsAppOperations } from "./operationsStore";

/**
 * WhatsApp Operations: the job indicator in the corner of every dashboard page.
 *
 * Add Number to Groups and the Groups Admin Maker run in the background worker for minutes or hours,
 * and their pages were the only place to see them — leave the page and the job vanished from view
 * although it kept running. This keeps every running job, and every one finished in the last twelve
 * hours, one click away wherever the person is. It shows nothing at all when there is nothing to
 * show: a permanent button reading "0" would be clutter on every page for most of the day.
 *
 * It never owns or drives a job. Closing it, navigating or refreshing changes nothing about the work.
 */
export function WhatsAppJobCenter({ projectSlug, besideAiChat }: { projectSlug: string; besideAiChat: boolean }) {
  const { ops } = useWhatsAppOperations(projectSlug);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // A navigation is a good moment to look again — it is also how a job just started from a module
  // page appears here without waiting for the next idle poll.
  useEffect(() => {
    void refreshWhatsAppOperations();
  }, [pathname]);

  // Operations this person cleared are already gone from `ops` (the server's per-user filter, plus the
  // store for the moment after the click), so this panel and a page's "Current operation" agree.
  const visible = ops;
  if (visible.length === 0) return null;

  const active = visible.filter((op) => !isFinishedOperationState(op.state));
  const working = active.some((op) => isWorkingOperationState(op.state));
  const label =
    active.length > 0
      ? `${active.length} WhatsApp operation${active.length === 1 ? "" : "s"} ${working ? "running" : "waiting"}`
      : `${visible.length} WhatsApp operation${visible.length === 1 ? "" : "s"} finished`;
  const lead = active[0];
  const leadPercent = lead && lead.total > 0 ? Math.floor((lead.processed / lead.total) * 100) : null;
  // Beside the AI assistant's button rather than on top of it.
  const right = besideAiChat ? "right-[5.25rem]" : "right-6";

  return (
    <>
      {open ? (
        <section
          aria-label="WhatsApp operations"
          className={`animate-scale-in fixed bottom-20 left-4 z-[var(--z-floating)] flex max-h-[70vh] origin-bottom-right flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)] sm:left-auto sm:w-[380px] ${right}`}
        >
          <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-[color:var(--color-foreground)]">WhatsApp operations</h2>
              <p className="text-xs text-[color:var(--color-muted-foreground)]">Runs on the server — you can leave any page.</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Minimise WhatsApp operations"
              className="flex size-8 cursor-pointer items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
            >
              <ChevronDown className="size-4" aria-hidden />
            </button>
          </header>
          <ul className="min-h-0 flex-1 divide-y divide-[var(--color-border)] overflow-y-auto">
            {visible.map((op) => (
              <li key={op.id} className="px-4 py-3">
                <OperationSummary op={op} compact actions={<ClearOperationButton op={op} size="xs" />} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={label}
        className={`fixed bottom-6 z-[var(--z-floating)] flex h-12 cursor-pointer items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] pr-4 pl-3.5 text-[13px] font-medium text-[color:var(--color-foreground)] shadow-[var(--shadow-lg)] transition-[box-shadow,transform] duration-[var(--duration-base)] hover:shadow-[var(--shadow-xl)] active:scale-[0.98] ${right}`}
      >
        {working ? (
          <Loader2 className="size-4 animate-spin text-[color:var(--color-primary)]" aria-hidden />
        ) : active.length > 0 ? (
          <Pause className="size-4 text-[color:var(--color-warning)]" aria-hidden />
        ) : (
          <CheckCircle2 className="size-4 text-[color:var(--color-success)]" aria-hidden />
        )}
        <span className="tabular">
          {active.length > 0 ? `${active.length} running` : `${visible.length} done`}
          {lead && leadPercent !== null && working ? <span className="text-[color:var(--color-muted-foreground)]"> · {leadPercent}%</span> : null}
        </span>
      </button>
    </>
  );
}
