"use client";

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { LIST_SCROLL_BOX } from "@/lib/listPageSizes";
import { Eye, Plus, Search, Trash2, Wallet } from "lucide-react";
import Link, { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, Input, useToast } from "@/components/ui";
import type { BillingRow } from "@/server/clientBilling";
import { createDue } from "@/server/actions/clientBilling";
import { searchClientsBrief, type ClientBrief } from "@/server/actions/clientExtras";
import { clientDisplayName, DUE_KIND_LABELS, INVOICE_STATE_LABELS, type DueKind } from "@support-automation/shared";
import { countryName } from "@/lib/clientPhone";
import { formatDay, INVOICE_TONE, money } from "@/lib/clientDisplay";
import { ClientAvatar } from "../ClientAvatar";
import { DueForm, type InvoiceSellers } from "../ClientBilling";
import { PaymentDialog, type PayableInvoice } from "../PaymentDialog";
import { RowMenu } from "../RowMenu";
import { deleteDues } from "@/server/actions/clientDeletes";

const muted = "text-[color:var(--color-muted-foreground)]";
const Sub = ({ children }: { children: ReactNode }) => <div className={`mt-0.5 text-xs ${muted}`}>{children}</div>;
const None = () => <span className={muted}>—</span>;

function cell(key: string, r: BillingRow): ReactNode {
  switch (key) {
    case "client":
      return (
        <div className="flex min-w-[200px] items-center gap-2.5">
          <ClientAvatar id={r.client.id} code={r.client.code} name={r.client.name} companyName={r.client.companyName} photoVersion={r.client.photoVersion} size="sm" />
          <div className="min-w-0">
            <Link href={`/clients/${r.client.id}`} className="block truncate font-medium hover:underline">
              {clientDisplayName(r.client.name, r.client.companyName)}
            </Link>
            <Sub>{r.client.code}</Sub>
          </div>
        </div>
      );
    case "service":
      return r.service ?? <None />;
    case "soldBy":
      return r.soldBy ?? <None />;
    case "team":
      return r.team ?? <None />;
    case "issued":
      return <span className="whitespace-nowrap">{formatDay(r.issuedDate)}</span>;
    case "due":
      return (
        <>
          <div className={`whitespace-nowrap font-medium ${r.state === "OVERDUE" ? "text-[color:var(--color-danger-fg)]" : ""}`}>{formatDay(r.dueDate)}</div>
          <Sub>{r.state === "OVERDUE" ? "Overdue" : r.state === "PAID" ? "Settled" : "Due schedule"}</Sub>
        </>
      );
    case "billed":
      return <span className="whitespace-nowrap font-semibold tabular">{money(r.amount, r.currency)}</span>;
    case "collected":
      return r.amount === null ? <None /> : <span className="whitespace-nowrap tabular text-[color:var(--color-success-fg)]">{money(r.collected, r.currency)}</span>;
    case "remaining":
      return r.remaining === null ? (
        <None />
      ) : r.remaining === "0.00" ? (
        <Badge color="green">Settled</Badge>
      ) : (
        <span className="whitespace-nowrap font-semibold tabular text-[color:var(--color-warning-fg)]">{money(r.remaining, r.currency)}</span>
      );
    case "status":
      return <Badge color={INVOICE_TONE[r.state]}>{INVOICE_STATE_LABELS[r.state]}</Badge>;
    case "currency":
      return r.currency ?? <None />;
    case "phone":
      return r.client.phone ?? <None />;
    case "email":
      return r.client.email ?? <None />;
    case "country":
      return r.client.country ? (countryName(r.client.country) ?? r.client.country) : <None />;
    case "lastPayment":
      return r.lastPaymentDate ? formatDay(r.lastPaymentDate) : <None />;
    case "subscriptionEnd":
      return r.subscriptionEnd ? formatDay(r.subscriptionEnd) : <None />;
    case "note":
      return r.note ? <span className="line-clamp-2 max-w-[220px]">{r.note}</span> : <None />;
    case "createdBy":
      return r.createdBy ?? <None />;
    default:
      return null;
  }
}

