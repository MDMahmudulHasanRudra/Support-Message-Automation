"use server";

import { revalidatePath } from "next/cache";
import {
  batchApprovalRefusal,
  emailEligibility,
  EMAIL_SKIP_LABELS,
  isMessageTemplateChannel,
  isValidEmailAddress,
  MESSAGE_BATCH_APPROVAL_HOURS,
  MESSAGE_BATCH_MAX_RECIPIENTS,
  MESSAGE_TEMPLATE_CATEGORY_LABELS,
  MESSAGE_TEMPLATE_LIMITS,
  renderMessageTemplate,
  validateMessageTemplate,
  type EmailEligibility,
  type MessageTemplateCategory,
  type MessageTemplateStatus,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { projectPath } from "@/server/projectPaths";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { logSystemEvent } from "@/server/logSystemEvent";
import { recordClientActivity } from "@/server/clientRecords";
import { getClientModuleSettings } from "@/server/clientModule";
import { clientEmails, clientWhatsAppRoute, emailChannelReady, readMessageContext, resolveMessageValues, type MessageContext, type WhatsAppRoute } from "@/server/clientMessages";

/**
 * Messages to clients (CLIENT_CRM_V7.md §6–§7). Every function is a public endpoint and makes its own check.
 *
 *   - Choosing or previewing a template sends NOTHING (`clients.view`).
 *   - WhatsApp, Messenger and Instagram wording is PREPARED: copied, or opened in WhatsApp's own click-to-chat on
 *     the person's device. It is recorded as prepared — never as sent — and Get Assist's WhatsApp engine is not
 *     involved at all (`clients.send_messages`).
 *   - Email is the one channel Get Assist sends through, via the existing EmailOutbox queue and worker:
 *     one message on a person's press (`clients.send_messages`), or a bulk batch that ANOTHER person approves
 *     within 24 hours (`clients.approve_messages`, CLIENT_CENTER_PLAN.md decisions 8, 9, 11).
 *   - Opted-out clients are never emailed; a bulk email needs recorded consent; the worker re-checks the opt-out
 *     when it sends.
 */

export interface MessageActionResult {
  ok: boolean;
  message: string;
}

const MAX_BODY = 8000;
const MAX_SUBJECT = 200;

async function canSeeBilling(session: Parameters<typeof hasPermission>[0]): Promise<boolean> {
  const [key, settings] = await Promise.all([hasPermission(session, "clients.view_billing"), getClientModuleSettings()]);
  return key && settings.billing;
}

async function refreshClient(clientId: string) {
  revalidatePath(await projectPath(`/clients/${clientId}`));
}

// ── Preview ───────────────────────────────────────────────────────────────────────────────────────

export interface MessagePreview {
  ok: true;
  subject: string | null;
  body: string;
  missing: string[];
  templateVersion: number | null;
  email: { ready: boolean; reason: string | null; canSend: boolean; eligibility: EmailEligibility };
  whatsapp: WhatsAppRoute & { canOpenChat: boolean };
  canPrepare: boolean;
}

export interface TemplateOption {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  channel: string;
  language: string | null;
}

/** The ACTIVE templates, for the "Prepare message" picker. Refuses as an empty list. */
export async function listTemplateOptions(): Promise<TemplateOption[]> {
  const granted = await checkPermission("clients.view");
  if ("denied" in granted) return [];
  const rows = await prisma.clientMessageTemplate.findMany({ where: { status: "ACTIVE" }, orderBy: [{ category: "asc" }, { name: "asc" }], select: { id: true, name: true, category: true, channel: true, language: true } });
  return rows.map((r) => ({ ...r, categoryLabel: MESSAGE_TEMPLATE_CATEGORY_LABELS[r.category as MessageTemplateCategory] ?? r.category }));
}

/** A template filled for one client, and where it could go. Sends nothing, writes nothing. */
export async function previewClientMessage(clientId: string, templateId: string | null, rawContext: unknown): Promise<MessagePreview | { ok: false; message: string }> {
  const granted = await checkPermission("clients.view");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const template = templateId ? await prisma.clientMessageTemplate.findFirst({ where: { id: templateId, status: "ACTIVE" }, select: { subject: true, body: true, version: true } }) : null;
  if (templateId && !template) return { ok: false, message: "That template is not active any more. Choose another." };
  const resolved = await resolveMessageValues(clientId, readMessageContext(rawContext), { billing: await canSeeBilling(granted.session) });
  if (!resolved) return { ok: false, message: "That client no longer exists." };
  const rendered = template ? renderMessageTemplate(template, resolved.values) : { subject: null, body: "", missing: [] };
  const [ready, emails, route, canSend, canOpenChat] = await Promise.all([
    emailChannelReady(),
    clientEmails(clientId),
    clientWhatsAppRoute(clientId),
    hasPermission(granted.session, "clients.send_messages"),
    hasPermission(granted.session, "messages.view"),
  ]);
  return {
    ok: true,
    subject: rendered.subject,
    body: rendered.body,
    missing: rendered.missing,
    templateVersion: template?.version ?? null,
    email: { ready: ready.ready, reason: ready.reason, canSend, eligibility: emailEligibility(emails ?? { archived: true, emails: [] }, { bulk: false }) },
    whatsapp: { ...route, canOpenChat },
    canPrepare: canSend,
  };
}

// ── One message ───────────────────────────────────────────────────────────────────────────────────

export interface OneMessageInput {
  clientId: string;
  templateId: string | null;
  context: MessageContext;
  subject: string;
  body: string;
}

function checkText(subject: string | null, body: string): string | null {
  if (!body.trim()) return "Write the message first.";
  if (body.length > MAX_BODY) return `The message can be at most ${MAX_BODY} characters.`;
  if (subject !== null && subject.length > MAX_SUBJECT) return `The subject can be at most ${MAX_SUBJECT} characters.`;
  // A placeholder left in the text would reach the client as "{{…}}".
  if (/\{\{|\}\}/.test(`${subject ?? ""}${body}`)) return "The message still contains {{ }}. Replace it with the real text before sending.";
  return null;
}

async function templateRef(templateId: string | null): Promise<{ id: string; version: number; category: string } | null> {
  if (!templateId) return null;
  return prisma.clientMessageTemplate.findFirst({ where: { id: templateId }, select: { id: true, version: true, category: true } });
}

/**
 * Records that a person prepared a WhatsApp / Messenger / Instagram message (copied it, or opened WhatsApp's
 * click-to-chat). It is recorded as PREPARED: Get Assist did not send it and does not claim it was sent.
 */
export async function recordPreparedMessage(input: OneMessageInput & { channel: string }): Promise<MessageActionResult> {
  const granted = await checkPermission("clients.send_messages");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const channel = ["WHATSAPP", "MESSENGER", "INSTAGRAM", "COPY"].includes(input.channel) ? input.channel : null;
  if (!channel) return { ok: false, message: "Choose how the message is being sent." };
  const body = String(input.body ?? "").replace(/\r\n/g, "\n").trim();
  const problem = checkText(null, body);
  if (problem) return { ok: false, message: problem };
  const resolved = await resolveMessageValues(input.clientId, readMessageContext(input.context), { billing: await canSeeBilling(granted.session) });
  if (!resolved) return { ok: false, message: "That client no longer exists." };
  const template = await templateRef(input.templateId);
  await prisma.$transaction(async (tx) => {
    await tx.clientMessage.create({
      data: {
        clientId: input.clientId,
        templateId: template?.id ?? null,
        templateVersion: template?.version ?? null,
        channel,
        category: template?.category ?? null,
        status: "PREPARED",
        body,
        relatedDueId: resolved.context.dueId ?? null,
        relatedPaymentId: resolved.context.paymentId ?? null,
        relatedOfferId: resolved.context.offerId ?? null,
        relatedSubscriptionId: resolved.context.subscriptionId ?? null,
        createdById: granted.session.userId,
        createdByName: granted.session.name,
      },
    });
    const where = channel === "COPY" ? "copied" : `prepared for ${channel === "WHATSAPP" ? "WhatsApp" : channel === "MESSENGER" ? "Messenger" : "Instagram"}`;
    await recordClientActivity(tx, input.clientId, granted.session.userId, { type: "MESSAGE_PREPARED", summary: `Message ${where} (not sent by Get Assist)` });
  });
  await refreshClient(input.clientId);
  return { ok: true, message: "Recorded as prepared. Get Assist did not send it." };
}

/**
 * Queues ONE email to one client, on a person's press. The client must not be opted out; the channel must be on
 * and verified. The browser's submission key makes a double press queue once.
 */
export async function sendClientEmail(input: OneMessageInput & { submissionKey: string }): Promise<MessageActionResult> {
  const granted = await checkPermission("clients.send_messages");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const key = String(input.submissionKey ?? "");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) return { ok: false, message: "Reload the page and try again." };
  const ready = await emailChannelReady();
  if (!ready.ready) return { ok: false, message: ready.reason! };
  const subject = String(input.subject ?? "").replace(/[\r\n]+/g, " ").trim();
  const body = String(input.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!subject) return { ok: false, message: "An email needs a subject." };
  const problem = checkText(subject, body);
  if (problem) return { ok: false, message: problem };
  const emails = await clientEmails(input.clientId);
  if (!emails) return { ok: false, message: "That client no longer exists." };
  const eligible = emailEligibility(emails, { bulk: false });
  if (!eligible.ok) return { ok: false, message: eligible.message };
  if (!isValidEmailAddress(eligible.address)) return { ok: false, message: "The client's email address is not valid. Correct it on Edit client." };
  const resolved = await resolveMessageValues(input.clientId, readMessageContext(input.context), { billing: await canSeeBilling(granted.session) });
  if (!resolved) return { ok: false, message: "That client no longer exists." };
  const [template, settings] = await Promise.all([templateRef(input.templateId), prisma.emailSettings.findFirst({ select: { settingsVersion: true } })]);
  try {
    await prisma.$transaction(async (tx) => {
      const outbox = await tx.emailOutbox.create({
        data: { purpose: "CLIENT_MESSAGE", toAddress: eligible.address, subject, bodyText: body, idempotencyKey: `client-message:${key}`, settingsVersion: settings?.settingsVersion ?? 1, createdById: granted.session.userId },
        select: { id: true },
      });
      await tx.clientMessage.create({
        data: {
          clientId: input.clientId,
          templateId: template?.id ?? null,
          templateVersion: template?.version ?? null,
          channel: "EMAIL",
          category: template?.category ?? null,
          status: "QUEUED",
          toAddress: eligible.address,
          subject,
          body,
          emailOutboxId: outbox.id,
          relatedDueId: resolved.context.dueId ?? null,
          relatedPaymentId: resolved.context.paymentId ?? null,
          relatedOfferId: resolved.context.offerId ?? null,
          relatedSubscriptionId: resolved.context.subscriptionId ?? null,
          createdById: granted.session.userId,
          createdByName: granted.session.name,
        },
      });
      await recordClientActivity(tx, input.clientId, granted.session.userId, { type: "MESSAGE_QUEUED", summary: `Email queued: ${subject.slice(0, 120)}` });
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: true, message: "This email was already queued." };
    throw err;
  }
  await logSystemEvent("INFO", "clients", "Client email queued", { clientId: input.clientId, templateId: template?.id ?? null }, { actorUserId: granted.session.userId, targetType: "Client", targetId: input.clientId });
  await refreshClient(input.clientId);
  return { ok: true, message: "Email queued. Its status shows here once the mail server answers — accepted, never “delivered”: email cannot prove that." };
}

// ── Templates ─────────────────────────────────────────────────────────────────────────────────────

export interface TemplateFormState {
  error?: string;
  success?: string;
  templateId?: string;
  values?: Record<string, string>;
}

const text = (f: FormData, k: string) => String(f.get(k) ?? "");

function echo(f: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of f.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) out[k] = v.slice(0, MESSAGE_TEMPLATE_LIMITS.body + 100);
  return out;
}

