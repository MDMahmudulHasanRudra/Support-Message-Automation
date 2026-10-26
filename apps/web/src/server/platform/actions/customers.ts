"use server";

import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { revalidatePath } from "next/cache";
import { createProjectWithDefaults, ensureDefaultRoles, prisma as globalPrisma, type Prisma } from "@support-automation/db";
import {
  isDomainStatus,
  nextDomainStatus,
  normalizeHostname,
  normalizeProjectName,
  validateCustomerHostname,
  validateProjectName,
  validateProjectSlug,
  type DomainCheckStep,
  type DomainStatus,
} from "@support-automation/shared";
import { forgetProjectAccessDecisions } from "@/server/projectContext";
import { forgetHostScopes, requestHostname } from "@/server/hostScope";
import { forgetFoundingCustomer } from "@/server/tenant";
import { confirmOperatorPassword, requireOperatorAction } from "@/server/platform/auth";
import { purgeCustomerData, removeCustomerData, restoreCustomerData } from "@/server/platform/customerRemoval";
import { logPlatformEvent } from "@/server/platform/log";
import { assignPlan, createOwnerLogin, inviteOwner, recordPayment } from "@/server/platform/actions/billing";
import { checkDomainBase, checkDomainHttps, domainNetwork } from "@/server/domainVerification";
import { isUniqueViolation } from "@/lib/prismaErrors";

/**
 * RELQIVO platform layer (SAAS_PLATFORM_PLAN.md §12): customers, their provisioning, their addresses,
 * and the platform's domain settings. Every action needs a signed-in platform operator and checks it
 * itself — a Server Action is a public endpoint whatever page shows its button. Platform rows, plus
 * provisioning a NEW customer's software; an existing customer's data is never read or changed here.
 */

async function requireManage(): Promise<{ session: { username: string } } | { denied: string }> {
  const access = await requireOperatorAction();
  return "denied" in access ? access : { session: { username: access.operator.username } };
}

function changed() {
  forgetHostScopes();
  forgetProjectAccessDecisions();
  forgetFoundingCustomer();
  revalidatePath("/platform", "layout");
}

const text = (formData: FormData, key: string, max: number) => String(formData.get(key) ?? "").trim().slice(0, max) || null;

// ---------------------------------------------------------------------------------------------
// Platform domain settings
// ---------------------------------------------------------------------------------------------

export interface DomainSettingsState {
  error?: string;
  fieldErrors?: Partial<Record<"rootDomain" | "adminHostnames" | "publicIps" | "reservedLabels" | "hostRoutingEnabled", string>>;
  savedAt?: number;
}

