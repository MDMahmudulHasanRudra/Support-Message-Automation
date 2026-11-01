/**
 * Invoice and money-receipt documents (CLIENT_CRM_V7.md §3). Pure rules shared by the setup page, the
 * document builders, the HTML/print view, the PDF and the tests.
 *
 *   - A document is a VIEW of financial records that already exist (`ClientDue`, `ClientPayment`). Every
 *     figure on it is computed once, by the same functions the Billing List uses; the HTML and PDF renderers
 *     only lay those strings out and never do arithmetic.
 *   - Branding is versioned. Every save of the Invoice & Receipt setup is a new, never-changed version, and a
 *     document is always drawn with the version that was in force when it was issued (an invoice's creation,
 *     a payment's recording). Changing the logo tomorrow does not change an invoice issued today.
 *   - No tax engine exists, so a document never shows a tax figure it did not record. The business's tax /
 *     VAT registration number may be printed as a fact about the business, nothing more.
 */

export const DOCUMENT_PAPER_SIZES = ["A4", "LETTER"] as const;
export type DocumentPaperSize = (typeof DOCUMENT_PAPER_SIZES)[number];

export const DOCUMENT_LIMITS = {
  businessName: 120,
  line: 200,
  address: 400,
  title: 40,
  paymentInstructions: 1000,
  terms: 2000,
  footer: 300,
  signatureName: 80,
  signatureTitle: 80,
  taxLabel: 40,
  taxNumber: 60,
} as const;

/** Images are stored in the database, so they stay small. PNG and JPEG only: what both a browser and a PDF can draw. */
export const DOCUMENT_IMAGE_MAX_BYTES = 256 * 1024;
export const DOCUMENT_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;
export type DocumentImageType = (typeof DOCUMENT_IMAGE_TYPES)[number];

export interface DocumentSettingsValue {
  businessName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  taxLabel: string | null;
  taxNumber: string | null;
  invoiceTitle: string;
  receiptTitle: string;
  paymentInstructions: string | null;
  terms: string | null;
  footer: string | null;
  signatureName: string | null;
  signatureTitle: string | null;
  accentColor: string;
  paperSize: DocumentPaperSize;
  /** SHA-256 of a `ClientDocumentAsset`, or null. */
  logoSha256: string | null;
  signatureSha256: string | null;
}

export const DEFAULT_ACCENT_COLOR = "#1F3A5F";

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettingsValue = {
  businessName: null,
  address: null,
  phone: null,
  email: null,
  website: null,
  taxLabel: null,
  taxNumber: null,
  invoiceTitle: "Invoice",
  receiptTitle: "Money Receipt",
  paymentInstructions: null,
  terms: null,
  footer: null,
  signatureName: null,
  signatureTitle: null,
  accentColor: DEFAULT_ACCENT_COLOR,
  paperSize: "A4",
  logoSha256: null,
  signatureSha256: null,
};

export type DocumentSettingsInput = Partial<Record<Exclude<keyof DocumentSettingsValue, "logoSha256" | "signatureSha256">, string>>;

