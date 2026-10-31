/**
 * Smart Bulk Import (SMART_IMPORT.md): the pure rules. Where each client field's text comes from
 * (mapping v2), the sample values a person may choose, the checks a file must pass, and the zip
 * inspection that runs before a workbook is parsed.
 *
 * Mapping v2 only decides each field's TEXT. Everything after that — what a valid name, phone, date or
 * subscription is — is the existing import's own rules (`buildImportRows`), called unchanged, so the
 * old import and this one cannot disagree about what a client is.
 */

import { buildImportRows, CLIENT_IMPORT_FIELDS, CLIENT_LIMITS, type ClientImportFieldKey, type ImportedClientRow, type ImportRowError } from "./clients.js";
import { readRowMoney, sanitizeMoneyMapping, type RowMoney, type SmartMoneyMapping } from "./clientImportMoney.js";
import { parseDurationUnit, parseImportDate, parseSubscriptionKind } from "./clientImportExtras.js";
import {
  EXPIRY_CONFLICT_RULES,
  EXPIRY_MODES,
  EXPIRY_PART_KEYS,
  EXPIRY_PART_LABELS,
  EXPIRY_PART_SYNONYMS,
  MONTH_YEAR_POLICIES,
  resolveSmartExpiry,
  type ExpiryPartKey,
  type ExpiryParts,
  type FieldIssue,
  type SmartExpiryOptions,
} from "./clientSmartExpiry.js";

// ── Limits ─────────────────────────────────────────────────────────────────────────────────────

export const SMART_IMPORT_LIMITS = {
  maxBytes: 15 * 1024 * 1024,
  maxRows: 5000,
  maxColumns: 100,
  maxCellChars: 5000,
  maxTotalChars: 20_000_000,
  maxHeaderRow: 20,
  maxConstantChars: 2000,
  /** Zip: what a 15 MB workbook may expand to before a single cell is read. */
  maxZipEntries: 2000,
  maxUncompressedBytes: 120 * 1024 * 1024,
  /** A large entry (over 1 MB expanded) more compressed than this is treated as a zip bomb. */
  maxCompressionRatio: 100,
} as const;

// ── Mapping v2 ─────────────────────────────────────────────────────────────────────────────────

export const SMART_FIELD_MODES = ["source", "constant", "sample", "empty"] as const;
export type SmartFieldMode = (typeof SMART_FIELD_MODES)[number];

export type SmartFieldRule =
  | { mode: "source"; column: string; fallback?: string }
  /** `sample` = a sample value frozen into a constant when the import was confirmed (shown as a sample). */
  | { mode: "constant"; value: string; sample?: boolean }
  | { mode: "sample" }
  | { mode: "empty" };

/** A client field, or one of the expiry parts (year / month / day) that compose the Expiry date. */
export type SmartRuleKey = ClientImportFieldKey | ExpiryPartKey;

export interface SmartMapping {
  version: 2;
  fields: Partial<Record<SmartRuleKey, SmartFieldRule>>;
  /** How the expiry is entered and how its gaps and conflicts are resolved (clientSmartExpiry.ts). */
  options?: SmartExpiryOptions;
  /**
   * V5: fill an empty country, preferred currency and language from the row's valid phone numbers (marked
   * Auto selected). Absent = on. A value the file gives is never replaced either way.
   */
  fillLocale?: boolean;
  /**
   * V6 (CLIENT_CODES.md §Import): a NEW client takes the file's own client code as its code. Absent = the client gets
   * the project's next code and the file's code is kept as an alias. Allowed only to someone who manages client settings.
   */
  useFileCodes?: boolean;
  /** V5 §7: how amounts are laid out (one column + currency, or one column per currency). Absent = no amounts read. */
  money?: SmartMoneyMapping;
  /**
   * V5 §11: columns no field reads that the person chose to keep, each as a custom field named after its header —
   * so data the import does not understand is kept on purpose, never dropped without a word.
   */
  keepColumns?: string[];
}

/** At most this many file columns can be kept as custom fields (the client's own limit leaves room for others). */
export const SMART_KEEP_COLUMNS_MAX = 20;

export const SMART_FIELD_KEYS = CLIENT_IMPORT_FIELDS.map((f) => f.key) as ClientImportFieldKey[];
const FIELD_KEY_SET = new Set<string>(SMART_FIELD_KEYS);
export const isSmartFieldKey = (key: unknown): key is ClientImportFieldKey => typeof key === "string" && FIELD_KEY_SET.has(key);
export const isExpiryPartKey = (key: unknown): key is ExpiryPartKey => typeof key === "string" && (EXPIRY_PART_KEYS as readonly string[]).includes(key);

/**
 * The review grid's column order: the official import template's order (clientImportTemplate.ts), every
 * field always present. A test pins it against the template.
 */
export const SMART_REVIEW_ORDER: readonly ClientImportFieldKey[] = [
  "name", "company", "code", "phone", "whatsapp", "email", "country", "currency", "address", "category", "businessType", "tags", "status", "language",
  "team", "assignedTo", "soldBy", "service", "subscriptionType", "startDate", "duration", "durationUnit", "expiryDate",
  "facebook", "instagram", "telegram", "note",
];

/**
 * Fields that identify a client. The same value on every row makes every row the same client, so a
 * constant or sample here is allowed but always warned about (and the rows show as repeats).
 */
