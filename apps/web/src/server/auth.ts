import { cache } from "react";
import { cookies } from "next/headers";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { prisma, tenantSingletonId } from "@support-automation/db";
import { requestHostname } from "@/server/hostScope";

const SESSION_COOKIE = "support_automation_session";
// A DB row's lastUsedAt is only refreshed at most this often per session — every page load
// hitting requireSession() would otherwise be a write on every single request.
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

/** Matches the "salt:hash" scrypt format used by packages/db/prisma/seed.ts. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

function hashSessionSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export interface Session {
  userId: string;
  username: string;
  email: string;
  name: string;
  /** The customer whose copy of the software this person belongs to; null or absent = the original installation (SAAS_PLATFORM_PLAN.md §12). */
  tenant?: string | null;
  /** Set when this is a Nexora operator's audited support session (§12): visible, time-limited, revocable. */
  support?: SupportAccessInfo | null;
}

export interface SupportAccessInfo {
  id: string;
  operatorUsername: string;
  customerId: string;
  reason: string;
  expiresAt: Date;
}

/**
 * Real, server-side-revocable session (packages/db/prisma/schema.prisma's UserSession) —
 * replaces the old stateless signed-cookie token, which had no way for an admin to force a
 * logout. The cookie carries only a random high-entropy secret; only its sha256 is ever
 * persisted, so a lookup is an indexed equality match against secretHash, never a scan, and the
 * raw secret is never recoverable from the database alone.
 */
export async function createSession(
  userId: string,
  meta?: { ipAddress?: string | null; userAgent?: string | null },
  support?: { supportAccessSessionId: string; expiresAt: Date },
): Promise<void> {
  const secret = randomBytes(32).toString("base64url");
  const secretHash = hashSessionSecret(secret);

  // The lifetime is the person's own customer's setting (one SecuritySettings row per customer).
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { customerId: true } });
  const tenant = user?.customerId ?? null;
  const settingsId = tenantSingletonId("SecuritySettings", tenant)!;
  const settings = await prisma.securitySettings.upsert({
    where: { id: settingsId },
    update: {},
    create: { id: settingsId, customerId: tenant },
  });
  // A support session ends with its support access, never later.
  const expiresAt = support?.expiresAt ?? new Date(Date.now() + settings.sessionLifetimeHours * 60 * 60 * 1000);

  await prisma.userSession.create({
    data: {
      userId,
      secretHash,
      expiresAt,
      // The address it was made on: refused on any other (SAAS_PLATFORM_PLAN.md §3.3).
      hostname: await requestHostname(),
      ipAddress: meta?.ipAddress ?? null,
      userAgent: meta?.userAgent ?? null,
      supportAccessSessionId: support?.supportAccessSessionId ?? null,
    },
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, secret, {
    httpOnly: true,
    // COOKIE_SECURE=false is an explicit opt-out for deployments running plain HTTP with no
    // TLS-terminating reverse proxy in front — a Secure cookie is silently dropped by the browser
    // in that case, which otherwise looks like the app logging the user out on every click.
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Revokes the session tied to the current cookie (real revocation, not just clearing the cookie) and clears it. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const secret = store.get(SESSION_COOKIE)?.value;
  if (secret) {
    await prisma.userSession.updateMany({
      where: { secretHash: hashSessionSecret(secret) },
      data: { revokedAt: new Date(), revokedReason: "USER_LOGOUT" },
    });
  }
  store.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const secret = store.get(SESSION_COOKIE)?.value;
  if (!secret) return null;
  return loadSession(secret, await requestHostname());
}

/**
 * One lookup per request per cookie value: every customer-scoped query asks for the session's
 * customer, so this is memoized for the request (React `cache`). Keyed by the cookie value, so a
 * session created later in the same request is read fresh.
 */
const loadSession = cache(async (secret: string, host: string | null): Promise<Session | null> => {
  const record = await prisma.userSession.findUnique({
    where: { secretHash: hashSessionSecret(secret) },
    include: { user: true, supportAccessSession: true },
  });
  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt <= new Date()) return null;
  if (!record.user.isActive) return null;
  // A session belongs to the address it was created on. Cookies are host-only already; this also
  // refuses a cookie copied to another customer's address by hand. Older sessions (no hostname) and
  // requests the proxy did not see (background work) are not affected.
  if (record.hostname && host && host !== record.hostname) return null;
  // A support session lives exactly as long as its support access: ended, revoked or expired ends it.
  const access = record.supportAccessSession;
  if (record.supportAccessSessionId && (!access || access.endedAt || access.expiresAt <= new Date())) return null;

  if (Date.now() - record.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    void prisma.userSession.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }

  return {
    userId: record.user.id,
    username: record.user.username,
    email: record.user.email ?? "",
    name: record.user.name,
    tenant: record.user.customerId ?? null,
    support: access
      ? { id: access.id, operatorUsername: access.operatorUsername, customerId: access.customerId, reason: access.reason, expiresAt: access.expiresAt }
      : null,
  };
});

/** Call at the top of any protected server component/page. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
