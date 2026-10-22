import { BrandMark, Card } from "@/components/ui";
import { getBranding } from "@/server/branding";
import { checkInvitation } from "./actions";
import { AcceptInvitationForm } from "./AcceptInvitationForm";

export const metadata = { title: "Accept invitation" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [check, brand] = await Promise.all([checkInvitation(token), getBranding()]);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-background)] px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <BrandMark className="size-8" />
          <span className="text-lg font-semibold">{brand.productName}</span>
        </div>
        <Card>
          {check.ok ? (
            <>
              <h1 className="text-lg font-semibold">Welcome, {check.name}</h1>
              <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
                You have been invited to manage {check.customerName}&apos;s workspace. Choose a username and password to finish.
              </p>
              <div className="mt-5">
                <AcceptInvitationForm token={token} />
              </div>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold">Invitation not available</h1>
              <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">{check.reason}</p>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
