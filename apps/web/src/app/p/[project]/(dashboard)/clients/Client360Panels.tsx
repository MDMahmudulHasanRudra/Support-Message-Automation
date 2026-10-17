"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Camera, MessageCircle, Pause, Play, RefreshCw, Search, ShieldCheck, Trash2, Users, Wallet, X } from "lucide-react";
import Link, { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Badge, Button, Dialog, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { cancelSubscription, createSubscription, renewSubscription, setSubscriptionPaused, type SubscriptionFormState } from "@/server/actions/clientSubscriptions";
import { linkClientGroup, searchLinkableGroups, unlinkClientGroup, type GroupCandidate } from "@/server/actions/clientGroupLinks";
import { removeClientPhoto, uploadClientPhoto } from "@/server/actions/clientExtras";
import type { GroupLinkView, OpenInvoice, SubscriptionView } from "@/server/client360";
import type { RosterMember } from "@/server/clients";
import {
  addDuration,
  describeDuration,
  parseCalendarDay,
  PAYMENT_METHOD_LABELS,
  renewalStartDate,
  SUBSCRIPTION_DURATION_LABELS,
  SUBSCRIPTION_DURATION_UNITS,
  SUBSCRIPTION_KINDS,
  SUBSCRIPTION_KIND_LABELS,
  SUBSCRIPTION_STATE_LABELS,
  type PaymentMethod,
  type SubscriptionKind,
} from "@support-automation/shared";
import { formatDay, groupChatHref, money, SUBSCRIPTION_TONE } from "@/lib/clientDisplay";
import { shrinkPicture } from "@/lib/clientPhotoResize";
import { ClientAvatar } from "./ClientAvatar";
import { DeleteRecordButton } from "./DeleteRecordButton";
import { PaymentDialog } from "./PaymentDialog";

const muted = "text-[color:var(--color-muted-foreground)]";

// ── Photo ───────────────────────────────────────────────────────────────────────────────────────

export function PhotoControl({ client, canEdit, size = "lg" }: { client: { id: string; code: string; name: string; companyName: string | null; photoVersion: number | null }; canEdit: boolean; size?: "lg" | "xl" }) {
  const router = useRouter();
  const { showToast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, start] = useTransition();
  async function upload(file: File | undefined) {
    if (!file) return;
    start(async () => {
      try {
        const small = await shrinkPicture(file);
        const fd = new FormData();
        fd.set("photo", small);
        const r = await uploadClientPhoto(client.id, fd);
        showToast({ tone: r.ok ? "success" : "danger", title: r.message });
        if (r.ok) router.refresh();
      } catch (err) {
        showToast({ tone: "danger", title: err instanceof Error ? err.message : "The picture could not be read." });
      }
    });
  }
  return (
    <div className="relative shrink-0">
      <ClientAvatar id={client.id} code={client.code} name={client.name} companyName={client.companyName} photoVersion={client.photoVersion} size={size} />
      {canEdit ? (
        <div className="absolute -bottom-1 -right-1 flex gap-0.5">
          <button type="button" disabled={busy} onClick={() => input.current?.click()} title="Change photo" aria-label="Change photo" className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-sm)] hover:bg-[var(--color-neutral-bg)]">
            <Camera className="size-3.5" />
          </button>
          {client.photoVersion ? (
            <button
              type="button"
              disabled={busy}
              title="Remove photo"
              aria-label="Remove photo"
              onClick={() =>
                start(async () => {
                  const r = await removeClientPhoto(client.id);
                  showToast({ tone: r.ok ? "success" : "danger", title: r.message });
                  if (r.ok) router.refresh();
                })
              }
              className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-sm)] hover:bg-[var(--color-neutral-bg)]"
            >
              <Trash2 className="size-3.5" />
            </button>
          ) : null}
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
        </div>
      ) : null}
    </div>
  );
}

// ── Subscriptions ───────────────────────────────────────────────────────────────────────────────

