import { customerProjectWhere, prisma as globalPrisma } from "@support-automation/db";
import { isDomainStatus, requiredDnsRecords, type DomainCheckStep, type DomainStatus } from "@support-automation/shared";

/**
 * Read-only loaders for the Nexora platform's customer and domain pages (SAAS_PLATFORM_PLAN.md §12,
 * Layer 1). They read across customers on purpose, with the unscoped client, and only counts and
 * names — never a conversation. The pages that call these are gated by `requireOperatorPage`; these
 * never decide access themselves.
 */

export interface DomainSettingsData {
  hostRoutingEnabled: boolean;
  rootDomain: string | null;
  adminHostnames: string[];
  publicIps: string[];
  reservedLabels: string[];
  updatedAt: string | null;
  updatedByUsername: string | null;
}

export async function getDomainSettings(): Promise<DomainSettingsData> {
  const row = await globalPrisma.platformDomainSettings.findUnique({ where: { id: "default" } });
  return {
    hostRoutingEnabled: Boolean(row?.hostRoutingEnabled),
    rootDomain: row?.rootDomain ?? null,
    adminHostnames: row?.adminHostnames ?? [],
    publicIps: row?.publicIps ?? [],
    reservedLabels: row?.reservedLabels ?? [],
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedByUsername: row?.updatedByUsername ?? null,
  };
}

export interface DomainView {
  id: string;
  hostname: string;
  status: DomainStatus;
  customerId: string;
  customerName: string;
  lastCheck: DomainCheckStep[] | null;
  lastCheckedAt: string | null;
  activatedAt: string | null;
  dnsRecords: Array<{ type: "A" | "AAAA"; name: string; value: string }>;
  isAdminHostname: boolean;
}

function toDomainView(
  row: { id: string; hostname: string; status: string; customerId: string; lastCheck: unknown; lastCheckedAt: Date | null; activatedAt: Date | null; customer: { name: string } },
  settings: DomainSettingsData,
): DomainView {
  return {
    id: row.id,
    hostname: row.hostname,
    status: isDomainStatus(row.status) ? row.status : "PENDING",
    customerId: row.customerId,
    customerName: row.customer.name,
    lastCheck: Array.isArray(row.lastCheck) ? (row.lastCheck as DomainCheckStep[]) : null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    dnsRecords: requiredDnsRecords(row.hostname, settings.rootDomain, settings.publicIps),
    isAdminHostname: settings.adminHostnames.includes(row.hostname),
  };
}

const DOMAIN_SELECT = {
  id: true,
  hostname: true,
  status: true,
  customerId: true,
  lastCheck: true,
  lastCheckedAt: true,
  activatedAt: true,
  customer: { select: { name: true } },
} as const;

export async function listAllDomains(): Promise<DomainView[]> {
  const [settings, rows] = await Promise.all([
    getDomainSettings(),
    globalPrisma.customerDomain.findMany({ select: DOMAIN_SELECT, orderBy: [{ customer: { name: "asc" } }, { hostname: "asc" }] }),
  ]);
  return rows.map((row) => toDomainView(row, settings));
}

export interface CustomerSummary {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  isFounding: boolean;
  projects: Array<{ id: string; name: string; slug: string; status: string }>;
  domains: Array<{ hostname: string; status: DomainStatus }>;
  createdAt: string;
}

export async function listCustomers(): Promise<CustomerSummary[]> {
  const rows = await globalPrisma.customer.findMany({
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      isFounding: true,
      createdAt: true,
      projects: { select: { id: true, name: true, slug: true, status: true }, orderBy: { createdAt: "asc" } },
      domains: { select: { hostname: true, status: true }, orderBy: { hostname: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  });
  // The founding customer also owns the original installation's projects (no customer recorded).
  const original = rows.some((r) => r.isFounding)
    ? await globalPrisma.project.findMany({ where: { customerId: null }, select: { id: true, name: true, slug: true, status: true }, orderBy: { createdAt: "asc" } })
    : [];
  return rows.map((row) => ({
    ...row,
    projects: row.isFounding ? [...original, ...row.projects] : row.projects,
    createdAt: row.createdAt.toISOString(),
    domains: row.domains.map((d) => ({ hostname: d.hostname, status: isDomainStatus(d.status) ? d.status : "PENDING" })),
  }));
}

export interface CustomerDetail {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  createdByUsername: string | null;
  createdAt: string;
  isFounding: boolean;
  projects: Array<{ id: string; name: string; slug: string; status: string; whatsappNumbers: number }>;
  /** People with a login in this customer's software (Nexora support identities not counted). */
  people: number;
  domains: DomainView[];
}

export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  const [settings, row] = await Promise.all([
    getDomainSettings(),
    globalPrisma.customer.findUnique({ where: { id }, include: { domains: { select: DOMAIN_SELECT, orderBy: { hostname: "asc" } } } }),
  ]);
  if (!row) return null;
  const [projects, people] = await Promise.all([
    globalPrisma.project.findMany({
      where: await customerProjectWhere(globalPrisma, id),
      select: { id: true, name: true, slug: true, status: true, _count: { select: { whatsAppAccountRows: true } } },
      orderBy: { createdAt: "asc" },
    }),
    globalPrisma.user.count({ where: { customerId: row.isFounding ? null : id, supportOperatorId: null } }),
  ]);
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    notes: row.notes,
    createdByUsername: row.createdByUsername,
    createdAt: row.createdAt.toISOString(),
    isFounding: row.isFounding,
    projects: projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug, status: p.status, whatsappNumbers: p._count.whatsAppAccountRows })),
    people,
    domains: row.domains.map((d) => toDomainView({ ...d, customer: { name: row.name } }, settings)),
  };
}

/** Whether the original installation can still be adopted as a customer (only once). */
export async function canAdoptOriginalInstallation(): Promise<boolean> {
  return (await globalPrisma.customer.count({ where: { isFounding: true } })) === 0;
}