export const SMART_IDENTITY_FIELDS: readonly ClientImportFieldKey[] = ["code", "phone", "email", "whatsapp", "facebook", "instagram", "telegram"];

/** Fields resolved against the project's own lists. Their sample value is a real entry of that list (server). */
export const SMART_ROSTER_FIELDS: readonly ClientImportFieldKey[] = ["team", "soldBy", "assignedTo"];

/** The software's sample value for each field, offered — never applied — in the mapping editor. */
export const SMART_SAMPLE_VALUES: Record<ClientImportFieldKey, string> = {
  name: "Sample Client",
  code: "SAMPLE-001",
  company: "Sample Company Ltd",
  businessType: "Retail",
  phone: "+8801700000000",
  email: "client@example.com",
  whatsapp: "+8801700000000",
  facebook: "sample.client",
  instagram: "sample.client",
  telegram: "sampleclient",
  category: "Imported",
  tags: "imported",
  status: "ACTIVE",
  language: "Bangla",
  address: "Dhaka, Bangladesh",
  country: "Bangladesh",
  currency: "BDT",
  team: "",
  soldBy: "",
  assignedTo: "",
  service: "Internet",
  subscriptionType: "Paid",
  startDate: "",
  duration: "1",
  durationUnit: "Months",
  expiryDate: "",
  note: "Imported with Smart Bulk Import",
};

/** Groups for the mapping editor, most-used first. */
export const SMART_FIELD_GROUPS: ReadonlyArray<{ title: string; fields: readonly ClientImportFieldKey[] }> = [
  { title: "Essentials", fields: ["name", "phone", "email", "whatsapp", "company"] },
  { title: "Details", fields: ["code", "status", "category", "businessType", "tags", "language", "address", "country", "currency", "note"] },
  { title: "Other channels", fields: ["facebook", "instagram", "telegram"] },
  { title: "People", fields: ["team", "soldBy", "assignedTo"] },
  { title: "Subscription", fields: ["service", "subscriptionType", "startDate", "duration", "durationUnit", "expiryDate"] },
];

/** Extra header words seen in real customer exports, on top of the import's own synonyms. */
const EXTRA_SYNONYMS: Partial<Record<ClientImportFieldKey, readonly string[]>> = {
  name: ["customer", "contact name", "subscriber name", "subscriber", "client full name", "customer full name"],
  phone: ["cell", "cell phone", "cell number", "contact", "contact no", "mobile no", "phone no", "msisdn", "mobile phone", "customer mobile", "customer phone"],
  email: ["email id", "mail id", "e mail", "customer email"],
  whatsapp: ["whatsapp no.", "wa number", "whatsapp mobile"],
  company: ["company/business", "firm", "shop", "shop name", "organization name"],
  address: ["area", "full address", "customer address"],
  startDate: ["connection date", "subscription start", "start", "activation"],
  expiryDate: ["expiration date", "expiration", "valid till", "valid until", "renewal date"],
  category: ["customer type", "package name"],
  service: ["package", "plan name"],
};

const headerKey = (header: string) => header.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();

const SYNONYMS: Record<ClientImportFieldKey, string[]> = Object.fromEntries(
  CLIENT_IMPORT_FIELDS.map((f) => [f.key, [...new Set([...(f.synonyms as readonly string[]), ...(EXTRA_SYNONYMS[f.key] ?? [])].map(headerKey))]]),
) as Record<ClientImportFieldKey, string[]>;

// The expiry is not here: an expiry alone is legitimate (recorded on the client, clientSmartExpiry.ts).
const SUBSCRIPTION_DETAIL_FIELDS: readonly ClientImportFieldKey[] = ["subscriptionType", "startDate", "duration", "durationUnit"];

export interface MappingSuggestion {
  field: ClientImportFieldKey;
  column: string;
  /** Why it was suggested, in words. */
  reason: string;
}

/**
 * The mapping a file's headers suggest. An EXACT synonym is applied; a header that only CONTAINS one
 * (e.g. "Customer Mobile Number") is offered as a suggestion and never applied by itself. Each column
 * is applied to at most one field here — feeding several fields from one column is the person's choice.
 */
export function autoMapSmart(headers: readonly string[]): { mapping: SmartMapping; suggestions: MappingSuggestion[] } {
  const fields: SmartMapping["fields"] = {};
  const used = new Set<string>();
  for (const field of SMART_FIELD_KEYS) {
    const hit = headers.find((h) => !used.has(h) && SYNONYMS[field].includes(headerKey(h)));
    if (hit) {
      fields[field] = { mode: "source", column: hit };
      used.add(hit);
    }
  }
  for (const part of EXPIRY_PART_KEYS) {
    const synonyms = EXPIRY_PART_SYNONYMS[part].map(headerKey);
    const hit = headers.find((h) => !used.has(h) && synonyms.includes(headerKey(h)));
    if (hit) {
      fields[part] = { mode: "source", column: hit };
      used.add(hit);
    }
  }
  const suggestions: MappingSuggestion[] = [];
  // A subscription needs its service. Start or expiry dates matched without one would make every row
  // an incomplete subscription — so without a Service column they are offered, never applied.
  if (!fields.service) {
    for (const field of SUBSCRIPTION_DETAIL_FIELDS) {
      const rule = fields[field];
      if (rule?.mode !== "source") continue;
      delete fields[field];
      used.delete(rule.column);
      suggestions.push({ field, column: rule.column, reason: `"${rule.column}" looks like ${labelOf(field)} — it needs a Service / plan column too` });
    }
  }
  for (const header of headers) {
    if (used.has(header) || suggestions.some((s) => s.column === header)) continue;
    const key = ` ${headerKey(header)} `;
    const claims = SMART_FIELD_KEYS.filter((field) => !fields[field] && SYNONYMS[field].some((s) => s.length >= 3 && key.includes(` ${s} `)));
    // A header two fields could claim is ambiguous: suggesting either would be a guess.
    if (claims.length === 1) suggestions.push({ field: claims[0]!, column: header, reason: `"${header}" looks like ${labelOf(claims[0]!)}` });
  }
  return { mapping: { version: 2, fields }, suggestions };
}

