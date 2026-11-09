import { notFound } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { formatPaymentAmount, formatPaymentLinkNumber } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { enabledProviders } from "@/server/payments/core";
import { withPaymentToken } from "@/server/payments/publicPay";
import { PayButtons } from "./PayButtons";

export const metadata = { title: "Payment", robots: { index: false, follow: false } };

/** What a customer sees when they open a payment link (PAYMENT_LINKS.md). The link itself is the only authority here. */
export default async function PayPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ back?: string }> }) {
  const { token } = await params;
  const { back } = await searchParams;
  const data = await withPaymentToken(token, async ({ linkId, projectName }) => {
    const link = await prisma.paymentLink.findFirst({ where: { id: linkId }, select: { number: true, amountMinor: true, description: true, status: true, expiresAt: true } });
    return link ? { link, projectName, providers: await enabledProviders() } : null;
  });
  if (!data) notFound();
  const { link, projectName, providers } = data;
  const expired = link.status === "EXPIRED" || (link.status === "OPEN" && isPast(link.expiresAt));
  return (
    <main className="mx-auto max-w-sm px-4 py-12">
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
        <p className="text-[13.5px] text-[color:var(--color-muted-foreground)]">{projectName}</p>
        {link.status === "PAID" ? <CheckCircle2 className="mx-auto mt-3 size-10 text-[color:var(--color-success-fg)]" aria-hidden /> : null}
        <p className="tabular mt-2 text-[32px] font-semibold tracking-[-0.02em]">{formatPaymentAmount(link.amountMinor)}</p>
        {link.description ? <p className="mt-1 text-[14px]">{link.description}</p> : null}
        <p className="tabular mt-1 text-[12.5px] text-[color:var(--color-muted-foreground)]">{formatPaymentLinkNumber(link.number)}</p>
        {link.status === "PAID" ? (
          <p className="mt-4 text-[14.5px] font-semibold text-[color:var(--color-success-fg)]">Paid. Thank you.</p>
        ) : link.status === "CANCELLED" ? (
          <p className="mt-4 text-[14px] text-[color:var(--color-muted-foreground)]">This link was cancelled.</p>
        ) : expired ? (
          <p className="mt-4 text-[14px] text-[color:var(--color-muted-foreground)]">This link has expired. Please ask for a new one.</p>
        ) : (
          <PayButtons token={token} providers={providers} returned={back === "1"} />
        )}
      </div>
    </main>
  );
}

function isPast(when: Date): boolean {
  return when.getTime() <= Date.now();
}
