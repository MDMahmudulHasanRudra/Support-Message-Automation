/**
 * Pure, DB-free logic for the knowledge base's non-conversational import sources — the same split
 * automationRuleImport.ts uses, and for the same reason: apps/web has no test runner of its own,
 * so anything worth testing has to live here. apps/web keeps the parts that genuinely can't
 * (reading the uploaded file via `xlsx`, fetching a URL, resolving DNS, the Prisma writes).
 *
 * Three unrelated things share this module rather than three files, because the owned-path
 * boundary for this change is this single file: spreadsheet row validation, HTML-to-text
 * extraction, and the URL safety guard.
 */

// ---------------------------------------------------------------------------
// Spreadsheet question/answer rows
// ---------------------------------------------------------------------------

/** Mirrors Prisma's AiKnowledgeCategory. Kept in sync by convention, like every other enum here. */
export const KNOWLEDGE_IMPORT_CATEGORIES = [
  "SOFTWARE",
  "WORKFLOW",
  "FAQ",
  "TROUBLESHOOTING",
  "CUSTOMER_RESPONSE",
  "SOP",
  "REQUIREMENT",
  "FEATURE",
  "POLICY",
  "ANNOUNCEMENT",
  "SCREENSHOT",
] as const;
export type KnowledgeImportCategory = (typeof KNOWLEDGE_IMPORT_CATEGORIES)[number];

/** A sheet with no Category column, or a blank one, is the common case — an FAQ export. */
const DEFAULT_CATEGORY: KnowledgeImportCategory = "FAQ";

/**
 * Lower than groupBroadcast's 2000-row ceiling on purpose. Every row here becomes an entry in the
 * review queue, and the AI importer already caps itself at 120 entries for exactly that reason —
 * a file nobody can review is a file that quietly never gets reviewed.
 */
export const MAX_KNOWLEDGE_IMPORT_ROWS = 500;
export const MAX_KNOWLEDGE_TITLE_LENGTH = 256;
export const MAX_KNOWLEDGE_ANSWER_LENGTH = 8000;
export const MAX_KNOWLEDGE_QUESTION_LENGTH = 1000;

export const KNOWLEDGE_ROW_COLUMN_LABELS = {
  question: "Question",
  answer: "Answer",
  title: "Title",
  category: "Category",
  module: "Module",
} as const;

type KnowledgeRowField = keyof typeof KNOWLEDGE_ROW_COLUMN_LABELS;

/** Question and Answer are the whole point of the file; everything else has a sensible default. */
const REQUIRED_KNOWLEDGE_COLUMNS: KnowledgeRowField[] = ["question", "answer"];

export interface KnowledgeImportRow {
  title: string;
  category: KnowledgeImportCategory;
  question: string;
  answer: string;
  module: string | null;
}

export type KnowledgeImportRowOutcome = "VALID" | "DUPLICATE_IN_FILE" | "INVALID";

export interface KnowledgeImportRowResult {
  /** 1-based and header-aware, so it matches the row number the operator sees in Excel. */
  rowNumber: number;
  row: KnowledgeImportRow | null;
  outcome: KnowledgeImportRowOutcome;
  /** Always populated — "Valid." for a clean row, otherwise the specific reason. */
  reason: string;
}