export function labelOf(field: SmartRuleKey): string {
  if (isExpiryPartKey(field)) return EXPIRY_PART_LABELS[field];
  return CLIENT_IMPORT_FIELDS.find((f) => f.key === field)?.label ?? field;
}

/** An old (v1: field → column) or v2 mapping, as v2. Anything unreadable becomes an empty mapping. */
export function upgradeMapping(raw: unknown): SmartMapping {
  if (raw && typeof raw === "object" && (raw as { version?: unknown }).version === 2 && typeof (raw as { fields?: unknown }).fields === "object") {
    const m = raw as SmartMapping;
    return {
      version: 2,
      fields: { ...(m.fields ?? {}) },
      ...(m.options ? { options: { ...m.options } } : {}),
      ...(m.fillLocale === false ? { fillLocale: false } : {}),
      ...(m.useFileCodes === true ? { useFileCodes: true } : {}),
      ...(m.money ? { money: m.money } : {}),
      ...(m.keepColumns?.length ? { keepColumns: [...m.keepColumns] } : {}),
    };
  }
  const fields: SmartMapping["fields"] = {};
  if (raw && typeof raw === "object") {
    for (const [field, column] of Object.entries(raw as Record<string, unknown>)) {
      if (isSmartFieldKey(field) && typeof column === "string" && column) fields[field] = { mode: "source", column };
    }
  }
  return { version: 2, fields };
}

// ── Field values ───────────────────────────────────────────────────────────────────────────────

const IDENTITY_MAPPING = Object.fromEntries(SMART_FIELD_KEYS.map((k) => [k, k])) as Record<ClientImportFieldKey, string>;

/** Text that a spreadsheet would run as a formula, or that is only a link where a name belongs. */
export function unsafeTextIssues(values: Partial<Record<ClientImportFieldKey, string>>): string[] {
  const issues: string[] = [];
  for (const field of ["name", "company"] as const) {
    const value = values[field] ?? "";
    if (!value) continue;
    if (/^[=@]/.test(value) || /^[+-][A-Za-z(]/.test(value)) issues.push(`${labelOf(field)} looks like a spreadsheet formula ("${value.slice(0, 30)}"). Correct it or leave it out.`);
    else if (/^(https?:\/\/|www\.)\S+$/i.test(value)) issues.push(`${labelOf(field)} is only a web address. Use the client's ${field === "name" ? "name" : "company name"} instead.`);
  }
  for (const [field, value] of Object.entries(values)) {
    // Tab and line breaks are ordinary in an address or note; other control characters never are.
    if (value && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) issues.push(`${labelOf(field as ClientImportFieldKey)} contains invisible control characters.`);
  }
  return issues;
}

/** The problems with one field's value on its own (used for a constant and for a person's correction). */
export function checkFieldValue(field: ClientImportFieldKey, value: string): string[] {
  if (value.length > SMART_IMPORT_LIMITS.maxConstantChars) return [`${labelOf(field)} is longer than ${SMART_IMPORT_LIMITS.maxConstantChars.toLocaleString()} characters.`];
  if (!value.trim()) return [];
  const row: Record<string, string> = { name: field === "name" ? value : "Check", [field]: value };
  const built = buildImportRows([row], IDENTITY_MAPPING);
  return [...(built.invalid[0]?.errors ?? []), ...unsafeTextIssues({ [field]: value })];
}

export type SmartSamples = Record<ClientImportFieldKey, string>;

/** One staged row's text per field: the person's correction, else the mapping's rule. */
export function materializeRow(
  source: Readonly<Record<string, string>>,
  mapping: SmartMapping,
  samples: SmartSamples,
  edits: Readonly<Partial<Record<ClientImportFieldKey, string>>> = {},
): Record<ClientImportFieldKey, string> {
  const out = {} as Record<ClientImportFieldKey, string>;
  for (const field of SMART_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(edits, field)) {
      out[field] = String(edits[field] ?? "").trim();
      continue;
    }
    const rule = mapping.fields[field];
    let value = "";
    if (rule?.mode === "source") {
      value = (source[rule.column] ?? "").trim();
      if (!value && rule.fallback) value = (source[rule.fallback] ?? "").trim();
    } else if (rule?.mode === "constant") value = rule.value.trim();
    else if (rule?.mode === "sample") value = samples[field] ?? "";
    out[field] = value;
  }
  return out;
}