const list = (raw: FormDataEntryValue | null) =>
  String(raw ?? "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);

export async function saveDomainSettings(_prev: DomainSettingsState, formData: FormData): Promise<DomainSettingsState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };

  const fieldErrors: NonNullable<DomainSettingsState["fieldErrors"]> = {};
  const rootRaw = String(formData.get("rootDomain") ?? "").trim();
  const rootDomain = rootRaw ? normalizeHostname(rootRaw) : null;
  if (rootRaw && (!rootDomain || !rootDomain.includes("."))) fieldErrors.rootDomain = "Enter a domain such as udboy.com.";

  const adminHostnames: string[] = [];
  for (const raw of list(formData.get("adminHostnames"))) {
    const host = normalizeHostname(raw);
    if (!host || !host.includes(".")) fieldErrors.adminHostnames = `"${raw}" is not a hostname.`;
    else if (!adminHostnames.includes(host)) adminHostnames.push(host);
  }
  const publicIps: string[] = [];
  for (const raw of list(formData.get("publicIps"))) {
    if (!isIP(raw)) fieldErrors.publicIps = `"${raw}" is not an IP address.`;
    else if (!publicIps.includes(raw)) publicIps.push(raw);
  }
  const reservedLabels: string[] = [];
  for (const raw of list(formData.get("reservedLabels"))) {
    const label = raw.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) fieldErrors.reservedLabels = `"${raw}" is not a valid subdomain label.`;
    else if (!reservedLabels.includes(label)) reservedLabels.push(label);
  }
  const hostRoutingEnabled = formData.get("hostRoutingEnabled") === "on";
  // An address belongs to the Main Admin or to one customer, never both.
  if (adminHostnames.length > 0) {
    const taken = await globalPrisma.customerDomain.findMany({ where: { hostname: { in: adminHostnames } }, select: { hostname: true } });
    if (taken.length > 0) {
      fieldErrors.adminHostnames = `${taken.map((t) => t.hostname).join(", ")} belongs to a customer. Use a separate platform address such as admin.${rootDomain ?? "example.com"}.`;
    }
  }

  if (hostRoutingEnabled) {
    // Switching routing on from an address that is not an admin address would lock the person
    // doing it out of the portal on the next request.
    const here = await requestHostname();
    if (here && !adminHostnames.includes(here) && !/^(localhost|\d{1,3}(\.\d{1,3}){3})$/.test(here)) {
      fieldErrors.hostRoutingEnabled = `You are using ${here}. Open this page from the platform address${adminHostnames[0] ? ` (${adminHostnames[0]})` : ""} to switch routing on — from here you would lose the platform the moment routing is on.`;
    }
    if (!rootDomain) fieldErrors.rootDomain = fieldErrors.rootDomain ?? "Set the root domain before switching routing on.";
    if (adminHostnames.length === 0) fieldErrors.adminHostnames = fieldErrors.adminHostnames ?? "Add at least one admin hostname before switching routing on.";
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const data = { rootDomain, adminHostnames, publicIps, reservedLabels, hostRoutingEnabled, updatedByUsername: access.session.username };
  const before = await globalPrisma.platformDomainSettings.findUnique({ where: { id: "default" }, select: { hostRoutingEnabled: true } });
  await globalPrisma.platformDomainSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  await logPlatformEvent(hostRoutingEnabled !== Boolean(before?.hostRoutingEnabled) ? "WARN" : "INFO", "Domain settings saved", {
    rootDomain,
    adminHostnames,
    publicIps,
    hostRoutingEnabled,
    routingChanged: hostRoutingEnabled !== Boolean(before?.hostRoutingEnabled),
    changedBy: access.session.username,
  });
  changed();
  return { savedAt: Date.now() };
}

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------

export interface CustomerFormState {
  error?: string;
  fieldErrors?: Partial<
    Record<
      | "name" | "contactEmail" | "projectName" | "projectSlug" | "hostname" | "mode" | "planId" | "price" | "paidThrough"
      | "paymentAmount" | "ownerName" | "ownerEmail" | "ownerUsername" | "ownerPassword",
      string
    >
  >;
  savedAt?: number;
  /** After Add customer: where it is, the owner's link (shown once) and anything left to finish. */
  created?: { customerId: string; link?: string; notes: string[] };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function customerFields(formData: FormData, fieldErrors: NonNullable<CustomerFormState["fieldErrors"]>) {
  const name = String(formData.get("name") ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) fieldErrors.name = "Enter the customer's name.";
  const contactEmail = text(formData, "contactEmail", 200);
  if (contactEmail && !EMAIL_RE.test(contactEmail)) fieldErrors.contactEmail = "Enter a valid email address, or leave it empty.";
  return {
    name,
    contactName: text(formData, "contactName", 120),
    contactEmail,
    contactPhone: text(formData, "contactPhone", 40),
    notes: text(formData, "notes", 2_000),
  };
}

const form = (fields: Record<string, string | null | undefined>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined && v !== "") f.set(k, v);
  return f;
};

/**
 * Add a customer (SAAS_PLATFORM_PLAN.md §12):
 *   - NEW: provisions a complete, separate copy of the software — its own standard roles, its first
 *     workspace (every default), its plan (All Access unless chosen otherwise) with the agreed price,
 *     expiry and an optional first payment, its address, and its owner as ITS Main Admin (invited or
 *     created). Nothing is copied from, or visible to, any other customer.
 *   - ORIGINAL: adopts the original installation as the founding customer (Customer #1). Nothing in
 *     it changes — no row is rewritten, no plan is given, nobody is limited; only the link is added.
 * Each later step reports what it could not do rather than undoing the customer.
 */
