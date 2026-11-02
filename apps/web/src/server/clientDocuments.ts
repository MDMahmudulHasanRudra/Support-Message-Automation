import {
  CLIENT_STATUS_LABELS,
  decimalToMinor,
  DEFAULT_DOCUMENT_SETTINGS,
  dhakaToday,
  DUE_KIND_LABELS,
  documentTexts,
  effectiveSettingsVersion,
  formatMinor,
  INVOICE_STATE_LABELS,
  invoiceState,
  isDueKind,
  isPdfStandardText,
  PAYMENT_METHOD_LABELS,
  readDocumentSettings,
  remainingOn,
  type DocumentBrandingView,
  type DocumentParty,
  type DocumentSettingsValue,
  type InvoiceDocumentModel,
  type PaymentMethod,
  type ReceiptDocumentModel,
} from "@support-automation/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { requireActiveProject } from "@/server/projectContext";

/**
 * Invoice and receipt documents (CLIENT_CRM_V7.md §3). READS only — not a "use server" file, nothing here is an
 * endpoint, and every caller has already checked `clients.view_billing`. Everything goes through the
 * project-scoped client, so another project's invoice, payment or setup is simply not found.
 *
 * The figures are computed here ONCE, with the Billing List's own functions (`remainingOn`, `invoiceState`,
 * `formatMinor`), and handed to the renderers as strings. Neither the HTML view nor the PDF does arithmetic.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-15" → "15 Oct 2026": unambiguous in every country a client may be in. */
export function documentDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

export interface DocumentSettingsRecord {
  version: number;
  createdAt: Date;
  createdByName: string | null;
  value: DocumentSettingsValue;
}

/** Every saved version of the setup, newest first (the setup page's history). */
export async function listDocumentSettingsVersions(limit = 20): Promise<DocumentSettingsRecord[]> {
  const rows = await prisma.clientDocumentSettingsVersion.findMany({ orderBy: { version: "desc" }, take: limit, select: { version: true, createdAt: true, createdByName: true, data: true } });
  return rows.map((r) => ({ version: r.version, createdAt: r.createdAt, createdByName: r.createdByName, value: readDocumentSettings(r.data) }));
}

/** The setup in force now: the newest version, or the built-in defaults when nobody has saved one. */
export async function currentDocumentSettings(): Promise<{ version: number | null; value: DocumentSettingsValue }> {
  const row = await prisma.clientDocumentSettingsVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true, data: true } });
  return row ? { version: row.version, value: readDocumentSettings(row.data) } : { version: null, value: DEFAULT_DOCUMENT_SETTINGS };
}

