"use server";

import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createProjectWithDefaults, type Prisma } from "@support-automation/db";
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
import { platformPrisma } from "@/server/db";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { forgetProjectAccessDecisions } from "@/server/projectContext";
import { forgetHostScopes, requestHostname } from "@/server/hostScope";
import { logSystemEvent } from "@/server/logSystemEvent";
import { checkDomainBase, checkDomainHttps, domainNetwork } from "@/server/domainVerification";
import { isUniqueViolation } from "@/lib/prismaErrors";

/**
 * SaaS platform, Phase 2 (SAAS_PLATFORM_PLAN.md): customers, their addresses, and the platform's
 * domain settings. Every action needs `projects.manage` (a Main Admin) and checks it itself — a
 * Server Action is a public endpoint whatever page shows its button — and that key exists only on
 * an address that may serve the Main Admin Portal (`keysOnHost`). Platform rows only; no project's
 * operational data is read or changed, except attaching a project to its customer.
 */

const DENIED = "Managing customers and domains needs the “Manage Projects and Project Access” permission (a Main Admin).";

async function requireManage(): Promise<{ session: Session } | { denied: string }> {
  const session = await requireSession();
  return (await hasPermission(session, "projects.manage")) ? { session } : { denied: DENIED };
}

function changed() {
  forgetHostScopes();
  forgetProjectAccessDecisions();
  revalidatePath("/admin", "layout");
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
    const taken = await platformPrisma.customerDomain.findMany({ where: { hostname: { in: adminHostnames } }, select: { hostname: true } });
    if (taken.length > 0) {
      fieldErrors.adminHostnames = `${taken.map((t) => t.hostname).join(", ")} belongs to a customer. Use a separate admin address such as admin.${rootDomain ?? "example.com"}.`;
    }
  }

  if (hostRoutingEnabled) {
    // Switching routing on from an address that is not an admin address would lock the person
    // doing it out of the portal on the next request.
    const here = await requestHostname();
    if (here && !adminHostnames.includes(here) && !/^(localhost|\d{1,3}(\.\d{1,3}){3})$/.test(here)) {
      fieldErrors.hostRoutingEnabled = `You are using ${here}. Add it to the admin hostnames first, or you would lose access to this portal the moment routing is on.`;
    }
    if (!rootDomain) fieldErrors.rootDomain = fieldErrors.rootDomain ?? "Set the root domain before switching routing on.";
    if (adminHostnames.length === 0) fieldErrors.adminHostnames = fieldErrors.adminHostnames ?? "Add at least one admin hostname before switching routing on.";
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const data = { rootDomain, adminHostnames, publicIps, reservedLabels, hostRoutingEnabled, updatedByUsername: access.session.username };
  const before = await platformPrisma.platformDomainSettings.findUnique({ where: { id: "default" }, select: { hostRoutingEnabled: true } });
  await platformPrisma.platformDomainSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  await logSystemEvent(hostRoutingEnabled !== Boolean(before?.hostRoutingEnabled) ? "WARN" : "INFO", "saas", "Domain settings saved", {
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
  fieldErrors?: Partial<Record<"name" | "contactEmail" | "projectId" | "projectName" | "projectSlug" | "hostname", string>>;
  savedAt?: number;
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

/**
 * Create a customer with its project — a NEW project (created with every default, exactly as
 * Create project does) or an EXISTING one no customer has yet (how Customer #1 is adopted: its
 * project, data and URLs stay exactly as they are). Optionally its first address.
 */
export async function createCustomer(_prev: CustomerFormState, formData: FormData): Promise<CustomerFormState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };

  const fieldErrors: NonNullable<CustomerFormState["fieldErrors"]> = {};
  const fields = customerFields(formData, fieldErrors);
  const mode = formData.get("projectMode") === "existing" ? "existing" : "new";

  let existingProjectId: string | null = null;
  let newProject: { name: string; slug: string } | null = null;
  if (mode === "existing") {
    existingProjectId = String(formData.get("projectId") ?? "") || null;
    const project = existingProjectId
      ? await platformPrisma.project.findUnique({ where: { id: existingProjectId }, select: { customerId: true } })
      : null;
    if (!project) fieldErrors.projectId = "Choose the project this customer already uses.";
    else if (project.customerId) fieldErrors.projectId = "That project already belongs to a customer.";
  } else {
    const name = normalizeProjectName(String(formData.get("projectName") ?? ""));
    const slug = String(formData.get("projectSlug") ?? "").trim();
    const nameError = validateProjectName(name);
    const slugError = validateProjectSlug(slug);
    if (nameError) fieldErrors.projectName = nameError;
    if (slugError) fieldErrors.projectSlug = slugError;
    if (!nameError && (await platformPrisma.project.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } }))) {
      fieldErrors.projectName = `A project called "${name}" already exists.`;
    }
    if (!slugError && (await platformPrisma.project.findUnique({ where: { slug }, select: { id: true } }))) {
      fieldErrors.projectSlug = `The address "${slug}" is already used by another project.`;
    }
    newProject = { name, slug };
  }

  let hostname: string | null = null;
  const hostRaw = String(formData.get("hostname") ?? "").trim();
  if (hostRaw) {
    const settings = await platformPrisma.platformDomainSettings.findUnique({ where: { id: "default" } });
    const valid = validateCustomerHostname(hostRaw, {
      hostRoutingEnabled: Boolean(settings?.hostRoutingEnabled),
      rootDomain: settings?.rootDomain ?? null,
      adminHostnames: settings?.adminHostnames ?? [],
      reservedLabels: settings?.reservedLabels ?? [],
    });
    if ("error" in valid) fieldErrors.hostname = valid.error;
    else if (await platformPrisma.customerDomain.findUnique({ where: { hostname: valid.hostname }, select: { id: true } })) {
      fieldErrors.hostname = `${valid.hostname} is already assigned to a customer.`;
    } else hostname = valid.hostname;
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  let projectId = existingProjectId;
  if (newProject) {
    try {
      projectId = (await createProjectWithDefaults({ ...newProject, status: "SETUP", creatorUserId: access.session.userId }, platformPrisma)).id;
    } catch (err) {
      if (isUniqueViolation(err)) return { fieldErrors: { projectSlug: `The address "${newProject.slug}" is already used by another project.` } };
      throw err;
    }
  }

  let customerId: string;
  try {
    customerId = await platformPrisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({ data: { ...fields, createdByUsername: access.session.username }, select: { id: true } });
      // Conditional: a project another admin attached in the meantime is not taken over.
      const attached = await tx.project.updateMany({ where: { id: projectId!, customerId: null }, data: { customerId: customer.id } });
      if (attached.count !== 1) throw new Error("PROJECT_TAKEN");
      if (hostname) {
        await tx.customerDomain.create({
          data: { customerId: customer.id, hostname, verificationToken: randomBytes(24).toString("base64url"), createdByUsername: access.session.username },
        });
      }
      return customer.id;
    });
  } catch (err) {
    if ((err as Error).message === "PROJECT_TAKEN") return { fieldErrors: { projectId: "That project was just attached to another customer." } };
    if (isUniqueViolation(err)) return { fieldErrors: { hostname: `${hostname} is already assigned to a customer.` } };
    throw err;
  }

  await logSystemEvent("INFO", "saas", `Customer "${fields.name}" created`, {
    customerId,
    projectId,
    projectMode: mode,
    hostname,
    createdBy: access.session.username,
  });
  changed();
  redirect(`/admin/customers/${customerId}?created=1`);
}

