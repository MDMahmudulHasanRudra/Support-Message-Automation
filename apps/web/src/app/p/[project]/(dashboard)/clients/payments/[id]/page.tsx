import { notFound } from "next/navigation";
import { ArrowLeft, Banknote, CalendarClock, FileText, Mail, ReceiptText, User } from "lucide-react";
import { clientDisplayName } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { clientViewerCaps } from "@/server/clientModule";
import { brandingFor, loadReceipt, pdfCanDraw } from "@/server/clientDocuments";
import { listClientMessages } from "@/server/clientMessages";
import Link from "@/components/ProjectLink";
import { Alert, Badge, ButtonLink } from "@/components/ui";
import { FactCard, SectionCard, muted } from "../../[id]/ProfileParts";
import { DocumentPreview, ReverseReceiptButton } from "../../documents/DocumentParts";
import { PrepareMessageButton } from "../../messages/PrepareMessage";
import { MessageHistory } from "../../messages/MessageHistory";

export const metadata = { title: "Money receipt" };

/**
 * One payment as a money receipt (CLIENT_CRM_V7.md §3). A receipt confirms money RECEIVED — it is not an invoice.
 * A reversed payment keeps its receipt, which says so on the page, the print and the PDF. Reversing is the
 * Payments & Receipts action with its own checks; nothing here deletes financial evidence.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, canManage } = await pageAccess("clients.view_billing", "clients.edit_billing");
  const caps = await clientViewerCaps(session);
  if (!caps.settings.payments) {
    return <Alert tone="info">Payments are switched off for this project (they need Billing on). A Client Module manager can turn them on under Settings → Client Module.</Alert>;
  }
  const { id } = await params;
  const record = await loadReceipt(id);
  if (!record) notFound();
  const { doc } = record;
  const [branding, messages] = await Promise.all([brandingFor(record.issuedAt), listClientMessages({ paymentId: id })]);
  const pdfBlocked = pdfCanDraw(branding, doc)
    ? null
    : "This receipt contains text in a script the PDF builder cannot lay out (for example Bengali). Use Print → Save as PDF: the browser draws it exactly.";

  return (
    <div className="space-y-5">
      <ButtonLink href="/clients/payments" variant="ghost" size="sm">
        <ArrowLeft className="size-3.5" aria-hidden /> Payments &amp; Receipts
      </ButtonLink>
      <div className="flex flex-col gap-4 border-b border-[var(--color-border)] pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className={`text-sm ${muted}`}>
            Money receipt for{" "}
            <Link href={`/clients/${record.clientId}?tab=payments`} className="font-medium text-[color:var(--color-foreground)] hover:underline">
              {clientDisplayName(doc.client.name, doc.client.company)}
            </Link>{" "}
            · {doc.client.code}
          </p>
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-[27px] font-semibold tracking-[-0.025em]">
            {doc.number}
            {doc.reversed ? <Badge color="yellow">Reversed</Badge> : <Badge color="green">Recorded</Badge>}
          </h1>
          <p className={`mt-1 text-sm ${muted}`}>
            Received {doc.receivedDate} · {doc.method}
            {doc.reference ? ` · Ref. ${doc.reference}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && caps.canRecordPayments && !doc.reversed ? (
            <ReverseReceiptButton
              paymentId={id}
              receiptNumber={doc.number}
              summary={`${doc.amount} goes back to owed on ${doc.invoices.map((i) => i.number).join(", ") || "its invoices"}. The receipt stays, marked reversed. A reversal cannot be undone — record the right amount as a new payment.`}
            />
          ) : null}
          {doc.reversed ? null : <PrepareMessageButton clientId={record.clientId} context={{ paymentId: id }} category="RECEIPT" />}
        </div>
      </div>
      {doc.reversed ? (
        <Alert tone="warning">
          Reversed on {doc.reversed.at}
          {record.reversedBy ? ` by ${record.reversedBy}` : ""}
          {doc.reversed.reason ? `: ${doc.reversed.reason}` : ""}. This receipt no longer counts as money received; its invoices were reopened for the amount.
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <FactCard icon={Banknote} accent={doc.reversed ? "slate" : "green"} label="Amount received" value={doc.amount} valueClass={doc.reversed ? "line-through" : ""} />
        <FactCard icon={CalendarClock} accent="blue" label="Received" value={doc.receivedDate} />
        <FactCard icon={FileText} accent="indigo" label="Invoices settled" value={String(doc.invoices.length)} />
        <FactCard icon={User} accent="slate" label="Recorded by" value={doc.recordedBy ?? "—"} sub={record.recordedAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" })} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <SectionCard icon={ReceiptText} title="Document">
          <DocumentPreview src={`/api/clients/documents/receipt/${id}`} title={`Receipt ${doc.number}`} pdfHref={`/api/clients/documents/receipt/${id}?format=pdf`} pdfBlockedReason={pdfBlocked} />
          <p className={`mt-2 text-xs ${muted}`}>
            Drawn with the Invoice &amp; Receipt setup {branding.view.version ? `version ${branding.view.version}` : "defaults"} — the one in force when this payment was recorded.
          </p>
        </SectionCard>
        <div className="space-y-5">
          <SectionCard icon={FileText} title="Applied to">
            {record.invoices.length === 0 ? (
              <p className={`text-sm ${muted}`}>Not applied to any invoice.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)] text-sm">
                {record.invoices.map((i) => (
                  <li key={i.dueId} className="flex items-center justify-between gap-3 py-2">
                    <Link href={`/clients/dues/${i.dueId}`} className="font-medium hover:underline">
                      {i.number ?? "Older due"}
                    </Link>
                    <span className="tabular-nums">{i.amount}</span>
                  </li>
                ))}
              </ul>
            )}
            {record.batchReference ? <p className={`mt-2 text-xs ${muted}`}>Recorded in batch {record.batchReference}.</p> : null}
          </SectionCard>
          {record.internalNote ? (
            <SectionCard icon={FileText} title="Internal note">
              <p className="whitespace-pre-wrap text-sm">{record.internalNote}</p>
              <p className={`mt-2 text-xs ${muted}`}>Staff only — never printed on the receipt.</p>
            </SectionCard>
          ) : null}
          <SectionCard icon={Mail} title="Messages about this receipt">
            <MessageHistory messages={messages} empty="No message prepared or sent about this receipt." />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
