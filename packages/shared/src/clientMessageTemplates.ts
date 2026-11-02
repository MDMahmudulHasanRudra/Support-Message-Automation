/**
 * Client Communication Templates (CLIENT_CRM_V7.md §6). Reusable wording for messages to CLIENTS — welcome,
 * renewal, invoice, payment, receipt — with variables filled from the client's own records. Different from
 * Notification Templates (alerts to the team) and Saved Replies (an operator's shorthand in the chat).
 *
 * Pure rules shared by the editor, the server actions and the tests:
 *   - a template body is PLAIN TEXT, never HTML: it is rendered into an email's text part or into a chat
 *     composer, and nothing in it is interpreted as markup;
 *   - only catalogued variables may appear; an unknown one is refused before a template can be activated;
 *   - a variable with no value is never invented: a line whose only content was empty variables is
 *     dropped, and the renderer reports which variables were missing so a person sees it before sending;
 *   - choosing a template sends nothing. Sending is a separate, permission-checked action.
 */

export const MESSAGE_TEMPLATE_CATEGORIES = [
  "WELCOME",
  "RENEWAL_REMINDER",
  "EXPIRY_NOTICE",
  "RENEWAL_OFFER",
  "FOLLOW_UP",
  "INVOICE",
  "PAYMENT_REMINDER",
  "PAYMENT_CONFIRMATION",
  "RECEIPT",
  "THANK_YOU",
  "CUSTOM",
] as const;
export type MessageTemplateCategory = (typeof MESSAGE_TEMPLATE_CATEGORIES)[number];
export const MESSAGE_TEMPLATE_CATEGORY_LABELS: Record<MessageTemplateCategory, string> = {
  WELCOME: "Welcome",
  RENEWAL_REMINDER: "Renewal reminder",
  EXPIRY_NOTICE: "Expiry notification",
  RENEWAL_OFFER: "Renewal offer",
  FOLLOW_UP: "Follow-up",
  INVOICE: "Invoice notification",
  PAYMENT_REMINDER: "Payment reminder",
  PAYMENT_CONFIRMATION: "Payment confirmation",
  RECEIPT: "Receipt delivery",
  THANK_YOU: "Thank you",
  CUSTOM: "Custom",
};
export const isMessageTemplateCategory = (v: unknown): v is MessageTemplateCategory => typeof v === "string" && (MESSAGE_TEMPLATE_CATEGORIES as readonly string[]).includes(v);

/**
 * Where a template is meant to be used. ANY = a plain message for whichever channel the person picks. Email is the
 * only channel Get Assist SENDS client messages through in this version; WhatsApp, Messenger and Instagram wording
 * is prepared (copied, or opened in WhatsApp's own click-to-chat) and sent by a person.
 */
export const MESSAGE_TEMPLATE_CHANNELS = ["ANY", "EMAIL", "WHATSAPP", "MESSENGER", "INSTAGRAM"] as const;
export type MessageTemplateChannel = (typeof MESSAGE_TEMPLATE_CHANNELS)[number];
export const MESSAGE_TEMPLATE_CHANNEL_LABELS: Record<MessageTemplateChannel, string> = {
  ANY: "Any channel",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  MESSENGER: "Messenger",
  INSTAGRAM: "Instagram",
};
export const isMessageTemplateChannel = (v: unknown): v is MessageTemplateChannel => typeof v === "string" && (MESSAGE_TEMPLATE_CHANNELS as readonly string[]).includes(v);

export const MESSAGE_TEMPLATE_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type MessageTemplateStatus = (typeof MESSAGE_TEMPLATE_STATUSES)[number];
export const MESSAGE_TEMPLATE_STATUS_LABELS: Record<MessageTemplateStatus, string> = { DRAFT: "Draft", ACTIVE: "Active", ARCHIVED: "Archived" };

export const MESSAGE_TEMPLATE_LIMITS = { name: 80, subject: 200, body: 4000, language: 40 } as const;

