"use server";

import { globalPrisma as prisma } from "@/server/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createSession, verifyPassword } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";
import { currentHostScope, requestHostname } from "@/server/hostScope";
import { runWithTenant, tenantOfCustomer } from "@/server/tenant";
import { decryptSecret } from "@support-automation/db";
import { recordFailedSecret } from "@/server/loginLockout";
import { consumeRecoveryCode, hashRecoveryCode, verifyTotp } from "@/server/totp";
import type { HostScope } from "@support-automation/shared";

export interface LoginState {
  error?: string;
  /** The password was right and this login has two-step sign-in: ask for the code (ACCOUNT_SELF_SERVICE.md). */
  needsCode?: boolean;
}

const GENERIC_ERROR = "Invalid username or password.";

async function readRequestMeta(): Promise<{ ipAddress: string | null; userAgent: string | null }> {
  const store = await headers();
  const forwardedFor = store.get("x-forwarded-for");
  const ipAddress = forwardedFor ? forwardedFor.split(",")[0]?.trim() ?? null : null;
  return { ipAddress, userAgent: store.get("user-agent") };
}

/**
 * Whether this person may sign in on this address (SAAS_PLATFORM_PLAN.md §3.3, §12). With hostname
 * routing off every address is OPEN: unchanged — anybody signs in as before. A customer's address
 * takes that customer's people only (their own Main Admin included); the platform address takes no
 * customer's people (the platform has its own sign-in); an unknown address takes nobody. Refused
 * with the SAME message as a wrong password: an address must not reveal who has an account elsewhere.
 */
async function mayUseThisAddress(userTenant: string | null, scope: HostScope): Promise<boolean> {
  if (scope.kind === "OPEN") return true;
  if (scope.kind !== "CUSTOMER") return false;
  return (await tenantOfCustomer(scope.customerId)) === userTenant;
}

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const code = String(formData.get("code") ?? "").trim();

  if (!username || !password) {
    return { error: "Username and password are required." };
  }

  // Usernames are unique across the platform; which customer the person belongs to is checked below.
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    return { error: GENERIC_ERROR };
  }
  // Every log line and setting from here on is the person's own customer's.
  const tenant = await tenantOfCustomer(user.customerId);
  return runWithTenant(tenant, () => signIn(user, tenant, password, code));
}

async function signIn(
  user: {
    id: string;
    username: string;
    passwordHash: string;
    isActive: boolean;
    lockedUntil: Date | null;
    lastFailedLoginAt: Date | null;
    failedLoginAttempts: number;
    supportOperatorId: string | null;
    mfaSecretCiphertext: string | null;
    mfaLastUsedStep: bigint | null;
    mfaRecoveryCodeHashes: string[];
  },
  tenant: string | null,
  password: string,
  code: string,
): Promise<LoginState> {
  const username = user.username;
  // A RELQIVO support identity has no password that works: it is entered only through support access.
  if (user.supportOperatorId) {
    await logSystemEvent("WARN", "auth", "LOGIN_BLOCKED_SUPPORT_IDENTITY", { username });
    return { error: GENERIC_ERROR };
  }

  // Checked before the password itself — never reveal "locked" vs. "wrong password" to the client.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await logSystemEvent("WARN", "auth", "LOGIN_BLOCKED_LOCKED_OUT", { username });
    return { error: GENERIC_ERROR };
  }

  if (!verifyPassword(password, user.passwordHash)) {
    await recordFailedSecret(user, tenant, "LOGIN_FAILURE");
    return { error: GENERIC_ERROR };
  }

  if (!user.isActive) {
    // Deliberately the same generic message — an inactive account must not be distinguishable
    // from a wrong password to an unauthenticated caller.
    await logSystemEvent("WARN", "auth", "LOGIN_BLOCKED_INACTIVE", { username });
    return { error: GENERIC_ERROR };
  }

  const scope = await currentHostScope();
  if (!(await mayUseThisAddress(tenant, scope))) {
    await logSystemEvent("WARN", "auth", "LOGIN_BLOCKED_WRONG_ADDRESS", { username, host: await requestHostname(), scope: scope.kind });
    return { error: GENERIC_ERROR };
  }

  // Two-step sign-in: the password alone is not enough. Asked only after every other check passed, so the
  // question itself reveals nothing a wrong password would not.
  if (user.mfaSecretCiphertext) {
    if (!code) return { needsCode: true };
    if (!(await acceptSecondStep(user, code))) {
      await recordFailedSecret(user, tenant, "LOGIN_MFA_FAILURE");
      return { needsCode: true, error: "That code is not right. Use the current code from your authenticator app, or one of your recovery codes." };
    }
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lastFailedLoginAt: null, lockedUntil: null, lastLoginAt: new Date() },
  });

  const meta = await readRequestMeta();
  await createSession(user.id, meta);
  await logSystemEvent("INFO", "auth", "LOGIN_SUCCESS", { username, ...meta, twoStep: Boolean(user.mfaSecretCiphertext) }, { actorUserId: user.id });
  // Into the project the user last opened (or their only one) — /open decides.
  redirect("/open");
}

/**
 * A current authenticator code, or one unused recovery code. Each is CLAIMED by a conditional update, so the
 * same code sent twice at once signs in at most once: a code's time step must be newer than the last one
 * accepted, and a recovery code must still be in the list when it is removed.
 */
async function acceptSecondStep(
  user: { id: string; username: string; mfaSecretCiphertext: string | null; mfaLastUsedStep: bigint | null; mfaRecoveryCodeHashes: string[] },
  code: string,
): Promise<boolean> {
  if (/^\d{6}$/.test(code.replace(/\s/g, ""))) {
    const step = verifyTotp(decryptSecret(user.mfaSecretCiphertext!), code, Date.now(), user.mfaLastUsedStep);
    if (step === null) return false;
    const claimed = await prisma.user.updateMany({
      where: { id: user.id, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }] },
      data: { mfaLastUsedStep: step },
    });
    return claimed.count === 1;
  }
  const remaining = consumeRecoveryCode(user.mfaRecoveryCodeHashes, code);
  if (!remaining) return false;
  const claimed = await prisma.user.updateMany({
    where: { id: user.id, mfaRecoveryCodeHashes: { has: hashRecoveryCode(code) } },
    data: { mfaRecoveryCodeHashes: remaining },
  });
  if (claimed.count !== 1) return false;
  await logSystemEvent("WARN", "auth", "LOGIN_RECOVERY_CODE_USED", { username: user.username, remaining: remaining.length }, { actorUserId: user.id });
  return true;
}
