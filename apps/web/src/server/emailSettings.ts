import { emailConnectionState, type EmailConnectionState } from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * Email settings READS (CLIENT_CENTER_PLAN.md §3.1). Not a "use server" file: nothing here is an
 * endpoint, and every caller has already checked `communications.manage_email`. The password is
 * NEVER selected: a page learns only whether one is stored.
 */

export interface EmailSettingsView {
  exists: boolean;
  enabled: boolean;
  host: string;
  port: number;
  tlsMode: "STARTTLS" | "TLS";
  username: string;
  passwordSet: boolean;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  maxPerMinute: number;
  maxPerDay: number;
  state: EmailConnectionState;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettingsView = {
  exists: false,
  enabled: false,
  host: "",
  port: 587,
  tlsMode: "STARTTLS",
  username: "",
  passwordSet: false,
  fromName: "",
  fromAddress: "",
  replyTo: "",
  maxPerMinute: 10,
  maxPerDay: 500,
  state: "NOT_CONFIGURED",
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
};

export async function getEmailSettingsView(): Promise<EmailSettingsView> {
  const row = await prisma.emailSettings.findFirst({
    // Explicit select: passwordCiphertext is deliberately absent.
    select: { enabled: true, host: true, port: true, tlsMode: true, username: true, fromName: true, fromAddress: true, replyTo: true, maxPerMinute: true, maxPerDay: true, settingsVersion: true, verifiedVersion: true, lastTestAt: true, lastTestOk: true, lastTestError: true, passwordCiphertext: true },
  });
  if (!row) return DEFAULT_EMAIL_SETTINGS;
  const passwordSet = row.passwordCiphertext !== null;
  return {
    exists: true,
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    tlsMode: row.tlsMode,
    username: row.username,
    passwordSet,
    fromName: row.fromName,
    fromAddress: row.fromAddress,
    replyTo: row.replyTo ?? "",
    maxPerMinute: row.maxPerMinute,
    maxPerDay: row.maxPerDay,
    state: emailConnectionState({ host: row.host, fromAddress: row.fromAddress, passwordSet, settingsVersion: row.settingsVersion, verifiedVersion: row.verifiedVersion, lastTestOk: row.lastTestOk }),
    lastTestAt: row.lastTestAt,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
  };
}

/** The newest queued / sent messages, for the status table. */
export async function listRecentEmails() {
  return prisma.emailOutbox.findMany({
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { id: true, purpose: true, status: true, toAddress: true, attempts: true, createdAt: true, acceptedAt: true, lastError: true },
  });
}