/** Every variable a template may use, with the sample used in the preview. Values come only from the client's own records. */
export const MESSAGE_VARIABLES = [
  { key: "client_name", label: "Client name", sample: "Rahim Uddin" },
  { key: "client_code", label: "Client code", sample: "0042" },
  { key: "company_name", label: "Client's company", sample: "Uddin Traders" },
  { key: "business_name", label: "Your company (from Invoice & Receipt setup)", sample: "Your Company Ltd" },
  { key: "service_name", label: "Service / plan", sample: "Internet 20 Mbps" },
  { key: "subscription_end_date", label: "Subscription expiry date", sample: "Nov 30, 2026" },
  { key: "days_left", label: "Days until expiry", sample: "7" },
  { key: "offer_amount", label: "Renewal offer amount", sample: "BDT 1,500.00" },
  { key: "offer_duration", label: "Renewal offer duration", sample: "12 months" },
  { key: "offer_valid_until", label: "Offer valid until", sample: "Dec 5, 2026" },
  { key: "invoice_number", label: "Invoice number", sample: "INV-000123" },
  { key: "invoice_amount", label: "Invoice total", sample: "BDT 1,500.00" },
  { key: "amount_due", label: "Amount still due", sample: "BDT 500.00" },
  { key: "due_date", label: "Invoice due date", sample: "Dec 10, 2026" },
  { key: "currency", label: "Currency", sample: "BDT" },
  { key: "receipt_number", label: "Receipt number", sample: "RCPT-000077" },
  { key: "payment_amount", label: "Amount received", sample: "BDT 1,000.00" },
  { key: "payment_date", label: "Payment date", sample: "Nov 28, 2026" },
  { key: "support_phone", label: "Your support phone", sample: "+880 1700-000000" },
  { key: "support_email", label: "Your support email", sample: "support@example.com" },
] as const;
export type MessageVariableKey = (typeof MESSAGE_VARIABLES)[number]["key"];
const VARIABLE_KEYS = new Set<string>(MESSAGE_VARIABLES.map((v) => v.key));
export const isMessageVariable = (v: string): v is MessageVariableKey => VARIABLE_KEYS.has(v);
export const SAMPLE_MESSAGE_VALUES: Record<MessageVariableKey, string> = Object.fromEntries(MESSAGE_VARIABLES.map((v) => [v.key, v.sample])) as Record<MessageVariableKey, string>;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** The variable names a text uses, in order of first appearance. */
export function templateVariables(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

export interface MessageTemplateInput {
  name: string;
  category: string;
  channel: string;
  language: string;
  subject: string;
  body: string;
}

export interface ValidMessageTemplate {
  name: string;
  category: MessageTemplateCategory;
  channel: MessageTemplateChannel;
  language: string | null;
  subject: string | null;
  body: string;
}

/**
 * A template as typed. Unknown variables are refused (naming the valid ones' location), an Email template needs a
 * subject, nothing is longer than its limit. A `{{` that is not a whole placeholder is refused too, because it would
 * reach a client as stray braces.
 */
export function validateMessageTemplate(input: MessageTemplateInput): { ok: true; value: ValidMessageTemplate } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const name = input.name.trim();
  if (!name) errors.push("Give the template a name.");
  else if (name.length > MESSAGE_TEMPLATE_LIMITS.name) errors.push(`The name can be at most ${MESSAGE_TEMPLATE_LIMITS.name} characters.`);
  const category = input.category.trim();
  if (!isMessageTemplateCategory(category)) errors.push("Choose a category.");
  const channel = input.channel.trim() || "ANY";
  if (!isMessageTemplateChannel(channel)) errors.push("Choose a channel.");
  const language = input.language.trim();
  if (language.length > MESSAGE_TEMPLATE_LIMITS.language) errors.push(`The language can be at most ${MESSAGE_TEMPLATE_LIMITS.language} characters.`);
  const subject = input.subject.replace(/[\r\n]+/g, " ").trim();
  if (subject.length > MESSAGE_TEMPLATE_LIMITS.subject) errors.push(`The subject can be at most ${MESSAGE_TEMPLATE_LIMITS.subject} characters.`);
  if (channel === "EMAIL" && !subject) errors.push("An email template needs a subject.");
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (!body) errors.push("Write the message.");
  else if (body.length > MESSAGE_TEMPLATE_LIMITS.body) errors.push(`The message can be at most ${MESSAGE_TEMPLATE_LIMITS.body} characters.`);

  for (const [label, text] of [
    ["subject", subject],
    ["message", body],
  ] as const) {
    const unknown = templateVariables(text).filter((v) => !isMessageVariable(v));
    if (unknown.length) errors.push(`The ${label} uses ${unknown.map((u) => `{{${u}}}`).join(", ")}, which ${unknown.length > 1 ? "are not variables" : "is not a variable"}. Pick variables from the list beside the editor.`);
    const stray = text.replace(PLACEHOLDER, "");
    if (stray.includes("{{") || stray.includes("}}")) errors.push(`The ${label} has a "{{" or "}}" that is not a whole variable.`);
  }

  if (errors.length || !isMessageTemplateCategory(category) || !isMessageTemplateChannel(channel)) return { ok: false, errors };
  return { ok: true, value: { name, category, channel, language: language || null, subject: subject || null, body } };
}

