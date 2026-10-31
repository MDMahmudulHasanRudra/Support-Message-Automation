import { readImportExtras, type ImportExtras } from "./clientImportExtras.js";
import { normalizePhoneNumber } from "./groupParticipantAdd.js";
import type { ImportedAmount } from "./clientImportMoney.js";

/**
 * Client Management (CLIENT_CENTER.md): the pure rules, shared by the dashboard, its import and its
 * tests. Nothing here touches a database, a provider or a clock.
 *
 * Deliberately NOT in here: billing. A client has no invoice, balance or due date in this module —
 * the company's billing lives in its own system, and a second ledger here would only ever disagree
 * with it. Nothing here sends a message either; channel references are data, and the consent fields
 * are recorded for the phases that will send.
 */

export const CLIENT_STATUSES = ["ACTIVE", "INACTIVE", "PENDING", "ARCHIVED", "BLOCKED"] as const;
export type ClientStatusValue = (typeof CLIENT_STATUSES)[number];

export const CLIENT_SOURCES = ["MANUAL", "IMPORT", "WHATSAPP", "FACEBOOK", "INSTAGRAM", "API"] as const;
export type ClientSourceValue = (typeof CLIENT_SOURCES)[number];

export const CLIENT_CHANNEL_KINDS = ["PHONE", "EMAIL", "WHATSAPP", "WHATSAPP_GROUP", "MESSENGER", "INSTAGRAM", "TELEGRAM", "OTHER"] as const;
export type ClientChannelKindValue = (typeof CLIENT_CHANNEL_KINDS)[number];

export const CLIENT_CONSENT_STATUSES = ["UNKNOWN", "OPTED_IN", "OPTED_OUT"] as const;
export type ClientConsentValue = (typeof CLIENT_CONSENT_STATUSES)[number];

export const CLIENT_STATUS_LABELS: Record<ClientStatusValue, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  PENDING: "Pending",
  ARCHIVED: "Archived",
  BLOCKED: "Blocked",
};

export const CLIENT_CHANNEL_LABELS: Record<ClientChannelKindValue, string> = {
  PHONE: "Phone",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp number",
  WHATSAPP_GROUP: "WhatsApp group",
  MESSENGER: "Facebook Messenger",
  INSTAGRAM: "Instagram",
  TELEGRAM: "Telegram",
  OTHER: "Other",
};

export const CLIENT_CONSENT_LABELS: Record<ClientConsentValue, string> = {
  UNKNOWN: "Not recorded",
  OPTED_IN: "Opted in",
  OPTED_OUT: "Opted out",
};

export const CLIENT_SOURCE_LABELS: Record<ClientSourceValue, string> = {
  MANUAL: "Manual entry",
  IMPORT: "File import",
  WHATSAPP: "WhatsApp",
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
  API: "API",
};

/** Limits on what one client may carry. Bounds, not policy: they stop a pasted file becoming a row of a megabyte. */
export const CLIENT_LIMITS = {
  name: 200,
  code: 40,
  company: 200,
  category: 80,
  language: 40,
  address: 500,
  businessDetails: 2000,
  followUp: 2000,
  note: 4000,
  tags: 20,
  tag: 40,
  channels: 25,
  customFields: 30,
  customFieldKey: 60,
  customFieldValue: 500,
} as const;

export function isClientStatus(value: unknown): value is ClientStatusValue {
  return typeof value === "string" && (CLIENT_STATUSES as readonly string[]).includes(value);
}
export function isClientChannelKind(value: unknown): value is ClientChannelKindValue {
  return typeof value === "string" && (CLIENT_CHANNEL_KINDS as readonly string[]).includes(value);
}
export function isClientConsent(value: unknown): value is ClientConsentValue {
  return typeof value === "string" && (CLIENT_CONSENT_STATUSES as readonly string[]).includes(value);
}

// ── Channel references ──────────────────────────────────────────────────────────────────────────

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function normalizeEmail(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) return null;
  return value;
}

/**
 * A phone number as digits, or null. Digits, spaces and the usual separators only: "call me" and
 * "01894431220x" are not numbers, where `normalizePhoneNumber` alone would strip the letters and accept them.
 *
 * A Bangladeshi number written locally ("01894431220", 11 digits starting 01) gets its country code, so the
 * same person entered as "+8801894431220" is recognised as the same number — which is the commonest way
 * two records for one client come to exist here. Any other number is kept as typed.
 */
