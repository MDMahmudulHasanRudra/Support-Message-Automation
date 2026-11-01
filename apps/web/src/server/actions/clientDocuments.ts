"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  DOCUMENT_IMAGE_MAX_BYTES,
  sniffDocumentImage,
  validateDocumentSettings,
  type DocumentSettingsInput,
  type DocumentSettingsValue,
  type InvoiceDocumentModel,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { projectPath } from "@/server/projectPaths";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { logSystemEvent } from "@/server/logSystemEvent";
import { getClientModuleSettings } from "@/server/clientModule";
import { brandingPreview, currentDocumentSettings, loadInvoice } from "@/server/clientDocuments";
import { renderDocumentHtml } from "@/server/clientDocumentHtml";

/**
 * The Invoice & Receipt setup (CLIENT_CRM_V7.md §3). Saving writes a NEW version and never changes an old one, so a
 * document already issued keeps the look it was issued with. `clients.manage_settings`, like the rest of the Client
 * Module's settings. Images are type-sniffed from their bytes (PNG/JPEG only), capped at 256 KB and stored by their
 * SHA-256, so a version names exactly the image it was saved with.
 */

export interface DocumentSettingsFormState {
  error?: string;
  success?: string;
  values?: Record<string, string>;
}

const FIELDS: Array<keyof DocumentSettingsInput> = [
  "businessName",
  "address",
  "phone",
  "email",
  "website",
  "taxLabel",
  "taxNumber",
  "invoiceTitle",
  "receiptTitle",
  "paymentInstructions",
  "terms",
  "footer",
  "signatureName",
  "signatureTitle",
  "accentColor",
  "paperSize",
];

function readFields(form: FormData): DocumentSettingsInput {
  const out: DocumentSettingsInput = {};
  for (const k of FIELDS) out[k] = String(form.get(k) ?? "");
  return out;
}

function echo(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FIELDS) out[k] = String(form.get(k) ?? "").slice(0, 3000);
  return out;
}

/** An uploaded image as an asset hash; "keep" when none was chosen; an error sentence when it is not acceptable. */
async function storeImage(file: FormDataEntryValue | null, label: string): Promise<{ sha: string } | "keep" | { error: string }> {
  if (!file || typeof file === "string" || file.size === 0) return "keep";
  if (file.size > DOCUMENT_IMAGE_MAX_BYTES) return { error: `The ${label} is larger than 256 KB. Use a smaller PNG or JPEG.` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffDocumentImage(bytes);
  if (!type) return { error: `The ${label} must be a PNG or JPEG image.` };
  const sha = createHash("sha256").update(bytes).digest("hex");
  try {
    await prisma.clientDocumentAsset.create({ data: { sha256: sha, mimeType: type, bytes: Buffer.from(bytes), byteLength: bytes.byteLength } });
  } catch (err) {
    // The same image again: the stored one is identical by definition.
    if (!isUniqueViolation(err)) throw err;
  }
  return { sha };
}

export async function saveDocumentSettings(_prev: DocumentSettingsFormState, form: FormData): Promise<DocumentSettingsFormState> {
  const granted = await checkPermission("clients.manage_settings");
  if ("denied" in granted) return { error: granted.denied, values: echo(form) };
  const current = await currentDocumentSettings();
  const expected = Number(form.get("version") ?? 0) || null;
  if (expected !== current.version) return { error: "Someone saved the setup while you were editing it. Reload to see their version.", values: echo(form) };

  const [logo, signature] = await Promise.all([storeImage(form.get("logo"), "logo"), storeImage(form.get("signature"), "signature")]);
  if (typeof logo === "object" && "error" in logo) return { error: logo.error, values: echo(form) };
  if (typeof signature === "object" && "error" in signature) return { error: signature.error, values: echo(form) };
  const keep = {
    logoSha256: form.get("removeLogo") === "1" ? null : logo === "keep" ? current.value.logoSha256 : logo.sha,
    signatureSha256: form.get("removeSignature") === "1" ? null : signature === "keep" ? current.value.signatureSha256 : signature.sha,
  };
  const parsed = validateDocumentSettings(readFields(form), keep);
  if (!parsed.ok) return { error: parsed.errors.join(" "), values: echo(form) };
  const next = (current.version ?? 0) + 1;
  try {
    // The (project, version) unique key makes two simultaneous saves of the same version one success and one refusal.
    await prisma.clientDocumentSettingsVersion.create({ data: { version: next, data: parsed.value as object, createdById: granted.session.userId, createdByName: granted.session.name } });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "Someone saved the setup while you were editing it. Reload to see their version.", values: echo(form) };
    throw err;
  }
  await logSystemEvent("INFO", "clients", "Invoice & Receipt setup saved", { version: next }, { actorUserId: granted.session.userId, targetType: "ClientDocumentSettingsVersion", targetId: String(next) });
  revalidatePath(await projectPath("/settings/clients/documents"));
  return { success: `Saved as version ${next}. Invoices and receipts issued from now on use it; earlier ones keep the setup they were issued with.` };
}

const SAMPLE_INVOICE: InvoiceDocumentModel = {
  kind: "INVOICE",
  id: "sample",
  number: "INV-000123",
  statusLabel: "Part-paid",
  state: "PART_PAID",
  issuedDate: "1 Nov 2026",
  dueDate: "10 Nov 2026",
  client: { name: "Sample Client", company: "Sample Trading Ltd", code: "0042", address: "House 1, Road 2\nDhaka 1212", phone: "+880 1700-000000", email: "client@example.com" },
  lines: [{ description: "Internet 20 Mbps", detail: "Renewal · Service period 1 Nov 2026 – 1 Dec 2026", amount: "BDT 1,500.00" }],
  currency: "BDT",
  total: "BDT 1,500.00",
  paid: "BDT 1,000.00",
  remaining: "BDT 500.00",
  payments: [{ receiptNumber: "RCPT-000077", date: "2 Nov 2026", amount: "BDT 1,000.00" }],
  note: null,
  soldBy: null,
};

/**
 * The preview beside the setup form, as the person types: the newest REAL invoice of this project for someone who
 * may see billing, else a clearly fictional sample. Returns HTML for a sandboxed frame; writes nothing.
 */
export async function previewDocumentSettings(fields: Record<string, string>, images: { logoSha256: string | null; signatureSha256: string | null }): Promise<{ html: string } | { error: string }> {
  const granted = await checkPermission("clients.manage_settings");
  if ("denied" in granted) return { error: granted.denied };
  const current = await currentDocumentSettings();
  const keep = {
    logoSha256: images.logoSha256 === current.value.logoSha256 ? images.logoSha256 : null,
    signatureSha256: images.signatureSha256 === current.value.signatureSha256 ? images.signatureSha256 : null,
  };
  const input: DocumentSettingsInput = {};
  for (const k of FIELDS) input[k] = String(fields?.[k] ?? "").slice(0, 3000);
  const parsed = validateDocumentSettings(input, keep);
  const value: DocumentSettingsValue = parsed.ok ? parsed.value : current.value;
  let doc = SAMPLE_INVOICE;
  const [billingKey, settings] = await Promise.all([hasPermission(granted.session, "clients.view_billing"), getClientModuleSettings()]);
  if (billingKey && settings.billing) {
    const latest = await prisma.clientDue.findFirst({ where: { invoiceNumber: { not: null }, amount: { not: null } }, orderBy: { createdAt: "desc" }, select: { id: true } });
    const real = latest ? await loadInvoice(latest.id) : null;
    if (real) doc = real.doc;
  }
  return { html: renderDocumentHtml(await brandingPreview(value), doc) };
}