export async function createCustomer(_prev: CustomerFormState, formData: FormData): Promise<CustomerFormState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const actor = access.session.username;

  const fieldErrors: NonNullable<CustomerFormState["fieldErrors"]> = {};
  const fields = customerFields(formData, fieldErrors);
  const mode = formData.get("mode") === "original" ? "original" : "new";
  if (mode === "original" && (await globalPrisma.customer.count({ where: { isFounding: true } })) > 0) {
    fieldErrors.mode = "The original installation is already a customer.";
  }

  let project: { name: string; slug: string } | null = null;
  if (mode === "new") {
    const name = normalizeProjectName(String(formData.get("projectName") ?? ""));
    const slug = String(formData.get("projectSlug") ?? "").trim();
    const nameError = validateProjectName(name);
    const slugError = validateProjectSlug(slug);
    if (nameError) fieldErrors.projectName = nameError;
    if (slugError) fieldErrors.projectSlug = slugError;
    if (!slugError && (await globalPrisma.project.findUnique({ where: { slug }, select: { id: true } }))) {
      fieldErrors.projectSlug = `The address "${slug}" is already used by another workspace.`;
    }
    project = { name, slug };
    const ownerMode = String(formData.get("ownerMode") ?? "invite");
    if (ownerMode !== "later" && !text(formData, "ownerName", 120)) fieldErrors.ownerName = "Enter the owner's name.";
    const ownerEmail = text(formData, "ownerEmail", 200);
    if (ownerEmail && !EMAIL_RE.test(ownerEmail)) fieldErrors.ownerEmail = "Enter a valid email address, or leave it empty.";
    if (ownerMode === "login") {
      if (!text(formData, "ownerUsername", 60)) fieldErrors.ownerUsername = "Choose the owner's username.";
      if (String(formData.get("ownerPassword") ?? "").length < 12) fieldErrors.ownerPassword = "At least 12 characters.";
    }
  }

  let hostname: string | null = null;
  const hostRaw = String(formData.get("hostname") ?? "").trim();
  if (hostRaw) {
    const settings = await globalPrisma.platformDomainSettings.findUnique({ where: { id: "default" } });
    const valid = validateCustomerHostname(hostRaw, {
      hostRoutingEnabled: Boolean(settings?.hostRoutingEnabled),
      rootDomain: settings?.rootDomain ?? null,
      adminHostnames: settings?.adminHostnames ?? [],
      reservedLabels: settings?.reservedLabels ?? [],
    });
    if ("error" in valid) fieldErrors.hostname = valid.error;
    else if (await globalPrisma.customerDomain.findUnique({ where: { hostname: valid.hostname }, select: { id: true } })) {
      fieldErrors.hostname = `${valid.hostname} is already assigned to a customer.`;
    } else hostname = valid.hostname;
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  // 1. The customer and its address — one transaction.
  let customerId: string;
  try {
    customerId = await globalPrisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({ data: { ...fields, isFounding: mode === "original", createdByUsername: actor }, select: { id: true } });
      if (hostname) {
        await tx.customerDomain.create({
          data: { customerId: customer.id, hostname, verificationToken: randomBytes(24).toString("base64url"), createdByUsername: actor },
        });
      }
      return customer.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return mode === "original" ? { fieldErrors: { mode: "The original installation was just adopted." } } : { fieldErrors: { hostname: `${hostname} is already assigned to a customer.` } };
    }
    throw err;
  }
  changed();
  const notes: string[] = [];
  if (mode === "original") {
    await logPlatformEvent("WARN", `Original installation adopted as customer "${fields.name}"`, { customerId, hostname, createdBy: actor }, { type: "Customer", id: customerId });
    if (!hostname) notes.push("Add the customer's address (for example zoventio.udboy.com) on its page.");
    return { created: { customerId, notes } };
  }

  // 2. Its own copy of the software: standard roles, then its first workspace.
  await ensureDefaultRoles(globalPrisma, customerId);
  let projectId: string;
  try {
    projectId = (await createProjectWithDefaults({ ...project!, status: "ACTIVE", creatorUserId: null, customerId }, globalPrisma)).id;
  } catch (err) {
    if (isUniqueViolation(err)) notes.push(`The workspace address "${project!.slug}" was taken a moment ago — create the workspace from the customer's page.`);
    else throw err;
    await logPlatformEvent("WARN", `Customer "${fields.name}" created without a workspace`, { customerId, createdBy: actor }, { type: "Customer", id: customerId });
    return { created: { customerId, notes } };
  }

  // 3. Plan, price, expiry, first payment.
  const planId = String(formData.get("planId") ?? "");
  if (planId) {
    const assigned = await assignPlan(customerId, {}, form({
      planId,
      price: text(formData, "price", 20),
      paidThrough: text(formData, "paidThrough", 10),
      graceDays: text(formData, "graceDays", 3),
      autoEnforce: formData.get("autoEnforce") === "on" ? "on" : null,
      applyFeatures: "on",
    }));
    if (assigned.error || assigned.fieldErrors) notes.push(`Plan not assigned: ${assigned.error ?? Object.values(assigned.fieldErrors ?? {}).join(" ")}`);
    else if (text(formData, "paymentAmount", 20)) {
      const paid = await recordPayment(customerId, {}, form({
        amount: text(formData, "paymentAmount", 20),
        method: text(formData, "paymentMethod", 20) ?? "OTHER",
        reference: text(formData, "paymentReference", 120),
      }));
      if (paid.error || paid.fieldErrors) notes.push(`First payment not recorded: ${paid.error ?? Object.values(paid.fieldErrors ?? {}).join(" ")}`);
    }
  } else notes.push("No plan was given: this customer is not billed, limited or suspended until you assign one.");

  // 4. The owner: the customer's own Main Admin.
  let link: string | undefined;
  const ownerMode = String(formData.get("ownerMode") ?? "invite");
  if (ownerMode === "invite") {
    const invited = await inviteOwner(customerId, {}, form({ name: text(formData, "ownerName", 120), email: text(formData, "ownerEmail", 200) }));
    if (invited.link) link = invited.link;
    else notes.push(`Owner not invited: ${invited.error ?? Object.values(invited.fieldErrors ?? {}).join(" ")}`);
  } else if (ownerMode === "login") {
    const password = String(formData.get("ownerPassword") ?? "");
    const created = await createOwnerLogin(customerId, {}, form({
      name: text(formData, "ownerName", 120),
      email: text(formData, "ownerEmail", 200),
      username: text(formData, "ownerUsername", 60),
      password,
      confirmPassword: password,
    }));
    if (created.error) notes.push(`Owner login not created: ${created.error}`);
  } else notes.push("No owner yet: invite them from the customer's page.");
  if (!hostname) notes.push("Add the customer's address on its page, then create its DNS record and press Check now.");

  await logPlatformEvent("INFO", `Customer "${fields.name}" provisioned`, { customerId, projectId, hostname, planId: planId || null, ownerMode, createdBy: actor }, { type: "Customer", id: customerId });
  changed();
  return { created: { customerId, link, notes } };
}

