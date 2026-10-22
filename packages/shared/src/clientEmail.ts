/**
 * Email (SMTP) rules (CLIENT_CENTER_PLAN.md §3.1): the pure parts, shared by the settings page, its
 * action and the worker's send loop. Nothing here opens a connection or reads a clock.
 *
 * No provider is assumed. Whoever configures the module supplies a host, a port, a username and a
 * password; until a test message is ACCEPTED under the current settings, Email is "not connected".
 * SMTP only says the server accepted the message, never that it was delivered.
 */

export const EMAIL_TLS_MODES = ["STARTTLS", "TLS"] as const;
export type EmailTlsModeValue = (typeof EMAIL_TLS_MODES)[number];

/** The usual port for each mode, offered as the default when the mode is chosen. */
export const EMAIL_TLS_LABELS: Record<EmailTlsModeValue, string> = {
  STARTTLS: "STARTTLS (usually port 587)",
  TLS: "TLS from the start (usually port 465)",
};

export const EMAIL_LIMITS = { host: 253, username: 254, password: 512, name: 100, address: 254, maxPerMinute: 600, maxPerDay: 100_000 } as const;

export const isEmailTlsMode = (v: string): v is EmailTlsModeValue => (EMAIL_TLS_MODES as readonly string[]).includes(v);

/** One mailbox, no display name, no spaces, no control characters (a CR or LF would be header injection). */
export function isValidEmailAddress(raw: string): boolean {
  if (raw.length === 0 || raw.length > EMAIL_LIMITS.address) return false;
  return /^[^\s@<>(),;:\\"[\]\u0000-\u001f]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(raw);
}

/** A bare hostname or IP, with no scheme, path, port or spaces. */
export function isValidSmtpHost(raw: string): boolean {
  if (raw.length === 0 || raw.length > EMAIL_LIMITS.host) return false;
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(raw);
}

/**
 * Whether an IP literal must never be used as the mail server: this machine itself, the link-local
 * range (which holds cloud metadata services) and the unspecified / multicast addresses. A private
 * network address is allowed — an internal mail relay is a legitimate setup — and a hostname is
 * checked again against what it resolves to, at send time (the worker).
 */
export function isForbiddenSmtpAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (a === "localhost" || a.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [n1, n2] = [Number(v4[1]), Number(v4[2])];
    return n1 === 127 || n1 === 0 || (n1 === 169 && n2 === 254) || n1 >= 224;
  }
  if (a.includes(":")) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
    if (mapped) return isForbiddenSmtpAddress(mapped[1]!);
    return a === "::1" || a === "::" || a.startsWith("fe80:") || a.startsWith("ff");
  }
  return false;
}

export interface EmailSettingsInput {
  host: string;
  port: string;
  tlsMode: string;
  username: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  maxPerMinute: string;
  maxPerDay: string;
}

export interface ValidEmailSettings {
  host: string;
  port: number;
  tlsMode: EmailTlsModeValue;
  username: string;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  maxPerMinute: number;
  maxPerDay: number;
}

const wholeNumber = (raw: string) => (/^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : null);

/** Validates the connection settings. Every refusal is a sentence the form can show. */
export function validateEmailSettings(input: EmailSettingsInput): { ok: true; value: ValidEmailSettings } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const host = input.host.trim();
  if (!isValidSmtpHost(host)) errors.push("Enter the mail server's host name only, such as smtp.example.com (no https://, no port).");
  else if (isForbiddenSmtpAddress(host)) errors.push("That address cannot be used as a mail server (this machine itself, or a link-local address).");
  const port = wholeNumber(input.port);
  if (port === null || port < 1 || port > 65535) errors.push("Enter the port, a number from 1 to 65535.");
  if (!isEmailTlsMode(input.tlsMode)) errors.push("Choose how the connection is secured.");
  const username = input.username.trim();
  if (!username || username.length > EMAIL_LIMITS.username || /[\u0000-\u001f]/.test(username)) errors.push("Enter the username the mail server expects.");
  const fromAddress = input.fromAddress.trim();
  if (!isValidEmailAddress(fromAddress)) errors.push("Enter the sender address, such as support@example.com.");
  const fromName = input.fromName.trim();
  if (fromName.length > EMAIL_LIMITS.name || /[\u0000-\u001f]/.test(fromName)) errors.push(`The sender name can be at most ${EMAIL_LIMITS.name} characters.`);
  const replyTo = input.replyTo.trim();
  if (replyTo && !isValidEmailAddress(replyTo)) errors.push("The reply-to address is not a valid email address.");
  const maxPerMinute = wholeNumber(input.maxPerMinute);
  if (maxPerMinute === null || maxPerMinute < 1 || maxPerMinute > EMAIL_LIMITS.maxPerMinute) errors.push(`Messages per minute must be 1 to ${EMAIL_LIMITS.maxPerMinute}.`);
  const maxPerDay = wholeNumber(input.maxPerDay);
  if (maxPerDay === null || maxPerDay < 1 || maxPerDay > EMAIL_LIMITS.maxPerDay) errors.push(`Messages per day must be 1 to ${EMAIL_LIMITS.maxPerDay}.`);
  if (maxPerMinute !== null && maxPerDay !== null && maxPerDay < maxPerMinute) errors.push("The daily limit cannot be lower than the per-minute limit.");

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { host, port: port!, tlsMode: input.tlsMode as EmailTlsModeValue, username, fromName, fromAddress, replyTo: replyTo || null, maxPerMinute: maxPerMinute!, maxPerDay: maxPerDay! },
  };
}