async function refreshTemplates() {
  revalidatePath(await projectPath("/clients/templates"));
}

/** Create (templateId null) or edit a template. Each save is a new version, kept; an edit is refused if someone else saved first. */
export async function saveMessageTemplate(templateId: string | null, _prev: TemplateFormState, form: FormData): Promise<TemplateFormState> {
  const granted = await checkPermission("clients.manage_settings");
  if ("denied" in granted) return { error: granted.denied, values: echo(form) };
  const parsed = validateMessageTemplate({ name: text(form, "name"), category: text(form, "category"), channel: text(form, "channel"), language: text(form, "language"), subject: text(form, "subject"), body: text(form, "body") });
  if (!parsed.ok) return { error: parsed.errors.join(" "), values: echo(form) };
  const t = parsed.value;
  const status: MessageTemplateStatus = text(form, "status") === "ACTIVE" ? "ACTIVE" : "DRAFT";
  const who = { actorUserId: granted.session.userId, actorName: granted.session.name };
  try {
    if (!templateId) {
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.clientMessageTemplate.create({
          data: { ...t, status, version: 1, createdById: granted.session.userId, createdByName: granted.session.name, updatedById: granted.session.userId, updatedByName: granted.session.name },
          select: { id: true },
        });
        await tx.clientMessageTemplateVersion.create({ data: { templateId: row.id, version: 1, ...t, ...who } });
        return row.id;
      });
      await refreshTemplates();
      return { success: "Template saved.", templateId: created };
    }
    const expected = Number(text(form, "version"));
    const existing = await prisma.clientMessageTemplate.findFirst({ where: { id: templateId }, select: { version: true, status: true } });
    if (!existing) return { error: "That template no longer exists.", values: echo(form) };
    if (existing.status === "ARCHIVED") return { error: "This template is archived. Restore it before editing.", values: echo(form) };
    const done = await prisma.$transaction(async (tx) => {
      const moved = await tx.clientMessageTemplate.updateMany({
        where: { id: templateId, version: expected },
        data: { ...t, status, version: expected + 1, updatedById: granted.session.userId, updatedByName: granted.session.name },
      });
      if (moved.count !== 1) return false;
      await tx.clientMessageTemplateVersion.create({ data: { templateId, version: expected + 1, ...t, ...who } });
      return true;
    });
    if (!done) return { error: "Someone saved this template while you were editing it. Reload to see their version.", values: echo(form) };
    await refreshTemplates();
    return { success: `Saved as version ${expected + 1}.`, templateId };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "Another template already has that name.", values: echo(form) };
    throw err;
  }
}

