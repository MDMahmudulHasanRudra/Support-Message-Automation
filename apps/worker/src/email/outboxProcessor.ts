import { decryptSecret } from "@support-automation/db";
import { EMAIL_MAX_ATTEMPTS, emailRetryDelayMs, headerSafe, type SmtpFailure } from "@support-automation/shared";
import { trackTick } from "../lifecycle.js";
import { prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import { checkHostIsAllowed, resolveHostAddresses, sendWithNodemailer, type HostResolver, type SmtpSender } from "./smtpTransport.js";

/**
 * The email send queue (CLIENT_CENTER_PLAN.md §3.1) — the module's one outbound mechanism, as
 * `OutboundMessage` is WhatsApp's. A row is written QUEUED by the dashboard; this loop is the only
 * thing that sends, and it records exactly what happened:
 *   - ACCEPTED: the SMTP server took the message. Never "delivered" — SMTP cannot say that;
 *   - a refusal the server calls temporary, or a failure BEFORE the message body was handed over
 *     → back to QUEUED with a backoff, up to 5 attempts (nothing can have been sent);
 *   - a login the server refuses, or a permanent refusal → FAILED, never retried;
 *   - a timeout or dropped connection AFTER the body was handed over → UNKNOWN, never retried by
 *     itself: the server may have accepted it, and a retry could email the person twice. A person decides.
 * A row stuck in SENDING (the worker died mid-send) becomes UNKNOWN for the same reason.
 *
 * Per-minute and per-day limits are the project's own (`EmailSettings`); the loop leaves rows queued
 * rather than exceed them. Nothing here is a campaign: the only purpose today is TEST, a message to
 * the signed-in administrator's own address, which is how the channel becomes "connected".
 */

const LOOP_NAME = "email-outbox";
/** Longer than a send's own bounded timeouts by a wide margin. */
export const EMAIL_STUCK_SENDING_MS = 5 * 60_000;

export function startEmailOutboxProcessor(intervalMs = 3_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    void trackTick(() => runEmailOutboxTick())
      .catch((err) => console.error("[email] unexpected error in the send queue", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

export async function runEmailOutboxTick(now: Date = new Date(), send: SmtpSender = sendWithNodemailer, resolve: HostResolver = resolveHostAddresses): Promise<void> {
  await forEachProject(LOOP_NAME, async () => {
    if (!(await projectHasFeature("CLIENT_CENTER"))) return;
    await recoverStuckSends(now);
    await sendNextQueued(now, send, resolve);
  });
}

async function recoverStuckSends(now: Date): Promise<void> {
  await prisma.emailOutbox.updateMany({
    where: { status: "SENDING", sendingStartedAt: { lt: new Date(now.getTime() - EMAIL_STUCK_SENDING_MS) } },
    data: { status: "UNKNOWN", lastError: "The send did not finish (the worker stopped while sending), so it is not known whether the message was accepted." },
  });
}

/** Claim and send the oldest due message of the current project. False when there was nothing to do. */
export async function sendNextQueued(now: Date = new Date(), send: SmtpSender = sendWithNodemailer, resolve: HostResolver = resolveHostAddresses): Promise<boolean> {
  const settings = await prisma.emailSettings.findFirst();
  const candidate = await prisma.emailOutbox.findFirst({
    where: { status: "QUEUED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!candidate) return false;

  // The project's own ceilings: leave the row queued rather than exceed either.
  if (settings) {
    const [lastMinute, lastDay] = await Promise.all([
      prisma.emailOutbox.count({ where: { status: { in: ["SENDING", "ACCEPTED", "UNKNOWN"] }, sendingStartedAt: { gte: new Date(now.getTime() - 60_000) } } }),
      prisma.emailOutbox.count({ where: { status: { in: ["SENDING", "ACCEPTED", "UNKNOWN"] }, sendingStartedAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } } }),
    ]);
    if (lastMinute >= settings.maxPerMinute || lastDay >= settings.maxPerDay) return false;
  }

  const claim = await prisma.emailOutbox.updateMany({
    where: { id: candidate.id, status: "QUEUED" },
    data: { status: "SENDING", sendingStartedAt: now, attempts: { increment: 1 } },
  });
  if (claim.count === 0) return true;

  const message = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: candidate.id } });
  const fail = (reason: string) => finish(message.id, { status: "FAILED", lastError: reason, nextAttemptAt: null });
  const recordTest = (ok: boolean, error: string | null) => recordTestResult(message.purpose, message.settingsVersion, ok, error, now);

  if (!settings || !settings.host || !settings.fromAddress || !settings.passwordCiphertext) {
    await fail("Not sent: Email is not configured for this project.");
    await recordTest(false, "Email is not configured for this project.");
    return true;
  }
  // A test proves the settings it was queued under. Settings changed since → it proves nothing.
  if (message.purpose === "TEST" && message.settingsVersion !== settings.settingsVersion) {
    await fail("Not sent: the settings were changed after this test was queued. Send a new test.");
    return true;
  }

  let password: string;
  try {
    password = decryptSecret(settings.passwordCiphertext);
  } catch (err) {
    await fail("Not sent: the saved password could not be read. Enter it again.");
    await recordTest(false, "The saved password could not be read. Enter it again.");
    console.error("[email] could not read the saved SMTP password", err);
    return true;
  }

  const blocked = await checkHostIsAllowed(settings.host, resolve);
  const outcome = blocked
    ? ({ ok: false, failure: blocked } as const)
    : await send(
        { host: settings.host, port: settings.port, tlsMode: settings.tlsMode, username: settings.username, password },
        { fromName: headerSafe(settings.fromName), fromAddress: settings.fromAddress, replyTo: settings.replyTo, to: message.toAddress, subject: headerSafe(message.subject), text: message.bodyText, messageIdSeed: message.id },
      );

  if (outcome.ok) {
    await finish(message.id, { status: "ACCEPTED", acceptedAt: now, providerMessageId: outcome.providerMessageId, lastError: null, nextAttemptAt: null });
    await recordTest(true, null);
    return true;
  }
  await handleFailure(message.id, message.attempts, outcome.failure, recordTest, settings.id, now);
  return true;
}

async function handleFailure(id: string, attempts: number, failure: SmtpFailure, recordTest: (ok: boolean, error: string | null) => Promise<void>, settingsId: string, now: Date): Promise<void> {
  switch (failure.kind) {
    case "UNKNOWN":
      await finish(id, { status: "UNKNOWN", lastError: failure.message, nextAttemptAt: null });
      await recordTest(false, failure.message);
      return;
    case "AUTH":
      await finish(id, { status: "FAILED", lastError: failure.message, nextAttemptAt: null });
      await recordTest(false, failure.message);
      await logSystemEvent("ERROR", "email", "EMAIL_CREDENTIAL_REFUSED", { settingsId }, { targetType: "EmailSettings", targetId: settingsId });
      return;
    case "NOT_SENT":
    case "TEMPORARY": {
      const delay = emailRetryDelayMs(attempts);
      if (delay === null) {
        const reason = `Not sent after ${EMAIL_MAX_ATTEMPTS} attempts: ${failure.message}`;
        await finish(id, { status: "FAILED", lastError: reason, nextAttemptAt: null });
        await recordTest(false, reason);
      } else {
        await finish(id, { status: "QUEUED", nextAttemptAt: new Date(now.getTime() + delay), lastError: failure.message, sendingStartedAt: null });
      }
      return;
    }
    case "PERMANENT":
      await finish(id, { status: "FAILED", lastError: failure.message, nextAttemptAt: null });
      await recordTest(false, failure.message);
      return;
  }
}

async function finish(id: string, data: Parameters<typeof prisma.emailOutbox.update>[0]["data"]): Promise<void> {
  await prisma.emailOutbox.updateMany({ where: { id, status: "SENDING" }, data: data as never });
}

/**
 * A TEST message's result is what makes the channel connected (or not). Conditional on the settings
 * still being the version the test was queued under: a test of OLD settings must never verify NEW ones.
 */
async function recordTestResult(purpose: string, settingsVersion: number, ok: boolean, error: string | null, now: Date): Promise<void> {
  if (purpose !== "TEST") return;
  await prisma.emailSettings.updateMany({
    where: { settingsVersion },
    data: ok ? { verifiedVersion: settingsVersion, lastTestAt: now, lastTestOk: true, lastTestError: null } : { lastTestAt: now, lastTestOk: false, lastTestError: error },
  });
}
