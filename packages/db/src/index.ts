import { PrismaClient } from "@prisma/client";
import type { WhatsAppServiceKey } from "@prisma/client";

// Standard Next.js/Node singleton pattern: avoids exhausting Postgres
// connections from hot-reload creating a new PrismaClient per request in dev.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/** Used by both apps' health endpoints to confirm DB connectivity. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export { PrismaClient } from "@prisma/client";

export interface ResolvedWhatsAppAccount {
  accountId: string;
  accountLabel: string;
  /** Why this account was picked — surfaced in logs/UI so multi-account behavior is never a mystery. */
  source: "CONFIGURED" | "PRIMARY_FALLBACK" | "PRIMARY_DEFAULT";
}

export interface WhatsAppAccountResolutionError {
  error: string;
}

export type WhatsAppAccountResolution = ResolvedWhatsAppAccount | WhatsAppAccountResolutionError;

export function isResolutionError(result: WhatsAppAccountResolution): result is WhatsAppAccountResolutionError {
  return "error" in result;
}

/**
 * The single centralized account resolver every WhatsApp-sending service must go through —
 * never scatter this decision across call sites. Implements the spec's exact decision tree:
 *
 *   service has a configured account?
 *     no  -> use Primary (PRIMARY_DEFAULT)
 *     yes -> is it connected?
 *              yes -> use it (CONFIGURED)
 *              no  -> follow fallbackPolicy:
 *                       STRICT_NO_FALLBACK -> clear error, never silently switch accounts
 *                       PRIMARY_FALLBACK   -> use Primary if connected (PRIMARY_FALLBACK), else error
 *
 * Never returns "some connected account" picked arbitrarily — every path either names a specific
 * account or returns an error. Callers must log the result (see the worker-side call sites) so
 * multi-account routing is traceable end to end.
 *
 * Deliberately kept in this same file rather than split out: packages/db ships as raw TypeScript
 * source (no build step — see this package's Dockerfile-consuming apps' own comments), so any
 * relative import between sibling files here is resolved differently by Node's native runtime
 * (worker, plain `node`) than by Next.js's Turbopack (web) — neither an extensionless nor a `.js`
 * specifier satisfies both at once. Zero relative imports sidesteps the incompatibility entirely.
 */
export async function resolveWhatsAppAccount(serviceKey: WhatsAppServiceKey): Promise<WhatsAppAccountResolution> {
  const [route, primary] = await Promise.all([
    prisma.whatsAppServiceRoute.findUnique({ where: { serviceKey } }),
    prisma.whatsAppAccount.findFirst({ where: { isPrimary: true } }),
  ]);

  const usePrimary = (source: "PRIMARY_DEFAULT" | "PRIMARY_FALLBACK"): WhatsAppAccountResolution => {
    if (!primary) {
      return { error: `No Primary WhatsApp account is configured, and ${serviceKey} has no specific account configured.` };
    }
    if (primary.status !== "CONNECTED") {
      return { error: `Primary WhatsApp account "${primary.label}" is not connected (status: ${primary.status}).` };
    }
    return { accountId: primary.id, accountLabel: primary.label, source };
  };

  if (!route || !route.enabled || !route.accountId) {
    return usePrimary("PRIMARY_DEFAULT");
  }

  const configured = await prisma.whatsAppAccount.findUnique({ where: { id: route.accountId } });
  if (configured && configured.status === "CONNECTED") {
    return { accountId: configured.id, accountLabel: configured.label, source: "CONFIGURED" };
  }

  if (route.fallbackPolicy === "STRICT_NO_FALLBACK") {
    return {
      error: `Configured WhatsApp account for ${serviceKey}${configured ? ` ("${configured.label}")` : ""} is unavailable, and this service is set to not fall back to Primary.`,
    };
  }

  return usePrimary("PRIMARY_FALLBACK");
}