/** One version of the setup, as typed. Everything is optional except that what is typed must fit and be well-formed. */
export function validateDocumentSettings(input: DocumentSettingsInput, keep: Pick<DocumentSettingsValue, "logoSha256" | "signatureSha256">): { ok: true; value: DocumentSettingsValue } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const text = (key: keyof DocumentSettingsInput, max: number, label: string, multiline = false): string | null => {
    const raw = (input[key] ?? "").replace(/\r\n/g, "\n");
    const value = (multiline ? raw : raw.replace(/\s+/g, " ")).trim();
    if (value.length > max) errors.push(`${label} can be at most ${max} characters.`);
    return value || null;
  };
  const businessName = text("businessName", DOCUMENT_LIMITS.businessName, "The business name");
  const address = text("address", DOCUMENT_LIMITS.address, "The address", true);
  const phone = text("phone", DOCUMENT_LIMITS.line, "The phone number");
  const email = text("email", DOCUMENT_LIMITS.line, "The email address");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("The email address does not look like an email address.");
  const website = text("website", DOCUMENT_LIMITS.line, "The website");
  if (website && /[<>"'\s]/.test(website)) errors.push("The website cannot contain spaces or quotes.");
  const taxLabel = text("taxLabel", DOCUMENT_LIMITS.taxLabel, "The tax label");
  const taxNumber = text("taxNumber", DOCUMENT_LIMITS.taxNumber, "The tax number");
  if (taxNumber && !taxLabel) errors.push("Say what the tax number is (for example VAT Reg. No. or BIN).");
  const invoiceTitle = text("invoiceTitle", DOCUMENT_LIMITS.title, "The invoice title") ?? DEFAULT_DOCUMENT_SETTINGS.invoiceTitle;
  const receiptTitle = text("receiptTitle", DOCUMENT_LIMITS.title, "The receipt title") ?? DEFAULT_DOCUMENT_SETTINGS.receiptTitle;
  const paymentInstructions = text("paymentInstructions", DOCUMENT_LIMITS.paymentInstructions, "The payment instructions", true);
  const terms = text("terms", DOCUMENT_LIMITS.terms, "The terms", true);
  const footer = text("footer", DOCUMENT_LIMITS.footer, "The footer", true);
  const signatureName = text("signatureName", DOCUMENT_LIMITS.signatureName, "The signatory's name");
  const signatureTitle = text("signatureTitle", DOCUMENT_LIMITS.signatureTitle, "The signatory's title");
  const accent = (input.accentColor ?? "").trim() || DEFAULT_ACCENT_COLOR;
  if (!/^#[0-9A-Fa-f]{6}$/.test(accent)) errors.push("The brand colour must be a hex colour such as #1F3A5F.");
  const paper = (input.paperSize ?? "").trim() || "A4";
  if (!(DOCUMENT_PAPER_SIZES as readonly string[]).includes(paper)) errors.push("Choose A4 or Letter.");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      businessName,
      address,
      phone,
      email,
      website,
      taxLabel,
      taxNumber,
      invoiceTitle,
      receiptTitle,
      paymentInstructions,
      terms,
      footer,
      signatureName,
      signatureTitle,
      accentColor: accent.toUpperCase(),
      paperSize: paper as DocumentPaperSize,
      logoSha256: keep.logoSha256,
      signatureSha256: keep.signatureSha256,
    },
  };
}

/** A stored version's JSON read back safely: unknown or missing fields fall back to the defaults. */
export function readDocumentSettings(data: unknown): DocumentSettingsValue {
  const raw = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const s = (k: keyof DocumentSettingsValue) => (typeof raw[k] === "string" && (raw[k] as string).trim() ? (raw[k] as string) : null);
  return {
    ...DEFAULT_DOCUMENT_SETTINGS,
    businessName: s("businessName"),
    address: s("address"),
    phone: s("phone"),
    email: s("email"),
    website: s("website"),
    taxLabel: s("taxLabel"),
    taxNumber: s("taxNumber"),
    invoiceTitle: s("invoiceTitle") ?? DEFAULT_DOCUMENT_SETTINGS.invoiceTitle,
    receiptTitle: s("receiptTitle") ?? DEFAULT_DOCUMENT_SETTINGS.receiptTitle,
    paymentInstructions: s("paymentInstructions"),
    terms: s("terms"),
    footer: s("footer"),
    signatureName: s("signatureName"),
    signatureTitle: s("signatureTitle"),
    accentColor: /^#[0-9A-F]{6}$/i.test(String(raw.accentColor ?? "")) ? String(raw.accentColor).toUpperCase() : DEFAULT_ACCENT_COLOR,
    paperSize: raw.paperSize === "LETTER" ? "LETTER" : "A4",
    logoSha256: typeof raw.logoSha256 === "string" && /^[0-9a-f]{64}$/.test(raw.logoSha256) ? raw.logoSha256 : null,
    signatureSha256: typeof raw.signatureSha256 === "string" && /^[0-9a-f]{64}$/.test(raw.signatureSha256) ? raw.signatureSha256 : null,
  };
}

/**
 * Which setup version draws a document issued at `issuedAt`: the newest version saved at or before that moment.
 * A document issued before any setup existed is drawn with the FIRST version ever saved — fixed from then on,
 * so it never moves with later edits. No versions at all → null (the built-in defaults).
 */
