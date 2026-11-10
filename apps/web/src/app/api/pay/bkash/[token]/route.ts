import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { verifyBkashCallback } from "@/server/payments/core";
import { withPaymentToken } from "@/server/payments/publicPay";

export const dynamic = "force-dynamic";

/** bKash sends the customer's browser back here. The status it names is ignored: the payment is executed and read from bKash. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const paymentId = request.nextUrl.searchParams.get("paymentID") ?? "";
  const status = request.nextUrl.searchParams.get("status");
  if (paymentId && status === "success") {
    await withPaymentToken(token, async ({ linkId }) => {
      const attempt = await prisma.paymentAttempt.findFirst({ where: { linkId, provider: "BKASH", sessionRef: paymentId } });
      if (attempt) await verifyBkashCallback(attempt.id, paymentId);
    }).catch((err) => console.error("[payments] bKash callback failed", (err as Error).message));
  }
  return NextResponse.redirect(new URL(`/pay/${encodeURIComponent(token)}?back=1`, request.nextUrl.origin), 303);
}