export async function updateCustomer(customerId: string, _prev: CustomerFormState, formData: FormData): Promise<CustomerFormState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const fieldErrors: NonNullable<CustomerFormState["fieldErrors"]> = {};
  const fields = customerFields(formData, fieldErrors);
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  const result = await globalPrisma.customer.updateMany({ where: { id: customerId, removedAt: null }, data: fields });
  if (result.count === 0) return { error: "This customer is removed or no longer exists." };
  await logPlatformEvent("INFO", `Customer "${fields.name}" updated`, { customerId, changedBy: access.session.username });
  changed();
  return { savedAt: Date.now() };
}

// ---------------------------------------------------------------------------------------------
// Remove / restore / delete permanently (CUSTOMER_REMOVAL.md)
// ---------------------------------------------------------------------------------------------

export interface CustomerRemovalState {
  error?: string;
  fieldErrors?: Partial<Record<"mode" | "confirmName" | "operatorPassword", string>>;
  done?: string;
}

/**
 * Remove (keep the data) or delete permanently — the operator picks `mode`. Both need the customer's
 * exact name typed and the operator's own platform password; the founding customer is refused.
 */
export async function removeOrDeleteCustomer(customerId: string, _prev: CustomerRemovalState, formData: FormData): Promise<CustomerRemovalState> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  const mode = String(formData.get("mode") ?? "");
  const fieldErrors: NonNullable<CustomerRemovalState["fieldErrors"]> = {};
  if (mode !== "remove" && mode !== "delete") fieldErrors.mode = "Choose Remove or Delete permanently.";
  const customer = await globalPrisma.customer.findUnique({ where: { id: customerId }, select: { name: true, isFounding: true, purgedAt: true } });
  if (!customer) return { error: "This customer no longer exists." };
  if (customer.isFounding) return { error: "The original installation can be neither removed nor deleted." };
  if (String(formData.get("confirmName") ?? "").trim() !== customer.name.trim()) fieldErrors.confirmName = `Type the customer's name exactly: ${customer.name}`;
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  if (!(await confirmOperatorPassword(access.operator, formData.get("operatorPassword")))) {
    return { fieldErrors: { operatorPassword: "Your platform password is not correct." } };
  }
  const actor = access.operator.username;

  if (mode === "remove") {
    const removed = await removeCustomerData(customerId, actor);
    if ("error" in removed) return { error: removed.error };
    await logPlatformEvent(
      "WARN",
      `Customer "${removed.name}" removed (data kept)`,
      { customerId, removedBy: actor, workspaces: removed.snapshot.projects.length, addresses: removed.snapshot.domains.length, logins: removed.snapshot.userIds.length },
      { type: "Customer", id: customerId },
    );
    changed();
    return { done: `${removed.name} was removed. Its data is kept, and it can be restored.` };
  }

  const purged = await purgeCustomerData(customerId, actor);
  if ("error" in purged) return { error: purged.error };
  await logPlatformEvent(
    "WARN",
    `Customer "${purged.name}" deleted permanently`,
    { customerId, deletedBy: actor, workspaces: purged.projectIds, rows: purged.deleted, mediaRemoved: purged.mediaRemoved },
    { type: "Customer", id: customerId },
  );
  changed();
  return {
    done: purged.mediaRemoved
      ? `${purged.name} was deleted permanently.`
      : `${purged.name} was deleted permanently. Some media files could not be removed from storage; they are no longer linked to anything.`,
  };
}

