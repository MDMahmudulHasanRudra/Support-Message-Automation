import { cookies } from "next/headers";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";

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
): Promise<void> {
  const secret = randomBytes(32).toString("base64url");
  const secretHash = hashSessionSecret(secret);

  const settings = await prisma.securitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
  const expiresAt = new Date(Date.now() + settings.sessionLifetimeHours * 60 * 60 * 1000);

  await prisma.userSession.create({
    data: {
      userId,
      secretHash,
      expiresAt,
      ipAddress: meta?.ipAddress ?? null,
      userAgent: meta?.userAgent ?? null,
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

  const record = await prisma.userSession.findUnique({
    where: { secretHash: hashSessionSecret(secret) },
    include: { user: true },
  });
  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt <= new Date()) return null;
  if (!record.user.isActive) return null;

  if (Date.now() - record.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    void prisma.userSession.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }

  return { userId: record.user.id, username: record.user.username, email: record.user.email ?? "", name: record.user.name };
}

/** Call at the top of any protected server component/page. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
