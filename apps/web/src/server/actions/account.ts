"use server";

import { revalidatePath } from "next/cache";
import { decryptSecret, encryptSecret } from "@support-automation/db";
import { prepareClientPhoto } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import { hashPassword, requireSession, verifyPassword, type Session } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";
import { recordFailedSecret } from "@/server/loginLockout";
import { currentSessionRowId } from "@/server/account";
import { getBranding } from "@/server/branding";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { normalizeUsername, validateNewPassword, validateUsername } from "@/lib/userRules";
import {
  formatSecretForTyping,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "@/server/totp";

/**
 * My account (ACCOUNT_SELF_SERVICE.md). Every action here changes ONLY the signed-in person's own login,
 * taken from the session — never an id from the form — so none needs a permission key. Rules:
 *
 *   - Changing the username, the password or two-step sign-in needs the CURRENT password (or a current
 *     code), and a wrong one counts toward the sign-in lockout like a wrong password at the sign-in page.
 *   - A support identity (a RELQIVO operator inside a customer) cannot change anything here.
 *   - Every change is a System Log entry with the person as the actor, which is what "Recent activity" reads.
 */

export interface AccountFormState {
  error?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
}

const PATH = "/account";
const SUPPORT_REFUSAL = "A support session cannot change this account.";

type OwnUser = NonNullable<Awaited<ReturnType<typeof loadOwnUser>>>;

async function loadOwnUser(session: Session) {
  return globalPrisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      username: true,
      email: true,
      passwordHash: true,
      customerId: true,
      supportOperatorId: true,
      failedLoginAttempts: true,
      lastFailedLoginAt: true,
      lockedUntil: true,
      mfaSecretCiphertext: true,
      mfaPendingSecretCiphertext: true,
      mfaLastUsedStep: true,
    },
  });
}

async function self(): Promise<{ session: Session; user: OwnUser } | { error: string }> {
  const session = await requireSession();
  if (session.support) return { error: SUPPORT_REFUSAL };
  const user = await loadOwnUser(session);
  if (!user) return { error: "Your account no longer exists. Sign in again." };
  if (user.supportOperatorId) return { error: SUPPORT_REFUSAL };
  return { session, user };
}

/** The current password, counted toward the lockout when wrong. A locked account is refused outright. */
async function checkCurrentPassword(user: OwnUser, password: string): Promise<string | null> {
  if (user.lockedUntil && user.lockedUntil > new Date()) return "Too many wrong attempts. Wait a few minutes and try again.";
  if (!password) return "Enter your current password.";
  if (!verifyPassword(password, user.passwordHash)) {
    await recordFailedSecret(user, user.customerId, "ACCOUNT_PASSWORD_CHECK_FAILED");
    return "Your current password is not right.";
  }
  return null;
}

function log(session: Session, event: string, meta: Record<string, unknown> = {}, level: "INFO" | "WARN" = "INFO") {
  return logSystemEvent(level, "account", event, meta, { actorUserId: session.userId, targetType: "User", targetId: session.userId });
}

// --- Profile ---------------------------------------------------------------------------------------

export async function updateMyProfile(_prev: AccountFormState, form: FormData): Promise<AccountFormState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim().toLowerCase() || null;
  const phone = String(form.get("phone") ?? "").trim() || null;

  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = "Your name is required.";
  else if (name.length > 120) fieldErrors.name = "Keep your name under 120 characters.";
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fieldErrors.email = "That email address does not look right.";
  if (phone && (phone.length > 40 || !/^[+()\d\s.-]{5,}$/.test(phone))) fieldErrors.phone = "Use digits, spaces, + ( ) - only.";
  if (Object.keys(fieldErrors).length) return { fieldErrors };

  if (email && email !== me.user.email) {
    const holder = await globalPrisma.user.findUnique({ where: { email }, select: { id: true } });
    if (holder && holder.id !== me.user.id) return { fieldErrors: { email: "Another login already uses that email address." } };
  }
  try {
    await globalPrisma.user.update({ where: { id: me.user.id }, data: { name, email, phone } });
  } catch (err) {
    if (isUniqueViolation(err)) return { fieldErrors: { email: "Another login already uses that email address." } };
    throw err;
  }
  await log(me.session, "ACCOUNT_PROFILE_UPDATED", { emailChanged: email !== me.user.email });
  revalidatePath("/", "layout");
  return { success: "Profile saved." };
}