export interface KnowledgeImportParseResult {
  results: KnowledgeImportRowResult[];
  /** File-level problems (missing column, too many rows, empty file) — nothing was parsed. */
  fileErrors: string[];
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Case/whitespace-tolerant column lookup — same convention as automationRuleImport.ts. */
function resolveColumnKey(sampleRow: Record<string, unknown>, wanted: string): string | null {
  const target = normalizeHeader(wanted);
  for (const key of Object.keys(sampleRow)) {
    if (normalizeHeader(key) === target) return key;
  }
  return null;
}

function cellString(raw: Record<string, unknown>, key: string | null | undefined): string {
  if (!key) return "";
  return String(raw[key] ?? "").trim();
}

type ResolvedKeys = Partial<Record<KnowledgeRowField, string | null>>;

function resolveAllColumnKeys(sampleRow: Record<string, unknown>): ResolvedKeys {
  const keys: ResolvedKeys = {};
  for (const field of Object.keys(KNOWLEDGE_ROW_COLUMN_LABELS) as KnowledgeRowField[]) {
    keys[field] = resolveColumnKey(sampleRow, KNOWLEDGE_ROW_COLUMN_LABELS[field]);
  }
  return keys;
}

/** The Title column is optional: an FAQ sheet usually holds only the question and the answer. */
function deriveTitle(question: string): string {
  const trimmed = question.split("\n")[0]!.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_KNOWLEDGE_TITLE_LENGTH
    ? `${trimmed.slice(0, MAX_KNOWLEDGE_TITLE_LENGTH - 1)}\u2026`
    : trimmed;
}

function parseRow(raw: Record<string, unknown>, rowNumber: number, keys: ResolvedKeys): KnowledgeImportRowResult {
  const fail = (reason: string): KnowledgeImportRowResult => ({ rowNumber, row: null, outcome: "INVALID", reason });

  const question = cellString(raw, keys.question);
  const answer = cellString(raw, keys.answer);

  // A trailing blank row is what Excel leaves behind, not an operator mistake — say so plainly
  // rather than reporting two missing-field errors for a row nobody ever filled in.
  if (!question && !answer) return fail("Blank row — skipped.");
  if (!question) return fail(`Missing required field: ${KNOWLEDGE_ROW_COLUMN_LABELS.question}.`);
  if (!answer) return fail(`Missing required field: ${KNOWLEDGE_ROW_COLUMN_LABELS.answer}.`);
  if (question.length > MAX_KNOWLEDGE_QUESTION_LENGTH) {
    return fail(`Question exceeds ${MAX_KNOWLEDGE_QUESTION_LENGTH} characters.`);
  }
  if (answer.length > MAX_KNOWLEDGE_ANSWER_LENGTH) {
    return fail(`Answer exceeds ${MAX_KNOWLEDGE_ANSWER_LENGTH} characters — split it into several entries.`);
  }

  const categoryRaw = cellString(raw, keys.category);
  if (categoryRaw && !(KNOWLEDGE_IMPORT_CATEGORIES as readonly string[]).includes(categoryRaw.toUpperCase())) {
    return fail(`Invalid Category "${categoryRaw}" — must be one of: ${KNOWLEDGE_IMPORT_CATEGORIES.join(", ")}.`);
  }

  const titleRaw = cellString(raw, keys.title);
  if (titleRaw.length > MAX_KNOWLEDGE_TITLE_LENGTH) {
    return fail(`Title exceeds ${MAX_KNOWLEDGE_TITLE_LENGTH} characters.`);
  }

  return {
    rowNumber,
    outcome: "VALID",
    reason: "Valid.",
    row: {
      title: titleRaw || deriveTitle(question),
      category: categoryRaw ? (categoryRaw.toUpperCase() as KnowledgeImportCategory) : DEFAULT_CATEGORY,
      question,
      answer,
      module: cellString(raw, keys.module) || null,
    },
  };
}

/**
 * Validates every row structurally and flags in-file duplicate titles. Nothing here touches the
 * database — apps/web adds the one check that needs it (duplicate against existing entries).
 *
 * No AI call is involved anywhere in this path, deliberately: the rows are already the answers,
 * so spending a model call to "extract" a question and an answer out of a Question column and an
 * Answer column would be pure waste, and would put a hallucination between what the operator
 * wrote and what gets stored.
 */
export function parseKnowledgeImportRows(rawRows: Array<Record<string, unknown>>): KnowledgeImportParseResult {
  if (rawRows.length === 0) {
    return { results: [], fileErrors: ["The file has no data rows."] };
  }
  if (rawRows.length > MAX_KNOWLEDGE_IMPORT_ROWS) {
    return {
      results: [],
      fileErrors: [
        `The file has ${rawRows.length} rows, which exceeds the maximum of ${MAX_KNOWLEDGE_IMPORT_ROWS}. Every row becomes an entry waiting for review — split the file so each import stays reviewable.`,
      ],
    };
  }

  const keys = resolveAllColumnKeys(rawRows[0]!);
  const missing = REQUIRED_KNOWLEDGE_COLUMNS.filter((field) => !keys[field]).map(
    (field) => KNOWLEDGE_ROW_COLUMN_LABELS[field],
  );
  if (missing.length > 0) {
    return { results: [], fileErrors: [`Missing required column(s): ${missing.join(", ")}.`] };
  }

  const seenTitles = new Set<string>();
  const results: KnowledgeImportRowResult[] = rawRows.map((raw, index) => {
    const parsed = parseRow(raw, index + 2, keys); // +1 for 1-based, +1 for the header row
    if (parsed.outcome !== "VALID" || !parsed.row) return parsed;

    const normalized = parsed.row.title.trim().toLowerCase();
    if (seenTitles.has(normalized)) {
      return {
        ...parsed,
        outcome: "DUPLICATE_IN_FILE",
        reason: `"${parsed.row.title}" appears more than once in this file — only the first occurrence will be created.`,
      };
    }
    seenTitles.add(normalized);
    return parsed;
  });

  return { results, fileErrors: [] };
}

/**
 * The downloadable template. Generated from the real column labels and enum values on every
 * request rather than shipped as a static asset that could drift — the same decision
 * buildRuleImportTemplateRows() documents. XLSX.utils.json_to_sheet derives the header row from
 * these objects' own keys, so no separate header row is built here.
 */
export function buildKnowledgeImportTemplateRows(): Array<Record<string, string>> {
  const label = KNOWLEDGE_ROW_COLUMN_LABELS;
  return [
    {
      [label.question]: "How do I reset a customer's PPPoE password?",
      [label.answer]:
        "Open the customer in Subscriber Management, choose Credentials, then Reset Password. The new password is shown once and is also sent to the registered number.",
      [label.title]: "Reset a PPPoE password",
      [label.category]: "SOP",
      [label.module]: "Subscriber Management",
    },
    {
      [label.question]: "What are the support office hours?",
      [label.answer]:
        "Support is staffed 9am to 10pm, seven days a week. Outside those hours only P1 outages are handled.",
      [label.title]: "",
      [label.category]: "FAQ",
      [label.module]: "",
    },
  ];
}

// ---------------------------------------------------------------------------
// HTML to readable text
// ---------------------------------------------------------------------------

/** Blocks that never carry the page's substance and reliably pollute it if left in. */
const DROPPED_BLOCKS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

function unescapeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match: string, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // A code point outside the valid range is a malformed entity, not text — leave it as it was
      // rather than throwing out of String.fromCodePoint.
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Turns a fetched HTML page into the text an operator would otherwise have copied out by hand.
 *
 * Deliberately regex-based rather than a DOM/readability dependency: this has exactly one caller,
 * the worst failure is noisier text for the model to read, and everything downstream already
 * assumes the text is imperfect — an entry still has to be verified by a person before it can
 * answer anyone.
 *
 * Entities are unescaped only after every tag has been removed, so a `&lt;script&gt;` written as
 * visible text on the page can never be resurrected into a tag by this function.
 */
export function extractReadableText(html: string): string {
  let working = html.replace(/<!--[\s\S]*?-->/g, " ");

  for (const tag of DROPPED_BLOCKS) {
    working = working.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi"), " ");
    // A self-closing or unterminated instance still has to lose its opening tag.
    working = working.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), " ");
  }

  // Prefer the page's own idea of where its content is. A site that marks it up gives far cleaner
  // text than one where the whole body has to be taken.
  const main =
    /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(working) ?? /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(working);
  if (main?.[1] && main[1].trim().length > 0) working = main[1];

  working = working
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n\u2022 ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|blockquote|pre|td|th)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");

  working = unescapeEntities(working)
    // Non-breaking and other exotic spaces read as text but survive the whitespace collapse below.
    .replace(/[\u00a0\u2000-\u200b\ufeff]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // The <title> is the one piece of context outside the content that is always worth keeping —
  // it is what tells the model (and the reviewer) which product the page describes.
  const rawTitle = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? "";
  const heading = unescapeEntities(rawTitle.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  return heading && !working.startsWith(heading) ? `${heading}\n\n${working}`.trim() : working;
}

// ---------------------------------------------------------------------------
// URL safety (SSRF)
// ---------------------------------------------------------------------------

/** Generous enough for a slow docs site, short enough that a hung host cannot pin a request. */
export const IMPORT_FETCH_TIMEOUT_MS = 15_000;
/** A documentation page is tens of kilobytes; this only exists to stop an endless stream. */
export const IMPORT_FETCH_MAX_BYTES = 3 * 1024 * 1024;
/** Enough for the usual http→https and trailing-slash hops, few enough to bound the guard's work. */
export const IMPORT_FETCH_MAX_REDIRECTS = 4;

/** Host names meaning "this machine" or "this network" regardless of what DNS answers. */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const BLOCKED_HOST_NAMES = ["localhost", "metadata", "instance-data", "metadata.google.internal"];

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/**
 * True for any address a server-side fetch must never reach.
 *
 * This is the SSRF guard, and it is the whole reason URL import is safe to offer: the fetch is
 * made by the *server*, so without it anyone who can reach the import form could aim it at
 * 127.0.0.1, at the Postgres container on the internal Docker network, or at a cloud provider's
 * 169.254.169.254 metadata endpoint — and read the response back as "knowledge".
 *
 * Fails closed. An address this function cannot positively identify as public is blocked, because
 * a wrongly-refused import costs a copy-paste and a wrongly-allowed one costs credentials.
 */
export function isBlockedImportAddress(address: string): boolean {
  const host = address.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return true;

  const v4 = parseIpv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return true; // 0.0.0.0/8 — "this host"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, including the 169.254.169.254 metadata IP
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 192 && b === 0) return true; // protocol assignments + documentation range
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }

  if (host.includes(":")) {
    // IPv4-mapped and NAT64-embedded forms carry a v4 address inside a v6 literal; judge them by
    // the address they actually reach, or ::ffff:127.0.0.1 would sail straight through.
    const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    if (embedded) return isBlockedImportAddress(embedded[1]!);
    if (host === "::" || host === "::1") return true;
    if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local
    if (/^ff/.test(host)) return true; // multicast
    if (/^64:ff9b:/.test(host)) return true; // NAT64
    if (/^2002:/.test(host) || /^2001:0*:/.test(host)) return true; // 6to4 / Teredo tunnels
    // Anything that is not a well-formed v6 literal at this point is unrecognised, so blocked.
    return !/^[0-9a-f:]+$/.test(host);
  }

  // Not an IP literal at all. The caller resolves the name and re-checks every address it gets.
  return false;
}

