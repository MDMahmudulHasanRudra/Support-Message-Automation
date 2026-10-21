import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { prisma as platformPrisma } from "@support-automation/db";
import { classifyHost, hostAllowsAdminPortal, normalizeHostname, ROUTABLE_DOMAIN_STATUSES, type HostScope } from "@support-automation/shared";
import { HOST_HEADER } from "@/lib/projectPaths";

/**
 * What the request's hostname opens (SAAS_PLATFORM_PLAN.md §3.3). The rule is `classifyHost`
 * (packages/shared/src/saasDomains.ts); this file only reads the inputs: the hostname the proxy
 * forwarded, the platform's domain settings and the routable customer domains.
 *
 * With routing switched off (the default, and the state of every install until a Main Admin turns
 * it on) the answer is always OPEN and nothing anywhere behaves differently.
 */

const TTL_MS = 10_000;
let cache: { at: number; settings: Awaited<ReturnType<typeof readSettings>>; domains: Awaited<ReturnType<typeof readDomains>> } | null = null;

function readSettings() {
  return platformPrisma.platformDomainSettings.findUnique({ where: { id: "default" } });
}
function readDomains() {
  return platformPrisma.customerDomain.findMany({
    where: { status: { in: [...ROUTABLE_DOMAIN_STATUSES] } },
    select: { hostname: true, customerId: true, status: true },
  });
}

/**
 * The emergency switch (SAAS_PLATFORM_PLAN.md §8): `SAAS_HOST_ROUTING_DISABLED=true` forces routing
 * OFF whatever the database says, for recovery when the admin address has been lost. Read on every
 * call, so a test or an operator setting it takes effect without anything else changing.
 */
export function hostRoutingForcedOff(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SAAS_HOST_ROUTING_DISABLED ?? "");
}

/** Called after any change to domains or domain settings, so this process sees it at once. */
export function forgetHostScopes(): void {
  cache = null;
}

async function inputs() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const [settings, domains] = await Promise.all([readSettings(), readDomains()]);
  cache = { at: Date.now(), settings, domains };
  return cache;
}

/** The request's hostname, normalized; null outside a request or when the proxy did not run. */
export async function requestHostname(): Promise<string | null> {
  try {
    return normalizeHostname((await headers()).get(HOST_HEADER) ?? "");
  } catch {
    return null;
  }
}

/** What a hostname opens. Exported for the TLS question and tests; pages use `currentHostScope`. */
export async function hostScopeFor(hostname: string | null): Promise<HostScope> {
  if (hostRoutingForcedOff()) return { kind: "OPEN" };
  const { settings, domains } = await inputs();
  return classifyHost(hostname, settings, domains);
}

/** What THIS request's hostname opens. Outside a request it is OPEN (background work, tests). */
export async function currentHostScope(): Promise<HostScope> {
  const host = await requestHostname();
  if (host === null) return { kind: "OPEN" };
  return hostScopeFor(host);
}

/** A stable string for caches keyed on the host's meaning. */
export function hostScopeKey(scope: HostScope): string {
  return scope.kind === "ADMIN" ? `ADMIN:${scope.customerId ?? ""}` : scope.kind === "CUSTOMER" ? `CUSTOMER:${scope.customerId}` : scope.kind;
}

/** For the Main Admin Portal: on a customer's or an unknown hostname the portal does not exist. */
export async function requireAdminPortalHost(): Promise<void> {
  if (!hostAllowsAdminPortal(await currentHostScope())) notFound();
}
