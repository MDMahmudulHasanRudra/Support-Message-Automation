"use server";

import { revalidatePath } from "next/cache";
import { encryptSecret, prisma as globalPrisma } from "@support-automation/db";
import { confirmOperatorPassword, requireOperatorAction } from "@/server/platform/auth";
import { logPlatformEvent } from "@/server/platform/log";

/**
 * The platform's own mail account (SAAS_PLATFORM_PLAN.md §12): billing reminders and owner
 * invitations, set here instead of in `.env`. The password is write-only (stored encrypted, never
 * sent back); saving needs the operator's own password. Only the worker sends — a test is queued
 * here and reported back on this page.
 */

export interface EmailSettingsState {
  error?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function savePlatformEmailSettings(_prev: EmailSettingsState, formData: FormData): Promise<EmailSettingsState> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  if (!(await confirmOperatorPassword(access.operator, formData.get("operatorPassword")))) return { error: "Your platform password is not correct." };
  const enabled = formData.get("enabled") === "on";
  const host = String(formData.get("host") ?? "").trim().toLowerCase() || null;
  const port = Number(formData.get("port") ?? 587);
  const tlsMode = formData.get("tlsMode") === "TLS" ? "TLS" : "STARTTLS";
  const username = String(formData.get("username") ?? "").trim() || null;
  const password = String(formData.get("password") ?? "");
  const fromAddress = String(formData.get("fromAddress") ?? "").trim().toLowerCase() || null;
  const fromName = String(formData.get("fromName") ?? "").trim().slice(0, 80) || null;
  const fieldErrors: Record<string, string> = {};
  if (enabled && (!host || !/^[a-z0-9.-]+$/.test(host))) fieldErrors.host = "Enter the mail server, for example smtp.gmail.com.";
  if (!Number.isInteger(port) || port < 1 || port > 65535) fieldErrors.port = "Enter a port, usually 587 or 465.";
  if (enabled && (!fromAddress || !EMAIL_RE.test(fromAddress))) fieldErrors.fromAddress = "Enter the address emails come from.";
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  let passwordCiphertext: string | undefined;
  if (password) {
    try {
      passwordCiphertext = encryptSecret(password);
    } catch {
      return { error: "The server has no encryption key set (AI_CREDENTIALS_ENCRYPTION_KEY), so the password cannot be stored safely." };
    }
  }
  const data = { enabled, host, port, tlsMode, username, fromAddress, fromName, ...(passwordCiphertext ? { passwordCiphertext } : {}), updatedByUsername: access.operator.username };
  await globalPrisma.platformEmailSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  await logPlatformEvent("WARN", "Platform email settings saved", { enabled, host, port, tlsMode, fromAddress, passwordChanged: Boolean(passwordCiphertext), by: access.operator.username });
  revalidatePath("/platform/settings");
  return { success: enabled ? "Saved. Send a test email to confirm it works." : "Saved. Platform email is off; nothing is emailed." };
}

export async function requestPlatformTestEmail(_prev: EmailSettingsState, formData: FormData): Promise<EmailSettingsState> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  const to = String(formData.get("to") ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return { fieldErrors: { to: "Enter the address to send the test to." } };
  const settings = await globalPrisma.platformEmailSettings.findUnique({ where: { id: "default" } });
  if (!settings?.enabled) return { error: "Turn platform email on and save first." };
  await globalPrisma.platformEmailSettings.update({ where: { id: "default" }, data: { testRequestedAt: new Date(), testRequestedTo: to } });
  await logPlatformEvent("INFO", "Platform test email requested", { to, by: access.operator.username });
  revalidatePath("/platform/settings");
  return { success: `Queued. The worker sends it within a minute; refresh to see the result.` };
}
