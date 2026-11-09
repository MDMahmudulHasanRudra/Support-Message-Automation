import { NextResponse, type NextRequest } from "next/server";
import { decryptSecret } from "@support-automation/db";
import type { SslCommerzCredentials } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { settleAttempt } from "@/server/payments/core";
import { validateSslCommerz } from "@/server/payments/gateways";
import { withPaymentToken } from "@/server/payments/publicPay";

export const dynamic = "force-dynamic";

/**
 * SSLCOMMERZ sends the customer's browser back here, and calls here itself (IPN). Nothing in this request is believed: only
 * its validation id is used, and SSLCOMMERZ is asked directly what that id means (PAYMENT_LINKS.md).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const isIpn = request.nextUrl.searchParams.get("r") === "ipn";
  const form = await request.formData().catch(() => null);
  const reference = String(form?.get("tran_id") ?? "");
  const valId = String(form?.get("val_id") ?? "");

  await withPaymentToken(token, async ({ linkId }) => {
    const attempt = await prisma.paymentAttempt.findFirst({ where: { linkId, provider: "SSLCOMMERZ", reference } });
    if (!attempt || !valId) return;
    const gateway = await prisma.paymentGateway.findFirst({ where: { provider: "SSLCOMMERZ" } });
    if (!gateway) return;
    const creds = JSON.parse(decryptSecret(gateway.credentialsCiphertext)) as SslCommerzCredentials;
    const verdict = await validateSslCommerz({ creds, mode: attempt.mode, valId });
    // A validation id for some other payment proves nothing about this one.
    if (verdict.state === "PAID" && verdict.reference !== attempt.reference) return;
    await settleAttempt(attempt.id, verdict);
  }).catch((err) => console.error("[payments] SSLCOMMERZ callback failed", (err as Error).message));

  if (isIpn) return new NextResponse("ok");
  return NextResponse.redirect(new URL(`/pay/${encodeURIComponent(token)}?back=1`, request.nextUrl.origin), 303);
}