/** The expiry parts a row gives (year / month / day columns or fixed values), before they are composed. */
export function materializeParts(source: Readonly<Record<string, string>>, mapping: SmartMapping): ExpiryParts {
  const read = (key: ExpiryPartKey) => {
    const rule = mapping.fields[key];
    if (rule?.mode === "source") return (source[rule.column] ?? "").trim() || (rule.fallback ? (source[rule.fallback] ?? "").trim() : "");
    if (rule?.mode === "constant") return rule.value.trim();
    return "";
  };
  return { year: read("expiryYear"), month: read("expiryMonth"), day: read("expiryDay"), mapped: EXPIRY_PART_KEYS.some((k) => Boolean(mapping.fields[k])) };
}

export interface StagedRow {
  rowNumber: number;
  source: Readonly<Record<string, string>>;
  edits?: Readonly<Partial<Record<ClientImportFieldKey, string>>>;
  ignored?: boolean;
}

export interface SmartBuildResult {
  valid: ImportedClientRow[];
  invalid: ImportRowError[];
  /** Rows the person excluded. */
  ignored: number[];
  /** Rows with nothing in them at all (no cell, no correction) — skipped, as the old import skips a blank line. */
  blank: number[];
  outputs: Map<number, Record<ClientImportFieldKey, string>>;
  /** Per row: the amounts it states (V5 §7). Rows without a money mapping are absent. */
  money: Map<number, RowMoney>;
  /** Per row: the problems and notes attached to the field they concern (the review grid colours that cell). */
  issues: Map<number, FieldIssue[]>;
  /** Per row: the exact expiry it will have and how it was reached — for display. */
  expiry: Map<number, { finalExpiry: string | null; basis: string | null }>;
}

/** Staged rows → the existing import's valid/invalid rows, keeping each row's own number. */
export function buildSmartRows(rows: readonly StagedRow[], mapping: SmartMapping, samples: SmartSamples): SmartBuildResult {
  const result: SmartBuildResult = { valid: [], invalid: [], ignored: [], blank: [], outputs: new Map(), money: new Map(), issues: new Map(), expiry: new Map() };
  for (const row of rows) {
    const raw = materializeRow(row.source, mapping, samples, row.edits ?? {});
    const expiryEdited = Object.prototype.hasOwnProperty.call(row.edits ?? {}, "expiryDate");
    const resolution = resolveSmartExpiry(raw, materializeParts(row.source, mapping), mapping.options ?? {}, expiryEdited);
    const output = resolution.output;
    // The review shows what the row says, with the expiry in its exact form — not what is passed on.
    result.outputs.set(row.rowNumber, { ...raw, expiryDate: resolution.finalExpiry ?? (resolution.output.expiryDate || raw.expiryDate) });
    result.expiry.set(row.rowNumber, { finalExpiry: resolution.finalExpiry, basis: resolution.basis });
    const money = mapping.money ? readRowMoney(row.source, mapping.money) : null;
    if (money) result.money.set(row.rowNumber, money);
    if (row.ignored) {
      result.ignored.push(row.rowNumber);
      continue;
    }
    const hasSource = Object.values(row.source).some((v) => String(v ?? "").trim() !== "");
    const hasEdits = Object.keys(row.edits ?? {}).length > 0;
    if (!hasSource && !hasEdits) {
      result.blank.push(row.rowNumber);
      continue;
    }
    if (Object.values(output).every((v) => !v)) {
      // The row has data, but none of it is mapped to a client field: say so, never skip it quietly.
      result.invalid.push({ rowNumber: row.rowNumber, errors: ["Nothing in this row is mapped to a client field. A client needs a name."] });
      continue;
    }
    const unsafe = unsafeTextIssues(output);
    const built = buildImportRows([output], IDENTITY_MAPPING);
    const expiryErrors = resolution.issues.filter((i) => i.severity === "error").map((i) => i.message);
    const errors = [...new Set([...expiryErrors, ...(built.invalid[0]?.errors ?? []), ...unsafe])];
    // Judged on what the row says WITH its expiry composed (parts → one date), or a valid row would show a red cell.
    result.issues.set(row.rowNumber, fieldIssues({ ...raw, expiryDate: resolution.finalExpiry ?? raw.expiryDate }, resolution.issues, errors));
    if (errors.length || !built.valid[0]) result.invalid.push({ rowNumber: row.rowNumber, errors: errors.length ? errors : ["The row could not be read."] });
    else {
      const valid = built.valid[0];
      const kept = keptCustomFields(row.source, mapping.keepColumns);
      result.valid.push({
        ...valid,
        rowNumber: row.rowNumber,
        recordedExpiry: resolution.recordedExpiry,
        ...(Object.keys(kept).length ? { fields: { ...valid.fields, customFields: { ...valid.fields.customFields, ...kept } } } : {}),
        ...(money?.amounts.length ? { importedAmounts: money.amounts } : {}),
      });
    }
  }
  return result;
}

/** The kept columns of one row, as custom fields: named after the header, values cut to the client's limit. */
export function keptCustomFields(source: Readonly<Record<string, string>>, keep: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of keep ?? []) {
    const value = (source[header] ?? "").trim();
    if (!value) continue;
    const key = header.trim().slice(0, CLIENT_LIMITS.customFieldKey);
    if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    out[key] = value.slice(0, CLIENT_LIMITS.customFieldValue);
  }
  return out;
}

/**
 * A mapping as the server will store it: known fields, known modes, columns the file has, constants
 * that are valid values for their field. Refuses rather than silently dropping anything.
 */
