"use client";

import { useActionState, useMemo, useState } from "react";
import { Link2 } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Button, Input, Select } from "@/components/ui";
import { IdentityImpactPanel } from "@/components/teamMembers/IdentityImpactPanel";
import { linkWhatsAppSender, type LinkSenderState } from "@/server/actions/teamMembers";
import type { LinkableMember, SenderSuggestion } from "@/server/rosterIdentityHealth";

/**
 * "Link to member..." beside an unknown sender in the Identity check (unified reporting WP11).
 *
 * It submits the SAME server action WhatsApp Chat's "This person is..." does (`linkWhatsAppSender`): the
 * same permission, the same refusal of a WhatsApp ID another member already holds, the same System Log
 * entry and the same re-attribution of history. Nothing here decides who anybody is. A name suggestion is
 * text with a shortcut that opens the picker with that member chosen; it never links by itself, and a link
 * is only ever written by pressing Link. "Preview impact" is read-only and says how many stored messages
 * would be credited to the chosen member before Link is pressed.
 */
export function LinkSenderToMember({
  senderId,
  members,
  suggestion,
  previewEnabled,
}: {
  senderId: string;
  members: LinkableMember[];
  suggestion: SenderSuggestion | null;
  previewEnabled: boolean;
}) {
  const [state, action, pending] = useActionState<LinkSenderState, FormData>(linkWhatsAppSender.bind(null, senderId), {});
  const suggested = suggestion?.kind === "ONE" ? suggestion.members[0]! : null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState("");

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle ? members.filter((m) => `${m.name} ${m.designation}`.toLowerCase().includes(needle)) : members;
    // The chosen member stays in the list while the search narrows, or the select would silently drop the choice.
    const picked = members.find((m) => m.id === chosen);
    return picked && !matching.includes(picked) ? [picked, ...matching] : matching;
  }, [members, query, chosen]);

  if (state.linked) {
    return (
      <p className="text-[12px] text-[color:var(--color-success-fg)]">Linked to {state.linked}. Their messages are credited to them from now on; history is being collected.</p>
    );
  }

  return (
    <div className="space-y-1.5">
      {suggestion?.kind === "SEVERAL" ? (
        <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
          Several possible members: {suggestion.members.map((m) => m.name).join(", ")}
        </p>
      ) : null}
      {suggested ? (
        suggested.linkable ? (
          <p className="text-[12px] text-[color:var(--color-foreground)]">
            Probably <strong className="font-medium">{suggested.name}</strong> —{" "}
            <button
              type="button"
              className="link cursor-pointer"
              onClick={() => {
                setChosen(suggested.id);
                setOpen(true);
              }}
            >
              Link
            </button>
          </p>
        ) : (
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
            Probably <strong className="font-medium">{suggested.name}</strong>, who already has a WhatsApp ID on file: check it on{" "}
            <Link className="link" href={`/team-members/${suggested.id}/edit`}>
              their page
            </Link>
            .
          </p>
        )
      ) : null}

      {!open ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={members.length === 0}>
          <Link2 className="size-3.5" aria-hidden />
          Link to member…
        </Button>
      ) : (
        <form action={action} className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-2.5">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search team members"
            aria-label="Search team members"
            className="text-[13px]"
          />
          <Select name="memberId" value={chosen} onChange={(event) => setChosen(event.target.value)} aria-label="Team member to link" required>
            <option value="" disabled>
              Choose a team member
            </option>
            {shown.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {m.designation}
              </option>
            ))}
          </Select>
          {shown.length === 0 ? <p className="text-[12px] text-[color:var(--color-muted-foreground)]">No team member without a WhatsApp ID matches.</p> : null}
          {previewEnabled ? <IdentityImpactPanel memberId={null} linkSenderId={senderId} /> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={pending}>
              <Link2 className="size-3.5" aria-hidden />
              Link
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {state.error ? <p className="text-[12px] text-[color:var(--color-danger-fg)]">{state.error}</p> : null}
        </form>
      )}
    </div>
  );
}
