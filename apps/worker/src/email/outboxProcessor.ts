import { decryptSecret } from "@support-automation/db";
import { EMAIL_MAX_ATTEMPTS, emailRetryDelayMs, headerSafe, type SmtpFailure } from "@support-automation/shared";
import { trackTick } from "../lifecycle.js";
import { platformPrisma, prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { currentProjectId, forEachProject } from "../project/context.js";
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
 * rather than exceed them. Two purposes: TEST, a message to the signed-in administrator's own address,
 * which is how the channel becomes "connected"; and CLIENT_MESSAGE (CLIENT_CRM_V7.md §6), a message to a
 * client that a person sent or that ANOTHER person approved in a batch — re-checked here (channel on and
 * verified, client not opted out) at the moment it is sent. Nothing here decides to send anything.
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

/** What counts toward a project's sending limits: every message that was, or may have been, handed to SMTP. */
const COUNTED_STATUSES = ["SENDING", "ACCEPTED", "UNKNOWN"] as const;

/**
 * Claims the oldest due message of the current project: QUEUED → SENDING, attempts + 1. Null when nothing
 * is due or a limit is reached (the row stays QUEUED); `won: false` when the conditional update lost.
 *
 * FOR UPDATE SKIP LOCKED (P1-13), like the channel queue: SMTP needs no browser, so a second worker could
 * share this queue; a row another claimer holds is skipped, never sent twice. The conditional update stays.
 *
 * The limits are checked INSIDE the claim, under a per-project advisory lock. Checked outside, two claimers
 * could both read "one below the limit" and both claim, so the limit could be passed once per extra claimer.
 * Under the lock the second claimer counts after the first one's SENDING row is committed. The lock is held
 * for two counts and one update, never for the send, and only while something is due.
 */
export async function claimNextEmail(now: Date, limits: { maxPerMinute: number; maxPerDay: number } | null): Promise<{ id: string; won: boolean } | null> {
  // Anything due at all? A plain indexed read, so an idle tick takes no lock and runs no count.
  const due = await prisma.emailOutbox.findFirst({
    where: { status: "QUEUED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    select: { id: true },
  });
  if (!due) return null;

  const projectId = currentProjectId();
  return platformPrisma.$transaction(async (tx) => {
    // The project's own ceilings: leave the queue untouched rather than exceed either.
    if (limits) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-outbox-rate:${projectId}`})::bigint)`;
      const counted = { projectId, status: { in: [...COUNTED_STATUSES] } };
      const [lastMinute, lastDay] = await Promise.all([
        tx.emailOutbox.count({ where: { ...counted, sendingStartedAt: { gte: new Date(now.getTime() - 60_000) } } }),
        tx.emailOutbox.count({ where: { ...counted, sendingStartedAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } } }),
      ]);
      if (lastMinute >= limits.maxPerMinute || lastDay >= limits.maxPerDay) return null;
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT e.id FROM "EmailOutbox" e
      WHERE e."projectId" = ${projectId} AND e.status = 'QUEUED' AND (e."nextAttemptAt" IS NULL OR e."nextAttemptAt" <= ${now})
      ORDER BY e."createdAt" ASC, e.id ASC
      LIMIT 1
      FOR UPDATE OF e SKIP LOCKED`;
    const found = rows[0];
    if (!found) return null;
    const claim = await tx.emailOutbox.updateMany({
      where: { id: found.id, projectId, status: "QUEUED" },
      data: { status: "SENDING", sendingStartedAt: now, attempts: { increment: 1 } },
    });
    return { id: found.id, won: claim.count === 1 };
  });
}

/** Claim and send the oldest due message of the current project. False when there was nothing to do. */
export async function sendNextQueued(now: Date = new Date(), send: SmtpSender = sendWithNodemailer, resolve: HostResolver = resolveHostAddresses): Promise<boolean> {
  const settings = await prisma.emailSettings.findFirst();
  const claimed = await claimNextEmail(now, settings);
  if (!claimed) return false;
  if (!claimed.won) return true;
  const candidate = { id: claimed.id };

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
  // A message to a CLIENT (CLIENT_CRM_V7.md §6) goes only through a channel that is switched on and verified as it
  // is now, and never to someone who opted out since it was queued.
  if (message.purpose === "CLIENT_MESSAGE") {
    const refusal = await clientMessageRefusal(message.id, message.toAddress, settings);
    if (refusal) {
      await fail(refusal);
      return true;
    }
  }

  if (message.purpose === "CONTACT_CAMPAIGN") {
    const refusal = await contactCampaignRefusal(message.id, message.toAddress, settings);
    if (refusal) {
      await fail(refusal);
      return true;
    }
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

/**
 * Why a client message must not go now, or null. Checked when SENDING, not only when queued: the channel may have
 * been switched off, its settings changed (no longer verified), or the client may have opted out meanwhile. A bulk
 * message (part of an approved batch) also still needs recorded consent.
 */
export async function clientMessageRefusal(outboxId: string, toAddress: string, settings: { enabled: boolean; settingsVersion: number; verifiedVersion: number | null }): Promise<string | null> {
  if (!settings.enabled) return "Not sent: email is switched off for this project.";
  if (settings.verifiedVersion !== settings.settingsVersion) return "Not sent: the email settings changed and have not been tested again.";
  const message = await prisma.clientMessage.findFirst({ where: { emailOutboxId: outboxId }, select: { clientId: true, batchId: true } });
  if (!message) return "Not sent: the client message this email belongs to no longer exists.";
  const channels = await prisma.clientChannel.findMany({ where: { clientId: message.clientId, kind: "EMAIL" }, select: { value: true, consentStatus: true } });
  const address = channels.find((c) => c.value.toLowerCase() === toAddress.toLowerCase());
  if (!address) return "Not sent: this address is no longer on the client's record.";
  if (address.consentStatus === "OPTED_OUT") return "Not sent: the client opted out of email.";
  if (message.batchId && address.consentStatus !== "OPTED_IN") return "Not sent: the client's email consent is no longer recorded, so a bulk email cannot include them.";
  return null;
}

/** The same re-check for one recipient of a Contacts campaign (CONTACTS.md): an opt-out since it was queued wins. */
export async function contactCampaignRefusal(outboxId: string, toAddress: string, settings: { enabled: boolean; settingsVersion: number; verifiedVersion: number | null }): Promise<string | null> {
  if (!settings.enabled) return "Not sent: email is switched off for this project.";
  if (settings.verifiedVersion !== settings.settingsVersion) return "Not sent: the email settings changed and have not been tested again.";
  const recipient = await prisma.contactCampaignRecipient.findFirst({ where: { emailOutboxId: outboxId }, select: { contact: { select: { status: true, consent: true, identifiers: { where: { kind: "EMAIL" }, select: { value: true } } } } } });
  if (!recipient) return "Not sent: the campaign this email belongs to no longer has this person.";
  if (recipient.contact.status !== "ACTIVE") return "Not sent: this contact was archived.";
  if (recipient.contact.consent === "OPTED_OUT") return "Not sent: this contact said no to offers.";
  if (!recipient.contact.identifiers.some((i) => i.value.toLowerCase() === toAddress.toLowerCase())) return "Not sent: this address is no longer on the contact.";
  return null;
}

async function finish(id: string, data:Parameters<typeof prisma.emailOutbox.update>[0]["data"]): Promise<void> {
  await prisma.emailOutbox.updateMany({ where: { id, status: "SENDING" }, data: data as never });
  await settleContactRecipient(id, data as { status?: unknown; lastError?: unknown }).catch((err) => console.error("[email] could not settle a campaign recipient", err));
}

/** A campaign row follows its email. Every ending passes through `finish`, so this is the one place that needs to know. */
async function settleContactRecipient(outboxId: string, data: { status?: unknown; lastError?: unknown }): Promise<void> {
  if (data.status !== "ACCEPTED" && data.status !== "FAILED" && data.status !== "UNKNOWN") return;
  const recipient = await prisma.contactCampaignRecipient.findFirst({ where: { emailOutboxId: outboxId, status: "QUEUED" }, select: { id: true, contactId: true, campaign: { select: { name: true } } } });
  if (!recipient) return;
  const now = new Date();
  if (data.status === "ACCEPTED") {
    await prisma.$transaction([
      prisma.contactCampaignRecipient.updateMany({ where: { id: recipient.id, status: "QUEUED" }, data: { status: "DONE", doneAt: now } }),
      prisma.contact.updateMany({ where: { id: recipient.contactId }, data: { lastContactedAt: now } }),
      prisma.contactEvent.create({ data: { contactId: recipient.contactId, kind: "CONTACTED", detail: recipient.campaign.name.slice(0, 1000), actorName: "Email campaign" } }),
    ]);
    return;
  }
  const reason = data.status === "UNKNOWN" ? "The mail server did not confirm this one; it may have gone out." : typeof data.lastError === "string" ? data.lastError.slice(0, 300) : "The email was not sent.";
  await prisma.contactCampaignRecipient.updateMany({ where: { id: recipient.id, status: "QUEUED" }, data: { status: "SKIPPED", skipReason: reason, doneAt: now } });
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