export interface DocumentImage {
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

async function loadAsset(sha256: string | null): Promise<DocumentImage | null> {
  if (!sha256) return null;
  const row = await prisma.clientDocumentAsset.findFirst({ where: { sha256 }, select: { mimeType: true, bytes: true } });
  if (!row || (row.mimeType !== "image/png" && row.mimeType !== "image/jpeg")) return null;
  return { mimeType: row.mimeType, bytes: new Uint8Array(row.bytes) };
}

export interface DocumentBranding {
  view: DocumentBrandingView;
  logo: DocumentImage | null;
  signature: DocumentImage | null;
}

/**
 * The branding a document issued at `issuedAt` is drawn with: the setup version in force then
 * (`effectiveSettingsVersion`), its own logo and signature by hash. A later edit of the setup never reaches it.
 */
export async function brandingFor(issuedAt: Date): Promise<DocumentBranding> {
  const [versions, project] = await Promise.all([
    prisma.clientDocumentSettingsVersion.findMany({ select: { version: true, createdAt: true, data: true }, orderBy: { version: "asc" } }),
    requireActiveProject(),
  ]);
  const chosen = effectiveSettingsVersion(versions, issuedAt);
  const value = chosen ? readDocumentSettings(chosen.data) : DEFAULT_DOCUMENT_SETTINGS;
  const [logo, signature] = await Promise.all([loadAsset(value.logoSha256), loadAsset(value.signatureSha256)]);
  return { view: { ...value, displayName: value.businessName ?? project.name, version: chosen?.version ?? null }, logo, signature };
}

/** A preview of the setup as typed (the setup page), with the CURRENT images unless new ones are given. */
export async function brandingPreview(value: DocumentSettingsValue): Promise<DocumentBranding> {
  const project = await requireActiveProject();
  const [logo, signature] = await Promise.all([loadAsset(value.logoSha256), loadAsset(value.signatureSha256)]);
  return { view: { ...value, displayName: value.businessName ?? project.name, version: null }, logo, signature };
}

type ChannelRow = { kind: string; value: string; isPrimary: boolean };
function party(client: { name: string; companyName: string | null; code: string; address: string | null; channels: ChannelRow[] }): DocumentParty {
  const ordered = [...client.channels].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  return {
    name: client.name,
    company: client.companyName,
    code: client.code,
    address: client.address,
    phone: ordered.find((c) => c.kind === "PHONE" || c.kind === "WHATSAPP")?.value ?? null,
    email: ordered.find((c) => c.kind === "EMAIL")?.value ?? null,
  };
}

const CLIENT_FOR_DOCUMENT = Prisma.validator<Prisma.ClientDefaultArgs>()({
  select: {
    id: true,
    name: true,
    companyName: true,
    code: true,
    address: true,
    status: true,
    channels: { where: { kind: { in: ["PHONE", "WHATSAPP", "EMAIL"] } }, select: { kind: true, value: true, isPrimary: true }, orderBy: { createdAt: "asc" }, take: 10 },
  },
});

export interface InvoiceRecord {
  doc: InvoiceDocumentModel;
  issuedAt: Date;
  clientId: string;
  clientArchived: boolean;
  /** For the detail page: what the Billing List knows about this row. */
  status: string;
  amount: string | null;
  currency: string | null;
  remainingMinor: bigint | null;
  payable: boolean;
  internalNote: string | null;
  subscription: { id: string; service: string; startDate: string; endDate: string } | null;
  /** Every payment ever allocated to it, reversed ones included (the detail page shows them struck through). */
  allocations: Array<{ paymentId: string; receiptNumber: string; receivedDate: string; amount: string; method: string; reversed: boolean }>;
  /** The raw values the edit form starts from. */
  form: { dueDate: string; amount: string | null; currency: string | null; status: string; paidAmount: string | null; note: string | null };
}

/** One invoice as a document, plus what its detail page needs. Null when it is not in this project. */
export async function loadInvoice(dueId: string): Promise<InvoiceRecord | null> {
  const due = await prisma.clientDue.findFirst({
    where: { id: dueId },
    select: {
      id: true,
      invoiceNumber: true,
      kind: true,
      issuedDate: true,
      createdAt: true,
      service: true,
      dueDate: true,
      currency: true,
      amount: true,
      paidAmount: true,
      status: true,
      note: true,
      soldByMember: { select: { name: true } },
      subscription: { select: { id: true, service: true, startDate: true, endDate: true, soldByName: true } },
      client: CLIENT_FOR_DOCUMENT,
      allocations: {
        orderBy: { createdAt: "asc" },
        select: { amount: true, payment: { select: { id: true, receiptNumber: true, receivedDate: true, method: true, reversedAt: true } } },
      },
    },
  });
  if (!due) return null;
  const today = dhakaToday(new Date());
  const amount = decimalToMinor(due.amount);
  const paid = decimalToMinor(due.paidAmount) ?? BigInt(0);
  const remaining = amount === null ? null : remainingOn({ status: due.status, amount, paid });
  const state = invoiceState({ status: due.status, amount, paid, dueDate: day(due.dueDate) }, today);
  const cur = due.currency;
  const fmt = (minor: bigint | null) => (minor === null ? "—" : formatMinor(minor, cur));
  const kindLabel = due.kind && isDueKind(due.kind) ? DUE_KIND_LABELS[due.kind] : null;
  const service = due.service ?? due.subscription?.service ?? null;
  const period = due.subscription ? `Service period ${documentDay(day(due.subscription.startDate))} – ${documentDay(day(due.subscription.endDate))}` : null;
  const active = due.allocations.filter((a) => a.payment.reversedAt === null);
  const doc: InvoiceDocumentModel = {
    kind: "INVOICE",
    id: due.id,
    number: due.invoiceNumber ?? "Due record",
    statusLabel: INVOICE_STATE_LABELS[state],
    state,
    issuedDate: documentDay(day(due.issuedDate ?? due.createdAt)),
    dueDate: documentDay(day(due.dueDate)),
    client: party(due.client),
    lines: [{ description: service ?? kindLabel ?? "Amount due", detail: [kindLabel && service ? kindLabel : null, period].filter(Boolean).join(" · ") || null, amount: fmt(amount) }],
    currency: cur,
    total: fmt(amount),
    // What the Billing List calls "collected": never more than the invoice itself.
    paid: amount === null ? "—" : formatMinor(paid > amount ? amount : paid, cur),
    remaining: fmt(remaining),
    payments: active.map((a) => ({ receiptNumber: a.payment.receiptNumber, date: documentDay(day(a.payment.receivedDate)), amount: formatMinor(decimalToMinor(a.amount) ?? BigInt(0), cur) })),
    note: null,
    soldBy: due.soldByMember?.name ?? due.subscription?.soldByName ?? null,
  };
  return {
    doc,
    issuedAt: due.createdAt,
    clientId: due.client.id,
    clientArchived: due.client.status === "ARCHIVED",
    status: due.status,
    amount: due.amount?.toFixed(2) ?? null,
    currency: cur,
    remainingMinor: remaining,
    payable: amount !== null && cur !== null && remaining !== null && remaining > BigInt(0) && (due.status === "UNPAID" || due.status === "PARTIALLY_PAID") && due.client.status !== "ARCHIVED",
    internalNote: due.note,
    subscription: due.subscription ? { id: due.subscription.id, service: due.subscription.service, startDate: day(due.subscription.startDate), endDate: day(due.subscription.endDate) } : null,
    allocations: due.allocations.map((a) => ({
      paymentId: a.payment.id,
      receiptNumber: a.payment.receiptNumber,
      receivedDate: day(a.payment.receivedDate),
      amount: formatMinor(decimalToMinor(a.amount) ?? BigInt(0), cur),
      method: PAYMENT_METHOD_LABELS[a.payment.method as PaymentMethod] ?? a.payment.method,
      reversed: a.payment.reversedAt !== null,
    })),
    form: { dueDate: day(due.dueDate), amount: due.amount?.toFixed(2) ?? null, currency: cur, status: due.status, paidAmount: due.paidAmount?.toFixed(2) ?? null, note: due.note },
  };
}

export interface ReceiptRecord {
  doc: ReceiptDocumentModel;
  issuedAt: Date;
  clientId: string;
  clientStatus: string;
  recordedAt: Date;
  batchReference: string | null;
  internalNote: string | null;
  reversedBy: string | null;
  invoices: Array<{ dueId: string; number: string | null; amount: string }>;
}

/** One payment as a money receipt. Null when it is not in this project. */
export async function loadReceipt(paymentId: string): Promise<ReceiptRecord | null> {
  const p = await prisma.clientPayment.findFirst({
    where: { id: paymentId },
    select: {
      id: true,
      receiptNumber: true,
      currency: true,
      amount: true,
      method: true,
      reference: true,
      receivedDate: true,
      note: true,
      batchReference: true,
      recordedAt: true,
      reversedAt: true,
      reversalReason: true,
      recordedBy: { select: { name: true } },
      reversedBy: { select: { name: true } },
      client: CLIENT_FOR_DOCUMENT,
      allocations: { orderBy: { createdAt: "asc" }, select: { dueId: true, amount: true, due: { select: { invoiceNumber: true } } } },
    },
  });
  if (!p) return null;
  const cur = p.currency;
  const money = (d: { toFixed(n: number): string }) => formatMinor(decimalToMinor(d) ?? BigInt(0), cur);
  const doc: ReceiptDocumentModel = {
    kind: "RECEIPT",
    id: p.id,
    number: p.receiptNumber,
    receivedDate: documentDay(day(p.receivedDate)),
    client: party(p.client),
    currency: cur,
    amount: money(p.amount),
    method: PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
    reference: p.reference,
    invoices: p.allocations.map((a) => ({ number: a.due.invoiceNumber ?? "Older due", amount: money(a.amount) })),
    // The payment's note is staff's; a receipt does not print it.
    note: null,
    recordedBy: p.recordedBy?.name ?? null,
    reversed: p.reversedAt ? { at: documentDay(day(p.reversedAt)), reason: p.reversalReason } : null,
  };
  return {
    doc,
    issuedAt: p.recordedAt,
    clientId: p.client.id,
    clientStatus: CLIENT_STATUS_LABELS[p.client.status as keyof typeof CLIENT_STATUS_LABELS] ?? p.client.status,
    recordedAt: p.recordedAt,
    batchReference: p.batchReference,
    internalNote: p.note,
    reversedBy: p.reversedBy?.name ?? null,
    invoices: p.allocations.map((a) => ({ dueId: a.dueId, number: a.due.invoiceNumber, amount: money(a.amount) })),
  };
}

/** Whether the PDF (standard fonts) can draw every character; otherwise the print view is the way to a PDF. */
export function pdfCanDraw(branding: DocumentBranding, doc: InvoiceDocumentModel | ReceiptDocumentModel): boolean {
  return documentTexts(branding.view, doc).every(isPdfStandardText);
}
