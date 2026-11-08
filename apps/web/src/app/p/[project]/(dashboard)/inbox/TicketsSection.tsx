"use client";

import { useState } from "react";
import { Plus, Reply } from "lucide-react";
import { formatTicketNumber, ticketReferenceText } from "@support-automation/shared";
import { Button, useToast } from "@/components/ui";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import { fillComposer } from "@/lib/composerBridge";
import { NewTicketDialog } from "@/components/tickets/NewTicketDialog";
import { TicketSummaryList } from "@/components/tickets/TicketSummaryList";
import type { WorkspaceData } from "@/server/inboxWorkspace";

/**
 * The side panel's Tickets tab (TICKETS.md): this conversation's tickets and a way to open one. After creating, the
 * number can be dropped into the reply box. It only fills the box: sending stays the person's own press.
 */
export function TicketsSection({ data }: { data: WorkspaceData }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ id: string; number: number } | null>(null);
  const items = data.tickets ?? [];

  return (
    <div className="flex flex-col gap-4 p-4">
      {data.access.canWrite ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <Plus className="size-4" aria-hidden />
          New ticket from this conversation
        </Button>
      ) : null}

      {created ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-3 text-[13px]">
          <p className="font-medium text-[color:var(--color-foreground)]">
            <Link href={`/tickets/${created.id}`} className="link">
              {formatTicketNumber(created.number)}
            </Link>{" "}
            created.
          </p>
          <button
            type="button"
            onClick={() => {
              fillComposer(ticketReferenceText(created.number));
              setCreated(null);
            }}
            className="link mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium"
          >
            <Reply className="size-3.5" aria-hidden />
            Put the number in my reply
          </button>
        </div>
      ) : null}

      {items.length ? <TicketSummaryList items={items} /> : <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No tickets from this conversation yet.</p>}

      {data.ticketOptions ? (
        <NewTicketDialog
          open={open}
          onClose={() => setOpen(false)}
          options={{ ...data.ticketOptions, people: data.people, viewerId: data.viewerId }}
          conversation={data.ref}
          onCreated={(t) => {
            setOpen(false);
            setCreated(t);
            showToast({ tone: "success", title: `${formatTicketNumber(t.number)} created` });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