export type ImportUrlCheck = { ok: true; url: string } | { ok: false; error: string };

const PRIVATE_NETWORK_REFUSAL =
  "That address points at a private or internal network, which cannot be imported from. Only public web pages can be fetched.";

/**
 * The structural half of the URL guard: scheme, embedded credentials, and any address written as
 * a literal. The caller must still resolve the host name and run every resulting address through
 * isBlockedImportAddress() — a public name is free to point at 127.0.0.1, and a redirect is free
 * to point somewhere else again, so this check alone is not sufficient.
 */
export function validateImportUrl(raw: string): ImportUrlCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Enter the address of the page to import." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "That is not a valid web address. Include the https:// prefix." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      error: `Only http and https addresses can be imported — "${parsed.protocol.replace(":", "")}" is not supported. Paste the text instead.`,
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: "Remove the username and password from the address — this import cannot sign in to a page.",
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, error: "That address has no host name." };
  if (BLOCKED_HOST_NAMES.includes(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, error: PRIVATE_NETWORK_REFUSAL };
  }
  // A bare number is a legal but obfuscated way to write an IP — http://2130706433/ is 127.0.0.1,
  // and Node's resolver honours it. Nothing legitimate is ever imported from one.
  if (/^\d+$/.test(host)) return { ok: false, error: PRIVATE_NETWORK_REFUSAL };
  if (isBlockedImportAddress(host)) return { ok: false, error: PRIVATE_NETWORK_REFUSAL };

  return { ok: true, url: parsed.toString() };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface KnowledgeExportInput {
  title: string;
  category: string;
  question: string | null;
  answer: string;
  procedure: string | null;
  module: string | null;
  software: string | null;
  softwareVersion: string | null;
  status: string;
  humanVerified: boolean;
  source: string;
  sourceLabel: string | null;
  sourceUrl: string | null;
  confidence: number | null;
  currentVersion: number;
  updatedAt: Date;
}

