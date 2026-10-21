import { platformPrisma } from "@/server/db";
import { isDomainStatus, requiredDnsRecords, type DomainCheckStep, type DomainStatus } from "@support-automation/shared";

/**
 * Read-only loaders for the SaaS pages of the Main Admin Portal (SAAS_PLATFORM_PLAN.md, Phase 2).
 * Platform rows only. The pages that call these are gated by `requireMainAdminPage` and the host
 * rule; these never decide access themselves.
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
  const row = await platformPrisma.platformDomainSettings.findUnique({ where: { id: "default" } });
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
    platformPrisma.customerDomain.findMany({ select: DOMAIN_SELECT, orderBy: [{ customer: { name: "asc" } }, { hostname: "asc" }] }),
  ]);
  return rows.map((row) => toDomainView(row, settings));
}

export interface CustomerSummary {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  project: { id: string; name: string; slug: string; status: string } | null;
  domains: Array<{ hostname: string; status: DomainStatus }>;
  createdAt: string;
}

export async function listCustomers(): Promise<CustomerSummary[]> {
  const rows = await platformPrisma.customer.findMany({
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      createdAt: true,
      project: { select: { id: true, name: true, slug: true, status: true } },
      domains: { select: { hostname: true, status: true }, orderBy: { hostname: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    ...row,
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
  project: { id: string; name: string; slug: string; status: string; whatsappNumbers: number; people: number } | null;
  domains: DomainView[];
}

export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  const [settings, row] = await Promise.all([
    getDomainSettings(),
    platformPrisma.customer.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, slug: true, status: true, _count: { select: { access: true, whatsAppAccountRows: true } } } },
        domains: { select: DOMAIN_SELECT, orderBy: { hostname: "asc" } },
      },
    }),
  ]);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    notes: row.notes,
    createdByUsername: row.createdByUsername,
    createdAt: row.createdAt.toISOString(),
    project: row.project
      ? {
          id: row.project.id,
          name: row.project.name,
          slug: row.project.slug,
          status: row.project.status,
          whatsappNumbers: row.project._count.whatsAppAccountRows,
          people: row.project._count.access,
        }
      : null,
    domains: row.domains.map((d) => toDomainView({ ...d, customer: { name: row.name } }, settings)),
  };
}

/** Projects no customer has adopted yet — what "use an existing project" offers. */
export async function unattachedProjects(): Promise<Array<{ id: string; name: string; slug: string }>> {
  return platformPrisma.project.findMany({
    where: { customerId: null, status: { not: "ARCHIVED" } },
    select: { id: true, name: true, slug: true },
    orderBy: { createdAt: "asc" },
  });
}