/** The fields whose change means a past test no longer proves the connection. */
export function connectionChanged(before: { host: string; port: number; tlsMode: string; username: string; fromAddress: string }, after: { host: string; port: number; tlsMode: string; username: string; fromAddress: string }, passwordChanged: boolean): boolean {
  return passwordChanged || before.host !== after.host || before.port !== after.port || before.tlsMode !== after.tlsMode || before.username !== after.username || before.fromAddress !== after.fromAddress;
}

export type EmailConnectionState = "NOT_CONFIGURED" | "NOT_TESTED" | "TEST_FAILED" | "NEEDS_RETEST" | "CONNECTED";

export interface EmailStateInput {
  host: string;
  fromAddress: string;
  passwordSet: boolean;
  settingsVersion: number;
  verifiedVersion: number | null;
  lastTestOk: boolean | null;
}

/**
 * Where the channel stands. CONNECTED only when a test message was accepted under the settings as
 * they are NOW: changing the host, port, security, username, password or sender address returns it
 * to NEEDS_RETEST, because the old test says nothing about the new settings.
 */
export function emailConnectionState(s: EmailStateInput | null): EmailConnectionState {
  if (!s || !s.host || !s.fromAddress || !s.passwordSet) return "NOT_CONFIGURED";
  if (s.verifiedVersion === s.settingsVersion) return "CONNECTED";
  if (s.verifiedVersion !== null) return "NEEDS_RETEST";
  return s.lastTestOk === false ? "TEST_FAILED" : "NOT_TESTED";
}

export const EMAIL_STATE_LABELS: Record<EmailConnectionState, string> = {
  NOT_CONFIGURED: "Not connected — settings are incomplete",
  NOT_TESTED: "Not connected — send a test message",
  TEST_FAILED: "Not connected — the last test failed",
  NEEDS_RETEST: "Not connected — settings changed since the last test",
  CONNECTED: "Connected — a test message was accepted",
};

export type SmtpFailureKind = "NOT_SENT" | "TEMPORARY" | "PERMANENT" | "AUTH" | "UNKNOWN";

export interface SmtpFailure {
  kind: SmtpFailureKind;
  message: string;
}

interface SmtpErrorLike {
  code?: string;
  command?: string;
  responseCode?: number;
  response?: string;
  message?: string;
}

/** Stages before the server has been handed the message body. A failure here means nothing was sent. */
const BEFORE_BODY = new Set(["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO"]);

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Turns an SMTP library error into what to do about it. The line that matters: once the message BODY
 * has been handed over, a timeout or a dropped connection is UNKNOWN, never retried by itself,
 * because the server may well have accepted it and a retry would email the person twice. Before the
 * body, nothing can have been sent, so a retry is safe.
 */
export function classifySmtpFailure(err: SmtpErrorLike): SmtpFailure {
  const code = err.code ?? "";
  const command = (err.command ?? "").toUpperCase();
  const stage = [...BEFORE_BODY].find((s) => command === s || command.startsWith(`${s} `)) ?? null;
  const status = err.responseCode ?? 0;
  const server = err.response ? ` The server said: ${clip(err.response.replace(/\s+/g, " "))}` : "";

  if (code === "EAUTH" || status === 535 || status === 534 || status === 530) {
    return { kind: "AUTH", message: `The mail server refused the username or password.${server}` };
  }
  if (code === "ETLS" || code === "ECONNECTION" || code === "EDNS" || code === "ESOCKET" || code === "ETIMEDOUT") {
    if (stage || command === "" || command === "CONN") return { kind: "NOT_SENT", message: `Could not reach or secure the connection to the mail server (${code}).` };
    return { kind: "UNKNOWN", message: "The connection was lost or timed out after the message was handed to the mail server, so it is not known whether it was accepted." };
  }
  if (status >= 400 && status < 500) return { kind: "TEMPORARY", message: `The mail server asked to try again later (${status}).${server}` };
  if (status >= 500 && status < 600) return { kind: "PERMANENT", message: `The mail server refused the message (${status}).${server}` };
  if (code === "EENVELOPE" || code === "EMESSAGE") return { kind: "PERMANENT", message: `The message was refused before sending (${code}).` };
  return { kind: "UNKNOWN", message: `The send ended in an error that does not say whether the message was accepted (${code || "no code"}).` };
}

export const EMAIL_MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/** Backoff after a temporary failure, or null once the attempts are used up. `attempts` counts the one that just failed. */
export function emailRetryDelayMs(attempts: number): number | null {
  if (attempts >= EMAIL_MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0]!;
}

/** A header-safe single line: control characters and line breaks removed. */
export const headerSafe = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