const toPayable = (r: BillingRow): PayableInvoice => ({
  id: r.id,
  invoiceNumber: r.invoiceNumber,
  clientName: clientDisplayName(r.client.name, r.client.companyName),
  clientCode: r.client.code,
  currency: r.currency!,
  remaining: r.remaining!,
  dueDate: r.dueDate,
});

/**
 * The Billing List table (CLIENTS_V3.md §4): invoices with billed / collected / remaining in their own
 * currency, never converted. Only invoices that can take money are selectable; "Pay selected" opens
 * the payment dialog with an editable amount per invoice.
 */
export function BillingTable({ rows, columns, labels, canPay, canDelete = false, today }: { rows: BillingRow[]; columns: string[]; labels: Record<string, string>; canPay: boolean; canDelete?: boolean; today: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState<PayableInvoice[] | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [busy, start] = useTransition();
  // Selecting is for paying (payable invoices) or, for someone allowed to delete, for deleting (any).
  const selectable = rows.filter((r) => r.payable || canDelete);
  const canSelect = canPay || canDelete;
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const chosen = rows.filter((r) => selected.has(r.id) && r.payable);
  const picked = rows.filter((r) => selected.has(r.id));
  const actionsFor = (r: BillingRow) => (
    <div className="flex items-center justify-end gap-1.5">
      {canPay && r.payable ? (
        <Button size="sm" variant="secondary" onClick={() => setPaying([toPayable(r)])}>
          <Wallet className="size-3.5" aria-hidden /> Record payment
        </Button>
      ) : null}
      <RowMenu
        horizontal
        label={`More actions for ${r.invoiceNumber ?? "this due"}`}
        items={[
          { label: "Open client", icon: <Eye className="size-4" aria-hidden />, href: `/clients/${r.client.id}?tab=billing` },
          { label: "Delete invoice", icon: <Trash2 className="size-4" aria-hidden />, onSelect: () => setDeleting([r.id]), danger: true, hidden: !canDelete },
        ]}
      />
    </div>
  );
  const data = columns.filter((k) => k !== "invoice");
  const th = "sticky top-0 whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]";
  const td = "border-b border-[var(--color-border)] px-4 py-3 align-middle text-[13px] group-hover:bg-[var(--color-surface-sunken)]";

  const invoiceCell = (r: BillingRow) => (
    <>
      <div className="whitespace-nowrap font-semibold">{r.invoiceNumber ?? "Older due"}</div>
      <Sub>{r.kind ? DUE_KIND_LABELS[r.kind as DueKind] : "Due"}</Sub>
    </>
  );

  return (
    <div>
      {canSelect ? (
        <div className="mb-2 flex flex-wrap items-center justify-end gap-2 text-sm">
          <span className={muted}>{picked.length} selected</span>
          {canDelete ? (
            <Button size="sm" variant="danger" disabled={!picked.length} onClick={() => setDeleting(picked.map((r) => r.id))}>
              <Trash2 className="size-3.5" aria-hidden /> Delete selected
            </Button>
          ) : null}
          {canPay ? (
            <Button size="sm" disabled={!chosen.length} onClick={() => setPaying(chosen.map(toPayable))}>
              <Wallet className="size-3.5" aria-hidden /> Pay selected{chosen.length && chosen.length !== picked.length ? ` (${chosen.length})` : ""}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className={`hidden ${LIST_SCROLL_BOX} rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] md:block`} data-list-scroll>
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              {canSelect ? (
                <th className={`${th} z-[2] w-10`}>
                  <Checkbox checked={allSelected} indeterminate={!allSelected && picked.length > 0} onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.id)))} aria-label="Select every invoice on this page" />
                </th>
              ) : null}
              <th className={`${th} left-0 z-[3] border-r`}>{labels.invoice ?? "Invoice"}</th>
              {data.map((k) => (
                <th key={k} className={`${th} z-[2]`}>
                  {labels[k] ?? k}
                </th>
              ))}
              <th className={`${th} z-[2] text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="group">
                {canSelect ? (
                  <td className={`${td} w-10`}>
                    <Checkbox disabled={!r.payable && !canDelete} checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.invoiceNumber ?? "this due"}`} title={r.payable || canDelete ? undefined : "Nothing left to pay, no amount, or the client is archived"} />
                  </td>
                ) : null}
                <td className={`${td} sticky left-0 z-[1] border-r bg-[var(--color-surface)]`}>{invoiceCell(r)}</td>
                {data.map((k) => (
                  <td key={k} className={td}>
                    {cell(k, r)}
                  </td>
                ))}
                <td className={td}>{actionsFor(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-3 md:hidden">
        {rows.map((r) => (
          <li key={r.id} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="flex items-start gap-3">
              {canSelect ? <Checkbox className="mt-1" disabled={!r.payable && !canDelete} checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.invoiceNumber ?? "this due"}`} /> : null}
              <div className="min-w-0 flex-1">{invoiceCell(r)}</div>
              <Badge color={INVOICE_TONE[r.state]}>{INVOICE_STATE_LABELS[r.state]}</Badge>
            </div>
            <div className="mt-2">{cell("client", r)}</div>
            <dl className="mt-3 grid grid-cols-3 gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 text-[13px]">
              <div>
                <dt className={`text-[11px] ${muted}`}>Billed</dt>
                <dd className="font-medium">{money(r.amount, r.currency)}</dd>
              </div>
              <div>
                <dt className={`text-[11px] ${muted}`}>Remaining</dt>
                <dd className="font-medium">{r.remaining === null ? "—" : money(r.remaining, r.currency)}</dd>
              </div>
              <div>
                <dt className={`text-[11px] ${muted}`}>Due</dt>
                <dd className="font-medium">{formatDay(r.dueDate)}</dd>
              </div>
            </dl>
            <div className="mt-3">{actionsFor(r)}</div>
          </li>
        ))}
      </ul>

      {canDelete ? (
        <ConfirmDialog
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          loading={busy}
          tone="danger"
          title={deleting && deleting.length > 1 ? `Delete ${deleting.length} invoices?` : "Delete this invoice?"}
          description="It is removed for good with its history. An invoice a recorded payment still settles is kept — reverse or delete that payment first. To stop expecting money on a real invoice, waive or cancel it instead."
          confirmLabel="Delete permanently"
          onConfirm={() =>
            start(async () => {
              const r = await deleteDues(deleting ?? []);
              showToast({ tone: r.ok ? "success" : "danger", title: r.message });
              setDeleting(null);
              setSelected(new Set());
              router.refresh();
            })
          }
        />
      ) : null}
      {paying ? (
        <PaymentDialog
          open
          invoices={paying}
          today={today}
          onClose={() => {
            setPaying(null);
            setSelected(new Set());
          }}
        />
      ) : null}
    </div>
  );
}

/** "Create bill": pick a client (search), then the ordinary invoice form for them. */
export function CreateBillButton({ currencies, invoice }: { currencies: string[]; invoice: InvoiceSellers }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ClientBrief[]>([]);
  const [client, setClient] = useState<ClientBrief | null>(null);
  useEffect(() => {
    if (!open || client) return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await searchClientsBrief(query);
      if (live) setFound(r);
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, query, client]);
  const action = useMemo(() => (client ? createDue.bind(null, client.id) : null), [client]);
  const close = () => {
    setOpen(false);
    setClient(null);
    setQuery("");
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden /> Create bill
      </Button>
      <Dialog open={open} onClose={close} size="lg" title={client ? `New invoice for ${clientDisplayName(client.name, client.companyName)}` : "Create a bill"} description={client ? `${client.code} — an invoice number is assigned on save.` : "Find the client first."}>
        {client && action ? (
          <DueForm action={action} currencies={currencies} submitLabel="Create invoice" invoice={invoice} onDone={close} />
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--color-muted-foreground)]" aria-hidden />
              <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Client name, code or number" className="pl-9" />
            </div>
            <ul className="max-h-72 divide-y divide-[var(--color-border)] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
              {found.length === 0 ? <li className={`px-3 py-2 text-sm ${muted}`}>No client matches.</li> : null}
              {found.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setClient(c)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--color-neutral-bg)]">
                    <span className="flex-1 truncate font-medium">{clientDisplayName(c.name, c.companyName)}</span>
                    <span className={`text-xs ${muted}`}>{c.code}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Dialog>
    </>
  );
}
