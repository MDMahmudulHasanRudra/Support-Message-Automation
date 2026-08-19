import { afterEach, describe, expect, it } from "vitest";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { prisma } from "@support-automation/db";

/**
 * apps/web has no test infrastructure (server actions need next/headers' request-scoped
 * cookies(), same limitation every prior slice in this repo has already accepted), so this suite
 * hand-mirrors the exact Prisma reads/writes apps/web/src/server/auth.ts and
 * apps/web/src/server/actions/{users,sessions}.ts perform, to validate the SCHEMA AND
 * DATA-LAYER CONTRACTS the real functions depend on: session validity filtering, multi-device
 * independence, revocation scoping, password-reset invalidation, and cascade-on-delete. The real
 * cookie round-trip, request-scoped IP/user-agent capture, and redirect() control flow cannot run
 * outside a real Next.js request and are verified manually instead (see the final report).
 */

const createdUserIds: string[] = [];

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

async function createTestUser(overrides: Partial<{ isActive: boolean }> = {}) {
  const user = await prisma.user.create({
    data: {
      username: `session-test-${randomUUID()}`,
      name: "Session Test User",
      passwordHash: "unused:unused",
      isActive: overrides.isActive ?? true,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

/** Mirrors auth.ts's createSession() exactly, minus the cookie write. */
async function createTestSession(userId: string, expiresInMs = 24 * 60 * 60 * 1000) {
  const secret = randomBytes(32).toString("base64url");
  const secretHash = hashSecret(secret);
  const session = await prisma.userSession.create({
    data: { userId, secretHash, expiresAt: new Date(Date.now() + expiresInMs) },
  });
  return { secret, session };
}

/** Mirrors auth.ts's getSession() validity check (excluding the cookie read itself). */
async function isSessionValid(sessionId: string): Promise<boolean> {
  const record = await prisma.userSession.findUnique({ where: { id: sessionId }, include: { user: true } });
  if (!record) return false;
  if (record.revokedAt) return false;
  if (record.expiresAt <= new Date()) return false;
  if (!record.user.isActive) return false;
  return true;
}

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }); // cascades UserSession
    createdUserIds.length = 0;
  }
});

describe("UserSession validity", () => {
  it("a freshly created session is valid", async () => {
    const user = await createTestUser();
    const { session } = await createTestSession(user.id);
    expect(await isSessionValid(session.id)).toBe(true);
  });

  it("an expired session is rejected even though it was never revoked", async () => {
    const user = await createTestUser();
    const { session } = await createTestSession(user.id, -1000); // already expired
    expect(await isSessionValid(session.id)).toBe(false);
  });

  it("a revoked session is rejected even though it has not expired", async () => {
    const user = await createTestUser();
    const { session } = await createTestSession(user.id);
    await prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: "USER_LOGOUT" } });
    expect(await isSessionValid(session.id)).toBe(false);
  });

  it("every session for a deactivated user is rejected, even though the sessions themselves are untouched", async () => {
    const user = await createTestUser();
    const { session } = await createTestSession(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect(await isSessionValid(session.id)).toBe(false);
    // The session row itself was never revoked — getSession() must check user.isActive
    // independently, not rely on deactivation cascading into revokedAt.
    const raw = await prisma.userSession.findUnique({ where: { id: session.id } });
    expect(raw?.revokedAt).toBeNull();
  });
});

describe("Multi-device independence", () => {
  it("revoking one of three sessions leaves the other two valid", async () => {
    const user = await createTestUser();
    const a = await createTestSession(user.id);
    const b = await createTestSession(user.id);
    const c = await createTestSession(user.id);

    await prisma.userSession.update({ where: { id: a.session.id }, data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED" } });

    expect(await isSessionValid(a.session.id)).toBe(false);
    expect(await isSessionValid(b.session.id)).toBe(true);
    expect(await isSessionValid(c.session.id)).toBe(true);
  });

  it("revokeAllOtherSessions-style update only touches the given user's other sessions, sparing the current one", async () => {
    const user = await createTestUser();
    const otherUser = await createTestUser();
    const current = await createTestSession(user.id);
    const other1 = await createTestSession(user.id);
    const other2 = await createTestSession(user.id);
    const unrelated = await createTestSession(otherUser.id);

    const result = await prisma.userSession.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: current.session.id } },
      data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED" },
    });

    expect(result.count).toBe(2);
    expect(await isSessionValid(current.session.id)).toBe(true);
    expect(await isSessionValid(other1.session.id)).toBe(false);
    expect(await isSessionValid(other2.session.id)).toBe(false);
    expect(await isSessionValid(unrelated.session.id)).toBe(true);
  });
});

