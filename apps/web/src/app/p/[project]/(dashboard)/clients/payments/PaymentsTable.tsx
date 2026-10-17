"use client";

import { useState, useTransition } from "react";
import { Undo2 } from "lucide-react";
import Link, { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Badge, Button, Dialog, Field, Textarea, useToast } from "@/components/ui";
import { reversePayment } from "@/server/actions/clientPayments";
import type { PaymentRow } from "@/server/clientBilling";
import { clientDisplayName, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@support-automation/shared";
import { formatDay, money } from "@/lib/clientDisplay";

const muted = "text-[color:var(--color-muted-foreground)]";

/** Receipts, newest first. A mistake is reversed with a reason — never edited or deleted. */
export function PaymentsTable({ payments, canReverse }: { payments: PaymentRow[]; canReverse: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [target, setTarget] = useState<PaymentRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, start] = useTransition();
  const th = "whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]";
  const td = "border-b border-[var(--color-border)] px-4 py-3 align-top text-[13px]";
  return (
    <>
      <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th className={th}>Receipt</th>
              <th className={th}>Client</th>
              <th className={th}>Amount</th>
              <th className={`${th} hidden md:table-cell`}>Method / reference</th>
              <th className={th}>Invoices settled</th>
              <th className={`${th} hidden lg:table-cell`}>Recorded</th>
              <th className={th}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className={p.reversed ? "opacity-70" : ""}>
                <td className={td}>
                  <div className="whitespace-nowrap font-semibold">{p.receiptNumber}</div>
                  <div className={`text-xs ${muted}`}>{formatDay(p.receivedDate)}</div>
                  {p.batchReference ? <div className={`text-xs ${muted}`}>{p.batchReference}</div> : null}
                </td>
                <td className={td}>
                  <Link href={`/clients/${p.client.id}`} className="font-medium hover:underline">
                    {clientDisplayName(p.client.name)}
                  </Link>
                  <div className={`text-xs ${muted}`}>{p.client.code}</div>
                </td>
                <td className={`${td} whitespace-nowrap`}>
                  <span className={`font-semibold tabular ${p.reversed ? "line-through" : ""}`}>{money(p.amount, p.currency)}</span>
                  {p.reversed ? (
                    <div className="mt-1">
                      <Badge color="gray">Reversed</Badge>
                      <div className={`mt-0.5 text-xs ${muted}`}>
                        {p.reversed.by ?? "—"}: {p.reversed.reason}
                      </div>
                    </div>
                  ) : null}
                </td>
                <td className={`${td} hidden md:table-cell`}>
                  {PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method}
                  {p.reference ? <div className={`text-xs ${muted}`}>{p.reference}</div> : null}
                </td>
                <td className={td}>
                  <ul className="space-y-0.5">
                    {p.invoices.map((i) => (
                      <li key={i.dueId} className="whitespace-nowrap text-xs">
                        <Link href={`/clients/dues?view=all&q=${encodeURIComponent(i.invoiceNumber ?? p.client.code)}`} className="hover:underline">
                          {i.invoiceNumber ?? "Older due"}
                        </Link>{" "}
                        <span className={muted}>{money(i.amount, p.currency)}</span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className={`${td} hidden lg:table-cell`}>
                  <div>{p.recordedBy ?? "—"}</div>
                  <div className={`text-xs ${muted}`}>{new Date(p.recordedAt).toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })}</div>
                </td>
                <td className={`${td} text-right`}>
                  {canReverse && !p.reversed ? (
                    <Button size="sm" variant="ghost" onClick={() => setTarget(p)}>
                      <Undo2 className="size-3.5" aria-hidden /> Reverse
                    </Button>
                  ) : null}
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
    </>
  );
}
