import { NextResponse, type NextRequest } from "next/server";
import { documentFileName } from "@support-automation/shared";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { subModuleOff } from "@/server/clientModule";
import { brandingFor, loadInvoice, loadReceipt, pdfCanDraw } from "@/server/clientDocuments";
import { renderDocumentHtml } from "@/server/clientDocumentHtml";
import { renderDocumentPdf } from "@/server/clientDocumentPdf";
import { contentDisposition } from "@/server/reports/exportFile";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * An invoice or a money receipt as a document (CLIENT_CRM_V7.md §3): `?format=html` (the preview and the print
 * view, the default) or `?format=pdf` (a download). Session → project access → `clients.view_billing` (with the
 * CLIENT_CENTER feature, which `checkPermission` applies) → Billing switched on → the row through the
 * project-scoped client, so another project's id is a 404. Never cached by a shared cache; the HTML carries a CSP
 * that allows no script and no remote resource at all. A PDF download is recorded in the System Log.
 */
export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;
const refuse = (status: number, text: string) => new NextResponse(text, { status, headers: { ...PRIVATE, "Content-Type": "text/plain; charset=utf-8" } });

export async function GET(request: NextRequest, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const session = await getSession();
  if (!session) return refuse(401, "Sign in to view this document.");
  const access = await checkPermission("clients.view_billing");
  if ("denied" in access) return refuse(403, access.denied);
  const off = await subModuleOff("billing");
  if (off) return refuse(403, off);

  const { kind, id } = await params;
  if (kind !== "invoice" && kind !== "receipt") return refuse(404, "No such document.");
  const record = kind === "invoice" ? await loadInvoice(id) : await loadReceipt(id);
  if (!record) return refuse(404, "That document does not exist in this project.");
  const branding = await brandingFor(record.issuedAt);

  const format = request.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "html";
  if (format === "html") {
    return new NextResponse(renderDocumentHtml(branding, record.doc), {
      status: 200,
      headers: {
        ...PRIVATE,
        "Content-Type": "text/html; charset=utf-8",
        // No script, no remote anything; framed only by this app's own pages (the preview).
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      },
    });
  }

  if (!pdfCanDraw(branding, record.doc)) {
    return refuse(
      422,
      "This document contains text in a script the PDF builder cannot lay out correctly (for example Bengali or Arabic). Open the document and use Print → Save as PDF instead: the browser draws it exactly.",
    );
  }
  const bytes = await renderDocumentPdf(branding, record.doc);
  await logSystemEvent(
    "INFO",
    "clients",
    kind === "invoice" ? "Invoice PDF downloaded" : "Receipt PDF downloaded",
    { documentId: id, number: record.doc.number, clientId: record.clientId, brandingVersion: branding.view.version },
    { actorUserId: access.session.userId, targetType: kind === "invoice" ? "ClientDue" : "ClientPayment", targetId: id },
  );
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      ...PRIVATE,
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": contentDisposition(documentFileName(kind === "invoice" ? "INVOICE" : "RECEIPT", record.doc.number, id)),
    },
  });
}