export async function updateCustomer(customerId: string, _prev: CustomerFormState, formData: FormData): Promise<CustomerFormState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const fieldErrors: NonNullable<CustomerFormState["fieldErrors"]> = {};
  const fields = customerFields(formData, fieldErrors);
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  const result = await platformPrisma.customer.updateMany({ where: { id: customerId }, data: fields });
  if (result.count === 0) return { error: "This customer no longer exists." };
  await logSystemEvent("INFO", "saas", `Customer "${fields.name}" updated`, { customerId, changedBy: access.session.username });
  changed();
  return { savedAt: Date.now() };
}

// ---------------------------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------------------------

export interface DomainActionResult {
  error?: string;
  success?: string;
}

async function domainSettingsView() {
  const settings = await platformPrisma.platformDomainSettings.findUnique({ where: { id: "default" } });
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
  const customer = await platformPrisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true } });
  if (!customer) return { error: "This customer no longer exists." };
  const valid = validateCustomerHostname(formData.get("hostname"), await domainSettingsView());
  if ("error" in valid) return { error: valid.error };
  try {
    await platformPrisma.customerDomain.create({
      data: { customerId, hostname: valid.hostname, verificationToken: randomBytes(24).toString("base64url"), createdByUsername: access.session.username },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: `${valid.hostname} is already assigned to a customer.` };
    throw err;
  }
  await logSystemEvent("INFO", "saas", `Domain ${valid.hostname} added`, { customerId, hostname: valid.hostname, changedBy: access.session.username });
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
  const domain = await platformPrisma.customerDomain.findUnique({ where: { id: domainId } });
  if (!domain) return { error: "This domain no longer exists." };
  if (domain.status === "DISABLED") return { error: "This domain is disabled. Enable it first, then check it." };
  const current: DomainStatus = isDomainStatus(domain.status) ? domain.status : "PENDING";
  const settings = await domainSettingsView();
  const net = domainNetwork();

  const steps: DomainCheckStep[] = await checkDomainBase(domain, settings, net);
  const baseOk = steps.length === 3 && steps.every((s) => s.ok);
  if (baseOk && current === "PENDING") {
    await platformPrisma.customerDomain.updateMany({ where: { id: domainId, status: "PENDING" }, data: { status: "VERIFIED", verifiedAt: new Date() } });
    forgetHostScopes();
  }
  if (baseOk) steps.push(await checkDomainHttps(domain, net));

  const next = nextDomainStatus(baseOk && current === "PENDING" ? "VERIFIED" : current, steps);
  const now = new Date();
  await platformPrisma.customerDomain.updateMany({
    where: { id: domainId, status: { not: "DISABLED" } },
    data: {
      status: next,
      lastCheck: steps as unknown as Prisma.InputJsonValue,
      lastCheckedAt: now,
      ...(next === "ACTIVE" && !domain.activatedAt ? { activatedAt: now } : {}),
      ...(next !== "PENDING" && !domain.verifiedAt ? { verifiedAt: now } : {}),
    },
  });
  await logSystemEvent(next === "ACTIVE" ? "INFO" : "WARN", "saas", `Domain ${domain.hostname} checked: ${next}`, {
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
  const domain = await platformPrisma.customerDomain.findUnique({ where: { id: domainId }, select: { hostname: true } });
  if (!domain) return { error: "This domain no longer exists." };
  const here = await requestHostname();
  if (here === domain.hostname) return { error: "You are using this address right now. Open the portal from the admin address to disable it." };
  await platformPrisma.customerDomain.update({ where: { id: domainId }, data: { status: "DISABLED", disabledAt: new Date() } });
  await logSystemEvent("WARN", "saas", `Domain ${domain.hostname} disabled`, { hostname: domain.hostname, changedBy: access.session.username });
  changed();
  return { success: `${domain.hostname} is disabled.` };
}

/** Back to PENDING; the next check decides again from scratch. */
export async function enableCustomerDomain(domainId: string): Promise<DomainActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const result = await platformPrisma.customerDomain.updateMany({ where: { id: domainId, status: "DISABLED" }, data: { status: "PENDING", disabledAt: null } });
  if (result.count === 0) return { error: "Only a disabled domain can be enabled." };
  await logSystemEvent("INFO", "saas", "Domain re-enabled", { domainId, changedBy: access.session.username });
  changed();
  return { success: "Enabled. Press Check now to verify it again." };
}

/** Remove an address that is not live. A live one must be disabled first, so removal is never a surprise. */
export async function removeCustomerDomain(domainId: string): Promise<DomainActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const domain = await platformPrisma.customerDomain.findUnique({ where: { id: domainId }, select: { hostname: true, status: true } });
  if (!domain) return { error: "This domain no longer exists." };
  if (domain.status === "ACTIVE" || domain.status === "VERIFIED") return { error: "Disable this domain before removing it." };
  await platformPrisma.customerDomain.delete({ where: { id: domainId } });
  await logSystemEvent("WARN", "saas", `Domain ${domain.hostname} removed`, { hostname: domain.hostname, changedBy: access.session.username });
  changed();
  return { success: `${domain.hostname} removed.` };
}
