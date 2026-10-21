import { createHash, randomBytes } from "node:crypto";
import { platformPrisma } from "@/server/db";
import { hostRoutingForcedOff } from "@/server/hostScope";
import {
  billingNotice,
  DEFAULT_GRACE_DAYS,
  DEFAULT_REMINDER_DAYS,
  subscriptionState,
  type BillingNotice,
  type SubscriptionReading,
} from "@support-automation/shared";

/**
 * Read side of SaaS billing (SAAS_PLATFORM_PLAN.md section 10): settings, a customer's subscription
 * with its invoices, payments and history, and what a workspace shows its people. Every state shown
 * is computed by `subscriptionState` at read time; the stored `status` is only a cache.
 */

export interface BillingSettingsData {
  defaultGraceDays: number;
  reminderDaysBefore: number[];
  paymentInstructions: string | null;
}

export async function getBillingSettings(): Promise<BillingSettingsData> {
  const row = await platformPrisma.platformBillingSettings.findUnique({ where: { id: "default" } });
  return {
    defaultGraceDays: row?.defaultGraceDays ?? DEFAULT_GRACE_DAYS,
    reminderDaysBefore: row?.reminderDaysBefore?.length ? row.reminderDaysBefore : [...DEFAULT_REMINDER_DAYS],
    paymentInstructions: row?.paymentInstructions ?? null,
  };
}

export interface PlanView {
  id: string;
  name: string;
  description: string | null;
  priceMinor: string;
  currency: string;
  interval: string;
  trialDays: number;
  maxWhatsAppAccounts: number | null;
  maxUsers: number | null;
  features: string[];
  isActive: boolean;
  customers: number;
}

export async function listPlans(): Promise<PlanView[]> {
  const rows = await platformPrisma.plan.findMany({
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { subscriptions: { where: { endedAt: null } } } } },
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    priceMinor: p.priceMinor.toString(),
    currency: p.currency,
    interval: p.interval,
    trialDays: p.trialDays,
    maxWhatsAppAccounts: p.maxWhatsAppAccounts,
    maxUsers: p.maxUsers,
    features: p.features,
    isActive: p.isActive,
    customers: p._count.subscriptions,
  }));
}

export interface SubscriptionView {
  id: string;
  planId: string | null;
  planName: string;
  priceMinor: string;
  currency: string;
  interval: string;
  maxWhatsAppAccounts: number | null;
  maxUsers: number | null;
  features: string[];
  startsAt: string;
  trialEndsAt: string | null;
  paidThrough: string | null;
  graceDays: number;
  autoEnforce: boolean;
  suspendedAt: string | null;
  suspendReason: string | null;
  cancelledAt: string | null;
  notes: string | null;
  reading: { state: SubscriptionReading["state"]; held: boolean; accessUntil: string | null; suspendsAt: string | null; manualSuspension: boolean };
}

type SubscriptionRow = NonNullable<Awaited<ReturnType<typeof platformPrisma.subscription.findFirst>>>;

export function toSubscriptionView(sub: SubscriptionRow, now = new Date()): SubscriptionView {
  const r = subscriptionState(sub, now);
  return {
    id: sub.id,
    planId: sub.planId,
    planName: sub.planName,
    priceMinor: sub.priceMinor.toString(),
    currency: sub.currency,
    interval: sub.interval,
    maxWhatsAppAccounts: sub.maxWhatsAppAccounts,
    maxUsers: sub.maxUsers,
    features: sub.features,
    startsAt: sub.startsAt.toISOString(),
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    paidThrough: sub.paidThrough?.toISOString() ?? null,
    graceDays: sub.graceDays,
    autoEnforce: sub.autoEnforce,
    suspendedAt: sub.suspendedAt?.toISOString() ?? null,
    suspendReason: sub.suspendReason,
    cancelledAt: sub.cancelledAt?.toISOString() ?? null,
    notes: sub.notes,
    reading: {
      state: r.state,
      held: r.held,
      accessUntil: r.accessUntil?.toISOString() ?? null,
      suspendsAt: r.suspendsAt?.toISOString() ?? null,
      manualSuspension: r.manualSuspension,
    },
  };
}