function TermFields({ defaults, today }: { defaults?: { service?: string; kind?: string; startDate?: string; durationValue?: string; durationUnit?: string }; today: string }) {
  const [start, setStart] = useState(defaults?.startDate ?? today);
  const [value, setValue] = useState(defaults?.durationValue ?? "1");
  const [unit, setUnit] = useState(defaults?.durationUnit ?? "MONTH");
  const startDay = parseCalendarDay(start);
  const n = Number(value);
  const end = startDay && Number.isInteger(n) && n > 0 ? addDuration(startDay, n, unit as never) : null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Service / plan" className="sm:col-span-2">
        <Input name="service" defaultValue={defaults?.service ?? ""} maxLength={120} placeholder="e.g. Tiger IPTV" required />
      </Field>
      <Field label="Type">
        <Select name="kind" defaultValue={defaults?.kind ?? "PAID"}>
          {SUBSCRIPTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {SUBSCRIPTION_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Starts on">
        <Input type="date" name="startDate" value={start} onChange={(e) => setStart(e.target.value)} />
      </Field>
      <Field label="Duration">
        <Input type="number" min={1} name="durationValue" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <Field label="Unit">
        <Select name="durationUnit" value={unit} onChange={(e) => setUnit(e.target.value)}>
          {SUBSCRIPTION_DURATION_UNITS.map((u) => (
            <option key={u} value={u}>
              {SUBSCRIPTION_DURATION_LABELS[u][1]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-end sm:col-span-2">
        <p className="text-sm">
          Expires on <strong>{end ? formatDay(end) : "—"}</strong>
        </p>
      </div>
    </div>
  );
}

function InvoiceFields({ currencies, preferred, today }: { currencies: string[]; preferred: string | null; today: string }) {
  return (
    <details className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
      <summary className="cursor-pointer text-sm font-medium">Also raise an invoice (optional)</summary>
      <p className={`mt-1 text-xs ${muted}`}>Leave the amount empty to record only the service term. The term and the invoice stay separate: expiry is not a debt.</p>
      {currencies.length === 0 ? (
        <p className="mt-2 text-xs">Add a currency on the Billing List before raising invoices.</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Amount">
            <Input name="invoiceAmount" inputMode="decimal" placeholder="0.00" />
          </Field>
          <Field label="Currency">
            <Select name="invoiceCurrency" defaultValue={preferred && currencies.includes(preferred) ? preferred : currencies[0]}>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payment due">
            <Input type="date" name="invoiceDueDate" defaultValue={today} />
          </Field>
        </div>
      )}
    </details>
  );
}

function SellerField({ roster, defaultValue }: { roster: RosterMember[]; defaultValue?: string | null }) {
  const active = roster.filter((m) => m.active);
  return (
    <Field label="Sold by" hint="From your team roster; recorded with this sale.">
      <Select name="soldByMemberId" defaultValue={defaultValue ?? ""}>
        <option value="">Not recorded</option>
        {active.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.teamName ? ` · ${m.teamName}` : ""}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function useFormResult(state: SubscriptionFormState, onDone: () => void) {
  const router = useRouter();
  const { showToast } = useToast();
  useEffect(() => {
    if (!state.success) return;
    showToast({ tone: "success", title: state.message ?? "Saved" });
    onDone();
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per result
  }, [state]);
}

function AddTermForm({ clientId, roster, today, currencies, preferredCurrency, canInvoice, defaultSeller, onDone }: { clientId: string; roster: RosterMember[]; today: string; currencies: string[]; preferredCurrency: string | null; canInvoice: boolean; defaultSeller: string | null; onDone: () => void }) {
  const [state, action, pending] = useActionState<SubscriptionFormState, FormData>(createSubscription.bind(null, clientId), {});
  useFormResult(state, onDone);
  return (
    <form action={action} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <TermFields today={today} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SellerField roster={roster} defaultValue={defaultSeller} />
        <Field label="Note">
          <Input name="note" maxLength={1000} placeholder="Optional" />
        </Field>
      </div>
      {canInvoice ? <InvoiceFields currencies={currencies} preferred={preferredCurrency} today={today} /> : null}
      <div className="flex gap-2">
        <Button type="submit" loading={pending}>
          Save subscription
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function RenewDialog({ term, roster, today, currencies, preferredCurrency, canInvoice, onClose }: { term: Pick<SubscriptionView, "id" | "service" | "kind" | "endDate" | "durationValue" | "durationUnit" | "soldByMemberId">; roster: RosterMember[]; today: string; currencies: string[]; preferredCurrency: string | null; canInvoice: boolean; onClose: () => void }) {
  const [state, action, pending] = useActionState<SubscriptionFormState, FormData>(renewSubscription.bind(null, term.id), {});
  useFormResult(state, onClose);
  const start = renewalStartDate(term.endDate, today);
  return (
    <Dialog open onClose={onClose} size="lg" title={`Renew ${term.service}`} description={`A new term starting ${formatDay(start)} — ${term.endDate > today ? "right where the current one ends, so no days are lost" : "today, because the old term has lapsed"}. The old term stays in the history.`}>
      <form action={action} className="space-y-3">
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <TermFields today={today} defaults={{ service: term.service, kind: term.kind === "TRIAL" || term.kind === "DEMO" ? "PAID" : term.kind, startDate: start, durationValue: String(term.durationValue ?? 1), durationUnit: term.durationUnit ?? "MONTH" }} />
        <SellerField roster={roster} defaultValue={term.soldByMemberId} />
        {canInvoice ? <InvoiceFields currencies={currencies} preferred={preferredCurrency} today={today} /> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            <RefreshCw className="size-4" aria-hidden /> Renew
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function SubscriptionsPanel({
  clientId,
  subscriptions,
  roster,
  today,
  currencies,
  preferredCurrency,
  defaultSeller,
  canManage,
  canInvoice,
  archived,
  canDelete = false,
}: {
  clientId: string;
  subscriptions: SubscriptionView[];
  roster: RosterMember[];
  today: string;
  currencies: string[];
  preferredCurrency: string | null;
  defaultSeller: string | null;
  canManage: boolean;
  canInvoice: boolean;
  archived: boolean;
  /** An Administrator, or a role an Administrator gave the delete permission. */
  canDelete?: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [adding, setAdding] = useState(false);
  const [renewing, setRenewing] = useState<SubscriptionView | null>(null);
  const [cancelling, setCancelling] = useState<SubscriptionView | null>(null);
  const [reason, setReason] = useState("");
  const [busy, start] = useTransition();
  const editable = canManage && !archived;
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      showToast({ tone: r.ok ? "success" : "danger", title: r.message });
      if (r.ok) router.refresh();
    });

  return (
    <div className="space-y-4">
      {subscriptions.length === 0 ? <p className={`text-sm ${muted}`}>No subscription recorded yet.</p> : null}
      <ul className="space-y-2">
        {subscriptions.map((t) => (
          <li key={t.id} className={`rounded-[var(--radius-md)] border p-3 ${t.isCurrent ? "border-[var(--color-border-strong)] bg-[var(--color-surface-sunken)]" : "border-[var(--color-border)]"}`}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {t.service} <span className={`text-xs font-normal ${muted}`}>· {SUBSCRIPTION_KIND_LABELS[t.kind as SubscriptionKind] ?? t.kind}</span>
                  {t.isCurrent ? <span className={`ml-2 text-xs font-normal ${muted}`}>current</span> : null}
                </p>
                <p className={`text-xs ${muted}`}>
                  {formatDay(t.startDate)} → {formatDay(t.endDate)} · {describeDuration(t.durationValue, t.durationUnit)} · {t.expiryText}
                  {t.isRenewal ? " · renewal" : ""}
                </p>
                <p className={`text-xs ${muted}`}>
                  Sold by {t.soldBy ?? "—"}
                  {t.soldByTeam ? ` (${t.soldByTeam})` : ""}
                  {t.cancelReason ? ` · cancelled: ${t.cancelReason}` : ""}
                  {t.note ? ` · ${t.note}` : ""}
                </p>
              </div>
              <Badge color={SUBSCRIPTION_TONE[t.state]}>{SUBSCRIPTION_STATE_LABELS[t.state]}</Badge>
            </div>
            {editable && t.state !== "CANCELLED" && (t.isCurrent || t.state !== "EXPIRED") ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => setRenewing(t)} disabled={busy}>
                  <RefreshCw className="size-3.5" aria-hidden /> Renew
                </Button>
                {t.state === "PAUSED" ? (
                  <Button size="sm" variant="ghost" onClick={() => run(() => setSubscriptionPaused(t.id, false))} disabled={busy}>
                    <Play className="size-3.5" aria-hidden /> Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => run(() => setSubscriptionPaused(t.id, true))} disabled={busy}>
                    <Pause className="size-3.5" aria-hidden /> Pause
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setCancelling(t)} disabled={busy}>
                  <X className="size-3.5" aria-hidden /> Cancel
                </Button>
                {canDelete ? <DeleteRecordButton kind="subscription" id={t.id} /> : null}
              </div>
            ) : canDelete ? (
              <div className="mt-2">
                <DeleteRecordButton kind="subscription" id={t.id} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        adding ? (
          <AddTermForm clientId={clientId} roster={roster} today={today} currencies={currencies} preferredCurrency={preferredCurrency} canInvoice={canInvoice} defaultSeller={defaultSeller} onDone={() => setAdding(false)} />
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            + {subscriptions.length ? "Add another subscription" : "Add a subscription"}
          </Button>
        )
      ) : null}
      {renewing ? <RenewDialog term={renewing} roster={roster} today={today} currencies={currencies} preferredCurrency={preferredCurrency} canInvoice={canInvoice} onClose={() => setRenewing(null)} /> : null}
      <Dialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={cancelling ? `Cancel ${cancelling.service}?` : ""}
        description="The term stays in the history, marked cancelled. Its invoices are not touched — cancel or waive them on the Billing List if they should not be paid."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelling(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={!reason.trim()}
              loading={busy}
              onClick={() => {
                const t = cancelling!;
                setCancelling(null);
                run(() => cancelSubscription(t.id, reason));
                setReason("");
              }}
            >
              Cancel subscription
            </Button>
          </div>
        }
      >
        <Field label="Why?">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} />
        </Field>
      </Dialog>
    </div>
  );
}

// ── WhatsApp group links ────────────────────────────────────────────────────────────────────────

export function GroupLinksPanel({
  clientId,
  links,
  accounts,
  canLink,
  canOpenChat,
  archived,
}: {
  clientId: string;
  links: GroupLinkView[];
  accounts: Array<{ id: string; label: string; phoneNumber: string | null; status: string }>;
  canLink: boolean;
  canOpenChat: boolean;
  archived: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [busy, start] = useTransition();
  const [accountId, setAccountId] = useState("");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<GroupCandidate[] | null>(null);
  const [chosen, setChosen] = useState<GroupCandidate | null>(null);
  const [unlinking, setUnlinking] = useState<GroupLinkView | null>(null);
  const [reason, setReason] = useState("");
  const editable = canLink && !archived;
  const active = links.filter((l) => !l.unlinkedAt);
  const history = links.filter((l) => l.unlinkedAt);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    const t = setTimeout(async () => {
      const found = await searchLinkableGroups(accountId, query);
      if (live) setCandidates(found);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [accountId, query]);

  return (
    <div className="space-y-4">
      {active.length === 0 ? <p className={`text-sm ${muted}`}>No WhatsApp group linked.</p> : null}
      <ul className="space-y-2">
        {active.map((l) => {
          const href = canOpenChat ? groupChatHref(l.accountId, l.groupId) : null;
          return (
            <li key={l.id} className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
              <Users className="size-4 shrink-0 text-[color:var(--color-success-fg)]" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{l.groupName}</p>
                <p className={`text-xs ${muted}`}>
                  {l.accountLabel ?? "Account removed"} · linked by {l.linkedBy ?? "—"}
                  {!l.groupActive ? " · this number is no longer in the group" : l.accountStatus && l.accountStatus !== "CONNECTED" ? " · account not connected" : ""}
                </p>
              </div>
              {href ? (
                <Link href={href} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-2.5 text-xs font-medium">
                  <MessageCircle className="size-3.5" aria-hidden /> Open chat
                </Link>
              ) : null}
              {editable ? (
                <Button size="sm" variant="ghost" onClick={() => setUnlinking(l)}>
                  Unlink
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {editable ? (
        accounts.length === 0 ? (
          <p className={`text-sm ${muted}`}>No WhatsApp account in this project yet.</p>
        ) : (
          <div className="space-y-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] p-3">
            <p className="text-sm font-medium">Link an existing group</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Select
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setCandidates(null);
                }}
                aria-label="WhatsApp account"
              >
                <option value="">Choose an account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                    {a.phoneNumber ? ` (${a.phoneNumber})` : ""}
                    {a.status !== "CONNECTED" ? " — not connected" : ""}
                  </option>
                ))}
              </Select>
              {accountId ? (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--color-muted-foreground)]" aria-hidden />
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Group name or id" className="pl-9" aria-label="Search groups" />
                </div>
              ) : null}
            </div>
            {accountId ? (
              <ul className="max-h-56 divide-y divide-[var(--color-border)] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
                {candidates === null ? <li className={`px-3 py-2 text-sm ${muted}`}>Loading groups…</li> : null}
                {candidates?.length === 0 ? <li className={`px-3 py-2 text-sm ${muted}`}>No active group matches on this account.</li> : null}
                {candidates?.map((g) => (
                  <li key={g.groupId}>
                    <button type="button" disabled={Boolean(g.linkedTo)} onClick={() => setChosen(g)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--color-neutral-bg)] disabled:cursor-not-allowed disabled:opacity-60">
                      <span className="min-w-0 flex-1 truncate">{g.name}</span>
                      {g.participantCount ? <span className={`text-xs ${muted}`}>{g.participantCount} members</span> : null}
                      {g.linkedTo ? <Badge color="gray">Linked to {g.linkedTo.code}</Badge> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className={`text-xs ${muted}`}>A link only records where you support this client. Nothing is sent, and the group&apos;s monitoring and AI stay as they are.</p>
          </div>
        )
      ) : null}

      {history.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-[13px] font-medium">Earlier links ({history.length})</summary>
          <ul className="mt-2 space-y-1">
            {history.map((l) => (
              <li key={l.id} className={`text-xs ${muted}`}>
                {l.groupName} · unlinked by {l.unlinkedBy ?? "—"}
                {l.unlinkReason ? ` — ${l.unlinkReason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <Dialog
        open={chosen !== null}
        onClose={() => setChosen(null)}
        title="Link this WhatsApp group?"
        description={chosen ? `${chosen.name} will be recorded as this client's group. Nothing is sent, and its monitoring and AI settings are unchanged.` : undefined}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setChosen(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              onClick={() => {
                const g = chosen!;
                start(async () => {
                  const r = await linkClientGroup(clientId, accountId, g.groupId);
                  showToast({ tone: r.ok ? "success" : "danger", title: r.message });
                  setChosen(null);
                  if (r.ok) {
                    setAccountId("");
                    router.refresh();
                  }
                });
              }}
            >
              <ShieldCheck className="size-4" aria-hidden /> Confirm link
            </Button>
          </div>
        }
      />
      <Dialog
        open={unlinking !== null}
        onClose={() => setUnlinking(null)}
        title={unlinking ? `Unlink ${unlinking.groupName}?` : ""}
        description="The link is kept in the history. The group itself, and everything in it, is unchanged."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setUnlinking(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => {
                const l = unlinking!;
                start(async () => {
                  const r = await unlinkClientGroup(l.id, reason);
                  showToast({ tone: r.ok ? "success" : "danger", title: r.message });
                  setUnlinking(null);
                  setReason("");
                  if (r.ok) router.refresh();
                });
              }}
            >
              Unlink
            </Button>
          </div>
        }
      >
        <Field label="Reason (optional)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </Field>
      </Dialog>
    </div>
  );
}

// ── Payments ────────────────────────────────────────────────────────────────────────────────────

export function ClientPaymentsPanel({
  client,
  openInvoices,
  payments,
  canRecord,
  today,
  canDelete = false,
}: {
  client: { name: string; code: string };
  openInvoices: OpenInvoice[];
  payments: Array<{ id: string; receiptNumber: string; currency: string; amount: string; method: string; reference: string | null; receivedDate: string; recordedBy: string | null; reversed: boolean; invoices: string[] }>;
  canRecord: boolean;
  today: string;
  canDelete?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      {canRecord && openInvoices.length ? (
        <Button size="sm" onClick={() => setOpen(true)}>
          <Wallet className="size-3.5" aria-hidden /> Record a payment ({openInvoices.length} open)
        </Button>
      ) : null}
      {payments.length === 0 ? <p className={`text-sm ${muted}`}>No payment recorded.</p> : null}
      <ul className="divide-y divide-[var(--color-border)]">
        {payments.map((p) => (
          <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm">
            <span className="font-medium">{p.receiptNumber}</span>
            <span className={`tabular ${p.reversed ? "line-through opacity-60" : "font-semibold"}`}>{money(p.amount, p.currency)}</span>
            <span className={`text-xs ${muted}`}>
              {formatDay(p.receivedDate)} · {PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method}
              {p.reference ? ` · ${p.reference}` : ""} · for {p.invoices.join(", ")}
            </span>
            {p.reversed ? <Badge color="gray">Reversed</Badge> : null}
            {canDelete ? (
              <span className="ml-auto">
                <DeleteRecordButton kind="payment" id={p.id} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <Link href={`/clients/payments?q=${encodeURIComponent(client.code)}`} className="text-xs underline underline-offset-2">
        All receipts for this client
      </Link>
      {open ? (
        <PaymentDialog
          open
          onClose={() => setOpen(false)}
          today={today}
          invoices={openInvoices.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, clientName: client.name || "Unnamed client", clientCode: client.code, currency: i.currency, remaining: i.remaining, dueDate: i.dueDate }))}
        />
      ) : null}
    </div>
  );
}
