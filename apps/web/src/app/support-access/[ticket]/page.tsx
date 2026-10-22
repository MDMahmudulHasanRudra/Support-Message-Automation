import { notFound } from "next/navigation";
import { hostServesCustomerSoftware } from "@support-automation/shared";
import { currentHostScope } from "@/server/hostScope";
import { ContinueSupport } from "./ContinueSupport";

export const metadata = { title: "RELQIVO support access" };

/** The landing page of a support link: it continues by itself (a POST, so a link preview cannot use the ticket up). */
export default async function SupportAccessPage({ params }: { params: Promise<{ ticket: string }> }) {
  if (!hostServesCustomerSoftware(await currentHostScope())) notFound();
  const { ticket } = await params;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-background)] px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold text-[color:var(--color-foreground)]">RELQIVO support access</h1>
        <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">Opening this customer&apos;s software for support. This session is time-limited and recorded.</p>
        <div className="mt-6">
          <ContinueSupport ticket={ticket} />
        </div>
      </div>
    </main>
  );
}
