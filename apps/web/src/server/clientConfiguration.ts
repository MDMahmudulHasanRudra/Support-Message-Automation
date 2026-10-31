import { CLIENT_CATALOG_KINDS, type ClientCatalogKindValue, type ServicePlanPrice } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";

/**
 * Reading the Client Configuration Center (CLIENT_CONFIGURATION.md): the project's tags, categories, business
 * types, service plans, currencies and country choices. Not a "use server" file. Every read goes through the
 * project-scoped client; the one raw query names "projectId".
 */

export interface CatalogEntryView {
  id: string;
  kind: ClientCatalogKindValue;
  name: string;
  aliases: string[];
  color: string | null;
  archived: boolean;
  /** Clients (not archived) that carry this value. */
  clients: number;
}

export interface ServicePlanView {
  id: string;
  name: string;
  service: string | null;
  defaultKind: string;
  defaultDuration: number | null;
  defaultUnit: string | null;
  prices: ServicePlanPrice[];
  aliases: string[];
  archived: boolean;
}

export interface ClientConfiguration {
  entries: Record<ClientCatalogKindValue, CatalogEntryView[]>;
  /** Values clients already carry that are not on the list yet (to add with one click). */
  unlisted: Record<ClientCatalogKindValue, Array<{ name: string; clients: number }>>;
  plans: ServicePlanView[];
  /** Services used on subscriptions that no plan names yet. */
  unlistedServices: Array<{ name: string; subscriptions: number }>;
  currencies: Array<{ code: string; enabled: boolean; favorite: boolean }>;
  countries: Array<{ country: string; favorite: boolean; currency: string | null; language: string | null }>;
}

const lower = (s: string) => s.trim().toLowerCase();

/** How many clients carry each tag / category / business type (case-insensitive), from the clients themselves. */
async function valueCounts(): Promise<Record<ClientCatalogKindValue, Map<string, { name: string; clients: number }>>> {
  const projectId = await activeProjectId();
  const [tags, categories, types] = await Promise.all([
    prisma.$queryRaw<Array<{ value: string; n: bigint }>>`
      SELECT t AS value, count(*)::bigint AS n FROM "Client", unnest("tags") AS t
      WHERE "projectId" = ${projectId} AND "status" <> 'ARCHIVED' GROUP BY t`,
    prisma.client.groupBy({ by: ["category"], where: { status: { not: "ARCHIVED" }, category: { not: null } }, _count: { _all: true } }),
    prisma.client.groupBy({ by: ["businessType"], where: { status: { not: "ARCHIVED" }, businessType: { not: null } }, _count: { _all: true } }),
  ]);
  const fold = (rows: Array<{ value: string; n: number }>) => {
    const map = new Map<string, { name: string; clients: number }>();
    for (const r of rows) {
      if (!r.value) continue;
      const prev = map.get(lower(r.value));
      map.set(lower(r.value), { name: prev?.name ?? r.value, clients: (prev?.clients ?? 0) + r.n });
    }
    return map;
  };
  return {
    TAG: fold(tags.map((t) => ({ value: t.value, n: Number(t.n) }))),
    CATEGORY: fold(categories.map((c) => ({ value: c.category ?? "", n: c._count._all }))),
    BUSINESS_TYPE: fold(types.map((c) => ({ value: c.businessType ?? "", n: c._count._all }))),
  };
}

