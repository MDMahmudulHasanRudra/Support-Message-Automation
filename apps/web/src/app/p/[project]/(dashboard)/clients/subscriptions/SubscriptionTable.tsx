"use client";

import { useState, useTransition } from "react";
import { CirclePause, CirclePlay, Eye, Phone, RefreshCw, Send, Trash2, XCircle } from "lucide-react";
import Link, { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Badge, Button, Checkbox, ConfirmDialog, useToast } from "@/components/ui";
import type { ClientListRow, RosterMember } from "@/server/clients";
import { clientDisplayName, describeDuration, SUBSCRIPTION_KIND_LABELS, SUBSCRIPTION_STATE_LABELS, type SubscriptionKind } from "@support-automation/shared";
import { formatDay, SUBSCRIPTION_TONE } from "@/lib/clientDisplay";
import { setSubscriptionPaused } from "@/server/actions/clientSubscriptions";
import { deleteSubscriptions } from "@/server/actions/clientDeletes";
import { ClientAvatar } from "../ClientAvatar";
import { RenewDialog } from "../Client360Panels";
import { daysBetween, DaysLeftBar, flag } from "../ModuleKit";
import { RowMenu } from "../RowMenu";
import { LIST_SCROLL_BOX } from "@/lib/listPageSizes";

const muted = "text-[color:var(--color-muted-foreground)]";

/**
 * The current term of each client in the view, soonest expiry first. Renew opens the renewal dialog
 * in place; Pause / Resume act at once (they are undoable); Delete — offered only to someone allowed to
 * delete — confirms first and names how many terms it removes.
 */