export async function setMessageTemplateStatus(templateId: string, status: string): Promise<MessageActionResult> {
  const granted = await checkPermission("clients.manage_settings");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  if (status !== "ACTIVE" && status !== "DRAFT" && status !== "ARCHIVED") return { ok: false, message: "Choose Active, Draft or Archived." };
  const t = await prisma.clientMessageTemplate.findFirst({ where: { id: templateId }, select: { name: true, category: true, channel: true, language: true, subject: true, body: true } });
  if (!t) return { ok: false, message: "That template no longer exists." };
  if (status === "ACTIVE") {
    // A template saved against an older catalogue is checked again before it can be used.
    const check = validateMessageTemplate({ ...t, language: t.language ?? "", subject: t.subject ?? "" });
    if (!check.ok) return { ok: false, message: `It cannot be activated: ${check.errors.join(" ")}` };
  }
  await prisma.clientMessageTemplate.updateMany({ where: { id: templateId }, data: { status, updatedById: granted.session.userId, updatedByName: granted.session.name } });
  await refreshTemplates();
  return { ok: true, message: status === "ACTIVE" ? "Activated. It is offered when preparing messages." : status === "ARCHIVED" ? "Archived. Messages already sent with it keep their record." : "Moved back to draft." };
}

export async function duplicateMessageTemplate(templateId: string): Promise<MessageActionResult & { templateId?: string }> {
  const granted = await checkPermission("clients.manage_settings");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const t = await prisma.clientMessageTemplate.findFirst({ where: { id: templateId }, select: { name: true, category: true, channel: true, language: true, subject: true, body: true } });
  if (!t) return { ok: false, message: "That template no longer exists." };
  for (let n = 1; n <= 20; n++) {
    const name = `${n === 1 ? "Copy of" : `Copy ${n} of`} ${t.name}`.slice(0, MESSAGE_TEMPLATE_LIMITS.name);
    try {
      const id = await prisma.$transaction(async (tx) => {
        const row = await tx.clientMessageTemplate.create({
          data: { ...t, name, status: "DRAFT", version: 1, createdById: granted.session.userId, createdByName: granted.session.name, updatedById: granted.session.userId, updatedByName: granted.session.name },
          select: { id: true },
        });
        await tx.clientMessageTemplateVersion.create({ data: { templateId: row.id, version: 1, ...t, name, actorUserId: granted.session.userId, actorName: granted.session.name } });
        return row.id;
      });
      await refreshTemplates();
      return { ok: true, message: `Copied as "${name}" (a draft).`, templateId: id };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return { ok: false, message: "Rename the earlier copies first." };
}

// ── Bulk email (prepared by one person, approved by another) ──────────────────────────────────────

export interface BatchRecipientInput {
  clientId: string;
  context?: MessageContext;
}

/**
 * Prepares a bulk email for approval. Each recipient is rendered now (what the approver reads is what will be sent)
 * and checked: no address, opted out, consent not recorded, archived, or an address already in the batch → SKIPPED
 * with that reason. Nothing is queued until a different person approves.
 */
export async function prepareMessageBatch(templateId: string, recipients: BatchRecipientInput[]): Promise<MessageActionResult & { batchId?: string }> {
  const granted = await checkPermission("clients.send_messages");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const list = Array.isArray(recipients) ? recipients.filter((r) => r && typeof r.clientId === "string") : [];
  if (list.length === 0) return { ok: false, message: "Select at least one client." };
  if (list.length > MESSAGE_BATCH_MAX_RECIPIENTS) return { ok: false, message: `One batch takes at most ${MESSAGE_BATCH_MAX_RECIPIENTS} recipients. Narrow the selection.` };
  const template = await prisma.clientMessageTemplate.findFirst({ where: { id: templateId, status: "ACTIVE" }, select: { id: true, name: true, version: true, category: true, channel: true, subject: true, body: true } });
  if (!template) return { ok: false, message: "Choose an active template." };
  if (!isMessageTemplateChannel(template.channel) || (template.channel !== "EMAIL" && template.channel !== "ANY")) return { ok: false, message: "Bulk messages are sent by email only. Choose an Email (or Any channel) template." };
  if (!template.subject) return { ok: false, message: "This template has no subject. Add one before using it for email." };

  const billing = await canSeeBilling(granted.session);
  const seen = new Set<string>();
  const rows: Array<{ clientId: string; status: "WAITING_APPROVAL" | "SKIPPED"; toAddress: string | null; skipReason: string | null; subject: string | null; body: string; context: MessageContext }> = [];
  for (const r of list) {
    const resolved = await resolveMessageValues(r.clientId, readMessageContext(r.context), { billing });
    if (!resolved) continue; // not this project's client: never listed, never counted
    const rendered = renderMessageTemplate(template, resolved.values);
    const emails = await clientEmails(r.clientId);
    let eligible: EmailEligibility = emailEligibility(emails ?? { archived: true, emails: [] }, { bulk: true });
    if (eligible.ok) {
      const k = eligible.address.toLowerCase();
      if (seen.has(k)) eligible = { ok: false, reason: "DUPLICATE", message: EMAIL_SKIP_LABELS.DUPLICATE };
      else seen.add(k);
    }
    rows.push({
      clientId: r.clientId,
      status: eligible.ok ? "WAITING_APPROVAL" : "SKIPPED",
      toAddress: eligible.ok ? eligible.address : null,
      skipReason: eligible.ok ? null : EMAIL_SKIP_LABELS[eligible.reason],
      subject: rendered.subject,
      body: rendered.body,
      context: resolved.context,
    });
  }
  if (rows.length === 0) return { ok: false, message: "None of the selected clients is in this project." };
  const eligibleCount = rows.filter((r) => r.status === "WAITING_APPROVAL").length;
  if (eligibleCount === 0) return { ok: false, message: "No selected client can be emailed in bulk (no address, opted out, or consent not recorded)." };
  const batchId = await prisma.$transaction(async (tx) => {
    const batch = await tx.clientMessageBatch.create({
      data: {
        templateId: template.id,
        templateVersion: template.version,
        templateName: template.name,
        channel: "EMAIL",
        status: "PENDING_APPROVAL",
        submittedById: granted.session.userId,
        submittedByName: granted.session.name,
        recipientCount: rows.length,
        eligibleCount,
        skippedCount: rows.length - eligibleCount,
      },
      select: { id: true },
    });
    await tx.clientMessage.createMany({
      data: rows.map((r) => ({
        clientId: r.clientId,
        batchId: batch.id,
        templateId: template.id,
        templateVersion: template.version,
        channel: "EMAIL",
        category: template.category,
        status: r.status,
        skipReason: r.skipReason,
        toAddress: r.toAddress,
        subject: r.subject,
        body: r.body,
        relatedDueId: r.context.dueId ?? null,
        relatedPaymentId: r.context.paymentId ?? null,
        relatedOfferId: r.context.offerId ?? null,
        relatedSubscriptionId: r.context.subscriptionId ?? null,
        createdById: granted.session.userId,
        createdByName: granted.session.name,
      })),
    });
    return batch.id;
  });
  await logSystemEvent("INFO", "clients", "Bulk client email prepared for approval", { batchId, recipients: rows.length, eligible: eligibleCount }, { actorUserId: granted.session.userId, targetType: "ClientMessageBatch", targetId: batchId });
  revalidatePath(await projectPath("/clients/messages"));
  return { ok: true, message: `Prepared for ${eligibleCount} of ${rows.length} client(s). Another person with the approve permission must approve it within ${MESSAGE_BATCH_APPROVAL_HOURS} hours.`, batchId };
}

/**
 * Approves a bulk email and queues it. Never the person who prepared it (also a database CHECK); never after 24 h.
 * Consent and opt-out are checked AGAIN here — a client who opted out since preparation is skipped.
 */
export async function approveMessageBatch(batchId: string): Promise<MessageActionResult> {
  const granted = await checkPermission("clients.approve_messages");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const ready = await emailChannelReady();
  if (!ready.ready) return { ok: false, message: ready.reason! };
  const batch = await prisma.clientMessageBatch.findFirst({ where: { id: batchId }, select: { id: true, status: true, submittedById: true, submittedAt: true } });
  if (!batch) return { ok: false, message: "That batch no longer exists." };
  const refusal = batchApprovalRefusal(batch, granted.session.userId, new Date());
  if (refusal) {
    if (batch.status === "PENDING_APPROVAL" && batch.submittedById !== granted.session.userId) await expireBatch(batchId);
    return { ok: false, message: refusal };
  }
  const settings = await prisma.emailSettings.findFirst({ select: { settingsVersion: true } });
  const result = await prisma.$transaction(async (tx) => {
    // Claim it first: two approvers pressing at once queue it once.
    const claimed = await tx.clientMessageBatch.updateMany({
      where: { id: batchId, status: "PENDING_APPROVAL", NOT: { submittedById: granted.session.userId } },
      data: { status: "QUEUED", decidedById: granted.session.userId, decidedByName: granted.session.name, decidedAt: new Date() },
    });
    if (claimed.count !== 1) return null;
    const waiting = await tx.clientMessage.findMany({ where: { batchId, status: "WAITING_APPROVAL" }, select: { id: true, clientId: true, toAddress: true, subject: true, body: true } });
    const queuedClients: string[] = [];
    let skipped = 0;
    for (const m of waiting) {
      const emails = await tx.client.findFirst({ where: { id: m.clientId }, select: { status: true, channels: { where: { kind: "EMAIL" }, select: { value: true, consentStatus: true, isPrimary: true } } } });
      const still = emailEligibility({ archived: !emails || emails.status === "ARCHIVED", emails: (emails?.channels ?? []).map((c) => ({ value: c.value, consent: c.consentStatus, isPrimary: c.isPrimary })) }, { bulk: true });
      if (!still.ok || still.address.toLowerCase() !== (m.toAddress ?? "").toLowerCase()) {
        await tx.clientMessage.update({ where: { id: m.id }, data: { status: "SKIPPED", skipReason: still.ok ? "The client's email address changed after preparation" : EMAIL_SKIP_LABELS[still.reason] } });
        skipped++;
        continue;
      }
      const outbox = await tx.emailOutbox.create({
        data: { purpose: "CLIENT_MESSAGE", toAddress: still.address, subject: m.subject ?? "", bodyText: m.body, idempotencyKey: `batch:${batchId}:${m.id}`, settingsVersion: settings?.settingsVersion ?? 1, createdById: granted.session.userId },
        select: { id: true },
      });
      await tx.clientMessage.update({ where: { id: m.id }, data: { status: "QUEUED", emailOutboxId: outbox.id } });
      queuedClients.push(m.clientId);
    }
    const queued = queuedClients.length;
    if (queued > 0) {
      await tx.clientActivity.createMany({
        data: queuedClients.map((clientId) => ({ clientId, actorUserId: granted.session.userId, type: "MESSAGE_QUEUED", summary: "Bulk email approved and queued" })),
      });
    }
    return { queued, skipped };
  });
  if (!result) return { ok: false, message: "This batch was already decided." };
  await logSystemEvent("WARN", "clients", "Bulk client email approved", { batchId, queued: result.queued, skippedAtApproval: result.skipped }, { actorUserId: granted.session.userId, targetType: "ClientMessageBatch", targetId: batchId });
  revalidatePath(await projectPath("/clients/messages"));
  return { ok: true, message: `Approved: ${result.queued} email(s) queued${result.skipped ? `, ${result.skipped} skipped because their consent or address changed` : ""}. They go out at the project's email pace.` };
}

async function expireBatch(batchId: string) {
  await prisma.$transaction(async (tx) => {
    const moved = await tx.clientMessageBatch.updateMany({ where: { id: batchId, status: "PENDING_APPROVAL" }, data: { status: "EXPIRED", decidedAt: new Date() } });
    if (moved.count === 1) await tx.clientMessage.updateMany({ where: { batchId, status: "WAITING_APPROVAL" }, data: { status: "CANCELLED" } });
  });
}

/** Rejects (an approver) or cancels (its own preparer) a batch still waiting. Nothing was queued, so nothing is sent. */
export async function closeMessageBatch(batchId: string, action: "REJECT" | "CANCEL", note: string): Promise<MessageActionResult> {
  const key = action === "REJECT" ? "clients.approve_messages" : "clients.send_messages";
  const granted = await checkPermission(key);
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const batch = await prisma.clientMessageBatch.findFirst({ where: { id: batchId }, select: { status: true, submittedById: true } });
  if (!batch) return { ok: false, message: "That batch no longer exists." };
  if (action === "CANCEL" && batch.submittedById !== granted.session.userId) return { ok: false, message: "Only the person who prepared a batch can cancel it. An approver can reject it." };
  const why = String(note ?? "").trim().slice(0, 500);
  if (action === "REJECT" && !why) return { ok: false, message: "Say why it is rejected." };
  const done = await prisma.$transaction(async (tx) => {
    const moved = await tx.clientMessageBatch.updateMany({
      where: { id: batchId, status: "PENDING_APPROVAL" },
      data: { status: action === "REJECT" ? "REJECTED" : "CANCELLED", decidedById: granted.session.userId, decidedByName: granted.session.name, decidedAt: new Date(), decisionNote: why || null },
    });
    if (moved.count !== 1) return false;
    await tx.clientMessage.updateMany({ where: { batchId, status: "WAITING_APPROVAL" }, data: { status: "CANCELLED" } });
    return true;
  });
  if (!done) return { ok: false, message: "This batch was already decided." };
  revalidatePath(await projectPath("/clients/messages"));
  return { ok: true, message: action === "REJECT" ? "Rejected. Nothing was sent." : "Cancelled. Nothing was sent." };
}
