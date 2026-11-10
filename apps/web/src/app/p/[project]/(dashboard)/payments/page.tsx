import { PAYMENT_PROVIDER_LABEL } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { enabledProviders, listPaymentLinks } from "@/server/payments/core";
import Link from "@/components/ProjectLink";
import { Badge, Card, EmptyState, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { NewPaymentLinkButton } from "./NewPaymentLinkButton";

export const metadata = { title: "Payment Links" };

const STATUS_COLOR = { OPEN: "blue", PAID: "green", CANCELLED: "gray", EXPIRED: "gray" } as const;
const STATUS_LABEL = { OPEN: "Waiting", PAID: "Paid", CANCELLED: "Cancelled", EXPIRED: "Expired" } as const;
const VIEWS = [["", "All"], ["OPEN", "Waiting"], ["PAID", "Paid"], ["ATTENTION", "Needs checking"]] as const;
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" });

/** Payment links (PAYMENT_LINKS.md): what was asked for and what was paid. */
export default async function PaymentLinksPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const session = await requireAccess("payments.view", "PAYMENT_LINKS");
  const { status } = await searchParams;
  const [rows, canCreate, providers] = await Promise.all([listPaymentLinks(status ?? null), hasPermission(session, "payments.create"), enabledProviders()]);
  return (
    <div className="min-w-0">
      <PageHeader
        title="Payment Links"
        description="Ask for payment in a chat. The money goes to your own SSLCOMMERZ or bKash account."
        actions={
          <>
            <HelpButton moduleTitle="Payment Links">
              <HelpSection title="How it works">
                <p>Make a link beside any chat or here, and send it to the customer. They pay on the SSLCOMMERZ or bKash page. When a link is for an invoice, a successful payment records the receipt by itself.</p>
              </HelpSection>
              <HelpSection title="Needs checking">
                <p>If a payment could not be confirmed, was for a different amount, or was paid twice, the link says so. Nothing is decided for you: check it in your payment account, then mark it done.</p>
              </HelpSection>
            </HelpButton>
            {canCreate ? <NewPaymentLinkButton ready={providers.length > 0} /> : null}
          </>
        }
      />
      <nav aria-label="Payment link lists" className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {VIEWS.map(([value, label]) => (
          <Link key={value} href={value ? `/payments?status=${value}` : "/payments"} aria-current={(status ?? "") === value ? "page" : undefined} className={`shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium ${(status ?? "") === value ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"}`}>
            {label}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <Card>
          <EmptyState>{providers.length ? "No payment links yet. Make one here or from the Payment tab beside a chat." : "Set up a payment account in Settings → Payment accounts to start."}</EmptyState>
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Card className="relative grid gap-x-4 gap-y-1 p-3.5 transition-colors hover:border-[var(--color-border-strong)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/payments/${r.id}`} className="tabular text-[14.5px] font-semibold after:absolute after:inset-0 hover:underline">
                      {r.amount}
                    </Link>
                    <Badge color={STATUS_COLOR[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    {r.needsAttention ? <Badge color="yellow">Needs checking</Badge> : null}
                  </div>
                  <p className="mt-0.5 truncate text-[12.5px] text-[color:var(--color-muted-foreground)]">
                    <span className="tabular">{r.label}</span>
                    {r.description ? ` · ${r.description}` : ""}
                    {r.customerName ? ` · ${r.customerName}` : ""}
                  </p>
                </div>
                <p className="text-[12.5px] text-[color:var(--color-muted-foreground)] sm:text-right">
                  {r.paidAt ? `Paid ${DATE.format(new Date(r.paidAt))}${r.paidProvider ? ` · ${PAYMENT_PROVIDER_LABEL[r.paidProvider]}` : ""}` : DATE.format(new Date(r.createdAt))}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