export function normalizeClientPhone(input: string): string | null {
  if (!/^[+\d\s().-]+$/.test(input.trim())) return null;
  const digits = normalizePhoneNumber(input);
  if (!digits) return null;
  return /^01\d{9}$/.test(digits) ? `88${digits}` : digits;
}

/**
 * The comparable form of a channel reference, or null when it is not a valid one of that kind.
 *
 * A phone and a WhatsApp number are the same thing written twice, so both reduce to their digits and
 * [`matchKeyOf`] puts them in one group — a client entered by phone is recognised when somebody else
 * enters the same number as WhatsApp. A WhatsApp GROUP is a group id and is kept as given: it is a
 * link to a group row, never typed.
 */
export function normalizeChannelValue(kind: ClientChannelKindValue, input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  switch (kind) {
    case "PHONE":
    case "WHATSAPP":
      return normalizeClientPhone(value);
    case "EMAIL":
      return normalizeEmail(value);
    case "WHATSAPP_GROUP":
      return value.length <= 120 ? value : null;
    default: {
      // A handle or a page-scoped id. A leading "@" is not part of it.
      const cleaned = value.replace(/^@+/, "").toLowerCase();
      return cleaned && cleaned.length <= 200 ? cleaned : null;
    }
  }
}

/** The group a channel belongs to when matching two clients: "phone:880…", "email:a@b.c", "messenger:123". */
export function matchKeyOf(kind: ClientChannelKindValue, normalizedValue: string): string {
  const group = kind === "PHONE" || kind === "WHATSAPP" ? "phone" : kind.toLowerCase();
  return `${group}:${normalizedValue}`;
}

export interface ClientChannelDraft {
  kind: ClientChannelKindValue;
  value: string;
  label?: string | null;
  isPrimary?: boolean;
}

export interface NormalizedChannel {
  kind: ClientChannelKindValue;
  value: string;
  normalizedValue: string;
  label: string | null;
  isPrimary: boolean;
  matchKey: string;
  /**
   * The match key the same number had in the digits-only form older imports stored ("0551234567"), when the V5
   * reading changed it. An update compares both, so a client's existing number is not added again in E.164.
   */
  legacyMatchKey?: string;
}

export function normalizeChannelDrafts(drafts: readonly ClientChannelDraft[]): { channels: NormalizedChannel[]; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const channels: NormalizedChannel[] = [];
  if (drafts.length > CLIENT_LIMITS.channels) errors.push(`A client can have at most ${CLIENT_LIMITS.channels} channel references.`);
  for (const draft of drafts.slice(0, CLIENT_LIMITS.channels)) {
    const normalizedValue = normalizeChannelValue(draft.kind, draft.value);
    if (!normalizedValue) {
      errors.push(`"${draft.value.trim().slice(0, 60)}" is not a valid ${CLIENT_CHANNEL_LABELS[draft.kind].toLowerCase()}.`);
      continue;
    }
    const key = `${draft.kind}:${normalizedValue}`;
    if (seen.has(key)) continue; // the same reference twice is one reference
    seen.add(key);
    channels.push({
      kind: draft.kind,
      value: draft.value.trim().slice(0, 200),
      normalizedValue,
      label: draft.label?.trim().slice(0, 60) || null,
      isPrimary: Boolean(draft.isPrimary),
      matchKey: matchKeyOf(draft.kind, normalizedValue),
    });
  }
  // At most one primary per kind: the first one asked for wins.
  const primaryKinds = new Set<string>();
  for (const channel of channels) {
    if (!channel.isPrimary) continue;
    if (primaryKinds.has(channel.kind)) channel.isPrimary = false;
    else primaryKinds.add(channel.kind);
  }
  return { channels, errors };
}

// ── Tags ────────────────────────────────────────────────────────────────────────────────────────

export function normalizeTag(input: string): string | null {
  const tag = input.replace(/[,;|]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!tag) return null;
  return tag.length <= CLIENT_LIMITS.tag ? tag : tag.slice(0, CLIENT_LIMITS.tag).trim();
}

export function normalizeTags(input: readonly string[] | string | null | undefined): string[] {
  const list = typeof input === "string" ? input.split(/[,;|]/) : [...(input ?? [])];
  const out: string[] = [];
  for (const raw of list) {
    const tag = normalizeTag(raw);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= CLIENT_LIMITS.tags) break;
  }
  return out;
}

// ── A client's own fields ────────────────────────────────────────────────────────────────────────

