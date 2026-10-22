"use server";

import { redirect } from "next/navigation";
import { prisma as globalPrisma } from "@support-automation/db";
import { destroySession, getSession } from "@/server/auth";
import { closeSupportAccess } from "@/server/platform/support";

/**
 * "End support session" inside a customer's software (SAAS_PLATFORM_PLAN.md §12): closes the support
 * access, signs this browser out of the customer's address, and returns the operator to the platform.
 */
export async function endSupportSession(): Promise<void> {
  const session = await getSession();
  if (!session?.support) redirect("/login");
  const { id, customerId, operatorUsername } = session.support;
  await closeSupportAccess(id, "ENDED", operatorUsername);
  await destroySession();
  const settings = await globalPrisma.platformDomainSettings.findUnique({ where: { id: "default" }, select: { adminHostnames: true } });
  const admin = settings?.adminHostnames[0];
  const scheme = (process.env.NEXTAUTH_URL ?? "").startsWith("http://") ? "http" : "https";
  redirect(admin ? `${scheme}://${admin}/platform/customers/${customerId}` : "/login");
}
