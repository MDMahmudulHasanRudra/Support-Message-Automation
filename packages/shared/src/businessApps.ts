import type { ProjectStatusValue } from "./projects.js";

/**
 * Business Apps (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md): first-party apps that are deployed on their
 * own — a Commerce ERP, an Education ERP, a Travel ERP — and that a project may add as an optional
 * add-on. They are NOT Core Modules (`projectFeatures.ts`): a Core Module is code inside this product,
 * switched by an entitlement; a Business App is another product, reached over a versioned contract, with
 * its own database. The internal Commerce modules (PRODUCT_CATALOG, ORDERS, SALES_PIPELINE) are Core
 * Modules and have nothing to do with the external Commerce app.
 *
 * This file is the registry and the pure rules. It holds no secret and no address: where an app lives is
 * deployment configuration, and the contract says how it is provisioned. Every rule here is applied by
 * the server; the browser only ever reads the outcome.
 */

export const BUSINESS_APP_KEYS = ["commerce", "education", "travel"] as const;
export type BusinessAppKey = (typeof BUSINESS_APP_KEYS)[number];

/**
 * INSTALLABLE: a project may add it now; it stays PENDING until its connection is verified.
 * COMING_SOON: shown so people know it exists, never installable.
 */
export type BusinessAppAvailability = "INSTALLABLE" | "COMING_SOON";

/** What the host may ask an app for, by name. The typed request/response shapes live in businessAppContract.ts. */
export const BUSINESS_APP_CAPABILITIES = [
  "commerce.searchProducts",
  "commerce.getProductDetails",
  "commerce.getCurrentPrice",
  "commerce.checkAvailability",
  "commerce.getActiveOffers",
  "commerce.getOrderStatus",
] as const;
export type BusinessAppCapability = (typeof BUSINESS_APP_CAPABILITIES)[number];

export interface BusinessAppDefinition {
  key: BusinessAppKey;
  name: string;
  description: string;
  /** A lucide icon name; the web maps it to a component. */
  icon: "ShoppingBag" | "GraduationCap" | "Plane";
  availability: BusinessAppAvailability;
  capabilities: readonly BusinessAppCapability[];
  /** The integration contract version this host speaks to the app. Bumped only with the contract document. */
  contractVersion: string;
  /**
   * The app's OWN contract versions this host has an adapter for. Activation refuses any other version the app
   * reports (`isSupportedAppContract`): an unknown version means unknown response shapes, and a guess about
   * prices or stock is exactly what must never reach a customer. Empty = nothing can be activated.
   */
  supportedContractVersions: readonly string[];
}

export const BUSINESS_APP_CONTRACT_VERSION = "2026-11-14.draft-1";

export const BUSINESS_APPS: readonly BusinessAppDefinition[] = [
  {
    key: "commerce",
    name: "Commerce",
    description: "Products, prices, stock, offers and orders from your Commerce ERP, kept in its own system and opened from your workspace.",
    icon: "ShoppingBag",
    availability: "INSTALLABLE",
    capabilities: [
      "commerce.searchProducts",
      "commerce.getProductDetails",
      "commerce.getCurrentPrice",
      "commerce.checkAvailability",
      "commerce.getActiveOffers",
      "commerce.getOrderStatus",
    ],
    // Commerce's published host contract (E-Commerce/docs/GET_ASSIST_INTEGRATION.md §12): "v1".
    contractVersion: "v1",
    supportedContractVersions: ["v1"],
  },
  {
    key: "education",
    name: "Education",
    description: "Students, courses, admissions and fees from an Education ERP.",
    icon: "GraduationCap",
    availability: "COMING_SOON",
    capabilities: [],
    contractVersion: BUSINESS_APP_CONTRACT_VERSION,
    supportedContractVersions: [],
  },
  {
    key: "travel",
    name: "Travel",
    description: "Packages, bookings and itineraries from a Travel ERP.",
    icon: "Plane",
    availability: "COMING_SOON",
    capabilities: [],
    contractVersion: BUSINESS_APP_CONTRACT_VERSION,
    supportedContractVersions: [],
  },
];

export function isBusinessAppKey(value: unknown): value is BusinessAppKey {
  return typeof value === "string" && (BUSINESS_APP_KEYS as readonly string[]).includes(value);
}