/**
 * One exported knowledge entry, as a flat row.
 *
 * The four importable columns come first and are spelled exactly as the import template spells
 * them, so an export can be edited in Excel and fed straight back in — which is the point of
 * having an export at all. Everything after them is provenance the importer ignores: it exists so
 * the file is a real record of the knowledge base rather than a lossy copy of it.
 *
 * The caller runs each row through sanitizeExcelRow(); every column here is free text an operator
 * or a model wrote, which is exactly the material formula injection needs.
 */
export function buildKnowledgeExportRow(item: KnowledgeExportInput): Record<string, string | number> {
  const label = KNOWLEDGE_ROW_COLUMN_LABELS;
  return {
    [label.question]: item.question ?? "",
    [label.answer]: item.answer,
    [label.title]: item.title,
    [label.category]: item.category,
    [label.module]: item.module ?? "",
    Procedure: item.procedure ?? "",
    Software: item.software ?? "",
    "Software Version": item.softwareVersion ?? "",
    Status: item.status,
    Verified: item.humanVerified ? "Yes" : "No",
    Source: item.source,
    "Source Label": item.sourceLabel ?? "",
    "Source URL": item.sourceUrl ?? "",
    Confidence: item.confidence ?? "",
    Version: item.currentVersion,
    "Last Modified": item.updatedAt.toISOString(),
  };
}