export function sanitizeSmartMapping(raw: unknown, headers: readonly string[]): { ok: true; mapping: SmartMapping } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "The mapping could not be read." };
  const fieldsIn = (raw as { fields?: unknown }).fields;
  if (!fieldsIn || typeof fieldsIn !== "object") return { ok: false, error: "The mapping could not be read." };
  const headerSet = new Set(headers);
  const fields: SmartMapping["fields"] = {};
  for (const [field, ruleIn] of Object.entries(fieldsIn as Record<string, unknown>)) {
    if (!isSmartFieldKey(field) && !isExpiryPartKey(field)) return { ok: false, error: `"${String(field).slice(0, 40)}" is not a client field.` };
    const rule = (ruleIn ?? {}) as Record<string, unknown>;
    const label = labelOf(field);
    if (isExpiryPartKey(field)) {
      // A part is a column or one fixed number for every row; a sample date would be fiction.
      if (rule.mode === "empty") continue;
      if (rule.mode === "source") {
        if (typeof rule.column !== "string" || !headerSet.has(rule.column)) return { ok: false, error: `${label}: the file has no column called "${String(rule.column ?? "").slice(0, 40)}".` };
        fields[field] = { mode: "source", column: rule.column };
        continue;
      }
      if (rule.mode === "constant") {
        const value = typeof rule.value === "string" ? rule.value.trim() : "";
        const max = field === "expiryMonth" ? 12 : 31;
        const okValue = field === "expiryYear" ? /^\d{4}$/.test(value) : /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= max;
        if (!okValue) return { ok: false, error: `${label}: "${value.slice(0, 20)}" is not a valid ${field === "expiryYear" ? "four-digit year" : field === "expiryMonth" ? "month (1–12)" : "day (1–31)"}.` };
        fields[field] = { mode: "constant", value };
        continue;
      }
      return { ok: false, error: `${label}: choose a column or a fixed value.` };
    }
    switch (rule.mode) {
      case "source": {
        if (typeof rule.column !== "string" || !headerSet.has(rule.column)) return { ok: false, error: `${label}: the file has no column called "${String(rule.column ?? "").slice(0, 40)}".` };
        const fallback = typeof rule.fallback === "string" && rule.fallback ? rule.fallback : undefined;
        if (fallback && !headerSet.has(fallback)) return { ok: false, error: `${label}: the file has no column called "${fallback.slice(0, 40)}".` };
        fields[field] = fallback && fallback !== rule.column ? { mode: "source", column: rule.column, fallback } : { mode: "source", column: rule.column };
        break;
      }
      case "constant": {
        const value = typeof rule.value === "string" ? rule.value.trim() : "";
        if (!value) return { ok: false, error: `${label}: type the value to use for every row, or choose Leave empty.` };
        const problems = checkFieldValue(field, value);
        if (problems.length) return { ok: false, error: `${label}: ${problems[0]}` };
        fields[field] = rule.sample === true ? { mode: "constant", value, sample: true } : { mode: "constant", value };
        break;
      }
      case "sample":
        fields[field] = { mode: "sample" };
        break;
      case "empty":
        break; // stored as absent: an empty field and an unmapped field are the same thing
      default:
        return { ok: false, error: `${label}: choose where the value comes from.` };
    }
  }
  const optionsIn = ((raw as { options?: unknown }).options ?? {}) as Record<string, unknown>;
  const options: SmartExpiryOptions = {};
  if (optionsIn.expiryMode !== undefined) {
    if (!(EXPIRY_MODES as readonly unknown[]).includes(optionsIn.expiryMode)) return { ok: false, error: "Choose how the expiry is entered." };
    options.expiryMode = optionsIn.expiryMode as SmartExpiryOptions["expiryMode"];
  }
  if (optionsIn.monthYearPolicy !== undefined) {
    if (!(MONTH_YEAR_POLICIES as readonly unknown[]).includes(optionsIn.monthYearPolicy)) return { ok: false, error: "Choose what to do when an expiry has no day." };
    options.monthYearPolicy = optionsIn.monthYearPolicy as SmartExpiryOptions["monthYearPolicy"];
  }
  if (optionsIn.expiryConflict !== undefined) {
    if (!(EXPIRY_CONFLICT_RULES as readonly unknown[]).includes(optionsIn.expiryConflict)) return { ok: false, error: "Choose what to do when the expiry and the duration disagree." };
    options.expiryConflict = optionsIn.expiryConflict as SmartExpiryOptions["expiryConflict"];
  }
  const fillLocale = (raw as { fillLocale?: unknown }).fillLocale;
  if (fillLocale !== undefined && typeof fillLocale !== "boolean") return { ok: false, error: "Choose whether to fill the country, currency and language from phone numbers." };
  const useFileCodes = (raw as { useFileCodes?: unknown }).useFileCodes;
  if (useFileCodes !== undefined && typeof useFileCodes !== "boolean") return { ok: false, error: "Choose whether the file's client codes become the clients' codes." };
  const money = sanitizeMoneyMapping((raw as { money?: unknown }).money, headers);
  if (!money.ok) return { ok: false, error: money.error };
  const keepIn = (raw as { keepColumns?: unknown }).keepColumns;
  const keepColumns: string[] = [];
  if (keepIn !== undefined) {
    if (!Array.isArray(keepIn)) return { ok: false, error: "The kept columns could not be read." };
    for (const c of keepIn) {
      if (typeof c !== "string" || !headerSet.has(c)) return { ok: false, error: `The file has no column called "${String(c).slice(0, 40)}" to keep.` };
      if (!keepColumns.includes(c)) keepColumns.push(c);
    }
    if (keepColumns.length > SMART_KEEP_COLUMNS_MAX) return { ok: false, error: `At most ${SMART_KEEP_COLUMNS_MAX} columns can be kept as custom fields.` };
  }
  return {
    ok: true,
    mapping: {
      version: 2,
      fields,
      ...(Object.keys(options).length ? { options } : {}),
      ...(fillLocale === false ? { fillLocale: false } : {}),
      ...(useFileCodes === true ? { useFileCodes: true } : {}),
      ...(money.money ? { money: money.money } : {}),
      ...(keepColumns.length ? { keepColumns } : {}),
    },
  };
}

