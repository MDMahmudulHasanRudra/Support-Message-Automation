/**
 * SaaS hostnames (SAAS_PLATFORM_PLAN.md §3.3–§3.5): which hostname opens what, and the rules a
 * customer's address must follow. Pure, so the web app, the TLS check and the tests share one
 * reading of every rule.
 */

import { MAIN_ADMIN_CATEGORY, PERMISSIONS } from "./permissions.js";

/** Labels no customer may claim, whatever the settings add. */
export const BUILT_IN_RESERVED_LABELS = [
  "admin", "www", "api", "app", "mail", "smtp", "imap", "pop", "ftp", "ns1", "ns2", "dns", "mx",
  "status", "support", "help", "docs", "blog", "static", "assets", "cdn", "auth", "login", "dashboard",
  "billing", "pay", "payment", "portal", "root", "system", "test", "staging", "dev", "localhost",
] as const;

export const DOMAIN_STATUSES = ["PENDING", "VERIFIED", "ACTIVE", "DISABLED"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export function isDomainStatus(value: unknown): value is DomainStatus {
  return typeof value === "string" && (DOMAIN_STATUSES as readonly string[]).includes(value);
}

/** What each status means, for the admin page. */
export const DOMAIN_STATUS_DESCRIPTIONS: Record<DomainStatus, string> = {
  PENDING: "Added. Create the DNS record, then run the check.",
  VERIFIED: "DNS points here and the address reaches this server. HTTPS is next.",
  ACTIVE: "Live: this address opens the customer's workspace over HTTPS.",
  DISABLED: "Switched off: the address shows nothing and no certificate is renewed for it.",
};

/**
 * A hostname as the platform stores and compares it: lower-case, no port, no trailing dot, ASCII
 * only (an internationalised name must be entered in its xn-- form). Null when it is not a hostname.
 */
export function normalizeHostname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, ""); // a pasted URL
  host = host.split("/")[0] ?? "";
  if (host.startsWith("[")) return null; // IPv6 literal
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!host || host.length > 253) return null;
  const labels = host.split(".");
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  }
  return host;
}

/** Whether a normalized host is an IP address, localhost or a single-label name (never a customer). */
export function isInfrastructureHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes(".");
}

export interface DomainSettingsView {
  hostRoutingEnabled: boolean;
  rootDomain: string | null;
  adminHostnames: readonly string[];
  reservedLabels: readonly string[];
}

/**
 * Whether `hostname` may be given to a customer. A subdomain of the root domain must be ONE label
 * deep (`customer2.udboy.com`, not `a.b.udboy.com`) and not reserved (`admin` is); another domain the
 * customer owns is allowed too. Never the root domain itself or an infrastructure host. An address
 * that is ALSO an admin address is allowed on purpose: that is the legacy host (Customer #1's
 * existing address keeps serving the portal while customers move over), and `classifyHost` gives it
 * both meanings.
 * Uniqueness is the database's job (CustomerDomain.hostname @unique) and the action's message.
 */
export function validateCustomerHostname(raw: unknown, settings: DomainSettingsView): { hostname: string } | { error: string } {
  const hostname = normalizeHostname(raw);
  if (!hostname) return { error: "Enter a hostname such as customer2.udboy.com — letters, digits, hyphens and dots only." };
  if (isInfrastructureHost(hostname)) return { error: "Use a full domain name, not an IP address or localhost." };
  const root = settings.rootDomain ? normalizeHostname(settings.rootDomain) : null;
  if (root && hostname === root) return { error: "The root domain itself cannot be given to a customer — use a subdomain of it." };
  if (root && hostname.endsWith(`.${root}`)) {
    const sub = hostname.slice(0, -(root.length + 1));
    if (sub.includes(".")) return { error: `Use one level under ${root}, for example customer2.${root}.` };
    const reserved = new Set<string>([...BUILT_IN_RESERVED_LABELS, ...settings.reservedLabels.map((l) => l.trim().toLowerCase())]);
    if (reserved.has(sub)) return { error: `"${sub}" is reserved for the platform. Choose another name.` };
  }
  return { hostname };
}

/** The DNS record the admin must create for a hostname, as their provider's form asks for it. */
export function requiredDnsRecords(hostname: string, rootDomain: string | null, publicIps: readonly string[]): Array<{ type: "A" | "AAAA"; name: string; value: string }> {
  const root = rootDomain ? normalizeHostname(rootDomain) : null;
  const name = root && hostname.endsWith(`.${root}`) ? hostname.slice(0, -(root.length + 1)) : hostname;
  return publicIps.map((ip) => ({ type: ip.includes(":") ? ("AAAA" as const) : ("A" as const), name, value: ip }));
}

/** What a hostname opens. */
export type HostScope =
  /** Routing is off, or an infrastructure host (localhost, an IP): everything works as before. */
  | { kind: "OPEN" }
  /** The Main Admin address. `customerId` is set when the same hostname is also a customer's (the legacy host). */
  | { kind: "ADMIN"; customerId: string | null }
  /** A customer's ACTIVE (or VERIFIED, while HTTPS is being set up) address. */
  | { kind: "CUSTOMER"; customerId: string }
  /** Routing is on and nobody has this hostname: nothing is shown. */
  | { kind: "UNKNOWN" };

