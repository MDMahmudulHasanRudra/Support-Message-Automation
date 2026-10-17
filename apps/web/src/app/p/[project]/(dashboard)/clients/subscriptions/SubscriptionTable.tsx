"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Badge, Button } from "@/components/ui";
import type { ClientListRow, RosterMember } from "@/server/clients";
import { clientDisplayName, describeDuration, SUBSCRIPTION_KIND_LABELS, SUBSCRIPTION_STATE_LABELS, type SubscriptionKind } from "@support-automation/shared";
import { expiryTextClass, formatDay, SUBSCRIPTION_TONE } from "@/lib/clientDisplay";
import { ClientAvatar } from "../ClientAvatar";
import { RenewDialog } from "../Client360Panels";

const muted = "text-[color:var(--color-muted-foreground)]";

/** The current term of each client in the view, soonest expiry first, with a one-click Renew. */
export function SubscriptionTable({
  rows,
  roster,
  today,
  currencies,
  canRenew,
  canInvoice,
}: {
  rows: ClientListRow[];
  roster: RosterMember[];
  today: string;
  currencies: string[];
  canRenew: boolean;
  canInvoice: boolean;
}) {
  const [renewing, setRenewing] = useState<ClientListRow | null>(null);
  const th = "whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]";
  const td = "border-b border-[var(--color-border)] px-4 py-3 align-middle text-[13px]";
  return (
    <>
      <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th className={th}>Client</th>
              <th className={th}>Service / plan</th>
              <th className={`${th} hidden sm:table-cell`}>Started</th>
              <th className={th}>Expires</th>
              <th className={th}>State</th>
              <th className={`${th} hidden md:table-cell`}>Sold by</th>
              <th className={`${th} hidden lg:table-cell`}>Renewals</th>
              <th className={th}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const s = c.subscription!;
              return (
                <tr key={c.id} className="hover:bg-[var(--color-surface-sunken)]">
                  <td className={td}>
                    <div className="flex items-center gap-2.5">
                      <ClientAvatar id={c.id} code={c.code} name={c.name} companyName={c.companyName} photoVersion={c.photoVersion} size="sm" />
                      <div className="min-w-0">
                        <Link href={`/clients/${c.id}#subscriptions`} className="block truncate font-medium hover:underline">
                          {clientDisplayName(c.name, c.companyName)}
                        </Link>
                        <div className={`text-xs ${muted}`}>{c.code}</div>
                      </div>
                    </div>
                  </td>
                  <td className={td}>
                    <div className="font-medium">{s.service}</div>
                    <div className={`text-xs ${muted}`}>
                      {SUBSCRIPTION_KIND_LABELS[s.kind as SubscriptionKind] ?? s.kind} · {describeDuration(s.durationValue, s.durationUnit)}
                    </div>
                  </td>
                  <td className={`${td} hidden whitespace-nowrap sm:table-cell`}>{formatDay(s.startDate)}</td>
                  <td className={td}>
                    <div className={`whitespace-nowrap font-medium ${expiryTextClass(s.state)}`}>{formatDay(s.endDate)}</div>
                    <div className={`text-xs ${muted}`}>{s.expiryText}</div>
                  </td>
                  <td className={td}>
                    <Badge color={SUBSCRIPTION_TONE[s.state]}>{SUBSCRIPTION_STATE_LABELS[s.state]}</Badge>
                  </td>
                  <td className={`${td} hidden md:table-cell`}>{c.soldBy?.name ?? <span className={muted}>—</span>}</td>
                  <td className={`${td} hidden lg:table-cell`}>{Math.max(0, c.subscriptionCount - 1)}</td>
                  <td className={`${td} text-right`}>
                    {canRenew && s.state !== "PAUSED" ? (
                      <Button size="sm" variant="secondary" onClick={() => setRenewing(c)}>
                        <RefreshCw className="size-3.5" aria-hidden /> Renew
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {renewing?.subscription ? (
        <RenewDialog
          term={{ id: renewing.subscription.id, service: renewing.subscription.service, kind: renewing.subscription.kind, endDate: renewing.subscription.endDate, durationValue: renewing.subscription.durationValue, durationUnit: renewing.subscription.durationUnit, soldByMemberId: renewing.soldBy?.id ?? null }}
          roster={roster}
          today={today}
          currencies={currencies}
          preferredCurrency={renewing.preferredCurrency}
          canInvoice={canInvoice}
          onClose={() => setRenewing(null)}
        />
      ) : null}
    </>
  );
}
