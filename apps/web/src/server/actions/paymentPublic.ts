"use server";

import { isPaymentProvider } from "@support-automation/shared";
import { startPayment } from "@/server/payments/core";
import { withPaymentToken } from "@/server/payments/publicPay";

/** The payment page's button (PAYMENT_LINKS.md). No session: the token in the link is the only authority, for this one link. */
export async function beginPayment(token: string, provider: unknown): Promise<{ url: string } | { error: string }> {
  if (!isPaymentProvider(provider)) return { error: "Choose how to pay." };
  const result = await withPaymentToken(token, ({ linkId }) => startPayment(linkId, token, provider));
  return result ?? { error: "This payment link is no longer available." };
}
