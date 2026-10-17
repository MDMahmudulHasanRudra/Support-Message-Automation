"use client";

import { useMemo, useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, Dialog, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { recordPayments } from "@/server/actions/clientPayments";
import { formatMinor, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, toMinor } from "@support-automation/shared";
import { formatDay, money } from "@/lib/clientDisplay";

export interface PayableInvoice {
  id: string;
  invoiceNumber: string | null;
  clientName: string;
  clientCode: string;
  currency: string;
  /** What is left, two-decimal string. */
  remaining: string;
  dueDate: string;
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, "");

/**
 * Recording money received — one invoice or many (CLIENTS_V3.md §4). Each selected invoice shows what
 * is left and takes its own amount (prefilled with the full remainder). The summary splits the batch
 * by currency, because money in two currencies is never one payment. Nothing is sent to a gateway;
 * the server plans and records it all in one transaction, or nothing, and the form's own key makes a
 * double press record once.
 */
export function PaymentDialog({ open, onClose, invoices, today }: { open: boolean; onClose: () => void; invoices: PayableInvoice[]; today: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [key, setKey] = useState(newKey);
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(invoices.map((i) => [i.id, i.remaining])));
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [busy, start] = useTransition();

  // A new selection is a new submission: fresh amounts and a fresh key.
  const signature = invoices.map((i) => i.id).join(",");
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setAmounts(Object.fromEntries(invoices.map((i) => [i.id, i.remaining])));
    setKey(newKey());
    setError(null);
    setLineErrors({});
  }

  const totals = useMemo(() => {
    const byCurrency = new Map<string, bigint>();
    for (const i of invoices) {
      const m = toMinor(amounts[i.id] ?? "");
      if (m === null) continue;
      byCurrency.set(i.currency, (byCurrency.get(i.currency) ?? BigInt(0)) + m);
    }
    return [...byCurrency.entries()].map(([c, m]) => formatMinor(m, c));
  }, [amounts, invoices]);
  const clients = new Set(invoices.map((i) => i.clientCode)).size;

  function submit() {
    setError(null);
    start(async () => {
      const r = await recordPayments({ idempotencyKey: key, method, receivedDate: date, reference, note, lines: invoices.map((i) => ({ dueId: i.id, amount: amounts[i.id] ?? "" })) });
      if (!r.ok) {
        setError(r.message);
        setLineErrors(r.lineErrors ?? {});
        return;
      }
      showToast({ tone: "success", title: r.message });
      setKey(newKey());
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={invoices.length > 1 ? "Record payments" : "Record a payment"}
      description="Edit each amount, then record. Partial payments are fine; more than what is left is not."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!invoices.length}>
            <ShieldCheck className="size-4" aria-hidden /> Record {invoices.length > 1 ? "selected payments" : "payment"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Alert tone="success">A separate payment is recorded per client and currency. Nothing is submitted to a payment gateway.</Alert>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <dl className="grid grid-cols-3 gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-sm">
          <div>
            <dt className="text-xs text-[color:var(--color-muted-foreground)]">Invoices</dt>
            <dd className="font-semibold">{invoices.length}</dd>
          </div>
          <div>
            <dt className="text-xs text-[color:var(--color-muted-foreground)]">Clients</dt>
            <dd className="font-semibold">{clients}</dd>
          </div>
          <div>
            <dt className="text-xs text-[color:var(--color-muted-foreground)]">Total, per currency</dt>
            <dd className="font-semibold tabular">{totals.join(" · ") || "—"}</dd>
          </div>
        </dl>
        <ul className="max-h-[38vh] space-y-2 overflow-y-auto pr-1">
          {invoices.map((i) => (
            <li key={i.id} className={`flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border p-3 ${lineErrors[i.id] ? "border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]" : "border-[var(--color-border)]"}`}>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{i.invoiceNumber ?? "Older due"}</p>
                <p className="truncate text-xs text-[color:var(--color-muted-foreground)]">
                  {i.clientName} · {i.currency} · left {money(i.remaining, i.currency)} · due {formatDay(i.dueDate)}
                </p>
                {lineErrors[i.id] ? <p className="mt-1 text-xs font-medium text-[color:var(--color-danger-fg)]">{lineErrors[i.id]}</p> : null}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-[color:var(--color-muted-foreground)]">{i.currency}</span>
                <Input
                  aria-label={`Amount for ${i.invoiceNumber ?? "this due"}`}
                  inputMode="decimal"
                  className="w-32 text-right tabular"
                  value={amounts[i.id] ?? ""}
                  onChange={(e) => setAmounts((prev) => ({ ...prev, [i.id]: e.target.value }))}
                />
              </div>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Payment method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payment date">
            <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Reference" hint="Transaction id, cheque number…">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={1} maxLength={1000} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
