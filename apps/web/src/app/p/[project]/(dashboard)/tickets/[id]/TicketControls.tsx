"use client";

import { useState, useTransition } from "react";
import { CONVERSATION_PRIORITY_LABEL, MAX_TICKET_SUBJECT, type TicketStatusValue } from "@support-automation/shared";
import { useProjectRouter } from "@/components/ProjectLink";
import { Button, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { addTicketNote, setTicketStatus, updateTicket, type TicketEditInput } from "@/server/actions/tickets";

const NEXT_STEPS: Record<TicketStatusValue, Array<{ to: TicketStatusValue; label: string; primary?: boolean }>> = {
  OPEN: [
    { to: "WAITING_CUSTOMER", label: "Wait on customer" },
    { to: "IN_PROGRESS", label: "Start working" },
    { to: "RESOLVED", label: "Resolve", primary: true },
  ],
  IN_PROGRESS: [
    { to: "WAITING_CUSTOMER", label: "Wait on customer" },
    { to: "RESOLVED", label: "Resolve", primary: true },
  ],
  WAITING_CUSTOMER: [
    { to: "IN_PROGRESS", label: "Customer answered" },
    { to: "RESOLVED", label: "Resolve", primary: true },
  ],
  RESOLVED: [
    { to: "OPEN", label: "Reopen" },
    { to: "CLOSED", label: "Close", primary: true },
  ],
  CLOSED: [{ to: "OPEN", label: "Reopen" }],
};

function useTicketAction() {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [pending, start] = useTransition();
  const run = (action: () => Promise<{ ok: true } | { error: string }>, after?: () => void) =>
    start(async () => {
      const result = await action();
      if ("error" in result) {
        showToast({ tone: "danger", title: result.error });
        // Whatever it was refused for, what is on screen should be what is true.
        router.refresh();
        return;
      }
      after?.();
      router.refresh();
    });
  return { pending, run };
}

export function TicketStatusActions({ id, status }: { id: string; status: TicketStatusValue }) {
  const { pending, run } = useTicketAction();
  return (
    <div className="flex flex-wrap gap-2">
      {NEXT_STEPS[status].map((step) => (
        <Button key={step.to} variant={step.primary ? "primary" : "secondary"} disabled={pending} onClick={() => run(() => setTicketStatus(id, step.to))}>
          {step.label}
        </Button>
      ))}
    </div>
  );
}

export function TicketDescription({ id, updatedAt, subject, description, canEdit }: { id: string; updatedAt: string; subject: string; description: string | null; canEdit: boolean }) {
  const { pending, run } = useTicketAction();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <form
        action={(form) =>
          run(
            () => updateTicket(id, updatedAt, { subject: form.get("subject"), description: form.get("description") }),
            () => setEditing(false),
          )
        }
        className="space-y-3"
      >
        <Field label="Subject">
          <Input name="subject" required maxLength={MAX_TICKET_SUBJECT} defaultValue={subject} />
        </Field>
        <Field label="Details">
          <Textarea name="description" rows={4} maxLength={4000} defaultValue={description ?? ""} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            Save
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3">
      {description ? (
        <p className="min-w-0 whitespace-pre-wrap text-[14px] leading-relaxed [overflow-wrap:anywhere]" dir="auto">
          {description}
        </p>
      ) : (
        <p className="text-[14px] text-[color:var(--color-muted-foreground)]">No details written.</p>
      )}
      {canEdit ? (
        <button type="button" onClick={() => setEditing(true)} className="link shrink-0 text-[13px] font-medium">
          Edit
        </button>
      ) : null}
    </div>
  );
}

export function TicketNoteForm({ id }: { id: string }) {
  const { pending, run } = useTicketAction();
  const [body, setBody] = useState("");
  return (
    <div className="mt-3">
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={4000} dir="auto" placeholder="Add a note for your team" aria-label="Add a note for your team" />
      <div className="mt-2 flex justify-end">
        <Button variant="secondary" size="sm" disabled={pending || !body.trim()} onClick={() => run(() => addTicketNote(id, body), () => setBody(""))}>
          {pending ? "Saving…" : "Add note"}
        </Button>
      </div>
    </div>
  );
}

const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

export function TicketProperties({
  id,
  updatedAt,
  canEdit,
  values,
  people,
  teams,
  categories,
}: {
  id: string;
  updatedAt: string;
  canEdit: boolean;
  values: { assignedUserId: string; assignedTeamId: string; priority: string; category: string; due: string };
  people: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  categories: string[];
}) {
  const { pending, run } = useTicketAction();
  const save = (patch: TicketEditInput) => run(() => updateTicket(id, updatedAt, patch));
  const disabled = !canEdit || pending;
  // Keyed on the row's version: after any change the fields show what the server holds.
  return (
    <div key={updatedAt} className="space-y-3">
      <Field label="Person">
        <Select defaultValue={values.assignedUserId} disabled={disabled} onChange={(e) => save({ assignedUserId: e.target.value })}>
          <option value="">Nobody yet</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Team">
        <Select defaultValue={values.assignedTeamId} disabled={disabled} onChange={(e) => save({ assignedTeamId: e.target.value })}>
          <option value="">No Team</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Priority">
        <Select defaultValue={values.priority} disabled={disabled} onChange={(e) => save({ priority: e.target.value })}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {CONVERSATION_PRIORITY_LABEL[p]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Category">
        <Select defaultValue={values.category} disabled={disabled} onChange={(e) => save({ category: e.target.value })}>
          <option value="">None</option>
          {/* A category since removed from the list stays visible on the tickets that have it. */}
          {values.category && !categories.includes(values.category) ? <option value={values.category}>{values.category}</option> : null}
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Due">
        <Input
          type="datetime-local"
          defaultValue={values.due}
          disabled={disabled}
          onBlur={(e) => {
            if (e.target.value !== values.due) save({ due: e.target.value });
          }}
        />
      </Field>
    </div>
  );
}
