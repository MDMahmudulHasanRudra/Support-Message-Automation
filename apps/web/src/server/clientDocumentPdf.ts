import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { isPdfStandardText, toPdfStandardText, type InvoiceDocumentModel, type ReceiptDocumentModel } from "@support-automation/shared";
import type { DocumentBranding, DocumentImage } from "@/server/clientDocuments";

/**
 * The downloadable PDF of an invoice or a money receipt (CLIENT_CRM_V7.md §3), drawn on the server with pdf-lib and
 * the PDF standard fonts — no font files, no browser, a few milliseconds per document. Those fonts hold Latin
 * script only, so the documents route sends a document that contains Bengali, Arabic or any other script to the
 * print view instead (`pdfCanDraw`); this file never draws a character it cannot encode.
 *
 * Same figures as the HTML view: both receive the strings `server/clientDocuments.ts` formatted; nothing is
 * computed here.
 */

const PAGE = { A4: [595.28, 841.89] as [number, number], LETTER: [612, 792] as [number, number] };
const MARGIN = 48;
const INK = rgb(0.11, 0.14, 0.19);
const MUTED = rgb(0.36, 0.4, 0.45);
const RULE = rgb(0.89, 0.9, 0.92);

function hexToRgb(hex: string): RGB {
  const m = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(hex);
  return m ? rgb(parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255) : rgb(0.12, 0.23, 0.37);
}

/** Last line of defence: anything the standard fonts cannot encode becomes "?" rather than a failed download. */
function clean(text: string | null | undefined): string {
  const t = toPdfStandardText(text ?? "");
  if (isPdfStandardText(t)) return t.replace(/\t/g, " ");
  return [...t].map((ch) => (isPdfStandardText(ch) ? ch : "?")).join("");
}

/** Greedy word wrap to `width`, keeping explicit line breaks; an over-long word is broken by characters. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of clean(text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      if (font.widthOfTextAtSize(word, size) <= width) line = word;
      else {
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > width) {
            out.push(chunk);
            chunk = ch;
          } else chunk += ch;
        }
        line = chunk;
      }
    }
    out.push(line);
  }
  return out;
}

class Writer {
  readonly pdf: PDFDocument;
  page!: PDFPage;
  y = 0;
  readonly size: [number, number];
  readonly pages: PDFPage[] = [];
  constructor(
    pdf: PDFDocument,
    size: [number, number],
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.pdf = pdf;
    this.size = size;
    this.newPage();
  }
  get width() {
    return this.size[0] - MARGIN * 2;
  }
  newPage() {
    this.page = this.pdf.addPage(this.size);
    this.pages.push(this.page);
    this.y = this.size[1] - MARGIN;
  }
  /** Room for `h` more points above the footer, else a new page. */
  need(h: number) {
    if (this.y - h < MARGIN + 30) this.newPage();
  }
  text(s: string, x: number, size: number, opts: { font?: PDFFont; color?: RGB; right?: number } = {}) {
    const font = opts.font ?? this.regular;
    const t = clean(s);
    const drawX = opts.right !== undefined ? opts.right - font.widthOfTextAtSize(t, size) : x;
    this.page.drawText(t, { x: drawX, y: this.y, size, font, color: opts.color ?? INK });
  }
  /** Wrapped paragraph at x within width; advances y. */
  para(s: string, x: number, width: number, size: number, opts: { font?: PDFFont; color?: RGB; gap?: number } = {}) {
    const font = opts.font ?? this.regular;
    for (const line of wrap(s, font, size, width)) {
      this.need(size + 3);
      this.page.drawText(line, { x, y: this.y, size, font, color: opts.color ?? INK });
      this.y -= size + (opts.gap ?? 3.5);
    }
  }
  rule(color = RULE, thickness = 0.8) {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + this.width, y: this.y }, thickness, color });
  }
}

async function embed(pdf: PDFDocument, img: DocumentImage | null): Promise<PDFImage | null> {
  if (!img) return null;
  try {
    return img.mimeType === "image/png" ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
  } catch {
    // An image the PDF library cannot read is left out rather than failing the whole document.
    return null;
  }
}

