"use client";

import { useState, useTransition } from "react";
import { Eye, FileText, Trash2, Undo2 } from "lucide-react";
import Link, { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, Field, Textarea, useToast } from "@/components/ui";
import { reversePayment } from "@/server/actions/clientPayments";
import { deletePayments } from "@/server/actions/clientDeletes";
import type { PaymentRow } from "@/server/clientBilling";
import { clientDisplayName, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@support-automation/shared";
import { formatDay, money } from "@/lib/clientDisplay";
import { RowMenu } from "../RowMenu";

const muted = "text-[color:var(--color-muted-foreground)]";

/**
 * Receipts, newest first. A mistake is reversed with a reason (kept, marked reversed). Delete — only
 * for someone allowed to delete — removes it for good, taking it off the invoices it settled first.
 */
export function PaymentsTable({ payments, canReverse, canDelete }: { payments: PaymentRow[]; canReverse: boolean; canDelete: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [target, setTarget] = useState<PaymentRow | null>(null);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [busy, start] = useTransition();
  const ids = payments.map((p) => p.id);
  const allOnPage = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const deletingLive = deleting ? payments.filter((p) => deleting.includes(p.id) && !p.reversed).length : 0;

  const th = "whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]";
  const td = "border-b border-[var(--color-border)] px-4 py-3 align-middle text-[13px]";
  return (
    <>
      {canDelete && selected.size > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button variant="danger" size="sm" onClick={() => setDeleting([...selected])}>
            <Trash2 className="size-3.5" aria-hidden /> Delete {selected.size}
          </Button>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              {canDelete ? (
                <th className={`${th} w-10`}>
                  <Checkbox checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(ids))} aria-label="Select this page" />
                </th>
              ) : null}
              <th className={th}>Receipt</th>
              <th className={th}>Client</th>
              <th className={th}>Amount</th>
              <th className={`${th} hidden md:table-cell`}>Method</th>
              <th className={`${th} hidden md:table-cell`}>Reference</th>
              <th className={th}>Invoices settled</th>
              <th className={`${th} hidden lg:table-cell`}>Recorded by</th>
              <th className={`${th} text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className={`hover:bg-[var(--color-surface-sunken)] ${p.reversed ? "opacity-75" : ""}`}>
                {canDelete ? (
                  <td className={`${td} w-10`}>
                    <Checkbox checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.receiptNumber}`} />
                  </td>
                ) : null}
                <td className={td}>
                  <div className="whitespace-nowrap font-semibold font-[family-name:var(--font-mono)]">{p.receiptNumber}</div>
                  <div className={`text-xs ${muted}`}>{formatDay(p.receivedDate)}</div>
                </td>
                <td className={td}>
                  <Link href={`/clients/${p.client.id}?tab=payments`} className="font-medium hover:underline">
                    {clientDisplayName(p.client.name)}
                  </Link>
                  <div className={`text-xs font-[family-name:var(--font-mono)] ${muted}`}>{p.client.code}</div>
                </td>
                <td className={`${td} whitespace-nowrap`}>
                  <span className={`text-sm font-semibold tabular-nums ${p.reversed ? "line-through" : "text-[color:var(--color-success-fg)]"}`}>{money(p.amount, p.currency)}</span>
                  {p.reversed ? (
                    <div className="mt-1" title={p.reversed.reason ?? undefined}>
                      <Badge color="yellow">Reversed</Badge>
                      <div className={`mt-0.5 max-w-[200px] truncate text-xs ${muted}`}>
                        {p.reversed.by ?? "—"}: {p.reversed.reason}
                      </div>
                    </div>
                  ) : null}
                </td>
                <td className={`${td} hidden md:table-cell`}>
                  <Badge color="gray">{(PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method).split(" (")[0]}</Badge>
                </td>
                <td className={`${td} hidden md:table-cell`}>
                  {p.reference ?? <span className={muted}>—</span>}
                  {p.batchReference ? <div className={`text-xs ${muted}`}>{p.batchReference}</div> : null}
                </td>
                <td className={td}>
                  <div className="flex max-w-[260px] flex-wrap gap-1">
                    {p.invoices.map((i) => (
                      <Link
                        key={i.dueId}
                        href={`/clients/dues?view=all&q=${encodeURIComponent(i.invoiceNumber ?? p.client.code)}`}
                        title={money(i.amount, p.currency)}
                        className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-neutral-bg)] px-1.5 py-0.5 text-[11px] font-medium hover:underline"
                      >
                        <FileText className="size-3" aria-hidden />
                        {i.invoiceNumber ?? "Older due"}
                      </Link>
                    ))}
                  </div>
                </td>
                <td className={`${td} hidden lg:table-cell`}>
                  <div>{p.recordedBy ?? "—"}</div>
                  <div className={`text-xs ${muted}`}>{new Date(p.recordedAt).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" })}</div>
                </td>
                <td className={`${td} text-right`}>
                  <div className="flex items-center justify-end gap-1.5">
                    <Link href={`/clients/${p.client.id}?tab=payments`} className="inline-flex size-8 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]" title="Open the client" aria-label="Open the client">
                      <Eye className="size-4" />
                    </Link>
                    <RowMenu
                      horizontal
                      label={`More actions for ${p.receiptNumber}`}
                      items={[
                        { label: "Reverse…", icon: <Undo2 className="size-4" aria-hidden />, onSelect: () => setTarget(p), hidden: !canReverse || Boolean(p.reversed) },
                        { label: "Delete payment", icon: <Trash2 className="size-4" aria-hidden />, onSelect: () => setDeleting([p.id]), danger: true, hidden: !canDelete },
                      ]}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? `Reverse ${target.receiptNumber}?` : ""}
        description={target ? `${money(target.amount, target.currency)} goes back to owed on ${target.invoices.map((i) => i.invoiceNumber ?? "an older due").join(", ")}. The receipt stays on this list, marked reversed. A reversal cannot be undone — record the right amount as a new payment.` : undefined}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setTarget(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={!reason.trim()}
              loading={busy}
              onClick={() => {
                const p = target!;
                start(async () => {
                  const r = await reversePayment(p.id, reason);
                  showToast({ tone: r.ok ? "success" : "danger", title: r.message });
                  setTarget(null);
                  setReason("");
                  if (r.ok) router.refresh();
                });
              }}
            >
              Reverse payment
            </Button>
          </div>
        }
      >
        <Field label="Reason" hint="Required, kept with the receipt.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
        </Field>
      </Dialog>
      {canDelete ? (
        <ConfirmDialog
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          loading={busy}
          tone="danger"
          title={deleting && deleting.length > 1 ? `Delete ${deleting.length} payments?` : "Delete this payment?"}
          description={`The receipt is removed for good${deletingLive ? `, and the invoices ${deletingLive === 1 ? "it" : "they"} settled are open again for ${deletingLive === 1 ? "its" : "their"} amount` : ""}. If the money really was received, reverse it instead — a reversal keeps the record.`}
          confirmLabel="Delete permanently"
          onConfirm={() =>
            start(async () => {
              const r = await deletePayments(deleting ?? []);
              showToast({ tone: r.ok ? "success" : "danger", title: r.message });
              setDeleting(null);
              setSelected(new Set());
              if (r.ok) router.refresh();
            })
          }
        />
      ) : null}
    </>
  );
}