export function SubscriptionTable({
  rows,
  roster,
  today,
  currencies,
  canRenew,
  canInvoice,
  canDelete,
}: {
  rows: ClientListRow[];
  roster: RosterMember[];
  today: string;
  currencies: string[];
  canRenew: boolean;
  canInvoice: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [renewing, setRenewing] = useState<ClientListRow | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const [busy, start] = useTransition();
  const termIds = rows.map((r) => r.subscription!.id);
  const allOnPage = termIds.length > 0 && termIds.every((id) => selected.has(id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pause = (id: string, paused: boolean) =>
    start(async () => {
      const r = await setSubscriptionPaused(id, paused);
      showToast({ tone: r.ok ? "success" : "danger", title: r.message });
      if (r.ok) router.refresh();
    });
  const remove = () =>
    start(async () => {
      const r = await deleteSubscriptions(confirmIds ?? []);
      showToast({ tone: r.ok ? "success" : "danger", title: r.message });
      setConfirmIds(null);
      setSelected(new Set());
      if (r.ok) router.refresh();
    });

  const th = "sticky top-0 z-[2] whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]";
  const td = "border-b border-[var(--color-border)] px-4 py-3 align-middle text-[13px]";
  return (
    <>
      {canDelete && selected.size > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button variant="danger" size="sm" onClick={() => setConfirmIds([...selected])}>
            <Trash2 className="size-3.5" aria-hidden /> Delete {selected.size}
          </Button>
        </div>
      ) : null}
      <div className={`${LIST_SCROLL_BOX} rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]`} data-list-scroll>
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              {canDelete ? (
                <th className={`${th} w-10`}>
                  <Checkbox checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(termIds))} aria-label="Select this page" />
                </th>
              ) : null}
              <th className={th}>Client</th>
              <th className={th}>Service / plan</th>
              <th className={`${th} hidden lg:table-cell`}>Duration</th>
              <th className={`${th} hidden md:table-cell`}>Start date</th>
              <th className={th}>Expiry date</th>
              <th className={th}>Days left</th>
              <th className={th}>Status</th>
              <th className={`${th} hidden md:table-cell`}>Sold by</th>
              <th className={`${th} text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const s = c.subscription!;
              const phone = c.channels.find((ch) => ch.kind === "WHATSAPP") ?? c.channels.find((ch) => ch.kind === "PHONE");
              const running = s.state !== "EXPIRED" && s.state !== "SCHEDULED" && s.state !== "PAUSED";
              const left = running ? daysBetween(today, s.endDate) : null;
              const total = Math.max(1, daysBetween(s.startDate, s.endDate));
              const name = clientDisplayName(c.name, c.companyName);
              return (
                <tr key={c.id} className="hover:bg-[var(--color-surface-sunken)]">
                  {canDelete ? (
                    <td className={`${td} w-10`}>
                      <Checkbox checked={selected.has(s.id)} onChange={() => toggle(s.id)} aria-label={`Select ${name}`} />
                    </td>
                  ) : null}
                  <td className={td}>
                    <div className="flex min-w-[220px] items-center gap-3">
                      <ClientAvatar id={c.id} code={c.code} name={c.name} companyName={c.companyName} photoVersion={c.photoVersion} />
                      <div className="min-w-0">
                        <Link href={`/clients/${c.id}?tab=subscriptions`} className="block truncate font-semibold hover:underline">
                          {name}
                        </Link>
                        <div className={`flex flex-wrap items-center gap-x-2 text-xs ${muted}`}>
                          <span className="font-[family-name:var(--font-mono)]">{c.code}</span>
                          {c.country ? (
                            <span>
                              {flag(c.country)} {c.country}
                            </span>
                          ) : null}
                        </div>
                        {phone ? (
                          <div className={`flex items-center gap-1 text-xs ${muted}`}>
                            <Phone className="size-3" aria-hidden /> {phone.value}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className={td}>
                    <div className="font-medium">{s.service}</div>
                    <div className={`text-xs ${muted}`}>{SUBSCRIPTION_KIND_LABELS[s.kind as SubscriptionKind] ?? s.kind}</div>
                  </td>
                  <td className={`${td} hidden whitespace-nowrap lg:table-cell`}>{describeDuration(s.durationValue, s.durationUnit)}</td>
                  <td className={`${td} hidden whitespace-nowrap md:table-cell`}>{formatDay(s.startDate)}</td>
                  <td className={`${td} whitespace-nowrap font-medium`}>{formatDay(s.endDate)}</td>
                  <td className={td}>
                    {s.state === "EXPIRED" && daysBetween(today, s.endDate) >= 0 ? (
                      <span className="text-[13px] font-medium text-[color:var(--color-danger-fg)]">Expired today</span>
                    ) : (
                      <DaysLeftBar daysLeft={s.state === "EXPIRED" ? daysBetween(today, s.endDate) : left} totalDays={total} />
                    )}
                  </td>
                  <td className={td}>
                    <Badge color={SUBSCRIPTION_TONE[s.state]} dot>
                      {SUBSCRIPTION_STATE_LABELS[s.state]}
                    </Badge>
                  </td>
                  <td className={`${td} hidden md:table-cell`}>
                    {c.soldBy ? (
                      <>
                        <div className="whitespace-nowrap font-medium">{c.soldBy.name}</div>
                        {c.soldBy.detail ? <div className={`text-xs ${muted}`}>{c.soldBy.detail}</div> : null}
                      </>
                    ) : (
                      <span className={muted}>—</span>
                    )}
                  </td>
                  <td className={`${td} text-right`}>
                    <div className="flex items-center justify-end gap-1.5">
                      <Link href={`/clients/${c.id}?tab=subscriptions`} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-xs font-medium hover:bg-[var(--color-neutral-bg)]">
                        <Eye className="size-3.5" aria-hidden /> View
                      </Link>
                      <RowMenu
                        horizontal
                        label={`More actions for ${name}`}
                        items={[
                          { label: "Renew", icon: <RefreshCw className="size-4" aria-hidden />, onSelect: () => setRenewing(c), hidden: !canRenew || s.state === "PAUSED" },
                          { label: "Pause", icon: <CirclePause className="size-4" aria-hidden />, onSelect: () => pause(s.id, true), hidden: !canRenew || s.state === "PAUSED" || busy },
                          { label: "Resume", icon: <CirclePlay className="size-4" aria-hidden />, onSelect: () => pause(s.id, false), hidden: !canRenew || s.state !== "PAUSED" || busy },
                          { label: "Cancel on profile…", icon: <XCircle className="size-4" aria-hidden />, href: `/clients/${c.id}?tab=subscriptions`, hidden: !canRenew },
                          { label: "Renewal offer…", icon: <Send className="size-4" aria-hidden />, href: `/clients/subscriptions/renewals?view=${s.state === "EXPIRED" ? "expired" : "renewing"}&q=${encodeURIComponent(c.code)}`, hidden: !canRenew || s.state === "CANCELLED" },
                          { label: "Delete subscription", icon: <Trash2 className="size-4" aria-hidden />, onSelect: () => setConfirmIds([s.id]), danger: true, hidden: !canDelete },
                        ]}
                      />
                    </div>
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
      {canDelete ? (
        <ConfirmDialog
          open={confirmIds !== null}
          onClose={() => setConfirmIds(null)}
          onConfirm={remove}
          loading={busy}
          tone="danger"
          title={confirmIds && confirmIds.length > 1 ? `Delete ${confirmIds.length} subscriptions?` : "Delete this subscription?"}
          description="The term is removed for good and the client's current plan is worked out again from what is left. Invoices raised for it stay on the Billing List. To end a real subscription, pause or cancel it instead — that keeps the history."
          confirmLabel="Delete permanently"
        />
      ) : null}
    </>
  );
}