export interface InvoiceView {
  id: string;
  number: string;
  periodStart: string;
  periodEnd: string;
  amountMinor: string;
  currency: string;
  status: string;
  dueAt: string;
  issuedAt: string;
  paidAt: string | null;
  voidReason: string | null;
}

export interface PaymentView {
  id: string;
  invoiceNumber: string | null;
  amountMinor: string;
  currency: string;
  method: string;
  reference: string | null;
  receivedAt: string;
  note: string | null;
  recordedByUsername: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface CustomerBillingData {
  subscription: SubscriptionView | null;
  invoices: InvoiceView[];
  payments: PaymentView[];
  events: Array<{ id: string; kind: string; detail: unknown; actorUsername: string | null; createdAt: string }>;
}

export async function getCustomerBilling(customerId: string, options: { events?: boolean } = {}): Promise<CustomerBillingData> {
  const [subscription, invoices, payments, events] = await Promise.all([
    platformPrisma.subscription.findFirst({ where: { customerId, endedAt: null } }),
    platformPrisma.subscriptionInvoice.findMany({ where: { customerId }, orderBy: { issuedAt: "desc" }, take: 100 }),
    platformPrisma.subscriptionPayment.findMany({ where: { customerId }, orderBy: { receivedAt: "desc" }, take: 100, include: { invoice: { select: { number: true } } } }),
    options.events ? platformPrisma.subscriptionEvent.findMany({ where: { customerId }, orderBy: { createdAt: "desc" }, take: 50 }) : Promise.resolve([]),
  ]);
  return {
    subscription: subscription ? toSubscriptionView(subscription) : null,
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.number,
      periodStart: i.periodStart.toISOString(),
      periodEnd: i.periodEnd.toISOString(),
      amountMinor: i.amountMinor.toString(),
      currency: i.currency,
      status: i.status,
      dueAt: i.dueAt.toISOString(),
      issuedAt: i.issuedAt.toISOString(),
      paidAt: i.paidAt?.toISOString() ?? null,
      voidReason: i.voidReason,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      invoiceNumber: p.invoice?.number ?? null,
      amountMinor: p.amountMinor.toString(),
      currency: p.currency,
      method: p.method,
      reference: p.reference,
      receivedAt: p.receivedAt.toISOString(),
      note: p.note,
      recordedByUsername: p.recordedByUsername,
      reversedAt: p.reversedAt?.toISOString() ?? null,
      reversalReason: p.reversalReason,
    })),
    events: events.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, actorUsername: e.actorUsername, createdAt: e.createdAt.toISOString() })),
  };
}

/** The customer behind a project, if any. */
export async function customerForProject(projectId: string): Promise<{ id: string; name: string } | null> {
  const row = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { customer: { select: { id: true, name: true } } } });
  return row?.customer ?? null;
}

/**
 * What a workspace shows about its subscription. A held workspace tells everybody (so nobody
 * wonders why nothing saves); "payment due" and "ends soon" go only to the people who can act on
 * them — the owner (Lead) and Main Admins. No subscription = nothing to say.
 */
export async function workspaceBillingNotice(projectId: string, viewerCanManageBilling: boolean): Promise<BillingNotice | null> {
  const customer = await customerForProject(projectId);
  if (!customer) return null;
  const sub = await platformPrisma.subscription.findFirst({ where: { customerId: customer.id, endedAt: null } });
  if (!sub) return null;
  const settings = await getBillingSettings();
  const now = new Date();
  const notice = billingNotice(subscriptionState(sub, now), now, Math.max(...settings.reminderDaysBefore, 0));
  if (!notice) return null;
  if (notice.tone !== "danger" && !viewerCanManageBilling) return null;
  return notice;
}

// ---------------------------------------------------------------------------------------------
// Owner access
// ---------------------------------------------------------------------------------------------

export interface CustomerPerson {
  userId: string;
  username: string;
  name: string;
  email: string | null;
  isActive: boolean;
  isLead: boolean;
  lastLoginAt: string | null;
}