export interface DomainRow {
  hostname: string;
  customerId: string;
  status: string;
}

/** The statuses in which a hostname opens its customer's workspace. */
export const ROUTABLE_DOMAIN_STATUSES: readonly DomainStatus[] = ["VERIFIED", "ACTIVE"];

/**
 * The single rule for what an incoming hostname opens. With routing off nothing changes for anyone
 * (OPEN). With it on: an admin hostname is ADMIN (and, when it is also a customer's address, keeps
 * that customer's workspace too — the legacy host during the move); a routable customer domain is
 * CUSTOMER; anything else is UNKNOWN. Infrastructure hosts stay OPEN so the server's own health
 * checks and the TLS question from Caddy keep working.
 */
export function classifyHost(rawHost: string | null | undefined, settings: DomainSettingsView | null, domains: readonly DomainRow[]): HostScope {
  if (!settings?.hostRoutingEnabled) return { kind: "OPEN" };
  const host = normalizeHostname(rawHost ?? "");
  if (!host || isInfrastructureHost(host)) return { kind: "OPEN" };
  const domain = domains.find((d) => d.hostname === host && (ROUTABLE_DOMAIN_STATUSES as readonly string[]).includes(d.status));
  if (settings.adminHostnames.includes(host)) return { kind: "ADMIN", customerId: domain?.customerId ?? null };
  if (domain) return { kind: "CUSTOMER", customerId: domain.customerId };
  return { kind: "UNKNOWN" };
}

/** Whether the Main Admin Portal may be served on this hostname. */
export function hostAllowsAdminPortal(scope: HostScope): boolean {
  return scope.kind === "OPEN" || scope.kind === "ADMIN";
}

/**
 * Whether a project may be opened on this hostname. A customer's address opens only that
 * customer's project — for everybody, a Main Admin included. The admin address opens every project
 * for a Main Admin (the Workspace) and, when it is also a customer's address, that customer's
 * project for its own people.
 */
export function hostAllowsProject(scope: HostScope, projectCustomerId: string | null, viewerIsMainAdmin: boolean): boolean {
  switch (scope.kind) {
    case "OPEN":
      return true;
    case "UNKNOWN":
      return false;
    case "CUSTOMER":
      return projectCustomerId === scope.customerId;
    case "ADMIN":
      return viewerIsMainAdmin || (scope.customerId !== null && projectCustomerId === scope.customerId);
  }
}

/** One step of a domain check, as the admin page shows it. */
export interface DomainCheckStep {
  key: "FORMAT" | "DNS" | "REACHES_APP" | "HTTPS";
  ok: boolean;
  /** Plain language: what was found, and what to do when it failed. */
  detail: string;
}

export interface DomainCheckResult {
  steps: DomainCheckStep[];
  /** The status the domain should move to. A check never moves a DISABLED domain. */
  nextStatus: DomainStatus;
}

/**
 * The status a domain moves to after a check: ACTIVE needs every step, VERIFIED needs everything
 * but HTTPS, and anything less leaves it PENDING. An ACTIVE domain whose check fails is NOT taken
 * down by the check (a DNS hiccup must not knock a live customer offline); the admin page shows the
 * failure and the admin decides.
 */
export function nextDomainStatus(current: DomainStatus, steps: readonly DomainCheckStep[]): DomainStatus {
  if (current === "DISABLED") return "DISABLED";
  const ok = (key: DomainCheckStep["key"]) => steps.some((s) => s.key === key && s.ok);
  const base = ok("FORMAT") && ok("DNS") && ok("REACHES_APP");
  if (base && ok("HTTPS")) return "ACTIVE";
  if (current === "ACTIVE") return "ACTIVE";
  return base ? "VERIFIED" : "PENDING";
}

/**
 * Keys that act on the whole platform rather than one project: the Main Admin Portal, platform-wide
 * users and permission modules, security settings, release notes. They are held only on an address
 * that may serve the portal — on a customer's address even a Main Admin does not hold them, so a
 * Server Action (a public endpoint, whatever page shows its button) cannot be used from there to
 * reach other customers. A project's own administration (Lead keys) is unaffected.
 */
const HOST_RESTRICTED_CATEGORIES: ReadonlySet<string> = new Set([MAIN_ADMIN_CATEGORY, "Users & Permissions"]);
const HOST_RESTRICTED_KEYS: ReadonlySet<string> = new Set([
  "release_notes.manage",
  ...PERMISSIONS.filter((p) => HOST_RESTRICTED_CATEGORIES.has(p.category)).map((p) => p.key),
]);

export function isHostRestrictedKey(key: string): boolean {
  return HOST_RESTRICTED_KEYS.has(key);
}

/** The keys a user holds on this hostname: every key on the admin or an open host, platform keys removed elsewhere. */
export function keysOnHost(keys: ReadonlySet<string>, scope: HostScope): Set<string> {
  if (hostAllowsAdminPortal(scope)) return new Set(keys);
  return new Set([...keys].filter((key) => !HOST_RESTRICTED_KEYS.has(key)));
}
