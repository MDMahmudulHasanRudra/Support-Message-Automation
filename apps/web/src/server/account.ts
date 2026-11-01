import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { globalPrisma } from "@/server/db";
import type { Session } from "@/server/auth";

/**
 * My account (ACCOUNT_SELF_SERVICE.md): what a signed-in person may see about their OWN login — profile,
 * sign-in security, their devices and their recent sign-in activity. Read with the unscoped client by the
 * session's own user id, so it never depends on which project or address the page is opened from, and it
 * never reads anybody else's row.
 */

const SESSION_COOKIE = "support_automation_session";
const ACTIVITY_LIMIT = 30;

/** Sign-in and account events a person may see about themselves. */
export const SECURITY_EVENTS = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILURE",
  "LOGIN_MFA_FAILURE",
  "LOGIN_LOCKED_OUT",
  "LOGIN_RECOVERY_CODE_USED",
  "ACCOUNT_PASSWORD_CHECK_FAILED",
  "ACCOUNT_PROFILE_UPDATED",
  "ACCOUNT_USERNAME_CHANGED",
  "ACCOUNT_PASSWORD_CHANGED",
  "ACCOUNT_SESSION_REVOKED",
  "ACCOUNT_OTHER_SESSIONS_REVOKED",
  "ACCOUNT_MFA_ENABLED",
  "ACCOUNT_MFA_DISABLED",
  "ACCOUNT_RECOVERY_CODES_REPLACED",
  "ACCOUNT_PHOTO_CHANGED",
  "ACCOUNT_PHOTO_REMOVED",
  "USER_MFA_RESET",
  "PASSWORD_RESET",
] as const;

export const SECURITY_EVENT_LABELS: Record<(typeof SECURITY_EVENTS)[number], string> = {
  LOGIN_SUCCESS: "Signed in",
  LOGIN_FAILURE: "Wrong password at sign-in",
  LOGIN_MFA_FAILURE: "Wrong two-step code at sign-in",
  LOGIN_LOCKED_OUT: "Sign-in locked after too many attempts",
  LOGIN_RECOVERY_CODE_USED: "Signed in with a recovery code",
  ACCOUNT_PASSWORD_CHECK_FAILED: "Wrong current password on My account",
  ACCOUNT_PROFILE_UPDATED: "Profile updated",
  ACCOUNT_USERNAME_CHANGED: "Username changed",
  ACCOUNT_PASSWORD_CHANGED: "Password changed",
  ACCOUNT_SESSION_REVOKED: "A device was signed out",
  ACCOUNT_OTHER_SESSIONS_REVOKED: "Every other device was signed out",
  ACCOUNT_MFA_ENABLED: "Two-step sign-in turned on",
  ACCOUNT_MFA_DISABLED: "Two-step sign-in turned off",
  ACCOUNT_RECOVERY_CODES_REPLACED: "New recovery codes made",
  ACCOUNT_PHOTO_CHANGED: "Profile photo changed",
  ACCOUNT_PHOTO_REMOVED: "Profile photo removed",
  USER_MFA_RESET: "Two-step sign-in reset by an administrator",
  PASSWORD_RESET: "Password reset by an administrator",
};

export interface MyAccount {
  id: string;
  username: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  usernameChangedAt: Date | null;
  mfaEnabledAt: Date | null;
  mfaSetupPending: boolean;
  recoveryCodesLeft: number;
  avatarUrl: string | null;
  employee: { code: string; department: string | null; jobTitle: string | null } | null;
  isSupportIdentity: boolean;
}

export async function getMyAccount(session: Session): Promise<MyAccount | null> {
  const user = await globalPrisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      phone: true,
      createdAt: true,
      lastLoginAt: true,
      passwordChangedAt: true,
      usernameChangedAt: true,
      mfaEnabledAt: true,
      mfaSecretCiphertext: true,
      mfaPendingSecretCiphertext: true,
      mfaRecoveryCodeHashes: true,
      supportOperatorId: true,
      permissionModule: { select: { name: true } },
      avatar: { select: { version: true } },
      employee: { select: { employeeCode: true, department: { select: { name: true } }, jobTitle: { select: { name: true } } } },
    },
  });
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.permissionModule?.name ?? null,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    passwordChangedAt: user.passwordChangedAt,
    usernameChangedAt: user.usernameChangedAt,
    mfaEnabledAt: user.mfaSecretCiphertext ? user.mfaEnabledAt : null,
    mfaSetupPending: !user.mfaSecretCiphertext && Boolean(user.mfaPendingSecretCiphertext),
    recoveryCodesLeft: user.mfaRecoveryCodeHashes.length,
    avatarUrl: user.avatar ? userAvatarUrl(user.id, user.avatar.version) : null,
    employee: user.employee ? { code: user.employee.employeeCode, department: user.employee.department?.name ?? null, jobTitle: user.employee.jobTitle?.name ?? null } : null,
    isSupportIdentity: Boolean(user.supportOperatorId),
  };
}

export function userAvatarUrl(userId: string, version: number): string {
  return `/api/account/avatar/${encodeURIComponent(userId)}?v=${version}`;
}

/** The UserSession row of the browser making this request. */
export async function currentSessionRowId(): Promise<string | null> {
  const secret = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!secret) return null;
  const secretHash = createHash("sha256").update(secret).digest("hex");
  return (await globalPrisma.userSession.findUnique({ where: { secretHash }, select: { id: true } }))?.id ?? null;
}

export interface MyDevice {
  id: string;
  current: boolean;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  device: string;
}

export async function getMyDevices(session: Session): Promise<MyDevice[]> {
  const [current, rows] = await Promise.all([
    currentSessionRowId(),
    globalPrisma.userSession.findMany({
      where: { userId: session.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
      take: 50,
      select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, ipAddress: true, userAgent: true },
    }),
  ]);
  return rows
    .map((row) => ({ id: row.id, current: row.id === current, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, expiresAt: row.expiresAt, ipAddress: row.ipAddress, device: describeUserAgent(row.userAgent) }))
    .sort((a, b) => Number(b.current) - Number(a.current));
}

export interface MySecurityEvent {
  id: string;
  at: Date;
  event: string;
  label: string;
  ipAddress: string | null;
  device: string | null;
}

/** The person's own recent sign-in and account events, newest first. Their own rows only (actorUserId). */
export async function getMySecurityActivity(session: Session): Promise<MySecurityEvent[]> {
  const rows = await globalPrisma.systemLog.findMany({
    where: {
      OR: [
        { actorUserId: session.userId, message: { in: [...SECURITY_EVENTS] } },
        // An administrator's reset is logged with the administrator as the actor and this person as the target.
        { targetType: "User", targetId: session.userId, message: { in: ["USER_MFA_RESET", "PASSWORD_RESET"] } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: ACTIVITY_LIMIT,
    select: { id: true, createdAt: true, message: true, metadata: true },
  });
  return rows.map((row) => {
    const meta = (row.metadata ?? {}) as { ipAddress?: unknown; userAgent?: unknown };
    return {
      id: row.id,
      at: row.createdAt,
      event: row.message,
      label: SECURITY_EVENT_LABELS[row.message as (typeof SECURITY_EVENTS)[number]] ?? row.message,
      ipAddress: typeof meta.ipAddress === "string" ? meta.ipAddress : null,
      device: typeof meta.userAgent === "string" ? describeUserAgent(meta.userAgent) : null,
    };
  });
}

/** "Chrome on Windows" from a user-agent string — a hint for recognising a device, never an identity. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}
