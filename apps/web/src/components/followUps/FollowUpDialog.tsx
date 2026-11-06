"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CONVERSATION_PRIORITIES,
  CONVERSATION_PRIORITY_LABEL,
  FOLLOW_UP_PRESET_LABEL,
  FOLLOW_UP_PRESETS,
  MAX_FOLLOW_UP_NOTE,
  MAX_FOLLOW_UP_TITLE,
  formatDhakaDateTimeInput,
  type ConversationPriorityValue,
  type ConversationRef,
  type FollowUpPreset,
} from "@support-automation/shared";
import { Button, Dialog, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { createFollowUp, updateFollowUp } from "@/server/actions/followUps";

export interface FollowUpFormInitial {
  id: string;
  title: string;
  note: string | null;
  dueAt: string;
  priority: ConversationPriorityValue;
  assignedUserId: string | null;
  assignedTeamId: string | null;
}

/**
 * Create or edit one follow-up (FOLLOW_UPS.md). A new one may carry the conversation and/or client it is
 * about; an edit changes only what, when, who and how urgent. Due time: "In 1 hour", "Tomorrow 10:00" or a
 * date and time read as Dhaka wall clock. Nothing here sends anything to a customer.
 */
export function FollowUpDialog({
  open,
  onClose,
  initial,
  people,
  teams,
  viewerId,
  conversation,
  clientId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initial?: FollowUpFormInitial | null;
  people: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  viewerId: string;
  conversation?: ConversationRef | null;
  clientId?: string | null;
  onSaved?: () => void;
}) {
  const editing = Boolean(initial);
  const { showToast } = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [duePreset, setDuePreset] = useState<FollowUpPreset | "CUSTOM">(editing ? "CUSTOM" : "TOMORROW_10");

  const submit = (form: FormData) => {
    const due = duePreset === "CUSTOM" ? String(form.get("dueCustom") ?? "") : duePreset;
    const input = {
      title: form.get("title"),
      note: form.get("note"),
      due,
      priority: form.get("priority"),
      assignedUserId: form.get("assignedUserId"),
      assignedTeamId: form.get("assignedTeamId"),
    };
    start(async () => {
      const result = initial ? await updateFollowUp(initial.id, input) : await createFollowUp({ ...input, conversation: conversation ?? null, clientId: clientId ?? null });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setError(null);
      showToast({ tone: "success", title: initial ? "Follow-up saved" : "Follow-up added" });
      onSaved?.();
      onClose();
      router.refresh();
    });
  };

  // Keyed on the follow-up so reopening the dialog for another one starts from its own values.
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? "Edit follow-up" : "New follow-up"}
      description="Internal only — nothing is sent to the customer."
    >
      <form key={initial?.id ?? "new"} action={submit} className="flex flex-col gap-4">
        <Field label="What needs to be done" required>
          <Input name="title" required maxLength={MAX_FOLLOW_UP_TITLE} defaultValue={initial?.title ?? ""} placeholder="Call back about the router" autoFocus />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[13px] font-medium">Due</legend>
          <div className="flex flex-wrap gap-1.5">
            {[...FOLLOW_UP_PRESETS, "CUSTOM" as const].map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={duePreset === p}
                onClick={() => setDuePreset(p)}
                className={`rounded-full px-3 py-1.5 text-[12.5px] font-medium ring-1 ring-inset ${
                  duePreset === p
                    ? "bg-[var(--color-primary)] text-[var(--color-on-primary)] ring-transparent"
                    : "bg-[var(--color-surface)] text-[color:var(--color-foreground)] ring-[var(--color-border-strong)] hover:bg-[var(--color-neutral-bg)]"
                }`}
              >
                {p === "CUSTOM" ? (editing ? "Date and time" : "Custom") : FOLLOW_UP_PRESET_LABEL[p]}
              </button>
            ))}
          </div>
          {duePreset === "CUSTOM" ? (
            <Input
              type="datetime-local"
              name="dueCustom"
              required
              aria-label="Due date and time (Dhaka)"
              defaultValue={initial ? formatDhakaDateTimeInput(new Date(initial.dueAt)) : ""}
            />
          ) : null}
          <p className="text-xs text-[color:var(--color-muted-foreground)]">Times are Dhaka time.</p>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Person">
            <Select name="assignedUserId" defaultValue={initial ? (initial.assignedUserId ?? "") : viewerId}>
              <option value="">Nobody yet</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === viewerId ? `${p.name} (me)` : p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Team">
            <Select name="assignedTeamId" defaultValue={initial?.assignedTeamId ?? ""}>
              <option value="">No Team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Priority">
          <Select name="priority" defaultValue={initial?.priority ?? "NONE"}>
            {CONVERSATION_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {CONVERSATION_PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note" hint="Optional. Internal — the customer never sees it.">
          <Textarea name="note" maxLength={MAX_FOLLOW_UP_NOTE} defaultValue={initial?.note ?? ""} rows={3} />
        </Field>
        {error ? (
          <p role="alert" className="text-[13px] text-[color:var(--color-danger-fg)]">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {editing ? "Save" : "Add follow-up"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
