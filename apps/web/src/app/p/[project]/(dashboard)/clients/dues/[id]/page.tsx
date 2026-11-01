import { notFound } from "next/navigation";
import { ArrowLeft, CalendarClock, CircleDollarSign, FileText, History, Mail, ReceiptText, Wallet } from "lucide-react";
import { clientDisplayName, dhakaToday, fromMinor, INVOICE_STATE_LABELS, type InvoiceState } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { clientViewerCaps } from "@/server/clientModule";
import { describeDueEvent, listBillingCurrencies } from "@/server/clientBilling";
import { brandingFor, loadInvoice, pdfCanDraw } from "@/server/clientDocuments";
import { listClientMessages } from "@/server/clientMessages";
import Link from "@/components/ProjectLink";
import { Alert, Badge, ButtonLink } from "@/components/ui";
import { formatDay, INVOICE_TONE } from "@/lib/clientDisplay";
import { FactCard, SectionCard, muted } from "../../[id]/ProfileParts";
import { DocumentPreview, InvoiceActions } from "../../documents/DocumentParts";
import { PrepareMessageButton } from "../../messages/PrepareMessage";
import { MessageHistory } from "../../messages/MessageHistory";

export const metadata = { title: "Invoice" };

/**
 * One invoice (CLIENT_CRM_V7.md §3): its figures, the document exactly as it prints, the payments applied to it
 * (reversed ones kept and marked), its change history and the messages sent about it. Billing viewers only; edits
 * and payments are the Billing List's own actions with their own checks.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { session, canManage } = await pageAccess("clients.view_billing", "clients.edit_billing");
  const caps = await clientViewerCaps(session);
  if (!caps.settings.billing) {
    return <Alert tone="info">Billing is switched off for this project. A Client Module manager can turn it on under Settings → Client Module.</Alert>;
  }
  const { id } = await params;
  const record = await loadInvoice(id);
  if (!record) notFound();
  const { doc } = record;
  const [branding, events, currencies, messages] = await Promise.all([
    brandingFor(record.issuedAt),
    prisma.clientDueEvent.findMany({ where: { dueId: id }, orderBy: { createdAt: "desc" }, take: 50, include: { actor: { select: { name: true } } } }),
    listBillingCurrencies(),
    listClientMessages({ dueId: id }),
  ]);
  const today = dhakaToday(new Date());
  const pdfBlocked = pdfCanDraw(branding, doc)
    ? null
    : "This invoice contains text in a script the PDF builder cannot lay out (for example Bengali). Use Print → Save as PDF: the browser draws it exactly.";
  const state = doc.state as InvoiceState;
  const payable =
    record.payable && record.currency && record.remainingMinor !== null
      ? { id, invoiceNumber: doc.number, clientName: clientDisplayName(doc.client.name, doc.client.company), clientCode: doc.client.code, currency: record.currency, remaining: fromMinor(record.remainingMinor), dueDate: record.form.dueDate }
      : null;
  const editable = canManage && caps.canEditBilling && !record.clientArchived;

  return (
    <div className="space-y-5">
      <ButtonLink href="/clients/dues" variant="ghost" size="sm">
        <ArrowLeft className="size-3.5" aria-hidden /> Billing List
      </ButtonLink>
      <div className="flex flex-col gap-4 border-b border-[var(--color-border)] pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className={`text-sm ${muted}`}>
            Invoice for{" "}
            <Link href={`/clients/${record.clientId}?tab=billing`} className="font-medium text-[color:var(--color-foreground)] hover:underline">
              {clientDisplayName(doc.client.name, doc.client.company)}
            </Link>{" "}
            · {doc.client.code}
          </p>
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-[27px] font-semibold tracking-[-0.025em]">
            {doc.number}
            <Badge color={INVOICE_TONE[state]}>{INVOICE_STATE_LABELS[state]}</Badge>
          </h1>
          <p className={`mt-1 text-sm ${muted}`}>
            Issued {doc.issuedDate} · Due {doc.dueDate}
            {doc.soldBy ? ` · Sold by ${doc.soldBy}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <InvoiceActions
            due={{ id, invoiceNumber: doc.number, ...record.form, overdue: state === "OVERDUE" }}
            currencies={currencies.filter((c) => c.enabled).map((c) => c.code)}
            payable={payable}
            canEdit={editable}
            canPay={caps.canRecordPayments}
            today={today}
          />
          <PrepareMessageButton clientId={record.clientId} context={{ dueId: id }} category={state === "PAID" ? "PAYMENT_CONFIRMATION" : state === "OVERDUE" ? "PAYMENT_REMINDER" : "INVOICE"} />
        </div>
      </div>
      {record.clientArchived ? <Alert tone="info">The client is archived, so this invoice cannot be edited or paid until the client is restored.</Alert> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <FactCard icon={FileText} accent="indigo" label="Total" value={doc.total} sub={record.currency ?? "No currency"} />
        <FactCard icon={Wallet} accent="green" label="Paid" value={doc.paid} sub={`${doc.payments.length} receipt${doc.payments.length === 1 ? "" : "s"}`} />
        <FactCard icon={CircleDollarSign} accent={state === "OVERDUE" ? "red" : "amber"} label="Balance due" value={doc.remaining} sub={state === "PAID" ? "Settled" : null} />
        <FactCard icon={CalendarClock} accent={state === "OVERDUE" ? "red" : "blue"} label="Due date" value={formatDay(record.form.dueDate)} sub={state === "OVERDUE" ? "Overdue" : null} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <SectionCard icon={ReceiptText} title="Document">
          <DocumentPreview src={`/api/clients/documents/invoice/${id}`} title={`Invoice ${doc.number}`} pdfHref={`/api/clients/documents/invoice/${id}?format=pdf`} pdfBlockedReason={pdfBlocked} />
          <p className={`mt-2 text-xs ${muted}`}>
            Drawn with the Invoice &amp; Receipt setup {branding.view.version ? `version ${branding.view.version}` : "defaults"} — the one in force when this invoice was issued. Later setup changes do not alter it.
          </p>
        </SectionCard>

        <div className="space-y-5">
          <SectionCard icon={Wallet} title="Payments applied">
            {record.allocations.length === 0 ? (
              <p className={`text-sm ${muted}`}>No payment recorded against this invoice yet.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)] text-sm">
                {record.allocations.map((a) => (
                  <li key={`${a.paymentId}`} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <Link href={`/clients/payments/${a.paymentId}`} className="font-medium hover:underline">
                        {a.receiptNumber}
                      </Link>
                      <div className={`text-xs ${muted}`}>
                        {formatDay(a.receivedDate)} · {a.method}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={`tabular-nums font-medium ${a.reversed ? "line-through opacity-70" : ""}`}>{a.amount}</div>
                      {a.reversed ? <Badge color="yellow">Reversed</Badge> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {record.subscription ? (
            <SectionCard icon={CalendarClock} title="Subscription">
              <p className="text-sm font-medium">{record.subscription.service}</p>
              <p className={`text-xs ${muted}`}>
                {formatDay(record.subscription.startDate)} → {formatDay(record.subscription.endDate)}
              </p>
              <p className={`mt-2 text-xs ${muted}`}>The term and the invoice are separate records: the expiry is not a debt, and this invoice is what is owed.</p>
            </SectionCard>
          ) : null}

          {record.internalNote ? (
            <SectionCard icon={FileText} title="Internal note">
              <p className="whitespace-pre-wrap text-sm">{record.internalNote}</p>
              <p className={`mt-2 text-xs ${muted}`}>Staff only — never printed on the invoice.</p>
            </SectionCard>
          ) : null}

          <SectionCard icon={History} title="History">
            {events.length === 0 ? (
              <p className={`text-sm ${muted}`}>No changes recorded.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {events.map((e) => (
                  <li key={e.id}>
                    <div>{describeDueEvent(e.type, (e.changes ?? {}) as never, null)}</div>
                    <div className={`text-xs ${muted}`}>
                      {e.actor?.name ?? "—"} · {e.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" })}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard icon={Mail} title="Messages about this invoice">
            <MessageHistory messages={messages} empty="No message prepared or sent about this invoice." />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
