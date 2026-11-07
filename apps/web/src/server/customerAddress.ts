import type { NextRequest } from "next/server";
import { prisma as globalPrisma } from "@support-automation/db";
import { normalizeHostname, pickCustomerOrigin } from "@support-automation/shared";
import { visitedHost } from "@/lib/projectPaths";
import { hostRoutingIsOn, requestHostname } from "@/server/hostScope";
import { requireActiveProject } from "@/server/projectContext";
import { foundingCustomerId } from "@/server/tenant";

/**
 * Which web address belongs to a project: what goes into its widget code, chat links, webhook addresses and
 * signed links. One server serves many customers, so NEXTAUTH_URL (`installationOrigin`) names one address and is
 * nobody else's to hand out. A customer's address comes from its own domains; the rule is `pickCustomerOrigin`.
 */

/** The address in NEXTAUTH_URL: the installation's, for what is not about one customer. */
export function installationOrigin(): string | null {
  const raw = process.env.NEXTAUTH_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Works without a request too (background work): then it is simply the customer's first address. */
export async function publicOriginForProject(projectId: string): Promise<string | null> {
  const fallback = installationOrigin();
  if (!(await hostRoutingIsOn())) return fallback;
  const [project, founding, visited] = await Promise.all([
    globalPrisma.project.findUnique({ where: { id: projectId }, select: { customerId: true } }),
    foundingCustomerId(),
    requestHostname(),
  ]);
  // A project with no customer is the original installation's, which is the founding customer's.
  const customerId = project?.customerId ?? founding;
  const domains = customerId
    ? await globalPrisma.customerDomain.findMany({
        where: { customerId, status: { in: ["ACTIVE", "VERIFIED"] } },
        orderBy: [{ activatedAt: "asc" }, { verifiedAt: "asc" }],
        select: { hostname: true, status: true },
      })
    : [];
  return pickCustomerOrigin({
    routingOn: true,
    fallback,
    scheme: fallback?.startsWith("http://") ? "http" : "https",
    visitedHost: visited,
    domains,
    isOriginalInstallation: !customerId || customerId === founding,
  });
}

/** The address of the project this request is in. */
export async function activeProjectOrigin(): Promise<string | null> {
  return publicOriginForProject((await requireActiveProject()).id);
}

/** The address this request came in on, as the person's browser sees it: where to send them back to. */
export function requestOrigin(request: NextRequest): string {
  const host = normalizeHostname(visitedHost(request.headers));
  if (!host) return new URL(request.url).origin;
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return `${forwarded || request.nextUrl.protocol.replace(":", "")}://${request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || host}`;
}