/** A mapping with every "sample" rule replaced by the sample's value, so the import does not depend on the day it runs. */
export function freezeSamples(mapping: SmartMapping, samples: SmartSamples): SmartMapping {
  const fields: SmartMapping["fields"] = {};
  for (const field of SMART_FIELD_KEYS) {
    const rule = mapping.fields[field];
    if (!rule) continue;
    if (rule.mode !== "sample") fields[field] = rule;
    else if (samples[field]) fields[field] = { mode: "constant", value: samples[field], sample: true };
  }
  for (const part of EXPIRY_PART_KEYS) if (mapping.fields[part]) fields[part] = mapping.fields[part];
  return {
    version: 2,
    fields,
    ...(mapping.options ? { options: mapping.options } : {}),
    ...(mapping.fillLocale === false ? { fillLocale: false } : {}),
    ...(mapping.useFileCodes === true ? { useFileCodes: true } : {}),
    ...(mapping.money ? { money: mapping.money } : {}),
    ...(mapping.keepColumns?.length ? { keepColumns: mapping.keepColumns } : {}),
  };
}

/** The columns each field reads — for showing one column feeding several fields. */
export function columnUsage(mapping: SmartMapping): Map<string, SmartRuleKey[]> {
  const usage = new Map<string, SmartRuleKey[]>();
  for (const field of [...SMART_FIELD_KEYS, ...EXPIRY_PART_KEYS] as SmartRuleKey[]) {
    const rule = mapping.fields[field];
    if (rule?.mode !== "source") continue;
    for (const column of [rule.column, rule.fallback]) {
      if (column) usage.set(column, [...(usage.get(column) ?? []), field]);
    }
  }
  return usage;
}

// ── Field-level issues ─────────────────────────────────────────────────────────────────────────

const SUBSCRIPTION_FIELDS = new Set<ClientImportFieldKey>(["service", "subscriptionType", "startDate", "duration", "durationUnit", "expiryDate"]);
/** Resolved on the server against the project's own lists. */
const ROSTER_RESOLVED = new Set<ClientImportFieldKey>(["country", "currency", "team", "soldBy", "assignedTo"]);

/**
 * Which field each problem concerns, decided by checking each field on its own with the import's own
 * rules — never by reading field names out of error sentences. The import's verdict on the whole row
 * stays the authority: a refusal no single field explains is still shown, so a row is never silently fine.
 */
export function fieldIssues(output: Record<ClientImportFieldKey, string>, expiryIssues: readonly FieldIssue[], rowErrors: readonly string[]): FieldIssue[] {
  const issues: FieldIssue[] = [...expiryIssues];
  const add = (field: ClientImportFieldKey, message: string, severity: FieldIssue["severity"] = "error") => {
    if (!issues.some((i) => i.field === field && i.message === message)) issues.push({ field, severity, message });
  };
  if (!output.name.trim()) add("name", "A client needs a name.");
  for (const field of SMART_FIELD_KEYS) {
    const value = output[field];
    if (!value || SUBSCRIPTION_FIELDS.has(field) || ROSTER_RESOLVED.has(field)) continue;
    for (const problem of checkFieldValue(field, value)) add(field, problem);
  }
  const subscription = Boolean(output.startDate.trim() || output.duration.trim() || (output.service.trim() && !expiryIssues.some((i) => i.severity === "warning" && /recorded on the client/.test(i.message))));
  if (subscription) {
    const start = output.startDate.trim() ? parseImportDate(output.startDate) : null;
    if (output.startDate.trim() && !start) add("startDate", `Start date "${output.startDate}" is not a date. Use 2026-10-17 or 17/10/2026.`);
    if (!output.startDate.trim()) add("startDate", "A subscription needs its start date. Add it, or clear the service and duration.");
    if (!output.service.trim()) add("service", "A subscription needs its service or plan.");
    if (output.subscriptionType.trim() && parseSubscriptionKind(output.subscriptionType) === "INVALID") add("subscriptionType", `"${output.subscriptionType}" is not Paid, Trial, Demo or Complimentary.`);
    const d = output.duration.trim();
    if (d && !(Number.isInteger(Number(d)) && Number(d) >= 1)) add("duration", `Duration "${d}" must be a whole number of at least 1.`);
    if (output.durationUnit.trim() && parseDurationUnit(output.durationUnit) === "INVALID") add("durationUnit", `"${output.durationUnit}" is not Days, Weeks, Months or Years.`);
    // An expiry that could not be read is already the problem; asking for a duration too would be noise.
    if (!d && !output.expiryDate.trim() && !expiryIssues.some((i) => i.field === "expiryDate" && i.severity === "error")) add("duration", "Give a duration, or an expiry date.");
  }
  if (rowErrors.length && !issues.some((i) => i.severity === "error")) {
    for (const e of rowErrors) {
      const field: ClientImportFieldKey = /expir|single term/i.test(e) ? "expiryDate" : /start date/i.test(e) ? "startDate" : /duration|at most \d+ (days|weeks|months|years)/i.test(e) ? "duration" : /service|plan/i.test(e) ? "service" : "name";
      add(field, e);
    }
  }
  return issues;
}

