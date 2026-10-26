import { Prisma, decryptSecret, recomputeCustomerBilling } from "@support-automation/db";
import {
  DEFAULT_PRODUCT_NAME,
  DEFAULT_REMINDER_DAYS,
  dueReminder,
  formatMoneyMinor,
  invitationEmail,
  reminderEmail,
  subscriptionState,
  type BillingEmail,
} from "@support-automation/shared";
import { platformPrisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { checkHostIsAllowed, resolveHostAddresses, sendWithNodemailer, type HostResolver, type SmtpConnection, type SmtpSender } from "../email/smtpTransport.js";

/**
 * SaaS billing upkeep (SAAS_PLATFORM_PLAN.md §10). Platform data only — no project is entered, no
 * WhatsApp session is touched. Each tick:
 *   1. re-derives every current subscription and writes the workspace hold (`recomputeCustomerBilling`,
 *      the one writer of `Project.billingHoldAt`). A customer with NO subscription is never read
 *      here, so it can never be held — that is Customer #1 until someone assigns them a plan;
 *   2. records each due reminder once (`SubscriptionEvent.dedupKey`, claimed by insert) and, only when
 *      platform SMTP is configured, emails it to the customer's contact and its Leads;
 *   3. emails owner invitations that carry an address, once, then forgets the stored link.
 * The workspace banner (the in-app reminder) is derived on every page load and needs nothing from here.
 */

const LOOP_NAME = "saas-billing";
export const BILLING_INTERVAL_MS = 5 * 60_000;

export interface PlatformMailer {
  connection: SmtpConnection;
  fromAddress: string;
  fromName: string;
}

/**
 * The platform's own SMTP account: set on the platform (Settings → Platform email) when enabled there,
 * otherwise from the environment. Null = email is not configured: nothing is emailed.
 */
export async function platformMailer(env: NodeJS.ProcessEnv = process.env): Promise<PlatformMailer | null> {
  const row = await platformPrisma.platformEmailSettings.findUnique({ where: { id: "default" } }).catch(() => null);
  if (row?.enabled && row.host && row.fromAddress) {
    let password = "";
    try {
      password = row.passwordCiphertext ? decryptSecret(row.passwordCiphertext) : "";
    } catch {
      return null; // a password that cannot be read is not a working account
    }
    return {
      connection: { host: row.host, port: row.port, tlsMode: row.tlsMode === "TLS" ? "TLS" : "STARTTLS", username: row.username ?? "", password },
      fromAddress: row.fromAddress,
      fromName: row.fromName ?? "",
    };
  }
  return platformMailerFromEnv(env);
}

/** The platform's own SMTP account, from the environment. Null = email is not configured: nothing is emailed. */
export function platformMailerFromEnv(env: NodeJS.ProcessEnv = process.env): PlatformMailer | null {
  const host = env.PLATFORM_SMTP_HOST?.trim();
  const fromAddress = env.PLATFORM_SMTP_FROM_ADDRESS?.trim();
  if (!host || !fromAddress) return null;
  const port = Number(env.PLATFORM_SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const tls = env.PLATFORM_SMTP_TLS?.trim().toUpperCase();
  return {
    connection: {
      host,
      port,
      tlsMode: tls === "TLS" || tls === "STARTTLS" ? tls : port === 465 ? "TLS" : "STARTTLS",
      username: env.PLATFORM_SMTP_USER ?? "",
      password: env.PLATFORM_SMTP_PASSWORD ?? "",
    },
    fromAddress,
    fromName: env.PLATFORM_SMTP_FROM_NAME?.trim() || "",
  };
}

export interface BillingDeps {
  mailer: PlatformMailer | null;
  send: SmtpSender;
  resolve: HostResolver;
}

export function startBillingProcessor(intervalMs = BILLING_INTERVAL_MS): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  // A test email requested on the platform is sent within seconds, not at the next billing pass.
  let testing = false;
  setInterval(() => {
    if (testing) return;
    testing = true;
    void sendRequestedTestEmail()
      .catch((err) => console.error("[billing] test email failed", err))
      .finally(() => {
        testing = false;
      });
  }, 15_000);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    void runBillingTick()
      .catch((err) => console.error("[billing] unexpected error", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

export async function runBillingTick(now: Date = new Date(), given?: BillingDeps): Promise<void> {
  const deps: BillingDeps = given ?? { mailer: await platformMailer(), send: sendWithNodemailer, resolve: resolveHostAddresses };
  // A removed customer (CUSTOMER_REMOVAL.md) is neither recomputed nor reminded: its workspaces are
  // archived already, and nobody should be emailed about a customer the platform took away.
  const current = await platformPrisma.subscription.findMany({ where: { endedAt: null, customer: { removedAt: null } }, select: { customerId: true } });
  for (const { customerId } of current) {
    try {
      await recomputeCustomerBilling(platformPrisma, customerId, now);
    } catch (err) {
      console.error(`[billing] could not recompute customer ${customerId}`, err);
    }
  }
  await sendDueReminders(now, deps);
  await sendInvitations(now, deps);
}

async function productName(): Promise<string> {
  const row = await platformPrisma.platformBranding.findFirst({ select: { productName: true } });
  return row?.productName?.trim() || DEFAULT_PRODUCT_NAME;
}

/** Who hears about a customer's subscription: its contact, and its own Main Admins (SAAS_PLATFORM_PLAN.md §12). */
async function recipientsFor(customer: { id: string; isFounding: boolean; contactEmail: string | null }): Promise<string[]> {
  const admins = await platformPrisma.user.findMany({
    where: {
      customerId: customer.isFounding ? null : customer.id,
      supportOperatorId: null,
      isActive: true,
      email: { not: null },
      permissionModule: { permissions: { some: { permission: { key: "projects.manage" } } } },
    },
    select: { email: true },
    take: 20,
  });
  const all = [customer.contactEmail, ...admins.map((a) => a.email)].map((e) => e?.trim().toLowerCase()).filter((e): e is string => !!e);
  return [...new Set(all)];
}

/** Sends one email; never throws. Returns the failure text, or null when the server accepted it. */
async function deliver(deps: BillingDeps, to: string, email: BillingEmail, seed: string): Promise<string | null> {
  if (!deps.mailer) return "Platform email is not configured.";
  try {
    const refused = await checkHostIsAllowed(deps.mailer.connection.host, deps.resolve);
    if (refused) return refused.message;
    const outcome = await deps.send(deps.mailer.connection, {
      fromName: deps.mailer.fromName,
      fromAddress: deps.mailer.fromAddress,
      replyTo: null,
      to,
      subject: email.subject,
      text: email.text,
      messageIdSeed: seed,
    });
    return outcome.ok ? null : outcome.failure.message;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function sendDueReminders(now: Date, deps: BillingDeps): Promise<void> {
  const settings = await platformPrisma.platformBillingSettings.findFirst();
  const reminderDays = settings?.reminderDaysBefore?.length ? settings.reminderDaysBefore : DEFAULT_REMINDER_DAYS;
  const subs = await platformPrisma.subscription.findMany({
    where: { endedAt: null, customer: { removedAt: null } },
    include: { customer: { select: { id: true, isFounding: true, name: true, contactEmail: true } } },
  });
  let name: string | null = null;
  for (const sub of subs) {
    const reading = subscriptionState(sub, now);
    const reminder = dueReminder(sub.id, reading, now, reminderDays);
    if (!reminder) continue;
    // Claim it: the unique dedupKey makes the reminder happen once, across restarts and workers.
    let eventId: string;
    try {
      const created = await platformPrisma.subscriptionEvent.create({
        data: { customerId: sub.customerId, kind: `REMINDER_${reminder.kind}`, dedupKey: reminder.dedupKey, detail: { daysBefore: reminder.daysBefore ?? null } },
        select: { id: true },
      });
      eventId = created.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
    if (!deps.mailer) {
      await platformPrisma.subscriptionEvent.update({ where: { id: eventId }, data: { detail: { daysBefore: reminder.daysBefore ?? null, email: "not configured" } } });
      continue;
    }
    name ??= await productName();
    const email = reminderEmail({
      productName: name,
      customerName: sub.customer.name,
      planName: sub.planName,
      price: formatMoneyMinor(sub.priceMinor, sub.currency),
      reminder,
      reading,
      paymentInstructions: settings?.paymentInstructions ?? null,
    });
    const sent: string[] = [];
    const failed: { to: string; reason: string }[] = [];
    for (const to of await recipientsFor(sub.customer)) {
      const problem = await deliver(deps, to, email, eventId);
      if (problem) failed.push({ to, reason: problem.slice(0, 300) });
      else sent.push(to);
    }
    await platformPrisma.subscriptionEvent.update({ where: { id: eventId }, data: { detail: { daysBefore: reminder.daysBefore ?? null, sent, failed } } });
  }
}

export async function sendInvitations(now: Date, deps: BillingDeps): Promise<void> {
  if (!deps.mailer) return;
  const pending = await platformPrisma.userInvitation.findMany({
    where: { emailedAt: null, linkCiphertext: { not: null }, email: { not: null }, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    include: { customer: { select: { name: true } } },
    take: 20,
  });
  let name: string | null = null;
  for (const inv of pending) {
    // Claim before sending, so two ticks can never email the same link twice.
    const claimed = await platformPrisma.userInvitation.updateMany({ where: { id: inv.id, emailedAt: null, linkCiphertext: { not: null } }, data: { emailedAt: now } });
    if (claimed.count === 0) continue;
    let problem: string | null;
    try {
      name ??= await productName();
      const link = decryptSecret(inv.linkCiphertext!);
      problem = await deliver(deps, inv.email!, invitationEmail({ productName: name, name: inv.name, customerName: inv.customer.name, link, expiresAt: inv.expiresAt }), inv.id);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    // One attempt either way: the link is forgotten, and a failed send is left for the admin to copy by hand.
    await platformPrisma.userInvitation.update({ where: { id: inv.id }, data: { linkCiphertext: null, emailedAt: problem ? null : now } });
    await platformPrisma.subscriptionEvent.create({
      data: { customerId: inv.customerId, kind: problem ? "INVITATION_EMAIL_FAILED" : "INVITATION_EMAILED", detail: problem ? { name: inv.name, reason: problem.slice(0, 300) } : { name: inv.name } },
    });
  }
}

/** Send the test email an operator asked for on the platform, once, and report the outcome there. */
export async function sendRequestedTestEmail(given?: BillingDeps): Promise<void> {
  const row = await platformPrisma.platformEmailSettings.findUnique({ where: { id: "default" } });
  if (!row?.testRequestedAt || !row.testRequestedTo) return;
  // Claim it: two workers (or ticks) never send the same test twice.
  const claimed = await platformPrisma.platformEmailSettings.updateMany({ where: { id: "default", testRequestedAt: row.testRequestedAt }, data: { testRequestedAt: null } });
  if (claimed.count !== 1) return;
  const deps: BillingDeps = given ?? { mailer: await platformMailer(), send: sendWithNodemailer, resolve: resolveHostAddresses };
  const name = await productName();
  const problem = deps.mailer
    ? await deliver(deps, row.testRequestedTo, { subject: `${name}: platform email works`, text: `This is a test from the ${name} platform. Billing reminders and owner invitations will be sent from this account.` }, `test-${Date.now()}`)
    : "Platform email is off or incomplete.";
  await platformPrisma.platformEmailSettings.update({
    where: { id: "default" },
    data: { lastTestAt: new Date(), lastTestOk: problem === null, lastTestMessage: problem ? problem.slice(0, 300) : null, testRequestedTo: null },
  });
}