export async function loadClientConfiguration(): Promise<ClientConfiguration> {
  const [rows, plans, currencies, countries, counts, services] = await Promise.all([
    prisma.clientCatalogEntry.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] }),
    prisma.clientServicePlan.findMany({ orderBy: { name: "asc" } }),
    prisma.clientBillingCurrency.findMany({ orderBy: { code: "asc" }, select: { code: true, enabled: true, favorite: true } }),
    prisma.clientCountrySetting.findMany({ orderBy: { country: "asc" }, select: { country: true, favorite: true, currency: true, language: true } }),
    valueCounts(),
    prisma.clientSubscription.groupBy({ by: ["service"], _count: { _all: true }, orderBy: { service: "asc" }, take: 500 }),
  ]);
  const entries = Object.fromEntries(CLIENT_CATALOG_KINDS.map((k) => [k, [] as CatalogEntryView[]])) as ClientConfiguration["entries"];
  const listed = Object.fromEntries(CLIENT_CATALOG_KINDS.map((k) => [k, new Set<string>()])) as Record<ClientCatalogKindValue, Set<string>>;
  for (const r of rows) {
    const kind = r.kind as ClientCatalogKindValue;
    entries[kind].push({ id: r.id, kind, name: r.name, aliases: r.aliases, color: r.color, archived: Boolean(r.archivedAt), clients: counts[kind].get(lower(r.name))?.clients ?? 0 });
    listed[kind].add(lower(r.name));
  }
  const unlisted = Object.fromEntries(
    CLIENT_CATALOG_KINDS.map((k) => [k, [...counts[k].entries()].filter(([key]) => !listed[k].has(key)).map(([, v]) => v).sort((a, b) => b.clients - a.clients)]),
  ) as ClientConfiguration["unlisted"];
  const planNames = new Set(plans.flatMap((p) => [lower(p.name), ...p.aliases.map(lower)]));
  return {
    entries,
    unlisted,
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      service: p.service,
      defaultKind: p.defaultKind,
      defaultDuration: p.defaultDuration,
      defaultUnit: p.defaultUnit,
      prices: Array.isArray(p.prices) ? (p.prices as unknown as ServicePlanPrice[]) : [],
      aliases: p.aliases,
      archived: Boolean(p.archivedAt),
    })),
    unlistedServices: services.filter((s) => !planNames.has(lower(s.service))).map((s) => ({ name: s.service, subscriptions: s._count._all })),
    currencies,
    countries,
  };
}

/** What a form or an import may pick from: active entries and plans, favourite currencies and countries first. */
export interface ClientChoices {
  tags: Array<{ name: string; aliases: string[] }>;
  categories: Array<{ name: string; aliases: string[] }>;
  businessTypes: Array<{ name: string; aliases: string[] }>;
  plans: Array<{ id: string; name: string; service: string | null; defaultKind: string; defaultDuration: number | null; defaultUnit: string | null; prices: ServicePlanPrice[]; aliases: string[] }>;
  favoriteCurrencies: string[];
  favoriteCountries: string[];
  /** The project's own country → currency / language choices (override the general suggestion). */
  currencyByCountry: Record<string, string>;
  languageByCountry: Record<string, string>;
}

export async function loadClientChoices(): Promise<ClientChoices> {
  const [rows, plans, currencies, countries] = await Promise.all([
    prisma.clientCatalogEntry.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" }, select: { kind: true, name: true, aliases: true } }),
    prisma.clientServicePlan.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" } }),
    prisma.clientBillingCurrency.findMany({ where: { enabled: true, favorite: true }, orderBy: { code: "asc" }, select: { code: true } }),
    prisma.clientCountrySetting.findMany({ select: { country: true, favorite: true, currency: true, language: true } }),
  ]);
  const of = (kind: ClientCatalogKindValue) => rows.filter((r) => r.kind === kind).map((r) => ({ name: r.name, aliases: r.aliases }));
  return {
    tags: of("TAG"),
    categories: of("CATEGORY"),
    businessTypes: of("BUSINESS_TYPE"),
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      service: p.service,
      defaultKind: p.defaultKind,
      defaultDuration: p.defaultDuration,
      defaultUnit: p.defaultUnit,
      prices: Array.isArray(p.prices) ? (p.prices as unknown as ServicePlanPrice[]) : [],
      aliases: p.aliases,
    })),
    favoriteCurrencies: currencies.map((c) => c.code),
    favoriteCountries: countries.filter((c) => c.favorite).map((c) => c.country),
    currencyByCountry: Object.fromEntries(countries.flatMap((c) => (c.currency ? [[c.country, c.currency]] : []))),
    languageByCountry: Object.fromEntries(countries.flatMap((c) => (c.language ? [[c.country, c.language]] : []))),
  };
}
