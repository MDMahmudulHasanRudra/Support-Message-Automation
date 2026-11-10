"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { verifySignup, type VerifyResult } from "@/server/platform/actions/publicSignup";

const TEXT: Record<VerifyResult, { title: string; body: string }> = {
  VERIFIED: { title: "Thank you", body: "Your email is confirmed. We are reviewing your request and will email you as soon as your workspace is ready." },
  ALREADY: { title: "Already confirmed", body: "We have this request. We will email you when your workspace is ready." },
  INVALID: { title: "This link has expired", body: "Please fill in the sign-up form again and we will send you a new link." },
};

export function VerifyButton({ token }: { token: string }) {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [pending, start] = useTransition();
  const shown = result ? TEXT[result] : null;
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
      <h1 className="text-[19px] font-semibold">{shown?.title ?? "Confirm your email"}</h1>
      <p className="mt-1.5 text-[14px] text-[color:var(--color-muted-foreground)]">{shown?.body ?? "Press the button to confirm this address and send us your request."}</p>
      {shown ? null : (
        <Button className="mt-4" disabled={pending} onClick={() => start(async () => setResult(await verifySignup(token)))}>
          {pending ? "Confirming…" : "Confirm my email"}
        </Button>
      )}
    </div>
  );
}
