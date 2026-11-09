import { createHash, randomBytes } from "node:crypto";
import { isReadOnlyProjectStatus } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import { foundingCustomerId } from "@/server/tenant";
import { invitationBaseUrl } from "@/server/platform/billing";

/**
 * Finding a payment link's project from its public token (PAYMENT_LINKS.md). The one read across projects, because a
 * customer paying has no session and the URL is all there is. Everything after this runs inside that project.
 */

export const hashPaymentToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newPaymentToken = () => randomBytes(24).toString("base64url");

export async function projectOfPaymentToken(token: string) {
  if (typeof token !== "string" || token.length > 80) return null;
  const link = await globalPrisma.paymentLink.findUnique({
    where: { tokenHash: hashPaymentToken(token) },
    select: { id: true, project: { select: { id: true, slug: true, name: true, status: true, billingHoldAt: true, customerId: true } } },
  });
  if (!link || isReadOnlyProjectStatus(link.project.status) || link.project.billingHoldAt) return null;
  return { linkId: link.id, project: link.project };
}

/** The address a customer opens: their business's own, or the platform's while it has none. */
export async function paymentBaseUrl(customerId: string | null): Promise<string> {
  const id = customerId ?? (await foundingCustomerId());
  const platform = (process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "");
  if (!id) return platform;
  const base = await invitationBaseUrl(id);
  return "url" in base ? base.url : platform;
}