/** Undo Remove: needs the operator's password. A permanently deleted customer cannot come back. */
export async function restoreCustomer(customerId: string, _prev: CustomerRemovalState, formData: FormData): Promise<CustomerRemovalState> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  if (!(await confirmOperatorPassword(access.operator, formData.get("operatorPassword")))) {
    return { fieldErrors: { operatorPassword: "Your platform password is not correct." } };
  }
  const restored = await restoreCustomerData(customerId);
  if ("error" in restored) return { error: restored.error };
  await logPlatformEvent("WARN", `Customer "${restored.name}" restored`, { customerId, restoredBy: access.operator.username, ...restored.restored }, { type: "Customer", id: customerId });
  changed();
  return { done: `${restored.name} is back: ${restored.restored.projects} workspace(s), ${restored.restored.domains} address(es) and ${restored.restored.users} login(s) restored. Pending invitations stay cancelled; send new ones.` };
}

// ---------------------------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------------------------

export interface DomainActionResult {
  error?: string;
  success?: string;
}

async function domainSettingsView() {
  const settings = await globalPrisma.platformDomainSettings.findUnique({ where: { id: "default" } });
  return {
    hostRoutingEnabled: Boolean(settings?.hostRoutingEnabled),
    rootDomain: settings?.rootDomain ?? null,
    adminHostnames: settings?.adminHostnames ?? [],
    reservedLabels: settings?.reservedLabels ?? [],
    publicIps: settings?.publicIps ?? [],
  };
}

export async function addCustomerDomain(customerId: string, _prev: DomainActionResult, formData: FormData): Promise<DomainActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const customer = await globalPrisma.customer.findUnique({ where: { id: customerId, removedAt: null }, select: { id: true, name: true } });
  if (!customer) return { error: "This customer no longer exists." };
  const valid = validateCustomerHostname(formData.get("hostname"), await domainSettingsView());
  if ("error" in valid) return { error: valid.error };
  try {
    await globalPrisma.customerDomain.create({
      data: { customerId, hostname: valid.hostname, verificationToken: randomBytes(24).toString("base64url"), createdByUsername: access.session.username },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: `${valid.hostname} is already assigned to a customer.` };
    throw err;
  }
  await logPlatformEvent("INFO", `Domain ${valid.hostname} added`, { customerId, hostname: valid.hostname, changedBy: access.session.username });
  changed();
  return { success: `${valid.hostname} added. Create the DNS record shown, then press Check now.` };
}

/**
 * Run the checks and move the status (`nextDomainStatus`). VERIFIED is saved BEFORE the HTTPS step:
 * the reverse proxy only obtains a certificate for a hostname the app says yes to, and the HTTPS
 * request is what makes it ask.
 */