describe("Password reset / deactivation invalidation", () => {
  it("resetting a password revokes every session for that user (mirrors resetUserPassword())", async () => {
    const user = await createTestUser();
    const a = await createTestSession(user.id);
    const b = await createTestSession(user.id);

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash: "newsalt:newhash" } }),
      prisma.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "PASSWORD_CHANGED" },
      }),
    ]);

    expect(await isSessionValid(a.session.id)).toBe(false);
    expect(await isSessionValid(b.session.id)).toBe(false);
  });

  it("deactivating a user revokes every session for that user (mirrors setUserActive(false))", async () => {
    const user = await createTestUser();
    const a = await createTestSession(user.id);
    const b = await createTestSession(user.id);

    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    await prisma.userSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED" },
    });

    const rows = await prisma.userSession.findMany({ where: { id: { in: [a.session.id, b.session.id] } } });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });
});

describe("Cascade delete", () => {
  it("deleting a User row cascades to delete its UserSession rows", async () => {
    const user = await createTestUser();
    const { session } = await createTestSession(user.id);

    await prisma.user.delete({ where: { id: user.id } });
    createdUserIds.length = 0; // already deleted, don't try again in afterEach

    const remaining = await prisma.userSession.findUnique({ where: { id: session.id } });
    expect(remaining).toBeNull();
  });
});

describe("Login lockout counter (mirrors login/actions.ts)", () => {
  it("failed attempts within the window accumulate toward the threshold, and crossing it sets lockedUntil", async () => {
    const user = await createTestUser();
    const threshold = 5;
    const windowMinutes = 15;
    const lockoutDurationMinutes = 15;

    let current = user;
    for (let i = 1; i <= threshold; i++) {
      const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
      const attemptsInWindow = current.lastFailedLoginAt && current.lastFailedLoginAt > windowStart ? current.failedLoginAttempts + 1 : 1;
      const now = new Date();
      const data =
        attemptsInWindow >= threshold
          ? { failedLoginAttempts: attemptsInWindow, lastFailedLoginAt: now, lockedUntil: new Date(now.getTime() + lockoutDurationMinutes * 60 * 1000) }
          : { failedLoginAttempts: attemptsInWindow, lastFailedLoginAt: now };
      current = await prisma.user.update({ where: { id: current.id }, data });
    }

    expect(current.failedLoginAttempts).toBe(threshold);
    expect(current.lockedUntil).not.toBeNull();
    expect(current.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("a failed attempt outside the lockout window resets the counter to 1 rather than compounding", async () => {
    const user = await createTestUser();
    const staleFailure = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 4, lastFailedLoginAt: staleFailure } });

    const windowMinutes = 15;
    const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
    const attemptsInWindow = reloaded.lastFailedLoginAt && reloaded.lastFailedLoginAt > windowStart ? reloaded.failedLoginAttempts + 1 : 1;

    expect(attemptsInWindow).toBe(1);
  });

  it("a successful login resets failedLoginAttempts, lastFailedLoginAt, and lockedUntil", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 5, lastFailedLoginAt: new Date(), lockedUntil: new Date(Date.now() + 60_000) },
    });

    const afterSuccess = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lastFailedLoginAt: null, lockedUntil: null, lastLoginAt: new Date() },
    });

    expect(afterSuccess.failedLoginAttempts).toBe(0);
    expect(afterSuccess.lastFailedLoginAt).toBeNull();
    expect(afterSuccess.lockedUntil).toBeNull();
  });
});
