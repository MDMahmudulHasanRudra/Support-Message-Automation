import { createHash } from "node:crypto";

/**
 * Project client codes (CLIENT_CODES.md). A client's CODE is what people read and type ("0001", "N0001");
 * its identity is `Client.id` inside its project, always. Each project issues codes from its own series:
 * the customer's primary project is numbers only, every other project has an alphabetic prefix that no
 * other project of the same customer holds (reserved for good, even after a prefix change). Serials are
 * never reused and are carried as decimal TEXT or bigint — a serial is never a JavaScript number.
 */

export const CLIENT_CODE_DEFAULT_WIDTH = 4;
export const CLIENT_CODE_MAX_WIDTH = 12;
export const CLIENT_CODE_PREFIX_MAX = 8;
/** The longest code the client record accepts (CLIENT_LIMITS.code). */
export const CLIENT_CODE_MAX_LENGTH = 40;
/** Codes made by the old installation-wide sequence ("CL-000041"). The pattern alone never proves it. */
export const LEGACY_CLIENT_CODE = /^CL-\d{6,}$/;

/** The tenant a series belongs to: the customer, or the original installation (no customer). */
export function codeTenantKey(customerId: string | null | undefined): string {
  return customerId ?? "__founding__";
}

/** Upper-case, trimmed; letters only are valid. "" is the primary project's (numbers-only) prefix. */
export function canonicalPrefix(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toUpperCase();
}

export function validateCodePrefix(prefix: string): string | null {
  if (prefix === "") return null;
  if (!/^[A-Z]+$/.test(prefix)) return "A prefix uses the letters A–Z only — no digits, spaces or symbols.";
  if (prefix.length > CLIENT_CODE_PREFIX_MAX) return `A prefix is at most ${CLIENT_CODE_PREFIX_MAX} letters.`;
  return null;
}

export function validateCodeWidth(width: number): string | null {
  return Number.isInteger(width) && width >= 1 && width <= CLIENT_CODE_MAX_WIDTH ? null : `The number width is 1 to ${CLIENT_CODE_MAX_WIDTH} digits.`;
}

/** A serial as written by a person: digits only, at least 1. Returned as bigint; never a Number. */
export function parseSerial(raw: string | number | bigint | null | undefined): bigint | null {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,38}$/.test(text)) return null;
  const value = BigInt(text);
  return value >= 1n ? value : null;
}

/** "N" + 42 at width 4 → "N0042"; 10000 at width 4 → "10000" (it grows, it never wraps or clips). */
export function formatClientCode(prefix: string, serial: bigint | string, minWidth: number = CLIENT_CODE_DEFAULT_WIDTH): string {
  const digits = (typeof serial === "bigint" ? serial : BigInt(serial)).toString();
  return `${prefix}${digits.padStart(minWidth, "0")}`;
}

/** The next `count` codes a series would issue — for previews only, never for allocation. */
export function previewClientCodes(prefix: string, nextSerial: bigint | string, minWidth: number, count = 3): string[] {
  const start = typeof nextSerial === "bigint" ? nextSerial : BigInt(nextSerial);
  return Array.from({ length: count }, (_, i) => formatClientCode(prefix, start + BigInt(i), minWidth));
}

/** Codes compare case-insensitively inside a project ("n0001" is "N0001"). */
export function canonicalClientCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Whether `code` is one that `prefix`'s series issues: the prefix, then digits only. */
export function belongsToSeries(code: string, prefix: string): boolean {
  const c = canonicalClientCode(code);
  if (!c.startsWith(prefix)) return false;
  return /^\d+$/.test(c.slice(prefix.length));
}

/**
 * The series a code would come from among the tenant's reserved prefixes, or null. "NE0001" belongs to NE,
 * never to N (a serial is digits only), so two reserved prefixes can never issue the same code.
 */
export function seriesOfCode(code: string, reservedPrefixes: Iterable<string>): string | null {
  const c = canonicalClientCode(code);
  const m = /^([A-Z]*)(\d+)$/.exec(c);
  if (!m) return null;
  for (const prefix of reservedPrefixes) if (prefix === m[1]) return prefix;
  return null;
}

/** Letters A–Z from a slug or a name, accents removed; anything else (Bangla, Arabic, digits) is skipped. */
export function latinLetters(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

function* letterSuffixes(): Generator<string> {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of A) yield a;
  for (const a of A) for (const b of A) yield a + b;
}

/**
 * The prefix to offer a new project: its first letter, then more of its own letters ("N" taken → "NE",
 * then "NEX"), then its first letter with a letter added. Never a prefix in `reserved`. Null when the
 * slug and name hold no Latin letter at all — the admin then types one (no transliteration is guessed).
 */