export interface ClientInput {
  name?: unknown;
  code?: unknown;
  companyName?: unknown;
  status?: unknown;
  category?: unknown;
  preferredChannel?: unknown;
  preferredLanguage?: unknown;
  address?: unknown;
  businessDetails?: unknown;
  followUpInstructions?: unknown;
  tags?: unknown;
  customFields?: unknown;
}

export interface ValidClientFields {
  name: string;
  code: string | null;
  companyName: string | null;
  status: ClientStatusValue;
  category: string | null;
  preferredChannel: ClientChannelKindValue | null;
  preferredLanguage: string | null;
  address: string | null;
  businessDetails: string | null;
  followUpInstructions: string | null;
  tags: string[];
  customFields: Record<string, string>;
}

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function text(value: unknown, max: number, label: string, errors: string[]): string | null {
  if (value === undefined || value === null) return null;
  const out = String(value).trim();
  if (!out) return null;
  if (out.length > max) {
    errors.push(`${label} is longer than ${max} characters.`);
    return null;
  }
  return out;
}

/**
 * `allowBlankName`: the Add Client form (CLIENTS_V3.md §6) lets a client be saved with no name — it is
 * then known by its generated code and shown as "Unnamed client". The import and every older caller
 * keep requiring one.
 */
export function validateClientFields(input: ClientInput, options: { allowBlankName?: boolean } = {}): { value: ValidClientFields | null; errors: string[] } {
  const errors: string[] = [];
  const name = text(input.name, CLIENT_LIMITS.name, "Name", errors) ?? (options.allowBlankName ? "" : null);
  if (name === null && !errors.length) errors.push("A client needs a name.");
  const code = text(input.code, CLIENT_LIMITS.code, "Client code", errors);
  if (code && !CODE_PATTERN.test(code)) errors.push("A client code may use letters, digits, dots, dashes and underscores only.");
  const statusRaw = input.status === undefined || input.status === null || input.status === "" ? "ACTIVE" : input.status;
  if (!isClientStatus(statusRaw)) errors.push("That client status is not recognised.");
  const preferredRaw = input.preferredChannel === undefined || input.preferredChannel === null || input.preferredChannel === "" ? null : input.preferredChannel;
  if (preferredRaw !== null && !isClientChannelKind(preferredRaw)) errors.push("That preferred channel is not recognised.");

  const customFields: Record<string, string> = {};
  if (input.customFields && typeof input.customFields === "object" && !Array.isArray(input.customFields)) {
    const entries = Object.entries(input.customFields as Record<string, unknown>);
    if (entries.length > CLIENT_LIMITS.customFields) errors.push(`At most ${CLIENT_LIMITS.customFields} custom fields.`);
    for (const [rawKey, rawValue] of entries.slice(0, CLIENT_LIMITS.customFields)) {
      const key = rawKey.trim();
      // `__proto__` and friends are never a field name, so a crafted import column cannot reach the prototype.
      if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (key.length > CLIENT_LIMITS.customFieldKey) {
        errors.push(`The custom field name "${key.slice(0, 30)}…" is too long.`);
        continue;
      }
      const value = String(rawValue ?? "").trim();
      if (value.length > CLIENT_LIMITS.customFieldValue) {
        errors.push(`The custom field "${key}" is longer than ${CLIENT_LIMITS.customFieldValue} characters.`);
        continue;
      }
      if (value) customFields[key] = value;
    }
  }

  const tagsInput = input.tags;
  const tags = normalizeTags(typeof tagsInput === "string" || Array.isArray(tagsInput) ? (tagsInput as string | string[]) : null);

  const companyName = text(input.companyName, CLIENT_LIMITS.company, "Company", errors);
  const category = text(input.category, CLIENT_LIMITS.category, "Category", errors);
  const preferredLanguage = text(input.preferredLanguage, CLIENT_LIMITS.language, "Preferred language", errors);
  const address = text(input.address, CLIENT_LIMITS.address, "Address", errors);
  const businessDetails = text(input.businessDetails, CLIENT_LIMITS.businessDetails, "Business details", errors);
  const followUpInstructions = text(input.followUpInstructions, CLIENT_LIMITS.followUp, "Follow-up instructions", errors);

  if (errors.length || name === null || !isClientStatus(statusRaw)) return { value: null, errors };
  return {
    value: {
      name,
      code,
      companyName,
      status: statusRaw,
      category,
      preferredChannel: preferredRaw as ClientChannelKindValue | null,
      preferredLanguage,
      address,
      businessDetails,
      followUpInstructions,
      tags,
      customFields,
    },
    errors,
  };
}