// ── Is this the right file? ────────────────────────────────────────────────────────────────────

export interface FileCheck {
  code: string;
  message: string;
}

export interface FileAssessment {
  /** Import is refused while any of these stand. */
  blocks: FileCheck[];
  /** Import needs the person to tick that they have checked each of these. */
  warnings: FileCheck[];
}

export function assessSmartFile(input: {
  headers: readonly string[];
  blankHeaders: number;
  duplicateHeaders: number;
  mapping: SmartMapping;
  recognisedColumns: number;
  totalRows: number;
  readyRows: number;
  invalidRows: number;
  /** V5 §7: ready rows stating amounts in more than one currency, and money cells that could not be read. */
  moneyMultipleRows?: number;
  moneyProblemRows?: number;
}): FileAssessment {
  const blocks: FileCheck[] = [];
  const warnings: FileCheck[] = [];
  const name = input.mapping.fields.name;
  if (!name) blocks.push({ code: "NAME_UNSET", message: "Every client needs a name. Choose a column for Name, type one name for all rows, or use the sample name." });
  if (input.totalRows === 0) blocks.push({ code: "NO_ROWS", message: "The sheet has a header row but no client rows." });
  if (input.totalRows > 0 && input.readyRows === 0) blocks.push({ code: "NOTHING_READY", message: "No row of this file can be imported as it stands. Check the mapping, or correct the rows below." });
  if (input.recognisedColumns === 0 && input.headers.length) {
    warnings.push({ code: "NO_RECOGNISED_COLUMNS", message: "None of this file's column names looks like a client field. Make sure this is the file you meant to upload." });
  }
  if (input.totalRows > 0 && input.invalidRows / input.totalRows >= 0.5 && input.readyRows > 0) {
    warnings.push({ code: "MOSTLY_INVALID", message: `${Math.round((input.invalidRows / input.totalRows) * 100)}% of the rows cannot be imported. This may be the wrong file or the wrong mapping.` });
  }
  const repeated = SMART_IDENTITY_FIELDS.filter((f) => {
    const rule = input.mapping.fields[f];
    return rule?.mode === "constant" || rule?.mode === "sample";
  });
  if (repeated.length) {
    warnings.push({
      code: "IDENTITY_SAME_VALUE",
      message: `${repeated.map(labelOf).join(", ")} ${repeated.length === 1 ? "has" : "have"} the same value on every row. Clients are recognised by these, so every row after the first will be treated as the same client.`,
    });
  }
  if (input.moneyMultipleRows) {
    warnings.push({
      code: "MONEY_MULTIPLE",
      message: `${input.moneyMultipleRows} row(s) state amounts in more than one currency. Each amount is kept on the client in its own currency, never added together or converted, and no invoice or payment is created. Exclude those rows instead if that is not what you want.`,
    });
  }
  if (input.moneyProblemRows) {
    warnings.push({
      code: "MONEY_PROBLEM",
      message: `${input.moneyProblemRows} row(s) have an amount that could not be read with certainty (shown in the review). The cell is kept exactly as written, with the reason; nothing is guessed.`,
    });
  }
  if (input.blankHeaders || input.duplicateHeaders) {
    warnings.push({
      code: "ODD_HEADERS",
      message: [input.blankHeaders ? `${input.blankHeaders} column(s) have no header` : "", input.duplicateHeaders ? `${input.duplicateHeaders} header(s) appear twice` : ""].filter(Boolean).join(" and ") + ". Check that the header row is the right one.",
    });
  }
  return { blocks, warnings };
}

// ── Reading a sheet ────────────────────────────────────────────────────────────────────────────

