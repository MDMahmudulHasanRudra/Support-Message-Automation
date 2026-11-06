"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Contact, Flag, History, MessageCircle, Pencil, Plus, RotateCcw, Users, UserRound, X } from "lucide-react";
import { CONVERSATION_PRIORITY_LABEL, formatFollowUpDue, type FollowUpView } from "@support-automation/shared";
import { Badge, Button, EmptyState, useToast } from "@/components/ui";
import Link from "@/components/ProjectLink";
import { FollowUpDialog, type FollowUpFormInitial } from "@/components/followUps/FollowUpDialog";
import { readFollowUpHistory, setFollowUpStatus } from "@/server/actions/followUps";
import type { FollowUpRow } from "@/server/followUps";
import type { FollowUpHistoryEntry } from "@/server/followUps";

type Person = { id: string; name: string };

export function NewFollowUpButton({ people, teams, viewerId }: { people: Person[]; teams: Person[]; viewerId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        New follow-up
      </Button>
      {open ? <FollowUpDialog open onClose={() => setOpen(false)} people={people} teams={teams} viewerId={viewerId} /> : null}
    </>
  );
}

const BUCKET_TONE = {
  OVERDUE: "text-[color:var(--color-danger-fg)]",
  DUE_TODAY: "text-[color:var(--color-warning-fg)]",
  UPCOMING: "text-[color:var(--color-muted-foreground)]",
  DONE: "text-[color:var(--color-muted-foreground)]",
  DISCARDED: "text-[color:var(--color-muted-foreground)]",
} as const;

const PRIORITY_COLOR = { NONE: null, LOW: "gray", NORMAL: "blue", HIGH: "yellow", URGENT: "red" } as const;

const EMPTY: Record<FollowUpView, string> = {
  MINE: "Nothing open is yours. New follow-ups you add, or that colleagues give you, appear here.",
  TEAM: "Nothing is open in this project.",
  OVERDUE: "Nothing is overdue.",
  DUE_TODAY: "Nothing else is due today.",
  UPCOMING: "Nothing is due after today.",
  DONE: "Nothing has been marked done yet.",
  DISCARDED: "Nothing has been discarded.",
};

/**
 * The list of one tab: a card per follow-up (a table does not fit a phone, and a follow-up is read more
 * than it is compared). Done / Edit / Discard on open ones, Reopen on closed ones, history on request.
 */
export function FollowUpBoard({
  rows,
  view,
  nowIso,
  people,
  teams,
  viewerId,
  canWhatsApp,
  canChannels,
}: {
  rows: FollowUpRow[];
  view: FollowUpView;
  nowIso: string;
  people: Person[];
  teams: Person[];
  viewerId: string;
  canWhatsApp: boolean;
  canChannels: boolean;
}) {
  const [editing, setEditing] = useState<FollowUpFormInitial | null>(null);
  if (rows.length === 0) return <EmptyState icon={<CalendarClock className="size-5" aria-hidden />}>{EMPTY[view]}</EmptyState>;
  const now = new Date(nowIso);
  const mayChange = (row: FollowUpRow) => (row.linkKind === "whatsapp" ? canWhatsApp : row.linkKind === "channel" ? canChannels : canWhatsApp || canChannels);
  return (
    <>
      <ul className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <FollowUpCard key={row.id} row={row} now={now} canChange={mayChange(row)} onEdit={() => setEditing(toInitial(row))} />
        ))}
      </ul>
      {editing ? <FollowUpDialog open onClose={() => setEditing(null)} initial={editing} people={people} teams={teams} viewerId={viewerId} /> : null}
    </>
  );
}

function toInitial(row: FollowUpRow): FollowUpFormInitial {
  return { id: row.id, title: row.title, note: row.note, dueAt: row.dueAt, priority: row.priority, assignedUserId: row.assignedUserId, assignedTeamId: row.assignedTeamId };
}

