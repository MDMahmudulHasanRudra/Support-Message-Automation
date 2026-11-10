import { notFound } from "next/navigation";
import { PAYMENT_PROVIDER_LABEL } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { loadPaymentLink } from "@/server/payments/core";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Card } from "@/components/ui";
import { CopyButton } from "@/components/contacts/contactDisplay";
import { PaymentActions } from "./PaymentActions";

export const metadata = { title: "Payment Link" };

const STATUS_COLOR = { OPEN: "blue", PAID: "green", CANCELLED: "gray", EXPIRED: "gray" } as const;
const STATUS_LABEL = { OPEN: "Waiting", PAID: "Paid", CANCELLED: "Cancelled", EXPIRED: "Expired" } as const;
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" });
const KIND: Record<string, string> = { CREATED: "Created", PAID: "Paid", PAID_TWICE: "Paid a second time", AMOUNT_MISMATCH: "Different amount reported", CANCELLED: "Cancelled", RESOLVED: "Marked as checked" };
const ATTEMPT: Record<string, string> = { STARTED: "Started", PAID: "Paid", FAILED: "Not completed", UNKNOWN: "Could not confirm", MISMATCH: "Different amount" };

export default async function PaymentLinkPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAccess("payments.view", "PAYMENT_LINKS");
  const { id } = await params;
  const link = await loadPaymentLink(id);
  if (!link) notFound();
  const [canCreate, canManage] = await Promise.all([hasPermission(session, "payments.create"), hasPermission(session, "payments.manage")]);
  return (
    <div className="max-w-3xl space-y-4">
      <div className="text-[13px] text-[color:var(--color-muted-foreground)]">
        <Link href="/payments" className="hover:underline">
          Payment Links
        </Link>{" "}
        / <span className="tabular">{link.label}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="tabular text-[24px] font-semibold tracking-[-0.01em]">{link.amount}</h1>
        <Badge color={STATUS_COLOR[link.status]}>{STATUS_LABEL[link.status]}</Badge>
      </div>
      {link.needsAttention ? <Alert tone="warning">{link.attentionNote ?? "This payment needs checking."}</Alert> : null}
      <Card className="space-y-2 p-4 text-[13.5px]">
        {link.description ? <p>{link.description}</p> : null}
        {link.status === "OPEN" ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 break-all rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2 text-[12.5px]">{link.url}</span>
            <CopyButton value={link.url} label="link" />
          </div>
        ) : null}
        <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
          Made {DATE.format(new Date(link.createdAt))}
          {link.createdByName ? ` by ${link.createdByName}` : ""}
          {link.status === "OPEN" ? ` · Works until ${DATE.format(new Date(link.expiresAt))}` : ""}
          {link.paidAt ? ` · Paid ${DATE.format(new Date(link.paidAt))}` : ""}
          {link.paidProvider ? ` through ${PAYMENT_PROVIDER_LABEL[link.paidProvider]}` : ""}
          {link.gatewayTxnId ? ` · ${link.gatewayTxnId}` : ""}
          {link.receiptNumber ? ` · Receipt ${link.receiptNumber}` : ""}
        </p>
        <PaymentActions id={link.id} canCancel={canCreate && link.status === "OPEN"} canClear={canManage && link.needsAttention} canRecheck={link.attempts.some((a) => a.status === "STARTED" || a.status === "UNKNOWN")} />
      </Card>
      {link.attempts.length ? (
        <Card className="p-4">
          <h2 className="mb-2 text-[14px] font-semibold">Tries</h2>
          <ul className="space-y-1 text-[13px]">
            {link.attempts.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  {PAYMENT_PROVIDER_LABEL[a.provider]}
                  {a.mode === "SANDBOX" ? " (test)" : ""} · {ATTEMPT[a.status] ?? a.status}
                  {a.note ? <span className="text-[color:var(--color-muted-foreground)]"> · {a.note}</span> : null}
                </span>
                <time className="tabular text-[12.5px] text-[color:var(--color-muted-foreground)]">{DATE.format(new Date(a.createdAt))}</time>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card className="p-4">
        <h2 className="mb-2 text-[14px] font-semibold">History</h2>
        <ul className="space-y-1 text-[13px]">
          {link.events.map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-2">
              <span>
                {KIND[e.kind] ?? e.kind}
                {e.detail ? <span className="text-[color:var(--color-muted-foreground)]"> · {e.detail}</span> : null}
                {e.actorName ? <span className="text-[color:var(--color-muted-foreground)]"> · {e.actorName}</span> : null}
              </span>
              <time className="tabular text-[12.5px] text-[color:var(--color-muted-foreground)]">{DATE.format(new Date(e.createdAt))}</time>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