/** The first of the top rows that looks like headers: at least two filled cells, mostly not numbers. */
export function detectHeaderRow(grid: readonly (readonly unknown[])[]): number {
  for (let i = 0; i < Math.min(grid.length, SMART_IMPORT_LIMITS.maxHeaderRow); i++) {
    const cells = (grid[i] ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
    if (cells.length >= 2 && cells.filter((c) => /^[\d\s.,+\-/:]+$/.test(c)).length <= cells.length / 2) return i;
  }
  return 0;
}

export interface SheetRecords {
  headers: string[];
  /** `rowNumber` is the row's place in the sheet as a person counts it (the sheet's first row is 1). */
  rows: Array<{ rowNumber: number; cells: Record<string, string> }>;
  blankHeaders: number;
  duplicateHeaders: number;
}

/** A grid (rows of cells) → named rows below the header row, within the limits. Never truncates silently. */
export function gridToRecords(grid: readonly (readonly unknown[])[], headerIndex: number): SheetRecords | { error: string } {
  const headerCells = grid[headerIndex] ?? [];
  let width = headerCells.length;
  for (const row of grid.slice(headerIndex + 1)) width = Math.max(width, row.length);
  if (width > SMART_IMPORT_LIMITS.maxColumns) return { error: `The sheet has ${width} columns. At most ${SMART_IMPORT_LIMITS.maxColumns} can be imported; remove the extra columns and try again.` };
  const seen = new Map<string, number>();
  let blankHeaders = 0;
  let duplicateHeaders = 0;
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    let base = String(headerCells[i] ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!base) {
      blankHeaders += 1;
      base = `Column ${i + 1}`;
    }
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n === 2) duplicateHeaders += 1;
    headers.push(n > 1 ? `${base} (${n})` : base);
  }
  const rows: SheetRecords["rows"] = [];
  let total = 0;
  const body = grid.slice(headerIndex + 1);
  for (let r = 0; r < body.length; r++) {
    const cells = body[r] ?? [];
    if (cells.every((c) => String(c ?? "").trim() === "")) continue;
    if (rows.length >= SMART_IMPORT_LIMITS.maxRows) {
      return { error: `The file has more than ${SMART_IMPORT_LIMITS.maxRows.toLocaleString()} client rows. One import takes at most ${SMART_IMPORT_LIMITS.maxRows.toLocaleString()}; split the file and import it in parts.` };
    }
    const record: Record<string, string> = {};
    for (let c = 0; c < width; c++) {
      const value = String(cells[c] ?? "").trim();
      if (value.length > SMART_IMPORT_LIMITS.maxCellChars) {
        return { error: `Row ${headerIndex + r + 2}, column "${headers[c]}" holds ${value.length.toLocaleString()} characters. A cell can hold at most ${SMART_IMPORT_LIMITS.maxCellChars.toLocaleString()}.` };
      }
      total += value.length;
      if (value) record[headers[c]!] = value;
    }
    if (total > SMART_IMPORT_LIMITS.maxTotalChars) return { error: "The file holds too much text for one import. Split it into smaller files." };
    rows.push({ rowNumber: headerIndex + r + 2, cells: record });
  }
  return { headers, rows, blankHeaders, duplicateHeaders };
}

// ── Zip inspection (before an .xlsx is parsed) ─────────────────────────────────────────────────

/**
 * Reads an .xlsx's zip central directory — sizes and names only, nothing is inflated — and refuses
 * a file that would expand beyond the limits, is encrypted, uses Zip64, or carries macros.
 */
export function inspectXlsxZip(buffer: Uint8Array): { ok: true; uncompressedBytes: number; entries: number } | { ok: false; error: string } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.length >= 8 && view.getUint32(0) === 0xd0cf11e0) {
    return { ok: false, error: "This workbook is password-protected or in the old .xls format. Open it in Excel and save it as a normal .xlsx without a password." };
  }
  if (buffer.length < 22 || view.getUint32(0, true) !== 0x04034b50) return { ok: false, error: "This is not an .xlsx file. Save it from Excel as .xlsx, or as .csv." };
  // End of central directory: the last 22 bytes, or up to 64 KB earlier when the zip has a comment.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, error: "The file is damaged or not a real .xlsx file." };
  const entries = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || dirOffset === 0xffffffff) return { ok: false, error: "This workbook is too large to import." };
  if (entries > SMART_IMPORT_LIMITS.maxZipEntries) return { ok: false, error: "This workbook has too many parts to be a client list." };
  if (dirOffset + dirSize > buffer.length) return { ok: false, error: "The file is damaged or not a real .xlsx file." };
  let p = dirOffset;
  let total = 0;
  let contentTypes = false;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buffer.length || view.getUint32(p, true) !== 0x02014b50) return { ok: false, error: "The file is damaged or not a real .xlsx file." };
    const flags = view.getUint16(p + 8, true);
    const compressed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const name = new TextDecoder().decode(buffer.subarray(p + 46, p + 46 + nameLength));
    if (flags & 1) return { ok: false, error: "This workbook is encrypted. Save it again without a password." };
    if (size === 0xffffffff || compressed === 0xffffffff) return { ok: false, error: "This workbook is too large to import." };
    if (/vbaProject\.bin$/i.test(name)) return { ok: false, error: "This workbook contains macros. Save it as a normal .xlsx (without macros) and try again." };
    if (name === "[Content_Types].xml") contentTypes = true;
    if (size > 1024 * 1024 && size / Math.max(1, compressed) > SMART_IMPORT_LIMITS.maxCompressionRatio) {
      return { ok: false, error: "This workbook expands to far more data than its size suggests, so it was not opened." };
    }
    total += size;
    if (total > SMART_IMPORT_LIMITS.maxUncompressedBytes) return { ok: false, error: "This workbook holds too much data for one import. Split it into smaller files." };
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (!contentTypes) return { ok: false, error: "This is not an Excel workbook. Save it from Excel as .xlsx, or as .csv." };
  return { ok: true, uncompressedBytes: total, entries };
}

/** A CSV must be text: no NUL bytes in what is read. */
export function looksLikeText(buffer: Uint8Array): boolean {
  const head = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
  return !head.includes(0);
}

/** A cell value made safe to open in a spreadsheet: one that would run as a formula is kept as text. */
export function escapeSpreadsheetCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
