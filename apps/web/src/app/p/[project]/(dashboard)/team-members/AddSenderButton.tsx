"use client";

import { useActionState, useState } from "react";
import { Button, Input } from "@/components/ui";
import { addTeamMemberFromSender, type AddSenderState } from "@/server/actions/teamMembers";

/**
 * "Add to team" beside a sender the Identity check found: one step from "probably a colleague" to
 * "on the roster, with their earlier history collected into every report".
 */
export function AddSenderButton({ senderId, suggestedName }: { senderId: string; suggestedName: string | null }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<AddSenderState, FormData>(addTeamMemberFromSender.bind(null, senderId), {});
  if (state.added) return <span className="text-[12px] text-[color:var(--color-success-fg)]">Added — collecting their history</span>;
  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Add to team
      </Button>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5">
      <Input name="name" defaultValue={suggestedName ?? ""} placeholder="Their name" aria-label="Name" className="w-36" required />
      <Input name="role" defaultValue="Support" aria-label="Designation" className="w-28" />
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add"}
      </Button>
      {state.error ? <span className="text-[12px] text-[color:var(--color-danger-fg)]">{state.error}</span> : null}
    </form>
  );
}
