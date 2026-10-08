"use client";

import { useActionState } from "react";
import Link from "@/components/ProjectLink";
import { Alert, Button, Card, Checkbox, SectionHeader } from "@/components/ui";
import { saveSupportResponseTeams, type SupportTeamSetupState } from "@/server/actions/supportResponse";

const initialState: SupportTeamSetupState = {};

/**
 * Which Teams are the Support Team for Messages → Unanswered Groups and Response Time
 * (SUPPORT_RESPONSE.md). Only a reply from a member of one of these Teams — at the moment they
 * replied — answers a customer there.
 */
export function SupportTeamCard({
  teams,
  selectedIds,
  canManage,
}: {
  teams: Array<{ id: string; name: string; memberCount: number }>;
  selectedIds: string[];
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState(saveSupportResponseTeams, initialState);
  return (
    <Card className="mt-5">
      <SectionHeader
        title="Support Team for response tracking"
        description="Messages → Unanswered Groups and Response Time count a customer as answered only when a member of one of these Teams replies from their own WhatsApp. Replies from other Teams, the business number, rules and AI do not count. Takes effect from the next message."
      />
      {state.error ? (
        <div className="mb-3">
          <Alert tone="danger">{state.error}</Alert>
        </div>
      ) : null}
      {state.saved && !state.error ? (
        <div className="mb-3">
          <Alert tone="success">Support Team saved.</Alert>
        </div>
      ) : null}
      {teams.length === 0 ? (
        <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
          No Teams exist yet. Create one under{" "}
          <Link href="/teams" className="underline">
            WhatsApp → Teams
          </Link>{" "}
          and add the support staff to it.
        </p>
      ) : (
        <form action={formAction}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {teams.map((team) => (
              <label key={team.id} className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-[13px]">
                <Checkbox name="teamIds" value={team.id} defaultChecked={selectedIds.includes(team.id)} disabled={!canManage} />
                <span className="font-medium">{team.name}</span>
                <span className="ml-auto text-[11px] text-[color:var(--color-muted-foreground)]">{team.memberCount} member(s)</span>
              </label>
            ))}
          </div>
          {canManage ? (
            <div className="mt-3">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save Support Team"}
              </Button>
            </div>
          ) : null}
        </form>
      )}
    </Card>
  );
}