// --- Username --------------------------------------------------------------------------------------

export async function changeMyUsername(_prev: AccountFormState, form: FormData): Promise<AccountFormState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  const username = normalizeUsername(form.get("username"));
  const invalid = validateUsername(username);
  if (invalid) return { fieldErrors: { username: invalid } };
  if (username === me.user.username) return { fieldErrors: { username: "That is already your username." } };
  const wrong = await checkCurrentPassword(me.user, String(form.get("currentPassword") ?? ""));
  if (wrong) return { fieldErrors: { currentPassword: wrong } };

  // Usernames are unique across the whole platform; "taken" never says by whom.
  if (await globalPrisma.user.findUnique({ where: { username }, select: { id: true } })) return { fieldErrors: { username: "That username is not available." } };
  try {
    await globalPrisma.user.update({ where: { id: me.user.id }, data: { username, usernameChangedAt: new Date(), failedLoginAttempts: 0, lastFailedLoginAt: null } });
  } catch (err) {
    if (isUniqueViolation(err)) return { fieldErrors: { username: "That username is not available." } };
    throw err;
  }
  await log(me.session, "ACCOUNT_USERNAME_CHANGED", { from: me.user.username, to: username }, "WARN");
  revalidatePath("/", "layout");
  return { success: `Your username is now "${username}". Use it the next time you sign in.` };
}

// --- Password --------------------------------------------------------------------------------------

export async function changeMyPassword(_prev: AccountFormState, form: FormData): Promise<AccountFormState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  const next = String(form.get("newPassword") ?? "");
  const invalid = validateNewPassword(next, String(form.get("confirmPassword") ?? ""), me.user.username);
  if (invalid) return { fieldErrors: { newPassword: invalid } };
  const current = String(form.get("currentPassword") ?? "");
  const wrong = await checkCurrentPassword(me.user, current);
  if (wrong) return { fieldErrors: { currentPassword: wrong } };
  if (current === next) return { fieldErrors: { newPassword: "Choose a password different from the current one." } };

  const signOutOthers = form.get("signOutOthers") === "on";
  const thisDevice = await currentSessionRowId();
  const now = new Date();
  const revoked = await globalPrisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: me.user.id }, data: { passwordHash: hashPassword(next), passwordChangedAt: now, failedLoginAttempts: 0, lastFailedLoginAt: null } });
    if (!signOutOthers || !thisDevice) return { count: 0 };
    return tx.userSession.updateMany({
      where: { userId: me.user.id, revokedAt: null, id: { not: thisDevice } },
      data: { revokedAt: now, revokedReason: "PASSWORD_CHANGED" },
    });
  });
  await log(me.session, "ACCOUNT_PASSWORD_CHANGED", { otherDevicesSignedOut: revoked.count }, "WARN");
  revalidatePath(PATH);
  return {
    success: revoked.count > 0 ? `Password changed. ${revoked.count} other device${revoked.count === 1 ? "" : "s"} signed out.` : "Password changed.",
  };
}

// --- Devices ---------------------------------------------------------------------------------------

export async function signOutMyDevice(sessionId: string): Promise<AccountFormState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  const thisDevice = await currentSessionRowId();
  if (String(sessionId) === thisDevice) return { error: "To sign out of this device, use Sign out." };
  // Conditional on the owner: another person's session id signs out nothing.
  const result = await globalPrisma.userSession.updateMany({
    where: { id: String(sessionId), userId: me.user.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "USER_LOGOUT" },
  });
  if (result.count === 0) return { error: "That device is already signed out." };
  await log(me.session, "ACCOUNT_SESSION_REVOKED", { sessionId: String(sessionId) });
  revalidatePath(PATH);
  return { success: "That device is signed out." };
}