/** Client code used when none is typed: stable, sortable, and unique per installation (a database sequence feeds `n`). */
export function formatClientCode(n: number): string {
  return `CL-${String(n).padStart(6, "0")}`;
}

// ── Duplicates ──────────────────────────────────────────────────────────────────────────────────

export interface DuplicateCandidate {
  clientId: string;
  matchKeys: readonly string[];
  code?: string | null;
}

export interface DuplicateMatch {
  clientId: string;
  /** The identifiers both records carry, for display ("phone:8801…", "email:a@b.c", "code"). */
  sharedKeys: string[];
}

/**
 * Which existing clients look like the one being entered. A match is a SHARED identifier — a phone,
 * an email, an external id or the client code — never a similar name: two people called Rahim are
 * not the same client. Nothing here merges anything; it only says "look at this one first".
 */
export function findDuplicateMatches(
  incoming: { matchKeys: readonly string[]; code?: string | null; excludeClientId?: string | null },
  existing: readonly DuplicateCandidate[],
): DuplicateMatch[] {
  const keys = new Set(incoming.matchKeys);
  const code = incoming.code?.trim().toLowerCase() || null;
  const matches: DuplicateMatch[] = [];
  for (const candidate of existing) {
    if (candidate.clientId === incoming.excludeClientId) continue;
    const shared = candidate.matchKeys.filter((key) => keys.has(key));
    if (code && candidate.code && candidate.code.trim().toLowerCase() === code) shared.push("code");
    if (shared.length) matches.push({ clientId: candidate.clientId, sharedKeys: [...new Set(shared)] });
  }
  return matches;
}

export function describeSharedKey(key: string): string {
  if (key === "code") return "the same client code";
  const [group, ...rest] = key.split(":");
  const value = rest.join(":");
  if (group === "phone") return `the same phone number (${value})`;
  if (group === "email") return `the same email (${value})`;
  return `the same ${group} reference (${value})`;
}

// ── Import ──────────────────────────────────────────────────────────────────────────────────────

export const MAX_CLIENT_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_CLIENT_IMPORT_ROWS = 2000;

export const CLIENT_IMPORT_FIELDS = [
  { key: "name", label: "Name", required: true, synonyms: ["name", "client name", "full name", "customer name", "client"] },
  { key: "code", label: "Client code", required: false, synonyms: ["code", "client code", "customer code", "client id", "reference", "ref"] },
  { key: "company", label: "Company", required: false, synonyms: ["company", "company name", "business", "business name", "organisation", "organization"] },
  { key: "businessType", label: "Business type", required: false, synonyms: ["business type", "company type", "industry", "sector", "business category"] },
  { key: "phone", label: "Phone", required: false, synonyms: ["phone", "phone number", "mobile", "mobile number", "contact number", "tel", "telephone"] },
  { key: "email", label: "Email", required: false, synonyms: ["email", "e-mail", "email address", "mail"] },
  { key: "whatsapp", label: "WhatsApp number", required: false, synonyms: ["whatsapp", "whatsapp number", "wa", "whatsapp no"] },
  { key: "facebook", label: "Facebook reference", required: false, synonyms: ["facebook", "facebook reference", "facebook id", "messenger", "fb"] },
  { key: "instagram", label: "Instagram handle", required: false, synonyms: ["instagram", "instagram handle", "ig"] },
  { key: "telegram", label: "Telegram", required: false, synonyms: ["telegram", "telegram username"] },
  { key: "category", label: "Category", required: false, synonyms: ["category", "type", "client type", "package", "plan"] },
  { key: "tags", label: "Tags", required: false, synonyms: ["tags", "tag", "labels"] },
  { key: "status", label: "Status", required: false, synonyms: ["status", "state"] },
  { key: "language", label: "Preferred language", required: false, synonyms: ["language", "preferred language", "lang"] },
  { key: "address", label: "Address", required: false, synonyms: ["address", "location"] },
  // Clients V3 (CLIENTS_V3.md §Import): resolved against the project's own lists on the server.
  { key: "country", label: "Country", required: false, synonyms: ["country", "country code"] },
  { key: "currency", label: "Preferred currency", required: false, synonyms: ["preferred currency", "currency"] },
  { key: "team", label: "Team", required: false, synonyms: ["team", "assigned team"] },
  { key: "soldBy", label: "Sold by", required: false, synonyms: ["sold by", "seller", "salesperson", "sales person", "sold by staff"] },
  { key: "assignedTo", label: "Assigned staff", required: false, synonyms: ["assigned staff", "assigned to", "account manager", "assign2emp", "assigned employee"] },
  { key: "service", label: "Service / plan", required: false, synonyms: ["service / plan", "service/plan", "service", "subscription", "product"] },
  { key: "subscriptionType", label: "Subscription type", required: false, synonyms: ["subscription type", "plan type", "sub type"] },
  { key: "startDate", label: "Start date", required: false, synonyms: ["start date", "join date", "joining date", "activation date", "started"] },
  { key: "duration", label: "Duration", required: false, synonyms: ["duration", "term", "period"] },
  { key: "durationUnit", label: "Duration unit", required: false, synonyms: ["duration unit", "unit", "period unit"] },
  { key: "expiryDate", label: "Expiry date", required: false, synonyms: ["expiry date", "expiry", "expires", "exp date", "end date", "expire date"] },
  // Becomes the client's first internal note (never sent, never on the timeline as text).
  { key: "note", label: "Note", required: false, synonyms: ["note", "notes", "internal note", "remarks", "remark", "comment", "comments"] },
] as const;

