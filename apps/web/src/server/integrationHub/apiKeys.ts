import { createHash, randomBytes } from "node:crypto";
import { API_KEY_PREFIX, looksLikeApiKey, type ApiScope } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import type { ActiveProject } from "@/server/projectContext";

/**
 * Public API keys (INTEGRATION_HUB.md §API). A key is "ga_" + 40 random url-safe characters, shown once;
 * only its SHA-256 is stored, so a database leak does not leak working keys. A key belongs to exactly one
 * project and carries its scopes; nothing in a request can widen either.
 */

export function newApiKey(): { key: string; hash: string; prefix: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(30).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 10) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface ApiCaller {
  keyId: string;
  scopes: ApiScope[];
  project: ActiveProject;
}

/** The caller behind `Authorization: Bearer ga_…`, or why not. Touches `lastUsedAt` at most once a minute. */
export async function authenticateApiKey(authorization: string | null): Promise<ApiCaller | { status: number; error: string }> {
  const raw = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!looksLikeApiKey(raw)) return { status: 401, error: "Send an API key as Authorization: Bearer ga_…" };
  const key = await globalPrisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    include: { project: { select: { id: true, slug: true, name: true, status: true, customerId: true, billingHoldAt: true } } },
  });
  if (!key || key.revokedAt) return { status: 401, error: "This API key is not valid." };
  if (key.expiresAt && key.expiresAt < new Date()) return { status: 401, error: "This API key has expired." };
  const p = key.project;
  if (p.status !== "ACTIVE" || p.billingHoldAt) return { status: 403, error: "This workspace is not active." };
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    await globalPrisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return { keyId: key.id, scopes: key.scopes as ApiScope[], project: { id: p.id, slug: p.slug, name: p.name, status: p.status, tenant: p.customerId } };
}

/** A small per-key limit: 120 requests a minute, in this process. */
const windows = new Map<string, { start: number; count: number }>();
export function apiRateLimited(keyId: string, now = Date.now()): boolean {
  const w = windows.get(keyId);
  if (!w || now - w.start > 60_000) {
    if (windows.size > 10_000) windows.clear();
    windows.set(keyId, { start: now, count: 1 });
    return false;
  }
  w.count += 1;
  return w.count > 120;
}
