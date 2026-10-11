"use client";

import { useActionState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, RefreshCw } from "lucide-react";
import { Button, Select } from "@/components/ui";
import { linkWhatsAppSender, requestGroupParticipants, type LinkSenderState } from "@/server/actions/teamMembers";

/**
 * "This sender is <team member>" — the human verification the identity rule cannot make by itself
 * (WHATSAPP_IDENTITY.md §4). Only members with no WhatsApp ID yet are offered; replacing one is an
 * edit on their own page.
 */
export function LinkSenderForm({ senderId, members }: { senderId: string; members: Array<{ id: string; name: string; designation: string }> }) {
  const [state, action, pending] = useActionState<LinkSenderState, FormData>(linkWhatsAppSender.bind(null, senderId), {});
  if (state.linked) {
    return (
      <p className="rounded-[var(--radius-md)] bg-[var(--color-success-bg)] px-3 py-2 text-[12px] text-[color:var(--color-success-fg)]">
        Linked to {state.linked}. Their messages are recognised as theirs from now on, in every report.
      </p>
    );
  }
  return (
    <form action={action} className="space-y-2">
      <label htmlFor="link-member" className="block text-[12px] font-medium text-[color:var(--color-foreground)]">
        This person is…
      </label>
      <div className="flex gap-2">
        <Select id="link-member" name="memberId" defaultValue="" required className="min-w-0 flex-1">
          <option value="" disabled>
            Choose a team member
          </option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} — {m.designation}
            </option>
          ))}
        </Select>
        <Button type="submit" size="sm" variant="secondary" loading={pending}>
          <Link2 className="size-3.5" aria-hidden />
          Link
        </Button>
      </div>
      {state.error ? <p className="text-[12px] text-[color:var(--color-danger-fg)]">{state.error}</p> : null}
    </form>
  );
}

/** Asks the worker for the group's current member list; the panel shows it when it arrives. */
export function ReadMembersButton({ groupId, label }: { groupId: string; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={() =>
        start(async () => {
          await requestGroupParticipants(groupId);
          router.refresh();
        })
      }
    >
      <RefreshCw className="size-3.5" aria-hidden />
      {label}
    </Button>
  );
}
