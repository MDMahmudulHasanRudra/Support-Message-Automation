"use client";

import { useState } from "react";
import { CalendarClock, Plus } from "lucide-react";
import { formatFollowUpDue } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { FollowUpDialog } from "@/components/followUps/FollowUpDialog";
import type { ConversationFollowUp } from "@/server/followUps";

/**
 * A client profile's open follow-ups and an "Add follow-up" button (FOLLOW_UPS.md). The follow-up is
 * linked to the client; it can be done, edited or discarded on the Follow-ups page. Nothing is sent.
 */
export function ClientFollowUps({
  clientId,
  items,
  canCreate,
  people,
  teams,
  viewerId,
}: {
  clientId: string;
  items: ConversationFollowUp[];
  canCreate: boolean;
  people: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  viewerId: string;
}) {
  const [open, setOpen] = useState(false);
  const now = new Date();
  return (
    <div className="flex flex-col gap-2.5">
      {items.length === 0 ? <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No open follow-ups.</p> : null}
      <ul className="flex flex-col gap-2">
        {items.map((f) => (
          <li key={f.id} className="min-w-0 text-[13px]">
            <p className="break-words font-medium">{f.title}</p>
            <p
              className={`flex items-center gap-1 text-xs ${f.bucket === "OVERDUE" ? "text-[color:var(--color-danger-fg)]" : f.bucket === "DUE_TODAY" ? "text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-muted-foreground)]"}`}
            >
              <CalendarClock className="size-3" aria-hidden />
              <span suppressHydrationWarning>
                {f.bucket === "OVERDUE" ? "Overdue · " : ""}
                {formatFollowUpDue(new Date(f.dueAt), now)}
              </span>
              {f.assigneeName ? <span className="truncate">· {f.assigneeName}</span> : null}
            </p>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        {canCreate ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-xs font-medium shadow-[var(--shadow-xs)] hover:bg-[var(--color-neutral-bg)]"
          >
            <Plus className="size-3.5" aria-hidden />
            Add follow-up
          </button>
        ) : null}
        <Link href="/follow-ups?view=TEAM" className="text-xs font-medium text-[color:var(--color-accent)] hover:underline">
          All follow-ups
        </Link>
      </div>
      {open ? <FollowUpDialog open onClose={() => setOpen(false)} people={people} teams={teams} viewerId={viewerId} clientId={clientId} /> : null}
    </div>
  );
}