export function effectiveSettingsVersion<T extends { version: number; createdAt: Date }>(versions: readonly T[], issuedAt: Date): T | null {
  if (versions.length === 0) return null;
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  let chosen: T | null = null;
  for (const v of sorted) if (v.createdAt.getTime() <= issuedAt.getTime()) chosen = v;
  return chosen ?? sorted[0]!;
}

/** The image type from its bytes (never from a file name or a browser's claim), or null. */
export function sniffDocumentImage(bytes: Uint8Array): DocumentImageType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

// ── What a PDF built with the standard fonts can draw ─────────────────────────────────────────────

// Windows-1252's printable characters beyond Latin-1: what the PDF standard fonts (WinAnsiEncoding) can encode.
const CP1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** True when every character can be drawn by the PDF's standard fonts (Latin script). */
export function isPdfStandardText(text: string): boolean {
  for (const ch of text) {
    if (ch === "\n" || ch === "\t") continue;
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRA.has(ch)) continue;
    return false;
  }
  return true;
}

/** Typographic characters a person or a phone keyboard often types, mapped to what the standard fonts hold. */
export function toPdfStandardText(text: string): string {
  return text
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/−/g, "-")
    .replace(/ | | /g, " ")
    .replace(/[​-‍﻿]/g, "");
}

/** A download file name that is safe on every system: "Invoice-INV-000123.pdf". */
export function documentFileName(kind: "INVOICE" | "RECEIPT", number: string | null, id: string): string {
  const label = kind === "INVOICE" ? "Invoice" : "Receipt";
  const safe = (number ?? id).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || id.slice(0, 12);
  return `${label}-${safe}.pdf`;
}

// ── The document models (built on the server, laid out by the renderers) ─────────────────────────

export interface DocumentParty {
  name: string;
  company: string | null;
  code: string;
  address: string | null;
  phone: string | null;
  email: string | null;
}

export interface DocumentBrandingView extends DocumentSettingsValue {
  /** The business name to print: the setup's, else the project's. */
  displayName: string;
  version: number | null;
}

export interface InvoiceDocumentModel {
  kind: "INVOICE";
  id: string;
  number: string;
  statusLabel: string;
  /** PAID / PART_PAID / OVERDUE / OPEN / WAIVED / CANCELLED / NO_AMOUNT — the Billing List's own state. */
  state: string;
  issuedDate: string;
  dueDate: string;
  client: DocumentParty;
  lines: Array<{ description: string; detail: string | null; amount: string }>;
  currency: string | null;
  /** Formatted with the currency's own decimals, e.g. "BDT 1,500.00"; "—" when the invoice has no amount. */
  total: string;
  paid: string;
  remaining: string;
  payments: Array<{ receiptNumber: string; date: string; amount: string }>;
  note: string | null;
  soldBy: string | null;
}

export interface ReceiptDocumentModel {
  kind: "RECEIPT";
  id: string;
  number: string;
  receivedDate: string;
  client: DocumentParty;
  currency: string;
  amount: string;
  /** The amount in words is not printed: no tested speller exists for every currency and language. */
  method: string;
  reference: string | null;
  invoices: Array<{ number: string; amount: string }>;
  note: string | null;
  recordedBy: string | null;
  reversed: { at: string; reason: string | null } | null;
}

/** Every piece of text a document will draw, for the standard-font check. */
export function documentTexts(branding: DocumentBrandingView, doc: InvoiceDocumentModel | ReceiptDocumentModel): string[] {
  const b = [branding.displayName, branding.address, branding.phone, branding.email, branding.website, branding.taxLabel, branding.taxNumber, branding.paymentInstructions, branding.terms, branding.footer, branding.signatureName, branding.signatureTitle, branding.invoiceTitle, branding.receiptTitle];
  const party = [doc.client.name, doc.client.company, doc.client.code, doc.client.address, doc.client.phone, doc.client.email];
  const rest =
    doc.kind === "INVOICE"
      ? [doc.number, doc.note, doc.soldBy, ...doc.lines.flatMap((l) => [l.description, l.detail]), ...doc.payments.map((p) => p.receiptNumber)]
      : [doc.number, doc.reference, doc.note, doc.recordedBy, doc.method, doc.reversed?.reason ?? null, ...doc.invoices.map((i) => i.number)];
  return [...b, ...party, ...rest].filter((t): t is string => Boolean(t));
}
