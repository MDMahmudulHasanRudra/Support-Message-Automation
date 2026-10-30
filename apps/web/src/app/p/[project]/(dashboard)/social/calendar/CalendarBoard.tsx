"use client";

import { useState, useTransition } from "react";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import { rescheduleSocialPostAction } from "@/server/actions/social";

export interface CalendarDay {
  key: string;
  label: string;
  inRange: boolean;
  isToday: boolean;
}

export interface CalendarItem {
  id: string;
  day: string;
  time: string;
  title: string;
  status: string;
  accounts: string;
  color: string | null;
  /** Scheduled and not started anywhere: it may be dragged to another day by someone who can publish. */
  movable: boolean;
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: "border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]",
  IN_REVIEW: "border-[var(--color-info-border)] bg-[var(--color-info-bg)]",
  APPROVED: "border-[var(--color-info-border)] bg-[var(--color-info-bg)]",
  SCHEDULED: "border-[var(--color-info-border)] bg-[var(--color-surface)]",
  PUBLISHED: "border-[var(--color-success-border)] bg-[var(--color-success-bg)]",
  PARTIAL: "border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]",
  FAILED: "border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]",
  UNKNOWN: "border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]",
  CANCELLED: "border-[var(--color-border)] bg-[var(--color-neutral-bg)] line-through",
};

/**
 * The calendar grid. Moving a post is drag-and-drop onto another day (keeping its time), or the post's
 * own Move control; both call the same action, which refuses anything that has started publishing.
 * Keyboard and touch users move a post from its page.
 */
export function CalendarBoard({ days, items, columns, canPublish, timezone, canCreate }: { days: CalendarDay[]; items: CalendarItem[]; columns: number; canPublish: boolean; timezone: string; canCreate: boolean }) {
  const router = useProjectRouter();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const byDay = new Map<string, CalendarItem[]>();
  for (const item of items) byDay.set(item.day, [...(byDay.get(item.day) ?? []), item]);

  function drop(day: string) {
    const item = items.find((i) => i.id === dragging);
    setDragging(null);
    setOver(null);
    if (!item || item.day === day) return;
    if (!window.confirm(`Move "${item.title}" to ${day} at ${item.time} (${timezone})?`)) return;
    start(async () => {
      const r = await rescheduleSocialPostAction(item.id, `${day}T${item.time}`, timezone);
      setMessage(r.error ? { tone: "error", text: r.error } : { tone: "ok", text: "Moved." });
      router.refresh();
    });
  }

  return (
    <div>
      {message ? <p className={`mb-2 text-sm ${message.tone === "error" ? "text-[color:var(--color-danger)]" : "text-[color:var(--color-success-fg)]"}`}>{message.text}</p> : null}
      <div className={`grid gap-px overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-border)] ${pending ? "opacity-70" : ""}`} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {days.map((d) => (
          <div
            key={d.key}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              setOver(d.key);
            }}
            onDragLeave={() => setOver((o) => (o === d.key ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              drop(d.key);
            }}
            className={`min-h-28 bg-[var(--color-surface)] p-1.5 ${d.inRange ? "" : "bg-[var(--color-surface-sunken)] text-[color:var(--color-subtle-foreground)]"} ${over === d.key ? "outline outline-2 -outline-offset-2 outline-[var(--color-accent)]" : ""}`}
          >
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className={d.isToday ? "rounded bg-[var(--color-primary)] px-1.5 font-semibold text-[color:var(--color-primary-foreground)]" : "font-medium"}>{d.label}</span>
              {canCreate && d.inRange ? (
                <Link href={`/social/new?date=${d.key}`} className="text-[color:var(--color-subtle-foreground)] hover:text-[color:var(--color-foreground)]" aria-label={`Create a post on ${d.key}`}>
                  +
                </Link>
              ) : null}
            </div>
            <ul className="space-y-1">
              {(byDay.get(d.key) ?? []).map((item) => (
                <li
                  key={item.id}
                  draggable={canPublish && item.movable}
                  onDragStart={() => setDragging(item.id)}
                  onDragEnd={() => setDragging(null)}
                  className={`rounded-[var(--radius-sm)] border px-1.5 py-1 text-[11px] leading-tight ${STATUS_STYLE[item.status] ?? ""} ${canPublish && item.movable ? "cursor-grab" : ""}`}
                  style={item.color ? { borderLeft: `3px solid ${item.color}` } : undefined}
                >
                  <Link href={`/social/posts/${item.id}`} className="block hover:underline">
                    <span className="tabular font-medium">{item.time}</span> {item.title}
                  </Link>
                  <span className="block truncate text-[color:var(--color-muted-foreground)]">{item.accounts}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
