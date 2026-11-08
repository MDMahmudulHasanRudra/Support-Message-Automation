"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Button, useToast } from "@/components/ui";
import { formatTicketNumber } from "@support-automation/shared";
import type { TicketSummary } from "@/server/tickets";
import { NewTicketDialog, type TicketFormOptions } from "./NewTicketDialog";
import { TicketSummaryList } from "./TicketSummaryList";

/** A client profile's tickets and a "New ticket" button; the ticket is linked to this client. */
export function ClientTickets({ clientId, items, canCreate, options }: { clientId: string; items: TicketSummary[]; canCreate: boolean; options: TicketFormOptions }) {
  const [open, setOpen] = useState(false);
  const router = useProjectRouter();
  const { showToast } = useToast();
  return (
    <div className="space-y-3">
      {items.length ? <TicketSummaryList items={items} /> : <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No tickets for this client yet.</p>}
      {canCreate ? (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <Plus className="size-3.5" aria-hidden />
          New ticket
        </Button>
      ) : null}
      <NewTicketDialog
        open={open}
        onClose={() => setOpen(false)}
        options={options}
        clientId={clientId}
        onCreated={(t) => {
          setOpen(false);
          showToast({ tone: "success", title: `${formatTicketNumber(t.number)} created` });
          router.refresh();
        }}
      />
    </div>
  );
}
