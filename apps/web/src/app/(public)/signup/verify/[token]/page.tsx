import { VerifyButton } from "./VerifyButton";

export const metadata = { title: "Confirm your email" };

/** Confirming takes a press, because mail scanners open links on their own (SIGNUP.md). */
export default async function VerifySignupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto max-w-md px-4 py-14 sm:px-6">
      <VerifyButton token={token} />
    </main>
  );
}
