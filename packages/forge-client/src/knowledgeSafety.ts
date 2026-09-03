/**
 * The disclosure gate for anything learned from the ISPDIGITAL repository.
 *
 * The requirement this implements is a hard line, in the user's words: the assistant may act as a
 * user guide, and must never expose code, database design, or anything else that could harm the
 * project. The prompts ask the model for that. This file does not trust the model to comply.
 *
 * Why a second, mechanical layer:
 *
 * - The material genuinely contains what must not escape. The repository's own hand-written
 *   Monthly Billing manual — a document written FOR customers — compares `BillMaster` against
 *   `MonthlyInvoice` in a table. A model faithfully summarising an authoritative document will
 *   reproduce internal names, and it will be right to, because it was told to preserve the
 *   document. Only a separate check can catch that.
 * - A prompt is a request. A regex is a guarantee. The asymmetry of consequences — a dropped
 *   entry costs one unanswered question, a leaked one hands a customer the schema — makes the
 *   trade obvious.
 *
 * Everything here is a pure function over a string so it can be unit tested exhaustively without
 * a database, a network, or a model.
 */

export interface SafetyVerdict {
  safe: boolean;
  /** Machine-readable rule ids that fired, for the reviewer UI and for logs. */
  violations: string[];
}

interface Rule {
  id: string;
  pattern?: RegExp;
  /** For rules that need more than a match — see `internal-identifier`. */
  test?: (text: string) => boolean;
}

/**
 * Compound capitalised words are how .NET names its types, so `CustomerBillMaster`,
 * `MonthlyInvoice` and `BillPeriod` are all internal identifiers leaking into an answer. They are
 * also, unfortunately, how the world names products — `MikroTik`, `WhatsApp`, `BanglaQR` — and
 * blocking those would gut legitimate answers.
 *
 * So the rule is "any compound capitalised word that is not a name a customer would already
 * know". The allowlist is the small, reviewable half; everything else is refused.
 *
 * This exists because the first live run leaked. The unit tests passed, and then the real
 * ISPDIGITAL manual produced "this will create a CustomerBillMaster for each customer" and
 * "the key terms are BillPeriod, MonthlyInvoice and CustomerCredit" — both stored, both
 * auto-verified, both one retrieval away from a customer.
 */
const KNOWN_PUBLIC_NAMES = new Set(
  [
    // The product and its vendors — names customers see in the UI and on invoices.
    "ISPDigital", "SoftifyBD", "MikroTik", "Mikrotik", "RouterOS", "WinBox",
    "WhatsApp", "BanglaQR", "BKash", "Nagad", "Rocket", "SSLCommerz", "PayPal",
    "FreeRADIUS", "PPPoE", "IPTV", "OpenVPN",
    // Ordinary English that happens to be written this way.
    "JavaScript", "PDF", "ID",
  ].map((name) => name.toLowerCase()),
);

const COMPOUND_IDENTIFIER = /\b[A-Z][a-z]+(?:[A-Z][a-z]*)+\b/g;

function containsInternalIdentifier(text: string): boolean {
  for (const match of text.matchAll(COMPOUND_IDENTIFIER)) {
    if (!KNOWN_PUBLIC_NAMES.has(match[0].toLowerCase())) return true;
  }
  return false;
}

/**
 * Ordered roughly by how damaging a leak would be. Each is deliberately narrow: a rule that fires
 * on ordinary support English would train reviewers to ignore this system, which is worse than
 * having no rule.
 */