export type ClientImportFieldKey = (typeof CLIENT_IMPORT_FIELDS)[number]["key"];
export type ClientImportMapping = Partial<Record<ClientImportFieldKey, string>>;

// Trimmed last: "Assign2Emp." must not keep the space its dot became.
const headerKey = (header: string) => header.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();

/** The mapping a sheet's own headers suggest. The administrator can change every entry before importing. */
export function autoMapColumns(headers: readonly string[]): ClientImportMapping {
  const mapping: ClientImportMapping = {};
  const used = new Set<string>();
  for (const field of CLIENT_IMPORT_FIELDS) {
    const synonyms = (field.synonyms as readonly string[]).map(headerKey);
    const hit = headers.find((header) => !used.has(header) && synonyms.includes(headerKey(header)));
    if (hit) {
      mapping[field.key] = hit;
      used.add(hit);
    }
  }
  return mapping;
}

export interface ImportedClientRow {
  rowNumber: number;
  /** Country, currency, team, seller, staff and the first subscription (clientImportExtras.ts). */
  extras: ImportExtras;
  fields: ValidClientFields;
  /** Whether the file gave a status. When it did not, an UPDATE must leave the client's status alone. */
  statusGiven: boolean;
  /** The file's note for this client, to add as an internal note (null = none). */
  note: string | null;
  channels: NormalizedChannel[];
  matchKeys: string[];
  /**
   * Smart Bulk Import only: an exact expiry with no start date, recorded on the client ("Expiry on
   * record") rather than invented into a subscription term. Absent on every other import.
   */
  recordedExpiry?: { date: string; service: string | null } | null;
  /** V5: the business / company type the file gives (free text, matched to the project's list on the server). */
  businessType?: string | null;
  /**
   * Smart Import V5 only: amounts the file states for this client, retained as written (clientImportMoney.ts).
   * Never an invoice, a receipt or a due.
   */
  importedAmounts?: ImportedAmount[];
}

export interface ImportRowError {
  rowNumber: number;
  errors: string[];
}

const splitMulti = (value: string) => value.split(/[;|\n]+/).map((part) => part.trim()).filter(Boolean);

/**
 * Turns a sheet's rows into clients, row by row. A bad row is reported and skipped; it never stops
 * the others. `rowNumber` is the row's place in the file as a person counts it (the header is row 1).
 */