export interface RenderedMessage {
  subject: string | null;
  body: string;
  /** Variables the text used that had no value for this client — shown to the person before anything is sent. */
  missing: string[];
}

/**
 * Fills a template. A missing value renders as nothing; a line whose ONLY content was variables that are all empty
 * is dropped (an unpaid-invoice line with no invoice is left out, not shown as "Invoice: "). Values are inserted as
 * plain text — never interpreted as markup, never re-scanned for placeholders.
 */
export function renderMessageTemplate(template: { subject: string | null; body: string }, values: Partial<Record<string, string | null | undefined>>): RenderedMessage {
  const missing = new Set<string>();
  const fill = (text: string, dropEmptyLines: boolean): string =>
    text
      .split("\n")
      .map((line) => {
        const used = templateVariables(line);
        let allEmpty = used.length > 0;
        const out = line.replace(PLACEHOLDER, (_all, key: string) => {
          const value = isMessageVariable(key) ? values[key] : undefined;
          if (value === null || value === undefined || value.trim() === "") {
            missing.add(key);
            return "";
          }
          allEmpty = false;
          return value;
        });
        // Drop a line made only of empty variables and label text around them ("Invoice: {{invoice_number}}").
        return dropEmptyLines && used.length > 0 && allEmpty ? null : out.replace(/[ \t]+$/g, "");
      })
      .filter((line): line is string => line !== null)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  // The subject is one line and is never dropped; only body lines made of nothing but empty variables are.
  const subject = template.subject ? fill(template.subject, false).replace(/\s+/g, " ").trim() || null : null;
  const body = fill(template.body, true);
  return { subject, body, missing: [...missing] };
}

// ── WhatsApp click-to-chat ───────────────────────────────────────────────────────────────────────

/**
 * WhatsApp's official click-to-chat link (https://wa.me/<number>?text=…), or null when the number cannot be used.
 * The number is international digits only (no "+", no leading zeros). Opening it opens WhatsApp on the person's own
 * device with the text typed in; it sends nothing, and Get Assist never records it as sent.
 */
export function whatsappClickToChatUrl(e164OrDigits: string, text?: string): string | null {
  const digits = e164OrDigits.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length < 8 || digits.length > 15) return null;
  const body = text?.trim();
  return `https://wa.me/${digits}${body ? `?text=${encodeURIComponent(body.slice(0, 2000))}` : ""}`;
}

// ── Who may be emailed ──────────────────────────────────────────────────────────────────────────

export type EmailEligibility =
  | { ok: true; address: string }
  | { ok: false; reason: "NO_EMAIL" | "OPTED_OUT" | "CONSENT_UNKNOWN" | "ARCHIVED" | "DUPLICATE"; message: string };

export const EMAIL_SKIP_LABELS: Record<Exclude<EmailEligibility, { ok: true }>["reason"], string> = {
  NO_EMAIL: "No email address",
  OPTED_OUT: "Opted out of email",
  CONSENT_UNKNOWN: "Email consent not recorded",
  ARCHIVED: "Client archived",
  DUPLICATE: "Same address already in this batch",
};

/**
 * Whether a client may be emailed. One message to one client (an invoice, a receipt) needs an address and must
 * not be opted out; a BULK send (`bulk: true`) also needs recorded consent — unknown consent is never treated as
 * consent for a mass send (CLIENT_CENTER_PLAN.md decision 11).
 */