export function businessAppDefinition(key: BusinessAppKey): BusinessAppDefinition {
  return BUSINESS_APPS.find((a) => a.key === key)!;
}

/**
 * The installation's state, as stored (`ProjectAppInstallation.status`, a CHECK in the database).
 *   PENDING    — added to the project, connection not verified yet (or verified once, then re-enabled).
 *   CONNECTING — a connection check is running (a claim, so two checks never run at once).
 *   ACTIVE     — the app answered a verified connection check. The database refuses ACTIVE without one.
 *   DISABLED   — switched off by a Main Admin. Nothing reaches the app; nothing is deleted.
 *   ERROR      — the last connection check failed for a reason other than "the app is not available yet".
 */
export const BUSINESS_APP_STATUSES = ["PENDING", "CONNECTING", "ACTIVE", "DISABLED", "ERROR"] as const;
export type BusinessAppStatus = (typeof BUSINESS_APP_STATUSES)[number];

export const BUSINESS_APP_STATUS_LABELS: Record<BusinessAppStatus, string> = {
  PENDING: "Waiting to connect",
  CONNECTING: "Connecting",
  ACTIVE: "Connected",
  DISABLED: "Disabled",
  ERROR: "Connection problem",
};

/** A CONNECTING claim older than this is treated as abandoned (a restart mid-check) and may be taken again. */
export const BUSINESS_APP_CONNECT_CLAIM_MS = 2 * 60_000;

/** Whether a project may add this app now (registry only; permission and duplicates are the server's). */
export function installRefusal(key: string): string | null {
  if (!isBusinessAppKey(key)) return "Unknown Business App.";
  const app = businessAppDefinition(key);
  if (app.availability !== "INSTALLABLE") return `${app.name} is not available yet.`;
  return null;
}

/** The statuses a connection check may start from. ACTIVE can be re-checked (Reconnect); DISABLED must be enabled first. */
export function canStartConnect(status: BusinessAppStatus, updatedAt: Date, now: Date = new Date()): boolean {
  if (status === "PENDING" || status === "ERROR" || status === "ACTIVE") return true;
  if (status === "CONNECTING") return now.getTime() - updatedAt.getTime() > BUSINESS_APP_CONNECT_CLAIM_MS;
  return false;
}

export type LaunchRefusal = "NOT_INSTALLED" | "NOT_ACTIVE" | "DISABLED" | "PROJECT_SUSPENDED" | "PROJECT_ARCHIVED" | "NO_PERMISSION" | "UNKNOWN_APP";

export const LAUNCH_REFUSAL_MESSAGES: Record<LaunchRefusal, string> = {
  UNKNOWN_APP: "There is no Business App with that name.",
  NOT_INSTALLED: "This app has not been added to this project. A Main Admin can add it from the project's Business Apps.",
  NOT_ACTIVE: "This app is not connected yet, so it cannot be opened.",
  DISABLED: "A Main Admin has disabled this app for this project.",
  PROJECT_SUSPENDED: "This project is suspended, so its Business Apps are paused.",
  PROJECT_ARCHIVED: "This project is archived, so its Business Apps are closed.",
  NO_PERMISSION: "Your role does not include opening Business Apps here. Ask a Main Admin or this project's Lead.",
};

/**
 * Whether one person may open (launch) one app in one project. Order matters only for the message: the
 * project's own state first (it applies to everybody), then the installation, then the person.
 */
export function decideLaunch(input: {
  appKey: string;
  projectStatus: ProjectStatusValue;
  installation: { status: BusinessAppStatus } | null;
  mayOpen: boolean;
}): { ok: true } | { ok: false; refusal: LaunchRefusal } {
  if (!isBusinessAppKey(input.appKey)) return { ok: false, refusal: "UNKNOWN_APP" };
  if (input.projectStatus === "ARCHIVED") return { ok: false, refusal: "PROJECT_ARCHIVED" };
  if (input.projectStatus === "SUSPENDED") return { ok: false, refusal: "PROJECT_SUSPENDED" };
  if (!input.installation) return { ok: false, refusal: "NOT_INSTALLED" };
  if (input.installation.status === "DISABLED") return { ok: false, refusal: "DISABLED" };
  if (input.installation.status !== "ACTIVE") return { ok: false, refusal: "NOT_ACTIVE" };
  if (!input.mayOpen) return { ok: false, refusal: "NO_PERMISSION" };
  return { ok: true };
}

