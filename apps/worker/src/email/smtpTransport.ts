import { lookup } from "node:dns/promises";
import nodemailer from "nodemailer";
import { classifySmtpFailure, isForbiddenSmtpAddress, type SmtpFailure } from "@support-automation/shared";

/**
 * The only module that imports the SMTP library (the way OpenWAProvider is the only one that imports
 * OpenWA). The send loop depends on `SmtpSender` alone, so tests use a fake and no test ever opens a
 * connection or sends a message.
 */

export interface SmtpConnection {
  host: string;
  port: number;
  tlsMode: "STARTTLS" | "TLS";
  username: string;
  password: string;
}

export interface SmtpMessage {
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  to: string;
  subject: string;
  text: string;
  /** Our own row id, used to build the Message-ID so a message is recognisable in the mail server's log. */
  messageIdSeed: string;
}

export type SmtpOutcome = { ok: true; providerMessageId: string } | { ok: false; failure: SmtpFailure };

export type SmtpSender = (connection: SmtpConnection, message: SmtpMessage) => Promise<SmtpOutcome>;
export type HostResolver = (host: string) => Promise<string[]>;

/** Bounded: a mail server that stops answering must not hold the send loop. */
const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 40_000;

export const resolveHostAddresses: HostResolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Refuses a mail server that is this machine or a link-local address — whether typed as an address or
 * reached through a name that RESOLVES to one. The settings form checks the typed value; this checks
 * what it resolves to at the moment of sending, because a name can be pointed anywhere.
 */
export async function checkHostIsAllowed(host: string, resolve: HostResolver = resolveHostAddresses): Promise<SmtpFailure | null> {
  let addresses: string[];
  try {
    addresses = isForbiddenSmtpAddress(host) ? [host] : await resolve(host);
  } catch {
    return { kind: "NOT_SENT", message: `The mail server's name (${host}) could not be looked up.` };
  }
  if (addresses.some(isForbiddenSmtpAddress)) return { kind: "PERMANENT", message: "That mail server resolves to this machine or a link-local address, which is not allowed." };
  return null;
}

export const sendWithNodemailer: SmtpSender = async (connection, message) => {
  const transport = nodemailer.createTransport({
    host: connection.host,
    port: connection.port,
    secure: connection.tlsMode === "TLS",
    // STARTTLS must actually upgrade: never fall back to sending the password in the clear.
    requireTLS: connection.tlsMode === "STARTTLS",
    auth: { user: connection.username, pass: connection.password },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const domain = message.fromAddress.split("@")[1] ?? "localhost";
    const info = await transport.sendMail({
      from: { name: message.fromName, address: message.fromAddress },
      to: message.to,
      replyTo: message.replyTo ?? undefined,
      subject: message.subject,
      text: message.text,
      messageId: `<${message.messageIdSeed}@${domain}>`,
    });
    // One recipient per message: if the server did not accept exactly that one, nothing was sent.
    if (!info.accepted.some((a) => String(a).toLowerCase() === message.to.toLowerCase())) {
      return { ok: false, failure: { kind: "PERMANENT", message: "The mail server did not accept the recipient address." } };
    }
    return { ok: true, providerMessageId: info.messageId };
  } catch (err) {
    return { ok: false, failure: classifySmtpFailure(err as Parameters<typeof classifySmtpFailure>[0]) };
  } finally {
    transport.close();
  }
};
