import { notFound } from "next/navigation";
import { issueSignupFormStamp, loadPublicPlans, signupAddressSuffix } from "@/server/platform/signups";
import { SignupForm } from "./SignupForm";

export const metadata = { title: "Sign up" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const plans = await loadPublicPlans();
  if (!plans || plans.length === 0) notFound();
  const { plan } = await searchParams;
  const suffix = await signupAddressSuffix();
  return (
    <main className="mx-auto max-w-md px-4 py-10 sm:px-6">
      <h1 className="text-[24px] font-semibold tracking-[-0.01em]">Create your workspace</h1>
      <p className="mt-1 text-[14px] text-[color:var(--color-muted-foreground)]">Tell us about your business. We check every request and email you when it is ready.</p>
      <SignupForm plans={plans.map((p) => ({ id: p.id, label: `${p.name} (${p.price} / ${p.interval === "YEAR" ? "year" : "month"})` }))} initialPlan={plans.some((p) => p.id === plan) ? plan! : plans[0]!.id} suffix={suffix} stamp={issueSignupFormStamp()} />
    </main>
  );
}
