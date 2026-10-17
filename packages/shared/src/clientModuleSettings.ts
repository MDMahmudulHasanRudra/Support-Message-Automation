/**
 * A project's own choices for the Client Management module (CLIENTS_V3.md §7): which sub-modules it
 * uses and which ordinary fields its staff must fill in.
 *
 * Two layers, as everywhere else (MULTI_PROJECT_PLAN.md §9): the `CLIENT_CENTER` project feature is
 * the Main Admin's ENTITLEMENT; these switches are the project's choice WITHIN it, and both must be on.
 * A switched-off sub-module is refused on the server — its actions return the reason — never just a
 * hidden tab. No settings row means "everything on, nothing required": a project that has used the
 * module so far sees no change.
 */

import { clampRenewalWindow, DEFAULT_RENEWAL_WINDOW_DAYS } from "./clientSubscriptions.js";

export const CLIENT_SUB_MODULES = ["subscriptions", "billing", "payments", "whatsappGroups"] as const;
export type ClientSubModule = (typeof CLIENT_SUB_MODULES)[number];

export const CLIENT_SUB_MODULE_INFO: Record<ClientSubModule, { label: string; description: string }> = {
  subscriptions: {
    label: "Subscriptions, trials and renewals",
    description: "Service terms with a start and an expiry, trials and demos, renewals and the Expiring list.",
  },
  billing: {
    label: "Billing list (invoices and dues)",
    description: "What each client was billed, when it is due and what remains. Amounts are seen only with the billing permission.",
  },
  payments: {
    label: "Payments and receipts",
    description: "Recording money received against invoices, one at a time or as a batch, and reversing a mistaken entry. Needs Billing.",
  },
  whatsappGroups: {
    label: "WhatsApp group links",
    description: "Linking a client to the existing WhatsApp groups you support them in. A link sends nothing and changes no monitoring.",
  },
};

/** The ordinary business fields a project may make mandatory. Technical rules (a valid email, a real date) always apply. */
export const CLIENT_REQUIRABLE_FIELDS = [
  { key: "name", label: "Client / contact name" },
  { key: "companyName", label: "Company / business" },
  { key: "phone", label: "Phone / WhatsApp number" },
  { key: "email", label: "Email" },
  { key: "country", label: "Country" },
  { key: "address", label: "Address / location" },
  { key: "preferredCurrency", label: "Preferred currency" },
  { key: "category", label: "Category" },
  { key: "assignedTeamId", label: "Team" },
  { key: "soldByMemberId", label: "Sold by" },
  { key: "assignedMemberId", label: "Assigned staff" },
  { key: "photo", label: "Profile photo" },
] as const;
export type ClientRequirableField = (typeof CLIENT_REQUIRABLE_FIELDS)[number]["key"];

const REQUIRABLE = new Set<string>(CLIENT_REQUIRABLE_FIELDS.map((f) => f.key));

export interface ClientModuleSettingsValue {
  subscriptions: boolean;
  billing: boolean;
  payments: boolean;
  whatsappGroups: boolean;
  requiredFields: ClientRequirableField[];
  renewalWindowDays: number;
  /** ISO 3166-1 alpha-2, used to read a number typed without a country code. Null = numbers need one. */
  defaultCountry: string | null;
}

export const DEFAULT_CLIENT_MODULE_SETTINGS: ClientModuleSettingsValue = {
  subscriptions: true,
  billing: true,
  payments: true,
  whatsappGroups: true,
  requiredFields: [],
  renewalWindowDays: DEFAULT_RENEWAL_WINDOW_DAYS,
  defaultCountry: null,
};

/** Only known fields, each once, in catalogue order. */
export function normalizeRequiredFields(raw: readonly unknown[] | null | undefined): ClientRequirableField[] {
  const wanted = new Set((raw ?? []).filter((v): v is string => typeof v === "string" && REQUIRABLE.has(v)));
  return CLIENT_REQUIRABLE_FIELDS.map((f) => f.key).filter((k) => wanted.has(k));
}

/** `XX` upper-case, or null. Whether the code is a real region is checked by the phone library in the web app. */
export function normalizeCountryCode(raw: unknown): string | null {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** A stored row (or none) → the effective settings. Payments need Billing: one is meaningless without the other. */
export function resolveClientModuleSettings(
  row: {
    subscriptionsEnabled: boolean;
    billingEnabled: boolean;
    paymentsEnabled: boolean;
    whatsappGroupLinksEnabled: boolean;
    requiredFields: string[];
    renewalWindowDays: number;
    defaultCountry: string | null;
  } | null,
): ClientModuleSettingsValue {
  if (!row) return { ...DEFAULT_CLIENT_MODULE_SETTINGS };
  return {
    subscriptions: row.subscriptionsEnabled,
    billing: row.billingEnabled,
    payments: row.billingEnabled && row.paymentsEnabled,
    whatsappGroups: row.whatsappGroupLinksEnabled,
    requiredFields: normalizeRequiredFields(row.requiredFields),
    renewalWindowDays: clampRenewalWindow(row.renewalWindowDays),
    defaultCountry: normalizeCountryCode(row.defaultCountry),
  };
}

export function subModuleRefusal(settings: ClientModuleSettingsValue, module: ClientSubModule): string | null {
  if (settings[module]) return null;
  return `${CLIENT_SUB_MODULE_INFO[module].label} is switched off for this project (Settings → Clients).`;
}

/**
 * The required fields the submission left empty, as sentences. `present` says which fields carry a
 * value. Required fields never relax a technical rule, and an optional field typed wrong is still
 * refused by its own validation.
 */
export function missingRequiredFields(required: readonly ClientRequirableField[], present: Partial<Record<ClientRequirableField, boolean>>): string[] {
  return CLIENT_REQUIRABLE_FIELDS.filter((f) => required.includes(f.key) && !present[f.key]).map((f) => `${f.label} is required in this project.`);
}
