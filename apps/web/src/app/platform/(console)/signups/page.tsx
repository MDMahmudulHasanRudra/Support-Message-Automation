import { Card, PageHeader } from "@/components/ui";
import { requireOperatorPage } from "@/server/platform/auth";
import { listPlans } from "@/server/platform/billing";
import { listSignupRequests, platformBaseUrl, signupIsOpen } from "@/server/platform/signups";
import { SignupQueue, SignupSwitch } from "./SignupsClient";

export const metadata = { title: "Sign-ups" };

/** Requests from the public sign-up form (SIGNUP.md), waiting for a person to approve them. */
export default async function SignupsPage() {
  await requireOperatorPage();
  const [rows, plans, open, base] = await Promise.all([listSignupRequests(), listPlans(), signupIsOpen(), platformBaseUrl()]);
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Sign-ups" description="People who asked for a workspace on the public page. Approving one sets it up exactly as Add customer does." />
      <Card className="p-4">
        <SignupSwitch open={open} pricingUrl={`${base}/pricing`} publicPlans={plans.filter((p) => p.isActive && p.isPublic).length} />
      </Card>
      <SignupQueue rows={rows} plans={plans.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name }))} />
    </div>
  );
}
