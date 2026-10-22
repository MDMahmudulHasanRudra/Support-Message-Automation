import { AsyncLocalStorage } from "node:async_hooks";
import { prisma as globalPrisma, TenantScopeError } from "@support-automation/db";
import { getSession } from "@/server/auth";
import { currentHostScope } from "@/server/hostScope";

/**
 * Which customer's copy of the software a request is about (SAAS_PLATFORM_PLAN.md §12, Layer 2).
 * `null` is the original installation — the founding customer, Customer #1 — whose rows carry no
 * customer at all, so everything that existed before multi-customer keeps exactly its meaning.
 *
 * Decided, in order, by:
 *   1. an explicit `runWithTenant` (provisioning, invitations, background work);
 *   2. an explicit project (`runWithProject`, e.g. `after()` work): that project's customer;
 *   3. the signed-in person: their own customer — a person never sees another customer's data;
 *   4. the address: a customer's address is that customer;
 *   5. the platform address has no customer: refused (the platform layer uses its own client);
 *   6. otherwise (an open address, nobody signed in — the sign-in page): the original installation,
 *      which is how every address behaves today.
 */

const explicitTenant = new AsyncLocalStorage<{ tenant: string | null }>();

export function runWithTenant<T>(tenant: string | null, fn: () => T): T {
  return explicitTenant.run({ tenant }, fn);
}

/** Set by projectContext for `runWithProject`, to avoid an import cycle. */
let explicitProject: () => { id: string; tenant?: string | null } | undefined = () => undefined;
export function registerExplicitProject(read: () => { id: string; tenant?: string | null } | undefined): void {
  explicitProject = read;
}

export async function currentTenant(): Promise<string | null> {
  const explicit = explicitTenant.getStore();
  if (explicit) return explicit.tenant;
  const project = explicitProject();
  if (project) {
    if (project.tenant !== undefined) return project.tenant;
    const row = await globalPrisma.project.findUnique({ where: { id: project.id }, select: { customerId: true } });
    return tenantOfCustomer(row?.customerId ?? null);
  }
  const session = await getSession();
  if (session) return session.tenant ?? null;
  const scope = await currentHostScope();
  if (scope.kind === "CUSTOMER") return tenantOfCustomer(scope.customerId);
  if (scope.kind === "ADMIN") throw new TenantScopeError("The platform address belongs to no customer.");
  return null;
}

/** The customer of the request, or undefined on the platform address — for code that must not throw (branding, the shell). */
export async function currentTenantOrNone(): Promise<string | null | undefined> {
  try {
    return await currentTenant();
  } catch (err) {
    if (err instanceof TenantScopeError) return undefined;
    throw err;
  }
}

const FOUNDING_TTL_MS = 10_000;
let founding: { at: number; id: string | null } | null = null;

/** The founding customer's id (the original installation adopted as Customer #1), cached briefly. */
export async function foundingCustomerId(): Promise<string | null> {
  if (founding && Date.now() - founding.at < FOUNDING_TTL_MS) return founding.id;
  const row = await globalPrisma.customer.findFirst({ where: { isFounding: true }, select: { id: true } });
  founding = { at: Date.now(), id: row?.id ?? null };
  return founding.id;
}

export function forgetFoundingCustomer(): void {
  founding = null;
}

/** A customer's tenant key: null for the founding customer, its id for every other. */
export async function tenantOfCustomer(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  return customerId === (await foundingCustomerId()) ? null : customerId;
}

/** The customer row behind a tenant key: the founding customer for null (when one was adopted). */
export async function customerOfTenant(tenant: string | null): Promise<string | null> {
  return tenant ?? (await foundingCustomerId());
}
