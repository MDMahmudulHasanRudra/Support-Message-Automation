"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { WhatsAppFallbackPolicy, WhatsAppServiceKey } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface ServiceRouteFormState {
  error?: string;
  success?: boolean;
}

/**
 * The only write path for WhatsAppServiceRoute. accountId "" from the <select> means
 * "use Primary" — stored as a null accountId, which resolveWhatsAppAccount treats as
 * unconfigured and falls through to Primary. fallbackPolicy only matters once a specific
 * account is set, but is stored either way so it's remembered if the admin switches back.
 */
export async function updateServiceRoute(
  _prevState: ServiceRouteFormState,
  formData: FormData,
): Promise<ServiceRouteFormState> {
  const session = await requireSession();
  const serviceKey = formData.get("serviceKey") as WhatsAppServiceKey;
  const rawAccountId = String(formData.get("accountId") ?? "");
  const accountId = rawAccountId === "" ? null : rawAccountId;
  const fallbackPolicy = formData.get("fallbackPolicy") as WhatsAppFallbackPolicy;

  const [previous, account] = await Promise.all([
    prisma.whatsAppServiceRoute.findUnique({ where: { serviceKey } }),
    accountId ? prisma.whatsAppAccount.findUnique({ where: { id: accountId } }) : Promise.resolve(null),
  ]);
  if (accountId && !account) {
    return { error: "Selected account no longer exists." };
  }

  await prisma.whatsAppServiceRoute.upsert({
    where: { serviceKey },
    update: { accountId, fallbackPolicy, enabled: true },
    create: { serviceKey, accountId, fallbackPolicy, enabled: true },
  });

  await logSystemEvent("INFO", "whatsapp-routing", `Service route changed for ${serviceKey}`, {
    serviceKey,
    previousAccountId: previous?.accountId ?? null,
    newAccountId: accountId,
    fallbackPolicy,
    changedBy: session.username,
  });

  revalidatePath("/accounts/routing");
  return { success: true };
}