export async function renderDocumentPdf(branding: DocumentBranding, doc: InvoiceDocumentModel | ReceiptDocumentModel): Promise<Uint8Array> {
  const b = branding.view;
  const pdf = await PDFDocument.create();
  const title = doc.kind === "INVOICE" ? b.invoiceTitle : b.receiptTitle;
  pdf.setTitle(clean(`${title} ${doc.number}`));
  pdf.setAuthor(clean(b.displayName));
  pdf.setProducer("Get Assist");
  pdf.setCreator("Get Assist");
  const [regular, bold] = await Promise.all([pdf.embedFont(StandardFonts.Helvetica), pdf.embedFont(StandardFonts.HelveticaBold)]);
  const w = new Writer(pdf, PAGE[b.paperSize === "LETTER" ? "LETTER" : "A4"], regular, bold);
  const accent = hexToRgb(b.accentColor);
  const right = MARGIN + w.width;
  const [logo, signature] = await Promise.all([embed(pdf, branding.logo), embed(pdf, branding.signature)]);

  // Accent bar.
  w.page.drawRectangle({ x: 0, y: w.size[1] - 6, width: w.size[0], height: 6, color: accent });

  // ── Header: business (left), title and number (right) ──
  const top = w.y;
  if (logo) {
    const scale = Math.min(200 / logo.width, 56 / logo.height, 1);
    const lw = logo.width * scale;
    const lh = logo.height * scale;
    w.page.drawImage(logo, { x: MARGIN, y: w.y - lh + 10, width: lw, height: lh });
    w.y -= lh + 6;
  }
  w.text(b.displayName, MARGIN, 15, { font: bold });
  w.y -= 15;
  const leftWidth = w.width * 0.58;
  if (b.address) w.para(b.address, MARGIN, leftWidth, 9, { color: MUTED });
  const contact = [b.phone, b.email, b.website].filter(Boolean).join("  ·  ");
  if (contact) w.para(contact, MARGIN, leftWidth, 9, { color: MUTED });
  if (b.taxNumber) w.para(`${b.taxLabel ?? ""} ${b.taxNumber}`.trim(), MARGIN, leftWidth, 9, { color: MUTED });
  const headerBottom = w.y;
  w.y = top;
  w.text(title.toUpperCase(), 0, 22, { font: bold, color: accent, right });
  w.y -= 18;
  w.text(doc.number, 0, 10, { color: MUTED, right });
  w.y = Math.min(headerBottom, w.y) - 16;

  // Status stamp (rotated), as on the printed view.
  const stampText =
    doc.kind === "RECEIPT" ? (doc.reversed ? "REVERSED" : "RECEIVED") : ({ PAID: "PAID", CANCELLED: "CANCELLED", WAIVED: "WAIVED", OVERDUE: "OVERDUE", PART_PAID: "PART-PAID" } as Record<string, string>)[doc.state];
  if (stampText) {
    const tone = stampText === "PAID" || stampText === "RECEIVED" ? rgb(0.11, 0.48, 0.27) : stampText === "OVERDUE" || stampText === "PART-PAID" ? rgb(0.7, 0.37, 0.04) : rgb(0.71, 0.14, 0.09);
    w.page.drawText(stampText, { x: right - bold.widthOfTextAtSize(stampText, 18) - 10, y: w.y - 6, size: 18, font: bold, color: tone, rotate: degrees(10), opacity: 0.7 });
  }

  // ── Bill to (left) and the document's facts (right) ──
  w.rule();
  w.y -= 18;
  const gridTop = w.y;
  w.text(doc.kind === "INVOICE" ? "BILL TO" : "RECEIVED FROM", MARGIN, 8, { font: bold, color: MUTED });
  w.y -= 14;
  w.para(doc.client.name, MARGIN, leftWidth, 11.5, { font: bold });
  for (const line of [doc.client.company, `Client code ${doc.client.code}`, doc.client.address, doc.client.phone, doc.client.email]) if (line) w.para(line, MARGIN, leftWidth, 9.5, { color: line.startsWith("Client code") ? MUTED : INK });
  const partyBottom = w.y;
  w.y = gridTop;
  const meta: Array<[string, string]> =
    doc.kind === "INVOICE"
      ? [
          ["Invoice no.", doc.number],
          ["Issued", doc.issuedDate],
          ["Due", doc.dueDate],
          ["Status", doc.statusLabel],
        ]
      : [["Receipt no.", doc.number], ["Received", doc.receivedDate], ["Method", doc.method], ...(doc.reference ? ([["Reference", doc.reference]] as Array<[string, string]>) : [])];
  for (const [k, v] of meta) {
    w.text(k, right - 190, 9.5, { color: MUTED });
    w.text(v, 0, 9.5, { font: bold, right });
    w.y -= 15;
  }
  w.y = Math.min(partyBottom, w.y) - 14;

  const table = (headers: Array<{ label: string; right?: boolean; x: number }>, rows: string[][], firstColWidth: number) => {
    w.need(26);
    w.page.drawRectangle({ x: MARGIN, y: w.y - 6, width: w.width, height: 20, color: accent });
    for (const h of headers) w.text(h.label.toUpperCase(), h.x, 8, { font: bold, color: rgb(1, 1, 1), right: h.right ? h.x : undefined });
    w.y -= 22;
    for (const row of rows) {
      const descLines = wrap(row[0]!, regular, 10, firstColWidth);
      const sub = row.length > headers.length && row[headers.length] ? wrap(row[headers.length]!, regular, 8.5, firstColWidth) : [];
      w.need(descLines.length * 13 + sub.length * 11 + 10);
      const rowTop = w.y;
      for (const [i, line] of descLines.entries()) {
        w.page.drawText(line, { x: MARGIN + 8, y: w.y, size: 10, font: i === 0 && headers.length === 2 ? bold : regular, color: INK });
        w.y -= 13;
      }
      for (const line of sub) {
        w.page.drawText(line, { x: MARGIN + 8, y: w.y, size: 8.5, font: regular, color: MUTED });
        w.y -= 11;
      }
      const saved = w.y;
      w.y = rowTop;
      headers.slice(1).forEach((h, i) => w.text(row[i + 1]!, h.x, 10, { right: h.right ? h.x : undefined }));
      w.y = saved - 4;
      w.rule();
      w.y -= 12;
    }
  };

  if (doc.kind === "INVOICE") {
    table(
      [
        { label: "Description", x: MARGIN + 8 },
        { label: "Amount", x: right - 8, right: true },
      ],
      doc.lines.map((l) => [l.description, l.amount, l.detail ?? ""]),
      w.width - 160,
    );
    const totals: Array<[string, string, boolean]> = [
      ["Total", doc.total, false],
      ["Paid", doc.paid, false],
      ["Balance due", doc.remaining, true],
    ];
    w.need(70);
    for (const [k, v, strong] of totals) {
      if (strong) {
        w.page.drawLine({ start: { x: right - 230, y: w.y + 11 }, end: { x: right, y: w.y + 11 }, thickness: 1.5, color: accent });
        w.y -= 4;
      }
      w.text(k, right - 222, strong ? 12 : 10, { font: strong ? bold : regular });
      w.text(v, 0, strong ? 12 : 10, { font: bold, right: right - 8 });
      w.y -= strong ? 20 : 16;
    }
    if (doc.payments.length) {
      w.y -= 8;
      w.need(40);
      w.text("PAYMENTS RECEIVED", MARGIN, 8.5, { font: bold, color: accent });
      w.y -= 14;
      table(
        [
          { label: "Receipt", x: MARGIN + 8 },
          { label: "Date", x: MARGIN + w.width * 0.45 },
          { label: "Amount", x: right - 8, right: true },
        ],
        doc.payments.map((p) => [p.receiptNumber, p.date, p.amount]),
        w.width * 0.4,
      );
    }
  } else {
    w.need(70);
    const boxTop = w.y + 8;
    w.page.drawRectangle({ x: MARGIN, y: boxTop - 62, width: w.width, height: 62, borderColor: RULE, borderWidth: 1 });
    w.page.drawRectangle({ x: MARGIN, y: boxTop - 62, width: 4, height: 62, color: accent });
    w.y -= 8;
    w.text("AMOUNT RECEIVED", MARGIN + 16, 8, { font: bold, color: MUTED });
    w.y -= 24;
    w.text(doc.amount, MARGIN + 16, 22, { font: bold });
    w.y -= 16;
    w.text(`${doc.method}${doc.reference ? `  ·  Ref. ${doc.reference}` : ""}`, MARGIN + 16, 9.5, { color: MUTED });
    w.y = boxTop - 62 - 20;
    if (doc.invoices.length) {
      w.text("APPLIED TO", MARGIN, 8.5, { font: bold, color: accent });
      w.y -= 14;
      table(
        [
          { label: "Invoice", x: MARGIN + 8 },
          { label: "Amount", x: right - 8, right: true },
        ],
        doc.invoices.map((i) => [i.number, i.amount]),
        w.width - 160,
      );
    }
    if (doc.reversed) {
      w.need(34);
      w.page.drawRectangle({ x: MARGIN, y: w.y - 10, width: w.width, height: 26, color: rgb(0.99, 0.93, 0.93) });
      w.para(`This payment was reversed on ${doc.reversed.at}${doc.reversed.reason ? `: ${doc.reversed.reason}` : ""}. It no longer counts as received.`, MARGIN + 10, w.width - 20, 9.5, { font: bold, color: rgb(0.54, 0.11, 0.11) });
      w.y -= 8;
    }
  }

  const section = (heading: string, text: string | null, size: number) => {
    if (!text) return;
    w.y -= 10;
    w.need(36);
    w.text(heading.toUpperCase(), MARGIN, 8.5, { font: bold, color: accent });
    w.y -= 14;
    w.para(text, MARGIN, w.width, size);
  };
  if (doc.kind === "INVOICE") section("How to pay", b.paymentInstructions, 9.5);
  section("Terms", b.terms, 8.5);

  if (b.signatureName || signature) {
    w.y -= 18;
    w.need(90);
    const x = right - 200;
    if (signature) {
      const scale = Math.min(180 / signature.width, 50 / signature.height, 1);
      w.page.drawImage(signature, { x: x + (200 - signature.width * scale) / 2, y: w.y - signature.height * scale, width: signature.width * scale, height: signature.height * scale });
      w.y -= signature.height * scale + 6;
    } else w.y -= 44;
    w.page.drawLine({ start: { x, y: w.y }, end: { x: right, y: w.y }, thickness: 0.8, color: INK });
    w.y -= 13;
    const name = clean(b.signatureName ?? "Authorised signature");
    w.page.drawText(name, { x: x + (200 - regular.widthOfTextAtSize(name, 9.5)) / 2, y: w.y, size: 9.5, font: regular, color: INK });
    if (b.signatureTitle) {
      w.y -= 12;
      const t = clean(b.signatureTitle);
      w.page.drawText(t, { x: x + (200 - regular.widthOfTextAtSize(t, 8.5)) / 2, y: w.y, size: 8.5, font: regular, color: MUTED });
    }
  }

  // Footer on every page: the business's line and "page n of N".
  const footer = clean(b.footer ?? (doc.kind === "INVOICE" ? "Thank you for your business." : "Thank you for your payment.")).split("\n")[0]!;
  w.pages.forEach((page, i) => {
    page.drawLine({ start: { x: MARGIN, y: MARGIN + 14 }, end: { x: MARGIN + w.width, y: MARGIN + 14 }, thickness: 0.6, color: RULE });
    page.drawText(footer.slice(0, 120), { x: MARGIN, y: MARGIN, size: 8, font: regular, color: MUTED });
    const label = clean(`${doc.number}  ·  Page ${i + 1} of ${w.pages.length}`);
    page.drawText(label, { x: MARGIN + w.width - regular.widthOfTextAtSize(label, 8), y: MARGIN, size: 8, font: regular, color: MUTED });
  });

  return pdf.save();
}