function FollowUpCard({ row, now, canChange, onEdit }: { row: FollowUpRow; now: Date; canChange: boolean; onEdit: () => void }) {
  const { showToast } = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [history, setHistory] = useState<FollowUpHistoryEntry[] | null>(null);
  const open = row.status === "OPEN";
  const priorityColor = PRIORITY_COLOR[row.priority];

  const act = (action: "DONE" | "DISCARD" | "REOPEN") =>
    start(async () => {
      const r = await setFollowUpStatus(row.id, action);
      if ("error" in r) showToast({ tone: "danger", title: r.error });
      else {
        showToast({ tone: "success", title: action === "DONE" ? "Marked done" : action === "DISCARD" ? "Discarded" : "Reopened" });
        router.refresh();
      }
    });
  const toggleHistory = () =>
    start(async () => {
      if (history) return setHistory(null);
      const r = await readFollowUpHistory(row.id);
      if ("error" in r) showToast({ tone: "danger", title: r.error });
      else setHistory(r.entries);
    });

  return (
    <li className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className={`break-words text-[14.5px] font-medium ${open ? "" : "text-[color:var(--color-muted-foreground)] line-through decoration-1"}`}>{row.title}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
            <span className={`inline-flex items-center gap-1 font-medium ${BUCKET_TONE[row.bucket]}`}>
              <CalendarClock className="size-3.5" aria-hidden />
              {row.bucket === "OVERDUE" ? "Overdue · " : ""}
              {formatFollowUpDue(new Date(row.dueAt), now)}
            </span>
            {priorityColor ? (
              <Badge color={priorityColor}>
                <Flag className="size-3" aria-hidden />
                {CONVERSATION_PRIORITY_LABEL[row.priority]}
              </Badge>
            ) : null}
            {row.status === "DONE" ? <Badge color="green">Done</Badge> : row.status === "DISCARDED" ? <Badge color="gray">Discarded</Badge> : null}
          </p>
        </div>
        {canChange ? (
          <div className="flex shrink-0 flex-wrap gap-1.5">
            {open ? (
              <>
                <Button size="sm" onClick={() => act("DONE")} disabled={pending}>
                  <Check className="size-3.5" aria-hidden />
                  Done
                </Button>
                <Button size="sm" variant="secondary" onClick={onEdit} disabled={pending} aria-label={`Edit ${row.title}`}>
                  <Pencil className="size-3.5" aria-hidden />
                  <span className="max-sm:sr-only">Edit</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => act("DISCARD")} disabled={pending} aria-label={`Discard ${row.title}`}>
                  <X className="size-3.5" aria-hidden />
                  <span className="max-sm:sr-only">Discard</span>
                </Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => act("REOPEN")} disabled={pending}>
                <RotateCcw className="size-3.5" aria-hidden />
                Reopen
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {row.note ? <p className="mt-2 whitespace-pre-wrap break-words text-[13px] text-[color:var(--color-muted-foreground)]">{row.note}</p> : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-[color:var(--color-muted-foreground)]">
        <span className="inline-flex items-center gap-1">
          <UserRound className="size-3.5" aria-hidden />
          {row.assignedUserName ?? "Nobody yet"}
        </span>
        {row.assignedTeamName ? (
          <span className="inline-flex items-center gap-1">
            <Users className="size-3.5" aria-hidden />
            {row.assignedTeamName}
          </span>
        ) : null}
        {row.conversation ? (
          <Link href={row.conversation.href} className="inline-flex min-w-0 items-center gap-1 text-[color:var(--color-accent)] hover:underline">
            <MessageCircle className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Open conversation · {row.conversation.label}</span>
          </Link>
        ) : null}
        {row.client ? (
          <Link href={`/clients/${row.client.id}`} className="inline-flex min-w-0 items-center gap-1 text-[color:var(--color-accent)] hover:underline">
            <Contact className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {row.client.name} · {row.client.code}
            </span>
          </Link>
        ) : null}
        <button type="button" onClick={toggleHistory} className="inline-flex items-center gap-1 hover:text-[color:var(--color-foreground)]" aria-expanded={history !== null}>
          <History className="size-3.5" aria-hidden />
          History
        </button>
      </div>
      {row.completedAt && row.completedByName ? (
        <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">
          {row.status === "DONE" ? "Done" : "Discarded"} by {row.completedByName} · {formatFollowUpDue(new Date(row.completedAt), now)}
        </p>
      ) : null}
      {history ? (
        <ol className="mt-3 flex flex-col gap-1 border-t border-[var(--color-border)] pt-2.5 text-xs text-[color:var(--color-muted-foreground)]">
          {history.map((h) => (
            <li key={h.id}>
              <span className="text-[color:var(--color-foreground)]">{h.actorName ?? "Someone"}</span> {describe(h, now)} ·{" "}
              {formatFollowUpDue(new Date(h.at), now)}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function describe(h: FollowUpHistoryEntry, now: Date): string {
  switch (h.kind) {
    case "CREATED":
      return "created it";
    case "RESCHEDULED":
      return `moved it from ${h.from ? formatFollowUpDue(new Date(h.from), now) : "?"} to ${h.to ? formatFollowUpDue(new Date(h.to), now) : "?"}`;
    case "REASSIGNED":
      return `gave it to ${h.to} (was ${h.from})`;
    case "EDITED":
      return "edited it";
    case "DONE":
      return "marked it done";
    case "DISCARDED":
      return "discarded it";
    case "REOPENED":
      return "reopened it";
    default:
      return h.kind.toLowerCase();
  }
}
