"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Button } from "@/components/ui";
import { NewTicketDialog, type TicketFormOptions } from "@/components/tickets/NewTicketDialog";

export function NewTicketButton({ options }: { options: TicketFormOptions }) {
  const [open, setOpen] = useState(false);
  const router = useProjectRouter();
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        New ticket
      </Button>
      <NewTicketDialog
        open={open}
        onClose={() => setOpen(false)}
        options={options}
        onCreated={(t) => {
          setOpen(false);
          router.push(`/tickets/${t.id}`);
        }}
      />
    </>
  );
}