export async function signOutMyOtherDevices(): Promise<AccountFormState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  const thisDevice = await currentSessionRowId();
  const result = await globalPrisma.userSession.updateMany({
    where: { userId: me.user.id, revokedAt: null, ...(thisDevice ? { id: { not: thisDevice } } : {}) },
    data: { revokedAt: new Date(), revokedReason: "USER_LOGOUT" },
  });
  await log(me.session, "ACCOUNT_OTHER_SESSIONS_REVOKED", { count: result.count }, "WARN");
  revalidatePath(PATH);
  return { success: result.count ? `${result.count} other device${result.count === 1 ? "" : "s"} signed out.` : "No other device was signed in." };
}

// --- Two-step sign-in ------------------------------------------------------------------------------

export interface MfaSetupState extends AccountFormState {
  /** Shown while setting up: the address for the app, and the same secret grouped for typing. */
  setup?: { uri: string; secret: string };
  /** Shown ONCE, after turning on or replacing them. */
  recoveryCodes?: string[];
}

/** Step 1: a new secret, held as pending until a code from it is confirmed. Needs the current password. */
export async function startMfaSetup(_prev: MfaSetupState, form: FormData): Promise<MfaSetupState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  if (me.user.mfaSecretCiphertext) return { error: "Two-step sign-in is already on." };
  const wrong = await checkCurrentPassword(me.user, String(form.get("currentPassword") ?? ""));
  if (wrong) return { fieldErrors: { currentPassword: wrong } };
  const secret = generateTotpSecret();
  await globalPrisma.user.update({ where: { id: me.user.id }, data: { mfaPendingSecretCiphertext: encryptSecret(secret) } });
  const issuer = (await getBranding()).productName;
  return { setup: { uri: otpauthUri(secret, me.user.username, issuer), secret: formatSecretForTyping(secret) } };
}

/** Step 2: a code from the app proves the secret was saved; then it is turned on and recovery codes are shown once. */
export async function confirmMfaSetup(_prev: MfaSetupState, form: FormData): Promise<MfaSetupState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  if (me.user.mfaSecretCiphertext) return { error: "Two-step sign-in is already on." };
  if (!me.user.mfaPendingSecretCiphertext) return { error: "Start again: the setup expired or was replaced." };
  const secret = decryptSecret(me.user.mfaPendingSecretCiphertext);
  const step = verifyTotp(secret, String(form.get("code") ?? ""), Date.now());
  if (step === null) {
    const issuer = (await getBranding()).productName;
    return {
      fieldErrors: { code: "That code is not right. Check the phone's clock is set automatically and use the newest code." },
      setup: { uri: otpauthUri(secret, me.user.username, issuer), secret: formatSecretForTyping(secret) },
    };
  }
  const codes = generateRecoveryCodes();
  // Conditional on the same pending secret, so two confirmations at once turn it on once.
  const updated = await globalPrisma.user.updateMany({
    where: { id: me.user.id, mfaSecretCiphertext: null, mfaPendingSecretCiphertext: me.user.mfaPendingSecretCiphertext },
    data: {
      mfaSecretCiphertext: me.user.mfaPendingSecretCiphertext,
      mfaPendingSecretCiphertext: null,
      mfaEnabledAt: new Date(),
      mfaLastUsedStep: step,
      mfaRecoveryCodeHashes: codes.map(hashRecoveryCode),
    },
  });
  if (updated.count === 0) return { error: "Two-step sign-in changed in another window. Reload the page." };
  await log(me.session, "ACCOUNT_MFA_ENABLED", {}, "WARN");
  revalidatePath(PATH);
  return { success: "Two-step sign-in is on.", recoveryCodes: codes };
}

export async function cancelMfaSetup(): Promise<AccountFormState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  await globalPrisma.user.update({ where: { id: me.user.id }, data: { mfaPendingSecretCiphertext: null } });
  revalidatePath(PATH);
  return {};
}