export async function checkCustomerDomain(domainId: string): Promise<DomainActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const domain = await globalPrisma.customerDomain.findUnique({ where: { id: domainId } });
  if (!domain) return { error: "This domain no longer exists." };
  if (domain.status === "DISABLED") return { error: "This domain is disabled. Enable it first, then check it." };
  const current: DomainStatus = isDomainStatus(domain.status) ? domain.status : "PENDING";
  const settings = await domainSettingsView();
  const net = domainNetwork();

  const steps: DomainCheckStep[] = await checkDomainBase(domain, settings, net);
  const baseOk = steps.length === 3 && steps.every((s) => s.ok);
  if (baseOk && current === "PENDING") {
    await globalPrisma.customerDomain.updateMany({ where: { id: domainId, status: "PENDING" }, data: { status: "VERIFIED", verifiedAt: new Date() } });
    forgetHostScopes();
  }
  if (baseOk) steps.push(await checkDomainHttps(domain, net));

  const next = nextDomainStatus(baseOk && current === "PENDING" ? "VERIFIED" : current, steps);
  const now = new Date();
  await globalPrisma.customerDomain.updateMany({
    where: { id: domainId, status: { not: "DISABLED" } },
    data: {
      status: next,
      lastCheck: steps as unknown as Prisma.InputJsonValue,
      lastCheckedAt: now,
      ...(next === "ACTIVE" && !domain.activatedAt ? { activatedAt: now } : {}),
      ...(next !== "PENDING" && !domain.verifiedAt ? { verifiedAt: now } : {}),
    },
  });
  await logPlatformEvent(next === "ACTIVE" ? "INFO" : "WARN", `Domain ${domain.hostname} checked: ${next}`, {
    hostname: domain.hostname,
    from: current,
    to: next,
    failed: steps.filter((s) => !s.ok).map((s) => s.key),
    checkedBy: access.session.username,
  });
  changed();
  if (next === "ACTIVE") return { success: `${domain.hostname} is live.` };
  const failed = steps.find((s) => !s.ok);
  return failed ? { error: failed.detail } : { success: `${domain.hostname}: ${next.toLowerCase()}.` };
}

/** Switch an address off at once: it shows nothing, and no certificate is renewed for it. History is kept. */
export async function disableCustomerDomain(domainId: string): Promise<DomainActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const domain = await globalPrisma.customerDomain.findUnique({ where: { id: domainId }, select: { hostname: true } });
  if (!domain) return { error: "This domain no longer exists." };
  const here = await requestHostname();
  if (here === domain.hostname) return { error: "You are using this address right now. Open the platform from its own address to disable it." };
  await globalPrisma.customerDomain.update({ where: { id: domainId }, data: { status: "DISABLED", disabledAt: new Date() } });
  await logPlatformEvent("WARN", `Domain ${domain.hostname} disabled`, { hostname: domain.hostname, changedBy: access.session.username });
  changed();
  return { success: `${domain.hostname} is disabled.` };
}

/** Back to PENDING; the next check decides again from scratch. */
export async function enableCustomerDomain(domainId: string): Promise<DomainActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const result = await globalPrisma.customerDomain.updateMany({ where: { id: domainId, status: "DISABLED" }, data: { status: "PENDING", disabledAt: null } });
  if (result.count === 0) return { error: "Only a disabled domain can be enabled." };
  await logPlatformEvent("INFO", "Domain re-enabled", { domainId, changedBy: access.session.username });
  changed();
  return { success: "Enabled. Press Check now to verify it again." };
}

/** Remove an address that is not live. A live one must be disabled first, so removal is never a surprise. */
export async function removeCustomerDomain(domainId: string): Promise<DomainActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const domain = await globalPrisma.customerDomain.findUnique({ where: { id: domainId }, select: { hostname: true, status: true } });
  if (!domain) return { error: "This domain no longer exists." };
  if (domain.status === "ACTIVE" || domain.status === "VERIFIED") return { error: "Disable this domain before removing it." };
  await globalPrisma.customerDomain.delete({ where: { id: domainId } });
  await logPlatformEvent("WARN", `Domain ${domain.hostname} removed`, { hostname: domain.hostname, changedBy: access.session.username });
  changed();
  return { success: `${domain.hostname} removed.` };
}