export async function customerPeople(projectId: string): Promise<CustomerPerson[]> {
  const rows = await platformPrisma.projectAccess.findMany({
    where: { projectId },
    select: {
      user: {
        select: {
          id: true,
          username: true,
          name: true,
          email: true,
          isActive: true,
          lastLoginAt: true,
          projectMemberRoles: { where: { projectId }, select: { isLead: true } },
          permissionModule: { select: { permissions: { where: { permission: { key: "projects.manage" } }, select: { permissionId: true } } } },
        },
      },
    },
  });
  return rows
    .filter((r) => !(r.user.permissionModule?.permissions.length ?? 0))
    .map((r) => ({
      userId: r.user.id,
      username: r.user.username,
      name: r.user.name,
      email: r.user.email,
      isActive: r.user.isActive,
      isLead: r.user.projectMemberRoles.some((m) => m.isLead),
      lastLoginAt: r.user.lastLoginAt?.toISOString() ?? null,
    }))
    .sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.name.localeCompare(b.name));
}

export interface InvitationView {
  id: string;
  name: string;
  email: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  emailedAt: string | null;
  createdAt: string;
}

export async function customerInvitations(customerId: string): Promise<InvitationView[]> {
  const rows = await platformPrisma.userInvitation.findMany({ where: { customerId }, orderBy: { createdAt: "desc" }, take: 20 });
  return rows.map((i) => ({
    id: i.id,
    name: i.name,
    email: i.email,
    expiresAt: i.expiresAt.toISOString(),
    acceptedAt: i.acceptedAt?.toISOString() ?? null,
    revokedAt: i.revokedAt?.toISOString() ?? null,
    emailedAt: i.emailedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  }));
}

/** A fresh invitation token and the hash that is stored (the token itself never is). */
export function newInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(`nexora-invitation:${token}`).digest("hex");
}

/**
 * Where an invitation link should point: the customer's live address when it has one, otherwise
 * the platform address. The token is single-use and works on either.
 */
/**
 * Where the owner's invitation link points: the customer's OWN address, since an invitation is
 * refused on an admin address and on another customer's address once routing is on. ACTIVE first,
 * then VERIFIED (it routes, and the proxy issues its certificate on the first visit). The scheme
 * follows the platform address (https in production). With no routable address the platform
 * address works only while routing is off; with routing on, no link is made rather than one that fails.
 */
export async function invitationBaseUrl(customerId: string): Promise<{ url: string } | { error: string }> {
  const platform = (process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "");
  const scheme = platform.startsWith("http://") ? "http" : "https";
  const domains = await platformPrisma.customerDomain.findMany({
    where: { customerId, status: { in: ["ACTIVE", "VERIFIED"] } },
    orderBy: [{ activatedAt: "asc" }, { verifiedAt: "asc" }],
    select: { hostname: true, status: true },
  });
  const own = domains.find((d) => d.status === "ACTIVE") ?? domains[0];
  if (own) return { url: `${scheme}://${own.hostname}` };
  const settings = await platformPrisma.platformDomainSettings.findUnique({ where: { id: "default" }, select: { hostRoutingEnabled: true } });
  if (settings?.hostRoutingEnabled && !hostRoutingForcedOff()) {
    return { error: "This customer has no verified address yet, and with hostname routing on an invitation opened anywhere else is refused. Add the customer's address, press Check now, then invite again." };
  }
  return { url: platform };
}

/** Each customer's current subscription, as the Customers list shows it. */
export async function listCustomerSubscriptions(): Promise<Map<string, { planName: string; state: SubscriptionReading["state"]; accessUntil: string | null }>> {
  const rows = await platformPrisma.subscription.findMany({ where: { endedAt: null } });
  const now = new Date();
  return new Map(
    rows.map((s) => {
      const r = subscriptionState(s, now);
      return [s.customerId, { planName: s.planName, state: r.state, accessUntil: r.accessUntil?.toISOString() ?? null }];
    }),
  );
}
