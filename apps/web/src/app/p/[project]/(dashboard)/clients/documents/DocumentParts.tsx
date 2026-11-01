"use client";

import { useRef, useState, useTransition } from "react";
import { Download, Pencil, Printer, Undo2, Wallet } from "lucide-react";
import { useProjectHref, useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, ButtonLink, Dialog, Field, Textarea, useToast } from "@/components/ui";
import { updateDue } from "@/server/actions/clientBilling";
import { reversePayment } from "@/server/actions/clientPayments";
import { DueForm, type DueRowView } from "../ClientBilling";
import { PaymentDialog, type PayableInvoice } from "../PaymentDialog";

/**
 * The document parts of the invoice and receipt pages (CLIENT_CRM_V7.md §3): the live preview (the very page that
 * prints), Print, Download PDF, and the invoice's Edit / Record payment and the receipt's Reverse — each a thin
 * caller of an action that makes its own checks.
 */

/** The document as it prints, in a frame. Print prints the frame, not the dashboard around it. */
export function DocumentPreview({ src, title, pdfHref, pdfBlockedReason }: { src: string; title: string; pdfHref: string; pdfBlockedReason: string | null }) {
  const toProject = useProjectHref();
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={!loaded} onClick={() => frame.current?.contentWindow?.print()}>
          <Printer className="size-4" aria-hidden /> Print
        </Button>
        {pdfBlockedReason ? (
          <Button size="sm" variant="secondary" disabled title={pdfBlockedReason}>
            <Download className="size-4" aria-hidden /> Download PDF
          </Button>
        ) : (
          <ButtonLink href={pdfHref} download>
            <Download className="size-4" aria-hidden /> Download PDF
          </ButtonLink>
        )}
        <ButtonLink href={src} target="_blank" rel="noopener">
          Open in a new tab
        </ButtonLink>
      </div>
      {pdfBlockedReason ? <Alert tone="info">{pdfBlockedReason}</Alert> : null}
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[#eef0f3]">
        <iframe ref={frame} src={toProject(src)} title={title} onLoad={() => setLoaded(true)} className="block h-[880px] w-full max-sm:h-[640px]" />
      </div>
    </div>
  );
}

/** Edit and Record payment for one invoice. Editing goes through the ordinary invoice rules (payments recorded against it hold its amount). */
export function InvoiceActions({ due, currencies, payable, canEdit, canPay, today }: { due: DueRowView; currencies: string[]; payable: PayableInvoice | null; canEdit: boolean; canPay: boolean; today: string }) {
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  return (
    <>
      {canPay && payable ? (
        <Button size="sm" onClick={() => setPaying(true)}>
          <Wallet className="size-4" aria-hidden /> Record payment
        </Button>
      ) : null}
      {canEdit ? (
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
          <Pencil className="size-4" aria-hidden /> Edit invoice
        </Button>
      ) : null}
      <Dialog open={editing} onClose={() => setEditing(false)} size="lg" title={`Edit ${due.invoiceNumber ?? "this due"}`} description="Payments recorded against this invoice keep its amount and currency; to lower what was paid, reverse a payment instead.">
        {editing ? <DueForm action={updateDue.bind(null, due.id)} initial={due} currencies={currencies} submitLabel="Save invoice" onDone={() => setEditing(false)} /> : null}
      </Dialog>
      {paying && payable ? <PaymentDialog open invoices={[payable]} today={today} onClose={() => setPaying(false)} /> : null}
    </>
  );
}

/** Reverse one payment, with a reason. The receipt stays, marked reversed — financial evidence is never deleted here. */
export function ReverseReceiptButton({ paymentId, receiptNumber, summary }: { paymentId: string; receiptNumber: string; summary: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, start] = useTransition();
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Undo2 className="size-4" aria-hidden /> Reverse…
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Reverse ${receiptNumber}?`}
        description={summary}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={!reason.trim()}
              loading={busy}
              onClick={() =>
                start(async () => {
                  const r = await reversePayment(paymentId, reason);
                  showToast({ tone: r.ok ? "success" : "danger", title: r.message });
                  if (r.ok) {
                    setOpen(false);
                    setReason("");
                    router.refresh();
                  }
                })
              }
            >
              Reverse payment
            </Button>
          </div>
        }
      >
        <Field label="Reason" hint="Required, kept with the receipt and printed on it.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
        </Field>
      </Dialog>
    </>
  );
}