export function emailEligibility(
  client: { archived: boolean; emails: ReadonlyArray<{ value: string; consent: string; isPrimary?: boolean }> },
  opts: { bulk: boolean },
): EmailEligibility {
  if (client.archived) return { ok: false, reason: "ARCHIVED", message: "This client is archived." };
  const ordered = [...client.emails].sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
  if (ordered.length === 0) return { ok: false, reason: "NO_EMAIL", message: "This client has no email address." };
  const usable = ordered.filter((e) => e.consent !== "OPTED_OUT");
  if (usable.length === 0) return { ok: false, reason: "OPTED_OUT", message: "This client opted out of email." };
  if (opts.bulk) {
    const consented = usable.find((e) => e.consent === "OPTED_IN");
    if (!consented) return { ok: false, reason: "CONSENT_UNKNOWN", message: "Email consent is not recorded for this client, so a bulk email cannot include them." };
    return { ok: true, address: consented.value };
  }
  return { ok: true, address: usable[0]!.value };
}

// ── Bulk email batches ───────────────────────────────────────────────────────────────────────────

export const MESSAGE_BATCH_STATUSES = ["PENDING_APPROVAL", "QUEUED", "REJECTED", "EXPIRED", "CANCELLED"] as const;
export type MessageBatchStatus = (typeof MESSAGE_BATCH_STATUSES)[number];
export const MESSAGE_BATCH_STATUS_LABELS: Record<MessageBatchStatus, string> = {
  PENDING_APPROVAL: "Waiting for approval",
  QUEUED: "Approved and queued",
  REJECTED: "Rejected",
  EXPIRED: "Approval window passed",
  CANCELLED: "Cancelled",
};
/** A bulk email must be approved within this long of being submitted (decision 9). */
export const MESSAGE_BATCH_APPROVAL_HOURS = 24;
export const MESSAGE_BATCH_MAX_RECIPIENTS = 500;

/**
 * Whether `approverId` may approve a batch submitted by `submitterId` at `submittedAt`. Self-approval never exists
 * (decision 8), and an approval after the window is refused (decision 9) — the batch must be submitted again.
 */
export function batchApprovalRefusal(batch: { status: string; submittedById: string | null; submittedAt: Date }, approverId: string, now: Date): string | null {
  if (batch.status !== "PENDING_APPROVAL") return "This batch is no longer waiting for approval.";
  if (!batch.submittedById || batch.submittedById === approverId) return "A batch must be approved by someone other than the person who prepared it.";
  if (now.getTime() - batch.submittedAt.getTime() > MESSAGE_BATCH_APPROVAL_HOURS * 3_600_000) return `This batch waited more than ${MESSAGE_BATCH_APPROVAL_HOURS} hours for approval. Prepare it again.`;
  return null;
}

/** What a client message is shown as, from what is actually known. "Sent" is never claimed for a prepared message. */
export const CLIENT_MESSAGE_STATES = ["PREPARED", "WAITING_APPROVAL", "QUEUED", "SENDING", "ACCEPTED", "FAILED", "UNKNOWN", "SKIPPED", "CANCELLED"] as const;
export type ClientMessageState = (typeof CLIENT_MESSAGE_STATES)[number];
export const CLIENT_MESSAGE_STATE_LABELS: Record<ClientMessageState, string> = {
  PREPARED: "Prepared (not sent by Get Assist)",
  WAITING_APPROVAL: "Waiting for approval",
  QUEUED: "Queued",
  SENDING: "Sending",
  ACCEPTED: "Accepted by the mail server",
  FAILED: "Failed",
  UNKNOWN: "Outcome unknown",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled",
};

/** A message's state from its own status and, for an email, its outbox row's status. */
export function clientMessageState(message: { status: string; channel: string }, outboxStatus: string | null): ClientMessageState {
  if (message.status === "SKIPPED" || message.status === "CANCELLED" || message.status === "WAITING_APPROVAL" || message.status === "PREPARED") return message.status;
  if (message.channel === "EMAIL" && outboxStatus) {
    if (outboxStatus === "QUEUED") return "QUEUED";
    if (outboxStatus === "SENDING") return "SENDING";
    if (outboxStatus === "ACCEPTED") return "ACCEPTED";
    if (outboxStatus === "FAILED") return "FAILED";
    if (outboxStatus === "UNKNOWN") return "UNKNOWN";
  }
  return "QUEUED";
}
