"use client";

import { DeleteRecordButton } from "./DeleteRecordButton";
import { useActionState, useEffect, useRef, useState } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Button, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { createDue, updateDue, type DueFormState } from "@/server/actions/clientBilling";
import { CLIENT_DUE_STATUSES, CLIENT_DUE_STATUS_LABELS, DUE_KINDS, DUE_KIND_LABELS, formatMoney, type ClientDueStatusValue } from "@support-automation/shared";

export interface DueRowView {
  id: string;
  invoiceNumber?: string | null;
  dueDate: string;
  amount: string | null;
  currency: string | null;
  status: string;
  paidAmount: string | null;
  note: string | null;
  overdue: boolean;
}

export interface DueHistoryView {
  id: string;
  dueId: string;
  type: string;
  summary: string;
  actor: string | null;
  at: string;
}

const STATUS_COLOR: Record<string, "gray" | "green" | "yellow" | "red"> = { UNPAID: "yellow", PARTIALLY_PAID: "yellow", PAID: "green", WAIVED: "gray", CANCELLED: "gray" };

export interface InvoiceSellers {
  sellers: Array<{ id: string; name: string; teamName: string | null }>;
  today: string;
}

/**
 * One due's fields. Used for adding and for editing; the action it posts to is the only difference.
 * A NEW due is an invoice (CLIENTS_V3.md §4): it gets a number, and `invoice` adds what it is for, the
 * service and the seller from the real roster.
 */
export function DueForm({ action, initial, currencies, submitLabel, onDone, invoice }: { action: (prev: DueFormState, formData: FormData) => Promise<DueFormState>; initial?: DueRowView; currencies: string[]; submitLabel: string; onDone?: () => void; invoice?: InvoiceSellers }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, formAction, pending] = useActionState<DueFormState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.success) return;
    if (!initial) formRef.current?.reset();
    showToast({ tone: "success", title: initial ? "Due updated" : "Due added" });
    router.refresh();
    onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per successful submission
  }, [state]);

  const v = (key: string, fallback: string) => state.values?.[key] ?? fallback;
  // A due keeps the currency it was saved with even when the list no longer offers it.
  const options = initial?.currency && !currencies.includes(initial.currency) ? [initial.currency, ...currencies] : currencies;
  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="Due date">
          <Input type="date" name="dueDate" required defaultValue={v("dueDate", initial?.dueDate ?? "")} />
        </Field>
        <Field label="Amount (optional)">
          <Input name="amount" inputMode="decimal" placeholder="Leave blank if unknown" defaultValue={v("amount", initial?.amount ?? "")} />
        </Field>
        <Field label="Currency">
          <Select name="currency" defaultValue={v("currency", initial?.currency ?? "")}>
            <option value="">—</option>
            {options.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue={v("status", initial?.status ?? "UNPAID")}>
            {CLIENT_DUE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CLIENT_DUE_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {invoice && !initial ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="For">
            <Select name="kind" defaultValue={v("kind", "SERVICE")}>
              {DUE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DUE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Service">
            <Input name="service" maxLength={120} placeholder="e.g. Tiger IPTV" defaultValue={v("service", "")} />
          </Field>
          <Field label="Issued on">
            <Input type="date" name="issuedDate" defaultValue={v("issuedDate", invoice.today)} />
          </Field>
          <Field label="Sold by">
            <Select name="soldByMemberId" defaultValue={v("soldByMemberId", "")}>
              <option value="">Not recorded</option>
              {invoice.sellers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.teamName ? ` · ${m.teamName}` : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="Paid so far">
          <Input name="paidAmount" inputMode="decimal" placeholder="Only if part-paid" defaultValue={v("paidAmount", initial?.paidAmount ?? "")} />
        </Field>
        <Field label="Note" className="sm:col-span-3">
          <Textarea name="note" rows={2} maxLength={1000} placeholder="Internal. Never sent to the client." defaultValue={v("note", initial?.note ?? "")} />
        </Field>
      </div>
      {currencies.length === 0 ? (
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          No currency is listed for this project, so an amount cannot be entered yet. A due can still be saved with a date only. A currency is added on the{" "}
          <Link className="link" href="/clients/dues">
            Billing List
          </Link>
          .
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={pending}>
          {submitLabel}
        </Button>
        {onDone ? (
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function DueRow({ due, currencies, canEdit, canDelete }: { due: DueRowView; currencies: string[]; canEdit: boolean; canDelete: boolean }) {
  const [editing, setEditing] = useState(false);
  const status = due.status as ClientDueStatusValue;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="min-w-32 text-sm font-medium">
          {due.dueDate}
          {due.invoiceNumber ? <div className="text-xs font-normal text-[color:var(--color-muted-foreground)]">{due.invoiceNumber}</div> : null}
        </div>
        <div className="min-w-0 flex-1 text-sm">
          {formatMoney(due.amount, due.currency)}
          {due.paidAmount ? <span className="text-[color:var(--color-muted-foreground)]"> · paid {formatMoney(due.paidAmount, due.currency)}</span> : null}
          {due.note ? <span className="text-[color:var(--color-muted-foreground)]"> · {due.note}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {due.overdue ? <Badge color="red">Overdue</Badge> : null}
          <Badge color={STATUS_COLOR[due.status] ?? "gray"}>{CLIENT_DUE_STATUS_LABELS[status] ?? due.status}</Badge>
          {canEdit ? (
            <Button variant="ghost" size="sm" onClick={() => setEditing((e) => !e)}>
              {editing ? "Close" : "Edit"}
            </Button>
          ) : null}
          {canDelete ? <DeleteRecordButton kind="invoice" id={due.id} /> : null}
        </div>
      </div>
      {editing ? (
        <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <DueForm action={updateDue.bind(null, due.id)} initial={due} currencies={currencies} submitLabel="Save changes" onDone={() => setEditing(false)} />
        </div>
      ) : null}
    </li>
  );
}

/** A client's manual dues. Shown only to someone with `clients.view_billing`; editing needs `clients.edit_billing`. */
export function BillingPanel({ clientId, dues, history, currencies, summaryText, canEdit, archived, invoice, canDelete = false }: { clientId: string; dues: DueRowView[]; history: DueHistoryView[]; currencies: string[]; summaryText: string; canEdit: boolean; archived: boolean; invoice?: InvoiceSellers; canDelete?: boolean }) {
  const editable = canEdit && !archived;
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
        Entered by staff. Nothing here is connected to a payment system, nothing is sent because of a due, and &quot;paid&quot; is a person&apos;s statement.
      </p>
      <p className="text-sm">{summaryText}</p>
      {dues.length === 0 ? <p className="text-sm text-[color:var(--color-muted-foreground)]">No dues recorded.</p> : null}
      <ul className="divide-y divide-[var(--color-border)]">
        {dues.map((d) => (
          <DueRow key={d.id} due={d} currencies={currencies} canEdit={editable} canDelete={canDelete} />
        ))}
      </ul>
      {editable ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <p className="mb-3 text-sm font-medium">Raise an invoice</p>
          <DueForm action={createDue.bind(null, clientId)} currencies={currencies} submitLabel="Add invoice" invoice={invoice} />
        </div>
      ) : null}
      {history.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-[13px] font-medium">Change history ({history.length})</summary>
          <ol className="mt-2 space-y-1.5">
            {history.map((h) => (
              <li key={h.id} className="text-[13px]">
                {h.summary}
                <span className="text-[color:var(--color-muted-foreground)]">
                  {" "}
                  · {h.actor ?? "System"} · {h.at}
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}
