import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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

const AI_SECRET_ALGORITHM = "aes-256-gcm";
const AI_SECRET_IV_LENGTH = 12;

function getAiSecretKey(): Buffer {
  const secret = process.env.AI_CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) throw new Error("AI_CREDENTIALS_ENCRYPTION_KEY is not configured.");
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) {
    throw new Error("AI_CREDENTIALS_ENCRYPTION_KEY must decode to 32 bytes (generate with: openssl rand -base64 32).");
  }
  return key;
}

/**
 * Encrypts an AI provider API key for storage — never store the plaintext. Lives directly in this
 * file (not a sibling module under packages/db/src) for the same reason resolveWhatsAppAccount()
 * above does: packages/db ships as raw, uncompiled TypeScript with no build step, consumed
 * directly by both Turbopack (apps/web) and plain Node/tsx (apps/worker) — a relative import
 * between two files here has already caused a real outage from those two resolving it
 * differently. `packages/ai-client` (the only other consumer of these functions besides
 * apps/web) imports them via `@support-automation/db`, a normal cross-package import, which is
 * unaffected by that constraint.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(AI_SECRET_IV_LENGTH);
  const cipher = createCipheriv(AI_SECRET_ALGORITHM, getAiSecretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString("base64")).join(".");
}

/** Reverses encryptSecret — only ever called server-side, right before an outbound API call. */
export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, ciphertextB64] = stored.split(".");
  if (!ivB64 || !tagB64 || !ciphertextB64) throw new Error("Malformed encrypted secret.");
  const decipher = createDecipheriv(AI_SECRET_ALGORITHM, getAiSecretKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Never send the real key to the browser — show only enough to recognize which one it is. */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "••••••••";
  return `${plaintext.slice(0, 4)}••••••••${plaintext.slice(-4)}`;
}
