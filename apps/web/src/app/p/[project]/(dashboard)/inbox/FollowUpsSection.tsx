"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlarmClock, CalendarClock, Check } from "lucide-react";
import {
  FOLLOW_UP_PRESET_LABEL,
  FOLLOW_UP_PRESETS,
  MAX_FOLLOW_UP_TITLE,
  formatFollowUpDue,
  type FollowUpBucket,
  type FollowUpPreset,
} from "@support-automation/shared";
import { Button, Input, useToast } from "@/components/ui";
import Link from "@/components/ProjectLink";
import type { WorkspaceData } from "@/server/inboxWorkspace";
import { createFollowUp, setFollowUpStatus } from "@/server/actions/followUps";

const TONE: Record<FollowUpBucket, string> = {
  OVERDUE: "text-[color:var(--color-danger-fg)]",
  DUE_TODAY: "text-[color:var(--color-warning-fg)]",
  UPCOMING: "text-[color:var(--color-muted-foreground)]",
  DONE: "text-[color:var(--color-muted-foreground)]",
  DISCARDED: "text-[color:var(--color-muted-foreground)]",
};

/**
 * The side panel's Follow-ups tab (FOLLOW_UPS.md): this conversation's open follow-ups and a quick add —
 * a title and when (in 1 hour, tomorrow 10:00, or a date and time). A quick add is given to the person
 * adding it; the Follow-ups page changes the person, Team, priority and note. Nothing is sent to the
 * customer, and a follow-up stays when the conversation is resolved.
 */
export function FollowUpsSection({ data }: { data: WorkspaceData }) {
  const { showToast } = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [preset, setPreset] = useState<FollowUpPreset | "CUSTOM">("IN_1_HOUR");
  const [custom, setCustom] = useState("");
  const [closed, setClosed] = useState<string[]>([]);
  const items = useMemo(() => (data.followUps ?? []).filter((f) => !closed.includes(f.id)), [data.followUps, closed]);
  const now = new Date();

  const add = () => {
    const text = title.trim();
    if (!text || pending) return;
    start(async () => {
      const r = await createFollowUp({ title: text, due: preset === "CUSTOM" ? custom : preset, assignedUserId: data.viewerId, conversation: data.ref });
      if ("error" in r) {
        showToast({ tone: "danger", title: r.error });
        return;
      }
      setTitle("");
      showToast({ tone: "success", title: "Follow-up added" });
      router.refresh();
    });
  };

  const done = (id: string) =>
    start(async () => {
      const r = await setFollowUpStatus(id, "DONE");
      if ("error" in r) showToast({ tone: "danger", title: r.error });
      else {
        setClosed((c) => [...c, id]);
        router.refresh();
      }
    });

  return (
    <div className="flex flex-col gap-4 p-4">
      <ol className="flex flex-col gap-2">
        {items.length === 0 ? (
          <li className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] p-4 text-center text-[12.5px] text-[color:var(--color-muted-foreground)]">
            <AlarmClock className="mx-auto mb-1.5 size-5 opacity-60" aria-hidden />
            No open follow-ups for this conversation. Add a call-back or a promised reply — it is never sent to the customer.
          </li>
        ) : null}
        {items.map((f) => (
          <li key={f.id} className="flex items-start gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="break-words text-[13px] font-medium">{f.title}</p>
              <p className={`mt-0.5 flex items-center gap-1 text-[11.5px] ${TONE[f.bucket]}`}>
                <CalendarClock className="size-3" aria-hidden />
                <span suppressHydrationWarning>
                  {f.bucket === "OVERDUE" ? "Overdue · " : ""}
                  {formatFollowUpDue(new Date(f.dueAt), now)}
                </span>
                {f.assigneeName || f.teamName ? <span className="truncate text-[color:var(--color-muted-foreground)]">· {[f.assigneeName, f.teamName].filter(Boolean).join(", ")}</span> : null}
              </p>
            </div>
            {data.access.canWrite ? (
              <button
                type="button"
                onClick={() => done(f.id)}
                disabled={pending}
                aria-label={`Mark "${f.title}" done`}
                title="Mark done"
                className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] ring-1 ring-inset ring-[var(--color-border)] hover:bg-[var(--color-success-bg)] hover:text-[color:var(--color-success-fg)]"
              >
                <Check className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </li>
        ))}
      </ol>

      {data.access.canWrite ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          className="flex flex-col gap-2 rounded-[var(--radius-lg)] bg-[var(--color-surface-sunken)] p-3"
        >
          <label htmlFor="follow-up-title" className="text-[12px] font-medium">
            Add follow-up
          </label>
          <Input id="follow-up-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MAX_FOLLOW_UP_TITLE} placeholder="Call back with the technician's time" />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="When">
            {[...FOLLOW_UP_PRESETS, "CUSTOM" as const].map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={preset === p}
                onClick={() => setPreset(p)}
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset ${
                  preset === p
                    ? "bg-[var(--color-primary)] text-[var(--color-on-primary)] ring-transparent"
                    : "bg-[var(--color-surface)] ring-[var(--color-border-strong)] hover:bg-[var(--color-neutral-bg)]"
                }`}
              >
                {p === "CUSTOM" ? "Custom" : FOLLOW_UP_PRESET_LABEL[p]}
              </button>
            ))}
          </div>
          {preset === "CUSTOM" ? <Input type="datetime-local" aria-label="Due date and time (Dhaka)" value={custom} onChange={(e) => setCustom(e.target.value)} required /> : null}
          <Button type="submit" size="sm" loading={pending} disabled={!title.trim() || (preset === "CUSTOM" && !custom)}>
            Add — assigned to me
          </Button>
        </form>
      ) : (
        <p className="text-[12px] text-[color:var(--color-muted-foreground)]">Your role can read this conversation but not add follow-ups to it.</p>
      )}
      <Link href="/follow-ups" className="text-[12.5px] font-medium text-[color:var(--color-accent)] hover:underline">
        All my follow-ups →
      </Link>
    </div>
  );
}
