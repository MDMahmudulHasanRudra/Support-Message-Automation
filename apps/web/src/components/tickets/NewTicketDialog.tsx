"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CONVERSATION_PRIORITY_LABEL, MAX_TICKET_SUBJECT, type ConversationRef } from "@support-automation/shared";
import { Alert, Button, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { createTicket } from "@/server/actions/tickets";

export interface TicketFormOptions {
  people: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  categories: string[];
  viewerId: string;
}

const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

/**
 * The one form that opens a ticket, from the Tickets page, a conversation or a client. Only the subject is needed: the
 * ticket goes to the person opening it and gets the due time of its priority unless they say otherwise.
 */
export function NewTicketDialog({
  open,
  onClose,
  options,
  conversation,
  clientId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  options: TicketFormOptions;
  conversation?: ConversationRef;
  clientId?: string;
  onCreated: (ticket: { id: string; number: number }) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const subject = useRef<HTMLInputElement>(null);

  // A modal focuses its first control, which is the close button: pressing Enter after typing would shut the form.
  useEffect(() => {
    if (open) subject.current?.focus();
  }, [open]);

  const submit = (form: FormData) =>
    startTransition(async () => {
      const result = await createTicket({
        subject: form.get("subject"),
        description: form.get("description"),
        priority: form.get("priority"),
        category: form.get("category"),
        due: form.get("due"),
        assignedUserId: form.get("assignedUserId"),
        assignedTeamId: form.get("assignedTeamId"),
        conversation,
        clientId,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setError(null);
      onCreated(result);
    });

  return (
    <Dialog open={open} onClose={onClose} title="New ticket" description="Internal. The customer sees nothing unless you tell them.">
      <form action={submit} className="space-y-3.5">
        <Field label="What is the problem?">
          <Input ref={subject} name="subject" required maxLength={MAX_TICKET_SUBJECT} placeholder="For example: internet down since this morning" />
        </Field>
        <Field label="Details (optional)">
          <Textarea name="description" rows={3} maxLength={4000} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select name="priority" defaultValue="NORMAL">
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {CONVERSATION_PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category">
            <Select name="category" defaultValue="">
              <option value="">None</option>
              {options.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Person">
            <Select name="assignedUserId" defaultValue={options.viewerId}>
              <option value="">Nobody yet</option>
              {options.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Team">
            <Select name="assignedTeamId" defaultValue="">
              <option value="">No Team</option>
              {options.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Due (optional)" hint="Leave empty to use the target for this priority.">
          <Input name="due" type="datetime-local" />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create ticket"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
