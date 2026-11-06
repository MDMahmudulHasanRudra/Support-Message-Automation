"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AlarmClock, CheckCircle2, Hourglass, PanelRight, RotateCcw, UserCheck, UserMinus } from "lucide-react";
import type { ConversationStatus } from "@support-automation/shared";
import { useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { setConversationAssignee, setConversationStatus } from "@/server/actions/inboxLifecycle";
import { togglePanel, usePanelCollapsed, usePanelSheetOpen, useWorkspaceInfo } from "./panelStore";

const ICON_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] disabled:opacity-50 max-sm:size-10";

/** Opens and closes the side panel. Renders nothing when the project has no panel. */
export function PanelToggle() {
  const info = useWorkspaceInfo();
  const collapsed = usePanelCollapsed();
  const sheet = usePanelSheetOpen();
  if (!info) return null;
  return (
    <button
      type="button"
      onClick={togglePanel}
      aria-label={sheet ? "Hide customer details" : collapsed ? "Show customer details" : "Customer details"}
      aria-pressed={sheet || !collapsed}
      title="Customer details"
      className={ICON_BUTTON}
    >
      <PanelRight className="size-4" aria-hidden />
    </button>
  );
}

function snoozeChoices(now: Date): { label: string; until: Date }[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const nextMonday = at(1, 9);
  while (nextMonday.getDay() !== 1) nextMonday.setDate(nextMonday.getDate() + 1);
  return [
    { label: "1 hour", until: new Date(now.getTime() + 60 * 60_000) },
    { label: "4 hours", until: new Date(now.getTime() + 4 * 60 * 60_000) },
    { label: "Tomorrow 9:00", until: at(1, 9) },
    { label: "Next Monday 9:00", until: nextMonday },
  ];
}

/**
 * The moves somebody makes from the header without opening the panel: Resolve (the main action), snooze,
 * mark pending, and take it. Same actions as the panel's Status section, and the server decides each again.
 */
export function ConversationQuickActions() {
  const info = useWorkspaceInfo();
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [busy, start] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const [choices, setChoices] = useState<{ label: string; until: Date }[]>([]);
  const menu = useRef<HTMLDivElement>(null);
  const refKey = info ? JSON.stringify(info.ref) : "";
  const [optimistic, setOptimistic] = useState<{ refKey: string; from: ConversationStatus | undefined; status: ConversationStatus } | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  if (!info?.lifecycle || !info.access.canWrite) return null;
  const ref = info.ref;
  // What this browser just did shows at once, until the next refresh of the page carries a different status.
  const status = optimistic && optimistic.refKey === refKey && optimistic.from === info.lifecycle.status ? optimistic.status : info.lifecycle.status;
  const mine = info.assignedUserId === info.viewerId;

  const move = (to: ConversationStatus, until?: Date) =>
    start(async () => {
      setOptimistic({ refKey, from: info.lifecycle?.status, status: to });
      setMenuOpen(false);
      const r = await setConversationStatus(ref, { to, until: until?.toISOString() });
      if ("error" in r) {
        setOptimistic(null);
        showToast({ tone: "danger", title: r.error });
        return;
      }
      router.refresh();
    });

  const assign = () =>
    start(async () => {
      const r = await setConversationAssignee(ref, mine ? null : info.viewerId);
      if ("error" in r) showToast({ tone: "danger", title: r.error });
      else showToast({ tone: "success", title: mine ? "Unassigned." : "Assigned to you." });
      router.refresh();
    });

  return (
    <>
      <button type="button" disabled={busy} onClick={assign} title={mine ? "Unassign" : info.assignedUserId ? "Take over" : "Assign to me"} aria-label={mine ? "Unassign" : info.assignedUserId ? "Take over" : "Assign to me"} className={`${ICON_BUTTON} max-sm:hidden`}>
        {mine ? <UserMinus className="size-4" aria-hidden /> : <UserCheck className="size-4" aria-hidden />}
      </button>
      {status !== "RESOLVED" ? (
        <div ref={menu} className="relative max-sm:hidden">
          <button
            type="button"
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Snooze or mark pending"
            title="Snooze or mark pending"
            onClick={() => {
              setChoices(snoozeChoices(new Date()));
              setMenuOpen((v) => !v);
            }}
            className={ICON_BUTTON}
          >
            <AlarmClock className="size-4" aria-hidden />
          </button>
          {menuOpen ? (
            <div role="menu" className="absolute right-0 top-full z-30 mt-1.5 w-48 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-lg)]">
              {status === "OPEN" ? (
                <button type="button" role="menuitem" onClick={() => move("PENDING")} className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-neutral-bg)]">
                  <Hourglass className="size-3.5 text-[color:var(--color-muted-foreground)]" aria-hidden />
                  Mark pending
                </button>
              ) : null}
              <p className="px-2.5 pb-0.5 pt-1.5 text-[11px] text-[color:var(--color-subtle-foreground)]">Snooze until</p>
              {choices.map((c) => (
                <button key={c.label} type="button" role="menuitem" onClick={() => move("SNOOZED", c.until)} className="block w-full rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-neutral-bg)]">
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {status === "OPEN" || status === "PENDING" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => move("RESOLVED")}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-3 text-[12.5px] font-medium text-[var(--color-on-primary)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-60 max-sm:size-10 max-sm:justify-center max-sm:px-0"
        >
          <CheckCircle2 className="size-3.5 max-sm:size-4.5" aria-hidden />
          <span className="max-sm:sr-only">Resolve</span>
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => move("OPEN")}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 text-[12.5px] font-medium text-[color:var(--color-foreground)] ring-1 ring-inset ring-[var(--color-border-strong)] transition-colors hover:bg-[var(--color-neutral-bg)] disabled:opacity-60 max-sm:size-10 max-sm:justify-center max-sm:px-0"
        >
          <RotateCcw className="size-3.5 max-sm:size-4.5" aria-hidden />
          <span className="max-sm:sr-only">{status === "SNOOZED" ? "Unsnooze" : "Reopen"}</span>
        </button>
      )}
    </>
  );
}
