import { notFound } from "next/navigation";
import Link from "next/link";
import { Check } from "lucide-react";
import { getBranding } from "@/server/branding";
import { loadPublicPlans } from "@/server/platform/signups";

export const metadata = { title: "Pricing" };

/** The public price list (SIGNUP.md). Prices are the plans marked public on Platform → Plans & billing. */
export default async function PricingPage() {
  const [plans, brand] = await Promise.all([loadPublicPlans(), getBranding()]);
  if (!plans) notFound();
  return (
    <main>
      <section className="bg-[linear-gradient(120deg,#08414b_0%,#0d6a74_100%)] px-4 pb-24 pt-10 text-center text-white sm:px-6">
        <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]">Answer every customer from one place</h1>
        <p className="mx-auto mt-3 max-w-xl text-[15.5px] text-white/85">{brand.productName} brings WhatsApp, Messenger, Instagram, Telegram and your website chat into one inbox, with AI that knows your business.</p>
      </section>
      <section className="mx-auto -mt-16 max-w-5xl px-4 pb-14 sm:px-6">
        {plans.length === 0 ? (
          <p className="rounded-[var(--radius-lg)] bg-[var(--color-surface)] p-8 text-center text-[14px] shadow-sm">Our plans are being prepared. Please check back soon.</p>
        ) : (
          <div className={`grid gap-4 ${plans.length === 1 ? "mx-auto max-w-sm" : plans.length === 2 ? "mx-auto max-w-2xl sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
            {plans.map((p) => (
              <article key={p.id} className="flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-sm">
                <h2 className="text-[17px] font-semibold">{p.name}</h2>
                {p.description ? <p className="mt-1 text-[13.5px] text-[color:var(--color-muted-foreground)]">{p.description}</p> : null}
                <p className="mt-4">
                  <span className="tabular text-[30px] font-semibold tracking-[-0.02em]">{p.price}</span>
                  <span className="text-[13.5px] text-[color:var(--color-muted-foreground)]"> / {p.interval === "YEAR" ? "year" : "month"}</span>
                </p>
                <ul className="mt-4 flex-1 space-y-2 text-[13.5px]">
                  {[
                    p.trialDays ? `${p.trialDays}-day free trial` : null,
                    p.maxWhatsAppAccounts === null ? "Unlimited WhatsApp numbers" : `${p.maxWhatsAppAccounts} WhatsApp ${p.maxWhatsAppAccounts === 1 ? "number" : "numbers"}`,
                    p.maxUsers === null ? "Unlimited team members" : `${p.maxUsers} team ${p.maxUsers === 1 ? "member" : "members"}`,
                    p.allModules ? "Every module included" : `${p.moduleCount} modules included`,
                  ]
                    .filter(Boolean)
                    .map((line) => (
                      <li key={line} className="flex items-start gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-[color:var(--color-success-fg)]" aria-hidden />
                        {line}
                      </li>
                    ))}
                </ul>
                <Link href={`/signup?plan=${encodeURIComponent(p.id)}`} className="mt-6 inline-flex h-10 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-primary)] text-[14px] font-medium text-[var(--color-on-primary)] hover:opacity-90">
                  {p.trialDays ? "Start free trial" : "Get started"}
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