const RULES: Rule[] = [
  // --- Credentials and access. Nothing in this class is ever acceptable in a customer answer.
  { id: "connection-string", pattern: /\b(Server|Data\s+Source|Initial\s+Catalog|User\s+Id|Password)\s*=/i },
  { id: "credential-literal", pattern: /\b(api[_-]?key|secret|passwd|password|bearer|authorization)\b\s*[:=]\s*\S/i },
  { id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  // A bare internal host or IP tells an attacker where to aim. Public documentation URLs are fine,
  // so this targets private ranges and port-suffixed hosts rather than every address.
  // Each private range is spelled out in full: they do not have the same number of fixed leading
  // octets, so a shared "prefix + three octets" shape silently matches none of them.
  {
    id: "private-address",
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },

  // --- Database design.
  { id: "sql-statement", pattern: /\b(SELECT\s+[\s\S]{0,80}?\sFROM\s|INSERT\s+INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s|CREATE\s+(TABLE|INDEX|PROCEDURE)|ALTER\s+TABLE\s|DROP\s+TABLE\s|INNER\s+JOIN\s|LEFT\s+JOIN\s)/i },
  { id: "schema-vocabulary", pattern: /\b(foreign\s+key|primary\s+key|database\s+(table|schema|column)|(table|column)\s+name[ds]?\b|stored\s+procedure|db\s+schema)\b/i },
  // "the BillMaster table", "in tbl_customer" — naming a physical table at all.
  { id: "table-reference", pattern: /\b(?:tbl|tb)_[A-Za-z]\w*|\b[A-Z][A-Za-z0-9]*(?:Master|Detail|Mapping|Log)\b\s+table\b|\btable\s+(?:named\s+)?[`"']?[A-Z][A-Za-z0-9]*(?:Master|Detail|Mapping)\b/ },

  // --- Source code and repository internals.
  { id: "code-fence", pattern: /```|~~~/ },
  { id: "code-syntax", pattern: /\b(public|private|protected|internal)\s+(static\s+)?(class|async|void|string|int|bool|Task|IActionResult)\b|\bnamespace\s+[A-Z]\w*(\.\w+)+|=>\s*\{|\bvar\s+\w+\s*=\s*new\s+/ },
  { id: "source-path", pattern: /\.(cs|cshtml|csproj|sln|razor|ts|tsx|js|jsx|sql|config|json|ya?ml)\b|\/(Controllers|Services|Repository|Repositories|Models|Entities|Migrations)\//i },
  { id: "dotnet-type", pattern: /\b\w+(Controller|Repository|DbContext|ViewModel|Dto|Entity)\b/ },
  // Catches the internal record and type names the other rules miss — see KNOWN_PUBLIC_NAMES.
  { id: "internal-identifier", test: containsInternalIdentifier },
  { id: "stack-trace", pattern: /\bat\s+[A-Z]\w*(\.\w+)+\s*\(|System\.(Exception|NullReference|InvalidOperation)/ },

  // --- Internal endpoints and infrastructure.
  { id: "internal-endpoint", pattern: /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[a-z0-9/{}_-]+/i },
  { id: "infrastructure", pattern: /\b(hangfire|rabbitmq|freeradius|gitlab|docker|kubernetes|redis|nginx)\b/i },
];

/**
 * Judges one piece of would-be customer-facing text.
 *
 * Note this runs over the *generated entry*, not over the source material. Source code is expected
 * to look like source code; the question is only ever whether what came out the other side is
 * safe to say to a customer.
 */
export function checkKnowledgeSafety(text: string): SafetyVerdict {
  if (!text) return { safe: true, violations: [] };
  const violations = RULES.filter((rule) =>
    rule.test ? rule.test(text) : rule.pattern!.test(text),
  ).map((rule) => rule.id);
  return { safe: violations.length === 0, violations };
}

/** Convenience for the common case of checking a title/question/answer triple as one unit. */
export function checkKnowledgeEntrySafety(entry: {
  title?: string | null;
  question?: string | null;
  answer?: string | null;
}): SafetyVerdict {
  return checkKnowledgeSafety([entry.title, entry.question, entry.answer].filter(Boolean).join("\n"));
}

/**
 * Plain-language explanation for the review UI. The reviewer is a support lead, not the person who
 * wrote these rules, so "schema-vocabulary" on its own would be a dead end.
 */
export function describeViolation(id: string): string {
  const descriptions: Record<string, string> = {
    "connection-string": "Looks like a database connection string.",
    "credential-literal": "Contains something shaped like a password, key or token.",
    "private-key": "Contains a private key block.",
    jwt: "Contains what looks like an access token.",
    "private-address": "Names an internal IP address.",
    "sql-statement": "Contains a SQL statement.",
    "schema-vocabulary": "Describes the database design in so many words.",
    "table-reference": "Names a database table.",
    "code-fence": "Contains a code block.",
    "code-syntax": "Contains source code.",
    "source-path": "Names a source file or code directory.",
    "dotnet-type": "Names an internal class such as a controller or repository.",
    "stack-trace": "Contains a stack trace or exception type.",
    "internal-endpoint": "Names an internal API endpoint.",
    infrastructure: "Names internal infrastructure the customer should not know about.",
    "internal-identifier": "Names an internal record or type, such as CustomerBillMaster.",
  };
  return descriptions[id] ?? "Contains information that should not reach a customer.";
}