/**
 * Whether host-side code (the AI's grounding, a report) may call one capability of an app for a project.
 * Only an ACTIVE installation in a project that still operates, and only a capability the app declares.
 * "Not allowed" means NO call — never a guessed or empty answer presented as the app's.
 */
export function decideCapability(input: {
  appKey: string;
  capability: string;
  projectStatus: ProjectStatusValue;
  installationStatus: BusinessAppStatus | null;
}): { allowed: true } | { allowed: false; reason: string } {
  if (!isBusinessAppKey(input.appKey)) return { allowed: false, reason: "UNKNOWN_APP" };
  const app = businessAppDefinition(input.appKey);
  if (!(app.capabilities as readonly string[]).includes(input.capability)) return { allowed: false, reason: "UNKNOWN_CAPABILITY" };
  if (input.projectStatus === "SUSPENDED" || input.projectStatus === "ARCHIVED") return { allowed: false, reason: `PROJECT_${input.projectStatus}` };
  if (input.installationStatus === null) return { allowed: false, reason: "NOT_INSTALLED" };
  if (input.installationStatus !== "ACTIVE") return { allowed: false, reason: `INSTALLATION_${input.installationStatus}` };
  return { allowed: true };
}

/** The add-on keys a Create Project form asked for: known, installable, each once. Anything else is dropped. */
export function sanitizeRequestedAddOns(values: readonly unknown[]): BusinessAppKey[] {
  const out: BusinessAppKey[] = [];
  for (const v of values) if (typeof v === "string" && installRefusal(v) === null && !out.includes(v as BusinessAppKey)) out.push(v as BusinessAppKey);
  return out;
}

/** Whether the app's reported contract version is one this host has an adapter for (exact, case-sensitive). */
export function isSupportedAppContract(key: BusinessAppKey, version: unknown): boolean {
  return typeof version === "string" && businessAppDefinition(key).supportedContractVersions.includes(version);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * An app address from deployment configuration, or null when it is not one this host will talk to: HTTPS, or
 * plain HTTP only on a loopback host (a developer's machine). No credentials in the URL, no query or fragment —
 * a base address is an origin plus an optional path, nothing a request could smuggle state through.
 */
export function parseApprovedAppUrl(raw: string | null | undefined): URL | null {
  if (!raw || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

/** Longest a launch ticket may still be valid for when it reaches us. A longer one is refused, not trimmed. */
export const LAUNCH_TICKET_MAX_LIFETIME_MS = 5 * 60_000;

export type LaunchTicketRefusal = "INVALID_URL" | "NOT_SECURE" | "WRONG_ORIGIN" | "EXPIRED" | "TOO_LONG_LIVED";

/**
 * Whether a launch hand-off an app returned may be followed: its address must be on the app's approved origin
 * (exactly — a lookalike host or another port is refused), secure by the same rule as the configuration, and
 * the ticket must expire soon but not already have expired.
 */
export function validateLaunchTicket(
  ticket: { redirectUrl: string; expiresAt: string },
  approvedOrigin: string,
  now: Date = new Date(),
): { ok: true; url: URL } | { ok: false; refusal: LaunchTicketRefusal } {
  let url: URL;
  try {
    url = new URL(ticket.redirectUrl);
  } catch {
    return { ok: false, refusal: "INVALID_URL" };
  }
  if (url.username || url.password) return { ok: false, refusal: "INVALID_URL" };
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) return { ok: false, refusal: "NOT_SECURE" };
  if (url.origin !== approvedOrigin) return { ok: false, refusal: "WRONG_ORIGIN" };
  const expires = Date.parse(ticket.expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return { ok: false, refusal: "EXPIRED" };
  if (expires - now.getTime() > LAUNCH_TICKET_MAX_LIFETIME_MS) return { ok: false, refusal: "TOO_LONG_LIVED" };
  return { ok: true, url };
}

/**
 * A path inside an embedded app the person asked to open (`?path=`), or the app's default page. Only an
 * absolute path on the app's own origin: no scheme, no `//host`, no backslash tricks, no control characters.
 */
export function safeAppPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw) || raw.length > 300) return fallback;
  return raw;
}