/** Needs the current password AND a current code (or recovery code), so a stolen session alone cannot remove it. */
export async function disableMfa(_prev: MfaSetupState, form: FormData): Promise<MfaSetupState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  if (!me.user.mfaSecretCiphertext) return { error: "Two-step sign-in is already off." };
  const wrong = await checkCurrentPassword(me.user, String(form.get("currentPassword") ?? ""));
  if (wrong) return { fieldErrors: { currentPassword: wrong } };
  if (!(await secondStepIsRight(me.user, String(form.get("code") ?? "")))) {
    await recordFailedSecret(me.user, me.user.customerId, "LOGIN_MFA_FAILURE");
    return { fieldErrors: { code: "That code is not right." } };
  }
  await globalPrisma.user.update({
    where: { id: me.user.id },
    data: { mfaSecretCiphertext: null, mfaPendingSecretCiphertext: null, mfaEnabledAt: null, mfaLastUsedStep: null, mfaRecoveryCodeHashes: [] },
  });
  await log(me.session, "ACCOUNT_MFA_DISABLED", {}, "WARN");
  revalidatePath(PATH);
  return { success: "Two-step sign-in is off. Your password alone now signs you in." };
}

/** New recovery codes replace every old one. Needs a current authenticator code. */
export async function replaceRecoveryCodes(_prev: MfaSetupState, form: FormData): Promise<MfaSetupState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  if (!me.user.mfaSecretCiphertext) return { error: "Turn on two-step sign-in first." };
  const step = verifyTotp(decryptSecret(me.user.mfaSecretCiphertext), String(form.get("code") ?? ""), Date.now(), me.user.mfaLastUsedStep);
  if (step === null) {
    await recordFailedSecret(me.user, me.user.customerId, "LOGIN_MFA_FAILURE");
    return { fieldErrors: { code: "That code is not right. Use the current code from your authenticator app." } };
  }
  const codes = generateRecoveryCodes();
  await globalPrisma.user.update({ where: { id: me.user.id }, data: { mfaRecoveryCodeHashes: codes.map(hashRecoveryCode), mfaLastUsedStep: step } });
  await log(me.session, "ACCOUNT_RECOVERY_CODES_REPLACED", {}, "WARN");
  revalidatePath(PATH);
  return { success: "New recovery codes made. The old ones no longer work.", recoveryCodes: codes };
}

async function secondStepIsRight(user: OwnUser, code: string): Promise<boolean> {
  const typed = code.trim();
  if (!typed || !user.mfaSecretCiphertext) return false;
  if (verifyTotp(decryptSecret(user.mfaSecretCiphertext), typed, Date.now(), user.mfaLastUsedStep) !== null) return true;
  const row = await globalPrisma.user.findUnique({ where: { id: user.id }, select: { mfaRecoveryCodeHashes: true } });
  return Boolean(row?.mfaRecoveryCodeHashes.includes(hashRecoveryCode(typed)));
}

// --- Photo -----------------------------------------------------------------------------------------

export async function uploadMyPhoto(form: FormData): Promise<AccountFormState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a picture." };
  if (file.size > 1024 * 1024) return { error: "The picture is too large. Choose one under 1 MB." };
  const prepared = prepareClientPhoto(new Uint8Array(await file.arrayBuffer()));
  if (!prepared.ok) return { error: prepared.error };
  const bytes = Buffer.from(prepared.bytes);
  await globalPrisma.userAvatar.upsert({
    where: { userId: me.user.id },
    create: { userId: me.user.id, bytes, mimeType: prepared.type },
    update: { bytes, mimeType: prepared.type, version: { increment: 1 } },
  });
  await log(me.session, "ACCOUNT_PHOTO_CHANGED");
  revalidatePath("/", "layout");
  return { success: "Photo saved." };
}

export async function removeMyPhoto(): Promise<AccountFormState> {
  const me = await self();
  if ("error" in me) return { error: me.error };
  await globalPrisma.userAvatar.deleteMany({ where: { userId: me.user.id } });
  await log(me.session, "ACCOUNT_PHOTO_REMOVED");
  revalidatePath("/", "layout");
  return { success: "Photo removed." };
}
