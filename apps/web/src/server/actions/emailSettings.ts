"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { EMAIL_LIMITS, connectionChanged, isValidEmailAddress, validateEmailSettings } from "@support-automation/shared";
import { encryptSecret } from "@support-automation/db";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * Email (SMTP) settings actions (CLIENT_CENTER_PLAN.md §3.1). Every one is a public endpoint, so every
 * one makes its own check: `communications.manage_email`, an authorized admin's key.
 *
 * The password is encrypted with `encryptSecret` before it is stored and is never sent back to a page
 * or written to a log. Saving a changed connection setting returns the channel to "not connected": a
 * test message must be accepted under the new settings. The test goes ONLY to the signed-in
 * administrator's own address, so the module cannot be used to send mail to anybody else.
 */

export interface EmailFormState {
  error?: string;
  success?: boolean;
  message?: string;
  values?: Record<string, string>;
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

/** What was typed, returned with a refusal. NEVER the password. */
function echo(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && key !== "password" && !key.startsWith("$ACTION")) out[key] = value.slice(0, 500);
  }
  return out;
}

async function refresh() {
  revalidatePath(await projectPath("/settings/email"));
}

export async function saveEmailSettings(_prev: EmailFormState, formData: FormData): Promise<EmailFormState> {
  const granted = await checkPermission("communications.manage_email");
  if ("denied" in granted) return { error: granted.denied, values: echo(formData) };

  const parsed = validateEmailSettings({
    host: text(formData, "host"),
    port: text(formData, "port"),
    tlsMode: text(formData, "tlsMode"),
    username: text(formData, "username"),
    fromName: text(formData, "fromName"),
    fromAddress: text(formData, "fromAddress"),
    replyTo: text(formData, "replyTo"),
    maxPerMinute: text(formData, "maxPerMinute"),
    maxPerDay: text(formData, "maxPerDay"),
  });
  if (!parsed.ok) return { error: parsed.errors.join(" "), values: echo(formData) };
  const value = parsed.value;

  const existing = await prisma.emailSettings.findFirst();
  // Blank keeps the stored password; there is no way to read it back, so a person types it again to change it.
  const typed = String(formData.get("password") ?? "");
  if (!existing?.passwordCiphertext && !typed) return { error: "Enter the mail account's password.", values: echo(formData) };
  if (typed.length > EMAIL_LIMITS.password) return { error: "That password is too long.", values: echo(formData) };
  let passwordCiphertext: string | undefined;
  if (typed) {
    try {
      passwordCiphertext = encryptSecret(typed);
    } catch {
      return { error: "The server has no credential encryption key set (AI_CREDENTIALS_ENCRYPTION_KEY), so a password cannot be stored safely. Ask whoever runs the server to set it.", values: echo(formData) };
    }
  }

  const changed = existing ? connectionChanged(existing, value, Boolean(passwordCiphertext)) : true;
  const data = {
    host: value.host,
    port: value.port,
    tlsMode: value.tlsMode,
    username: value.username,
    fromName: value.fromName,
    fromAddress: value.fromAddress,
    replyTo: value.replyTo,
    maxPerMinute: value.maxPerMinute,
    maxPerDay: value.maxPerDay,
    updatedById: granted.session.userId,
    ...(passwordCiphertext ? { passwordCiphertext } : {}),
  };
  if (existing) {
    await prisma.emailSettings.update({ where: { id: existing.id }, data: { ...data, ...(changed ? { settingsVersion: { increment: 1 } } : {}) } });
  } else {
    await prisma.emailSettings.create({ data: { ...data, passwordCiphertext: passwordCiphertext!, enabled: false } });
  }
  // Ids and the fact of the change only: never the host's credentials.
  await logSystemEvent("INFO", "email", "Email settings saved", { connectionChanged: changed }, { actorUserId: granted.session.userId, targetType: "EmailSettings" });
  await refresh();
  return { success: true, message: changed ? "Saved. The connection settings changed, so send a test message to connect." : "Saved." };
}

export async function setEmailEnabled(enabled: boolean): Promise<{ ok: boolean; message: string }> {
  const granted = await checkPermission("communications.manage_email");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const updated = await prisma.emailSettings.updateMany({ where: {}, data: { enabled, updatedById: granted.session.userId } });
  if (updated.count === 0) return { ok: false, message: "Save the email settings first." };
  await logSystemEvent("INFO", "email", enabled ? "Email switched on" : "Email switched off", {}, { actorUserId: granted.session.userId, targetType: "EmailSettings" });
  await refresh();
  return { ok: true, message: enabled ? "Email is on. It still needs a successful test message before anything can use it." : "Email is off. Nothing will use it." };
}

/**
 * Queues one test message to the signed-in administrator's own address. The result (ACCEPTED or the
 * reason it failed) is written by the worker and shown on the page; the channel is connected only if
 * the server accepted it under the settings as they are now.
 */
export async function sendTestEmail(): Promise<{ ok: boolean; message: string }> {
  const granted = await checkPermission("communications.manage_email");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const to = (granted.session.email ?? "").trim();
  if (!isValidEmailAddress(to)) return { ok: false, message: "Your login has no valid email address, so there is nowhere to send the test. Add one under Users first." };

  const settings = await prisma.emailSettings.findFirst({ select: { host: true, fromAddress: true, passwordCiphertext: true, settingsVersion: true } });
  if (!settings || !settings.host || !settings.fromAddress || !settings.passwordCiphertext) return { ok: false, message: "Save complete email settings first." };
  // One at a time: a second press while one is waiting would only queue a duplicate.
  const open = await prisma.emailOutbox.count({ where: { purpose: "TEST", status: { in: ["QUEUED", "SENDING"] } } });
  if (open > 0) return { ok: false, message: "A test message is already waiting to be sent. Give it a moment." };

  await prisma.emailOutbox.create({
    data: {
      purpose: "TEST",
      toAddress: to,
      subject: "Test message from your support system",
      bodyText: "This is a test message. If you are reading it, the mail server accepted it using the settings saved for this project. Nothing else was sent.",
      idempotencyKey: `test:${randomUUID()}`,
      settingsVersion: settings.settingsVersion,
      createdById: granted.session.userId,
    },
  });
  await refresh();
  return { ok: true, message: `A test message to ${to} is queued. This page shows the result in a few seconds.` };
}
