"use client";

import { CheckCircle2, Phone, RefreshCw, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";
import { Badge, Button, Card, Checkbox, ProgressBar, SwitchField, useToast } from "@/components/ui";
import { matchMembersNow, mergeTeamMembers, setNumberOperators, setTeamAutomation } from "@/server/actions/teamAutomation";

export interface NumberOperatorRow {
  accountId: string;
  label: string;
  phoneNumber: string | null;
  operatorIds: string[];
}

/**
 * The top of Team Members: how many people the system can tell apart, kept up to date by itself, and the one thing
 * only a person can say: who answers from our own number on their phone.
 */
export function TeamAutomationCard({
  matched,
  total,
  unmatched,
  autoLink,
  canManage,
  numbers,
  members,
  duplicates,
}: {
  duplicates: Array<{ name: string; keepId: string; otherId: string }>;
  matched: number;
  total: number;
  unmatched: string[];
  autoLink: boolean;
  canManage: boolean;
  numbers: NumberOperatorRow[];
  members: Array<{ id: string; name: string }>;
}) {
  const { showToast } = useToast();
  const [pending, start] = useTransition();
  const allDone = total > 0 && matched === total;

  const matchNow = () =>
    start(async () => {
      const result = await matchMembersNow();
      showToast(result.error ? { tone: "danger", title: result.error } : { tone: "success", title: result.message ?? "Done" });
    });

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-[color:var(--color-foreground)]">
            {allDone ? <CheckCircle2 className="size-4 text-[color:var(--color-success)]" aria-hidden /> : <Sparkles className="size-4 text-[color:var(--color-accent)]" aria-hidden />}
            {matched} of {total} team members matched to their WhatsApp messages
          </div>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            WhatsApp often shows people in groups by a private ID rather than their number. Matching connects the two, so everything a
            person has already done appears in every report, however late they were added.
          </p>
          <div className="mt-3 max-w-md">
            <ProgressBar value={total ? Math.round((matched / total) * 100) : 0} />
          </div>
          {unmatched.length > 0 ? (
            <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
              Still looking for: {unmatched.slice(0, 8).join(", ")}
              {unmatched.length > 8 ? ` and ${unmatched.length - 8} more` : ""}. If their WhatsApp name differs from the name here, link them from the Identity check below.
            </p>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex shrink-0 flex-col items-end gap-3">
            <Button variant="secondary" size="sm" onClick={matchNow} loading={pending}>
              <RefreshCw className="size-3.5" aria-hidden />
              Match now
            </Button>
            <SwitchField
              label="Match automatically"
              defaultChecked={autoLink}
              onChange={(event) => {
                const on = event.currentTarget.checked;
                start(async () => {
                  await setTeamAutomation("autoLinkMembers", on);
                });
              }}
            />
          </div>
        ) : null}
      </div>

      {duplicates.length > 0 ? (
        <div className="mt-5 border-t border-[var(--color-border)] pt-4">
          <div className="text-[13px] font-semibold text-[color:var(--color-foreground)]">On the list twice?</div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
            Their work is split between two rows. Merging puts it all on one, and deletes nothing.
          </p>
          <ul className="mt-2 space-y-1.5">
            {duplicates.map((d) => (
              <li key={d.otherId} className="flex flex-wrap items-center gap-3 text-[13px]">
                <span className="font-medium text-[color:var(--color-foreground)]">{d.name}</span>
                {canManage ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={pending}
                    onClick={() =>
                      start(async () => {
                        const result = await mergeTeamMembers(d.keepId, d.otherId);
                        showToast(result.error ? { tone: "danger", title: result.error } : { tone: "success", title: result.message ?? "Merged" });
                      })
                    }
                  >
                    Merge
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {numbers.length > 0 ? (
        <div className="mt-5 border-t border-[var(--color-border)] pt-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[color:var(--color-foreground)]">
            <Phone className="size-3.5" aria-hidden />
            Who answers from our number on their phone?
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
            WhatsApp shows those replies as the number itself, so only you can say who typed them. One person gets every such reply. If
            several share a number, the roster decides by who was on duty.
          </p>
          <div className="mt-3 space-y-2">
            {numbers.map((number) => (
              <NumberOperators key={number.accountId} number={number} members={members} canManage={canManage} />
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function NumberOperators({ number, members, canManage }: { number: NumberOperatorRow; members: Array<{ id: string; name: string }>; canManage: boolean }) {
  const { showToast } = useToast();
  const [chosen, setChosen] = useState(new Set(number.operatorIds));
  const [pending, start] = useTransition();
  const names = members.filter((m) => number.operatorIds.includes(m.id)).map((m) => m.name);
  const changed = chosen.size !== number.operatorIds.length || number.operatorIds.some((id) => !chosen.has(id));

  return (
    <details className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium text-[color:var(--color-foreground)]">{number.label}</span>
        {number.phoneNumber ? <span className="text-xs text-[color:var(--color-muted-foreground)]">{number.phoneNumber}</span> : null}
        {names.length ? <Badge color="green">{names.join(", ")}</Badge> : <Badge color="gray">Nobody yet</Badge>}
      </summary>
      <div className="mt-3 grid max-h-56 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
        {members.map((member) => (
          <label key={member.id} className="flex items-center gap-2 text-[13px]">
            <Checkbox
              checked={chosen.has(member.id)}
              disabled={!canManage}
              onChange={(event) => {
                const next = new Set(chosen);
                if (event.currentTarget.checked) next.add(member.id);
                else next.delete(member.id);
                setChosen(next);
              }}
            />
            <span className="truncate">{member.name}</span>
          </label>
        ))}
      </div>
      {canManage ? (
        <div className="mt-3">
          <Button
            size="sm"
            disabled={!changed}
            loading={pending}
            onClick={() =>
              start(async () => {
                const result = await setNumberOperators(number.accountId, [...chosen]);
                if (result.error) showToast({ tone: "danger", title: result.error });
                else if (result.message) showToast({ tone: "success", title: result.message });
              })
            }
          >
            Save
          </Button>
        </div>
      ) : null}
    </details>
  );
}
