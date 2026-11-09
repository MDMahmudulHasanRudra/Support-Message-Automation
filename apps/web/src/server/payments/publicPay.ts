import { tenantOfCustomer } from "@/server/tenant";
import { runWithProject } from "@/server/projectContext";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { projectOfPaymentToken } from "@/server/platform/paymentLookup";

/** Runs `fn` inside the project a public payment token belongs to. Null when the link does not exist or cannot be used. */
export async function withPaymentToken<T>(token: string, fn: (ctx: { linkId: string; projectName: string }) => Promise<T>): Promise<T | null> {
  const found = await projectOfPaymentToken(token);
  if (!found) return null;
  const { project } = found;
  const active = { id: project.id, slug: project.slug, name: project.name, status: project.status, tenant: await tenantOfCustomer(project.customerId) };
  return runWithProject(active as never, async () => {
    // Read inside the project: this request has no session to say whose it is.
    if ((await disabledFeaturesFor(project.id)).has("PAYMENT_LINKS")) return null;
    return fn({ linkId: found.linkId, projectName: project.name });
  });
}
