import { DEFAULT_PRODUCT_NAME } from "@support-automation/shared";
import { Alert } from "@/components/ui";
import { setupAllowed } from "./actions";
import { SetupForm } from "./SetupForm";

export const metadata = { title: "Set up" };

export default async function PlatformSetupPage() {
  const allowed = await setupAllowed();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-background)] px-4 py-12">
      <div className="w-full max-w-md">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-[color:var(--color-subtle-foreground)] uppercase">{DEFAULT_PRODUCT_NAME} Platform</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-[color:var(--color-foreground)]">Create the first platform operator</h1>
        <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
          A separate login for running {DEFAULT_PRODUCT_NAME}: customers, plans, payments, monitoring and support. It is not a login of your own
          software, and your software&apos;s Main Admin stays exactly as it is.
        </p>
        <div className="mt-6">{allowed.ok ? <SetupForm signedInAs={allowed.username} /> : <Alert tone="warning">{allowed.reason}</Alert>}</div>
      </div>
    </main>
  );
}
