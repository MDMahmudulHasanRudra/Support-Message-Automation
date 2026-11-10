"use client";

import { useTransition } from "react";
import { Button, useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { cancelPaymentLink, clearPaymentAttention, recheckPayment } from "@/server/actions/paymentLinks";

export function PaymentActions({ id, canCancel, canClear, canRecheck }: { id: string; canCancel: boolean; canClear: boolean; canRecheck: boolean }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [pending, start] = useTransition();
  const run = (work: () => Promise<{ error: string } | object>, done: string) =>
    start(async () => {
      const r = await work();
      if ("error" in r) showToast({ tone: "danger", title: r.error as string });
      else showToast({ tone: "success", title: done });
      router.refresh();
    });
  if (!canCancel && !canClear && !canRecheck) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {canRecheck ? (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => recheckPayment(id), "Checked with the payment service")}>
          Check again
        </Button>
      ) : null}
      {canClear ? (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => clearPaymentAttention(id), "Marked as checked")}>
          Mark as checked
        </Button>
      ) : null}
      {canCancel ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => window.confirm("Cancel this link? The customer will not be able to pay with it.") && run(() => cancelPaymentLink(id), "Cancelled")}>
          Cancel link
        </Button>
      ) : null}
    </div>
  );
}
