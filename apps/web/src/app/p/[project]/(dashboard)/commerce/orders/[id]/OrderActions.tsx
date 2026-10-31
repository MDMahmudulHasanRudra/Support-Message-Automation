"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { ORDER_STATUS_LABELS, type OrderStatus } from "@support-automation/shared";
import { Alert, Button, ConfirmDialog, Field, Input, Select, useToast } from "@/components/ui";
import { markOrderRefunded, moveOrderStatus, recordOrderPayment } from "@/server/actions/commerce";

const MOVE_HINT: Partial<Record<OrderStatus, string>> = {
  CONFIRMED: "Tracked items are taken out of stock. If any is short, nothing changes and you are told which.",
  CANCELLED: "If the order was confirmed, its tracked items go back into stock.",
  RETURNED: "Its tracked items go back into stock.",
};

function useRun() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ error?: string; success?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (r.error) {
        setError(r.error);
        return;
      }
      showToast({ tone: "success", title: r.success ?? "Done" });
      after?.();
      router.refresh();
    });
  };
  return { pending, error, run };
}

/** The next statuses this order may take, each confirmed in a dialog that says what happens to stock. */
export function StatusMoves({ orderId, next }: { orderId: string; next: OrderStatus[] }) {
  const { pending, error, run } = useRun();
  const [target, setTarget] = useState<OrderStatus | null>(null);
  const [note, setNote] = useState("");
  if (next.length === 0) return <p className="text-sm text-[color:var(--color-muted-foreground)]">This order is closed.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {next.map((s) => (
          <Button key={s} variant={s === "CANCELLED" || s === "RETURNED" ? "secondary" : "primary"} size="sm" onClick={() => setTarget(s)}>
            {s === "CANCELLED" ? "Cancel order" : `Mark ${ORDER_STATUS_LABELS[s].toLowerCase()}`}
          </Button>
        ))}
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        onConfirm={() => target && run(() => moveOrderStatus(orderId, target, note), () => { setTarget(null); setNote(""); })}
        loading={pending}
        tone={target === "CANCELLED" || target === "RETURNED" ? "danger" : "primary"}
        title={target ? `${target === "CANCELLED" ? "Cancel" : "Mark"} this order${target === "CANCELLED" ? "" : ` ${ORDER_STATUS_LABELS[target].toLowerCase()}`}?` : ""}
        description={target ? MOVE_HINT[target] : undefined}
        confirmLabel={target === "CANCELLED" ? "Cancel order" : "Confirm"}
      >
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

const METHODS = ["Cash", "Cash on delivery", "bKash", "Nagad", "Rocket", "Bank transfer", "Card", "Other"];

/** Money received for this order. The order's payment state follows from what was recorded. */
export function PaymentPanel({ orderId, due, paid, canRefund }: { orderId: string; due: string; paid: boolean; canRefund: boolean }) {
  const { pending, error, run } = useRun();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState(METHODS[0]);
  const [reference, setReference] = useState("");
  const [refundNote, setRefundNote] = useState("");
  const [refunding, setRefunding] = useState(false);
  return (
    <div className="space-y-3">
      {!paid ? (
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => recordOrderPayment(orderId, amount, method, reference), () => {
              setAmount("");
              setReference("");
            });
          }}
        >
          <Field label="Amount" hint={`Due ${due}`}>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="Reference">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder="Transaction id" />
          </Field>
          <div className="flex items-start pt-6">
            <Button type="submit" loading={pending}>
              Record
            </Button>
          </div>
        </form>
      ) : null}
      {canRefund ? (
        refunding ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Why was it refunded?">
              <Input value={refundNote} onChange={(e) => setRefundNote(e.target.value)} maxLength={500} className="w-72" />
            </Field>
            <Button variant="danger" loading={pending} onClick={() => run(() => markOrderRefunded(orderId, refundNote), () => setRefunding(false))}>
              Mark refunded
            </Button>
            <Button variant="ghost" onClick={() => setRefunding(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setRefunding(true)}>
            Mark refunded…
          </Button>
        )
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