export function buildImportRows(
  rows: readonly Record<string, unknown>[],
  mapping: ClientImportMapping,
): { valid: ImportedClientRow[]; invalid: ImportRowError[] } {
  const valid: ImportedClientRow[] = [];
  const invalid: ImportRowError[] = [];
  const get = (row: Record<string, unknown>, key: ClientImportFieldKey): string => {
    const column = mapping[key];
    if (!column) return "";
    const raw = row[column];
    return raw === undefined || raw === null ? "" : String(raw).trim();
  };

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (Object.values(row).every((v) => v === undefined || v === null || String(v).trim() === "")) return; // a blank line
    const drafts: ClientChannelDraft[] = [];
    for (const phone of splitMulti(get(row, "phone"))) drafts.push({ kind: "PHONE", value: phone, isPrimary: drafts.every((d) => d.kind !== "PHONE") });
    for (const wa of splitMulti(get(row, "whatsapp"))) drafts.push({ kind: "WHATSAPP", value: wa, isPrimary: drafts.every((d) => d.kind !== "WHATSAPP") });
    for (const email of splitMulti(get(row, "email"))) drafts.push({ kind: "EMAIL", value: email, isPrimary: drafts.every((d) => d.kind !== "EMAIL") });
    for (const [field, kind] of [["facebook", "MESSENGER"], ["instagram", "INSTAGRAM"], ["telegram", "TELEGRAM"]] as const) {
      const value = get(row, field);
      if (value) drafts.push({ kind, value });
    }

    const statusText = get(row, "status");
    const statusKey = statusText.toUpperCase();
    const fields = validateClientFields({
      name: get(row, "name"),
      code: get(row, "code"),
      companyName: get(row, "company"),
      status: statusText ? statusKey : undefined,
      category: get(row, "category"),
      preferredLanguage: get(row, "language"),
      address: get(row, "address"),
      tags: get(row, "tags"),
    });
    const normalized = normalizeChannelDrafts(drafts);
    const extras = readImportExtras({
      country: get(row, "country"),
      currency: get(row, "currency"),
      team: get(row, "team"),
      soldBy: get(row, "soldBy"),
      assignedTo: get(row, "assignedTo"),
      service: get(row, "service"),
      subscriptionType: get(row, "subscriptionType"),
      startDate: get(row, "startDate"),
      duration: get(row, "duration"),
      durationUnit: get(row, "durationUnit"),
      expiryDate: get(row, "expiryDate"),
    });
    const note = get(row, "note").trim();
    // Same rule as the form's business type (clientConfiguration.cleanBusinessType), kept here so this module
    // does not import the one that imports it.
    const businessType = get(row, "businessType").replace(/\s+/g, " ").trim();
    const errors = [...fields.errors, ...normalized.errors, ...(extras.ok ? [] : extras.errors)];
    if (businessType && (businessType.length > 80 || /^[=+\-@]/.test(businessType) || /[\u0000-\u001f\u007f]/.test(businessType))) {
      errors.push("Business type must be at most 80 characters and cannot start with = + - or @.");
    }
    if (note.length > CLIENT_LIMITS.note) errors.push(`Note is longer than ${CLIENT_LIMITS.note.toLocaleString()} characters.`);
    if (fields.value?.status === "ARCHIVED") errors.push("A file cannot archive clients; archive them from the client list.");
    if (errors.length || !fields.value || !extras.ok) {
      invalid.push({ rowNumber, errors: errors.length ? errors : ["The row could not be read."] });
      return;
    }
    valid.push({
      rowNumber,
      extras: extras.value,
      fields: fields.value,
      statusGiven: Boolean(statusText),
      note: note || null,
      channels: normalized.channels,
      matchKeys: normalized.channels.map((c) => c.matchKey),
      ...(businessType ? { businessType } : {}),
    });
  });
  return { valid, invalid };
}

export const CLIENT_DUPLICATE_POLICIES = ["SKIP", "UPDATE", "CREATE"] as const;
export type ClientDuplicatePolicy = (typeof CLIENT_DUPLICATE_POLICIES)[number];
export const CLIENT_DUPLICATE_POLICY_LABELS: Record<ClientDuplicatePolicy, string> = {
  SKIP: "Skip rows that match an existing client",
  UPDATE: "Update the matching client with the file's values",
  CREATE: "Create a new client anyway",
};

/** Rows of a file that name the same identifier twice are duplicates of EACH OTHER; the later one is reported, not silently dropped. */
export function findInFileDuplicates(rows: readonly ImportedClientRow[]): Map<number, number> {
  const firstSeen = new Map<string, number>();
  const duplicateOf = new Map<number, number>();
  for (const row of rows) {
    const keys = [...row.matchKeys, ...(row.fields.code ? [`code:${row.fields.code.toLowerCase()}`] : [])];
    for (const key of keys) {
      const first = firstSeen.get(key);
      if (first !== undefined && first !== row.rowNumber) {
        duplicateOf.set(row.rowNumber, first);
        break;
      }
      if (first === undefined) firstSeen.set(key, row.rowNumber);
    }
  }
  return duplicateOf;
}

// ── Export ──────────────────────────────────────────────────────────────────────────────────────

export const CLIENT_EXPORT_COLUMNS = ["Client code", "Name", "Company", "Status", "Category", "Tags", "Phone", "Email", "WhatsApp", "Preferred language", "Address", "Source", "Created", "Last contact", "Country", "Preferred currency", "Team", "Sold by", "Service / plan", "Subscription start", "Expires", "Subscription", "Linked WhatsApp groups"] as const;