export function suggestCodePrefix(input: { name: string; slug: string }, reserved: ReadonlySet<string>): string | null {
  const letters = latinLetters(input.slug) || latinLetters(input.name);
  if (!letters) return null;
  const offer = (p: string) => (p.length <= CLIENT_CODE_PREFIX_MAX && !reserved.has(p) ? p : null);
  for (let n = 1; n <= Math.min(letters.length, CLIENT_CODE_PREFIX_MAX); n++) {
    const p = offer(letters.slice(0, n));
    if (p) return p;
  }
  // Initials of the slug's words ("noor-vip" → "NV") read better than an arbitrary letter.
  const initials = latinLetters(input.slug.split(/[^a-z0-9]+/i).map((w) => w[0] ?? "").join(""));
  if (initials.length > 1) {
    const p = offer(initials.slice(0, CLIENT_CODE_PREFIX_MAX));
    if (p) return p;
  }
  for (const s of letterSuffixes()) {
    const p = offer(letters[0] + s);
    if (p) return p;
  }
  return null;
}

/** Why a prefix cannot be used by a new or changing series, or null. */
export function prefixRefusal(prefix: string, reserved: ReadonlyMap<string, string>): string | null {
  const invalid = validateCodePrefix(prefix);
  if (invalid) return invalid;
  if (prefix === "") return "Numbers-only codes belong to the customer's primary project.";
  const holder = reserved.get(prefix);
  return holder ? `The prefix ${prefix} is already reserved by ${holder}. Choose another.` : null;
}

// ── Converting existing codes (dry run, then apply) ─────────────────────────────────────────────────

export type CodePlanCategory = "LEGACY_PATTERN" | "CUSTOM" | "IN_SERIES";

export interface CodePlanClient {
  id: string;
  code: string;
  createdAt: Date;
  archived: boolean;
}

export interface CodePlanOptions {
  /** Codes shaped like the old generator ("CL-000041"). Default on. */
  convertLegacyPattern: boolean;
  /** Any other code (typed by staff or taken from a file). Default off: those are usually real references. */
  convertCustom: boolean;
}

export interface CodePlanRow {
  clientId: string;
  from: string;
  to: string | null;
  category: CodePlanCategory;
  archived: boolean;
}

export interface CodePlan {
  rows: CodePlanRow[];
  changes: number;
  kept: number;
  /** The series' next serial once the plan is applied. Text: a serial is never a JS number. */
  nextSerialAfter: string;
  /** Fingerprint of the exact plan. Apply refuses unless the plan it recomputes has the same one. */
  hash: string;
}

/**
 * The deterministic conversion of one project's codes. Clients are numbered in creation order (id breaks
 * ties), from the series' next serial, skipping every code already in use or reserved as an alias.
 * A code already in the series' own form is kept. Nothing about a client other than its code changes.
 */
export function planCodeConversion(input: {
  clients: readonly CodePlanClient[];
  aliases: readonly string[];
  series: { prefix: string; minWidth: number; nextSerial: string; version: number };
  options: CodePlanOptions;
}): CodePlan {
  const { prefix, minWidth } = input.series;
  const sorted = [...input.clients].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const categorise = (code: string): CodePlanCategory =>
    belongsToSeries(code, prefix) ? "IN_SERIES" : LEGACY_CLIENT_CODE.test(canonicalClientCode(code)) ? "LEGACY_PATTERN" : "CUSTOM";
  const willChange = (c: CodePlanCategory) => (c === "LEGACY_PATTERN" ? input.options.convertLegacyPattern : c === "CUSTOM" ? input.options.convertCustom : false);

  // Taken = every code that stays, and every alias. A changing client's old code becomes an alias too.
  const taken = new Set<string>(input.aliases.map(canonicalClientCode));
  for (const c of sorted) taken.add(canonicalClientCode(c.code));

  let serial = BigInt(input.series.nextSerial);
  const rows: CodePlanRow[] = [];
  for (const c of sorted) {
    const category = categorise(c.code);
    if (!willChange(category)) {
      rows.push({ clientId: c.id, from: c.code, to: null, category, archived: c.archived });
      continue;
    }
    let to = formatClientCode(prefix, serial, minWidth);
    while (taken.has(to)) to = formatClientCode(prefix, ++serial, minWidth);
    taken.add(to);
    serial += 1n;
    rows.push({ clientId: c.id, from: c.code, to, category, archived: c.archived });
  }
  const changes = rows.filter((r) => r.to).length;
  const hash = createHash("sha256")
    .update(JSON.stringify({ s: input.series, o: input.options, r: rows.map((r) => [r.clientId, r.from, r.to]) }))
    .digest("hex");
  return { rows, changes, kept: rows.length - changes, nextSerialAfter: serial.toString(), hash };
}
