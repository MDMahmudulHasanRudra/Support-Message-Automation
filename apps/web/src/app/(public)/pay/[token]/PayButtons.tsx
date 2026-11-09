"use client";

import { useState, useTransition } from "react";
import { PAYMENT_PROVIDER_LABEL, type PaymentProviderValue } from "@support-automation/shared";
import { Alert, Button } from "@/components/ui";
import { beginPayment } from "@/server/actions/paymentPublic";

const HINT: Record<PaymentProviderValue, string> = { SSLCOMMERZ: "Card, bKash, Nagad or bank", BKASH: "Your bKash account" };

export function PayButtons({ token, providers, returned }: { token: string; providers: PaymentProviderValue[]; returned: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (providers.length === 0) return <p className="mt-4 text-[14px] text-[color:var(--color-muted-foreground)]">Payment is not available right now.</p>;
  return (
    <div className="mt-5 space-y-2.5">
      {returned ? <Alert tone="warning">The payment was not completed. If money left your account, do not pay again: contact us first.</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {providers.map((p) => (
        <Button
          key={p}
          className="w-full"
          variant={p === providers[0] ? "primary" : "secondary"}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await beginPayment(token, p);
              if ("error" in r) setError(r.error);
              else window.location.assign(r.url);
            })
          }
        >
          Pay with {PAYMENT_PROVIDER_LABEL[p]}
        </Button>
      ))}
      <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">{providers.map((p) => HINT[p]).join(" · ")}</p>
    </div>
  );
}
