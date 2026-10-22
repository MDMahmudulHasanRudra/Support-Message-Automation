import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createHash, randomBytes } from "node:crypto";
import { prisma as globalPrisma } from "@support-automation/db";
import { hashPassword, verifyPassword } from "@/server/auth";
import { currentHostScope, requestHostname } from "@/server/hostScope";
import { hostServesPlatform } from "@support-automation/shared";

/**
 * The Nexora platform's own sign-in (SAAS_PLATFORM_PLAN.md §12, Layer 1). Platform operators are
 * not customer users: their accounts, sessions and cookie are separate, the cookie is sent only to
 * /platform, and nothing a customer's role grants opens anything here — or the reverse.
 */

export const PLATFORM_COOKIE = "nexora_platform_session";
const LIFETIME_HOURS = 12;
/** Sensitive actions (support access, operators, platform email) need the password re-entered this recently. */
export const STEP_UP_MINUTES = 10;

export interface PlatformOperatorSession {
  sessionId: string;
  operatorId: string;
  username: string;
  name: string;
  canSupport: boolean;
  stepUpAt: Date | null;
}

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

export async function createOperatorSession(operatorId: string): Promise<void> {
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + LIFETIME_HOURS * 3_600_000);
  await globalPrisma.platformOperatorSession.create({
    data: { operatorId, secretHash: hashSecret(secret), expiresAt, hostname: await requestHostname(), stepUpAt: new Date() },
  });
  (await cookies()).set(PLATFORM_COOKIE, secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    sameSite: "lax",
    path: "/platform",
    expires: expiresAt,
  });
}

export async function destroyOperatorSession(): Promise<void> {
  const store = await cookies();
  const secret = store.get(PLATFORM_COOKIE)?.value;
  if (secret) await globalPrisma.platformOperatorSession.updateMany({ where: { secretHash: hashSecret(secret) }, data: { revokedAt: new Date() } });
  store.delete({ name: PLATFORM_COOKIE, path: "/platform" });
}

export async function getOperator(): Promise<PlatformOperatorSession | null> {
  const secret = (await cookies()).get(PLATFORM_COOKIE)?.value;
  if (!secret) return null;
  return loadOperator(secret, await requestHostname());
}

const loadOperator = cache(async (secret: string, host: string | null): Promise<PlatformOperatorSession | null> => {
  const row = await globalPrisma.platformOperatorSession.findUnique({ where: { secretHash: hashSecret(secret) }, include: { operator: true } });
  if (!row || row.revokedAt || row.expiresAt <= new Date() || !row.operator.isActive) return null;
  if (row.hostname && host && row.hostname !== host) return null;
  if (Date.now() - row.lastUsedAt.getTime() > 5 * 60_000) {
    void globalPrisma.platformOperatorSession.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return { sessionId: row.id, operatorId: row.operatorId, username: row.operator.username, name: row.operator.name, canSupport: row.operator.canSupport, stepUpAt: row.stepUpAt };
});

/** For a platform page: the platform address (or an open one) and a signed-in operator, else the platform sign-in. */
export async function requireOperatorPage(): Promise<PlatformOperatorSession> {
  if (!hostServesPlatform(await currentHostScope())) notFound();
  const operator = await getOperator();
  if (!operator) redirect("/platform/login");
  return operator;
}

/** For a platform Server Action (a public endpoint): the operator, or a refusal to show. */
export async function requireOperatorAction(): Promise<{ operator: PlatformOperatorSession } | { denied: string }> {
  if (!hostServesPlatform(await currentHostScope())) return { denied: "The Nexora platform is not available on this address." };
  const operator = await getOperator();
  return operator ? { operator } : { denied: "Your platform session has ended. Sign in again." };
}

/**
 * Re-check the operator's password for a sensitive action (support access, operators, platform
 * email). A correct password also refreshes the session's step-up time.
 */
export async function confirmOperatorPassword(operator: PlatformOperatorSession, password: unknown): Promise<boolean> {
  const row = await globalPrisma.platformOperator.findUnique({ where: { id: operator.operatorId }, select: { passwordHash: true, isActive: true } });
  if (!row?.isActive || typeof password !== "string" || !password || !verifyPassword(password, row.passwordHash)) return false;
  await globalPrisma.platformOperatorSession.update({ where: { id: operator.sessionId }, data: { stepUpAt: new Date() } });
  return true;
}

export { hashPassword as hashOperatorPassword };
