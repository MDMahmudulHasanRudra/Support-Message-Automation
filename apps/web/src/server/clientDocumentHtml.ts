import type { InvoiceDocumentModel, ReceiptDocumentModel } from "@support-automation/shared";
import type { DocumentBranding, DocumentImage } from "@/server/clientDocuments";

/**
 * The printable HTML of an invoice or a money receipt (CLIENT_CRM_V7.md §3). One standalone page, served by the
 * documents route with a CSP that allows no script and no remote resource: the preview iframe shows it, Print
 * prints it (the browser's "Save as PDF" draws every script correctly, Bengali and Arabic included).
 *
 * Every value is ESCAPED: client names, notes, the business's own wording — nothing here is ever markup. The
 * figures arrive formatted from `server/clientDocuments.ts`; this file lays them out and never computes one.
 */

const esc = (s: string | null | undefined): string =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const lines = (s: string | null | undefined): string => esc(s).replace(/\n/g, "<br>");
const dataUri = (img: DocumentImage | null): string | null => (img ? `data:${img.mimeType};base64,${Buffer.from(img.bytes).toString("base64")}` : null);
/** The accent colour was validated as #RRGGBB when it was saved and again when it was read; anything else is the default. */
const safeColor = (c: string) => (/^#[0-9A-F]{6}$/i.test(c) ? c : "#1F3A5F");

function stamp(doc: InvoiceDocumentModel | ReceiptDocumentModel): { text: string; tone: "paid" | "void" | "warn" } | null {
  if (doc.kind === "RECEIPT") return doc.reversed ? { text: "Reversed", tone: "void" } : { text: "Received", tone: "paid" };
  if (doc.state === "PAID") return { text: "Paid", tone: "paid" };
  if (doc.state === "CANCELLED") return { text: "Cancelled", tone: "void" };
  if (doc.state === "WAIVED") return { text: "Waived", tone: "void" };
  if (doc.state === "OVERDUE") return { text: "Overdue", tone: "warn" };
  if (doc.state === "PART_PAID") return { text: "Part-paid", tone: "warn" };
  return null;
}

function partyHtml(label: string, p: InvoiceDocumentModel["client"]): string {
  return `<div class="party"><div class="label">${esc(label)}</div>
    <div class="party-name">${esc(p.name)}</div>
    ${p.company ? `<div>${esc(p.company)}</div>` : ""}
    <div class="muted">Client code ${esc(p.code)}</div>
    ${p.address ? `<div>${lines(p.address)}</div>` : ""}
    ${p.phone ? `<div>${esc(p.phone)}</div>` : ""}
    ${p.email ? `<div>${esc(p.email)}</div>` : ""}
  </div>`;
}

export function renderDocumentHtml(branding: DocumentBranding, doc: InvoiceDocumentModel | ReceiptDocumentModel): string {
  const b = branding.view;
  const accent = safeColor(b.accentColor);
  const logo = dataUri(branding.logo);
  const signature = dataUri(branding.signature);
  const title = doc.kind === "INVOICE" ? b.invoiceTitle : b.receiptTitle;
  const mark = stamp(doc);
  const page = b.paperSize === "LETTER" ? "letter" : "A4";

  const meta =
    doc.kind === "INVOICE"
      ? [
          ["Invoice no.", doc.number],
          ["Issued", doc.issuedDate],
          ["Due", doc.dueDate],
          ["Status", doc.statusLabel],
        ]
      : [
          ["Receipt no.", doc.number],
          ["Received", doc.receivedDate],
          ["Method", doc.method],
          ...(doc.reference ? [["Reference", doc.reference]] : []),
        ];

  const body =
    doc.kind === "INVOICE"
      ? `<table class="items">
          <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
          <tbody>${doc.lines.map((l) => `<tr><td><div class="item">${esc(l.description)}</div>${l.detail ? `<div class="muted small">${esc(l.detail)}</div>` : ""}</td><td class="num">${esc(l.amount)}</td></tr>`).join("")}</tbody>
        </table>
        <table class="totals">
          <tr><td>Total</td><td class="num strong">${esc(doc.total)}</td></tr>
          <tr><td>Paid</td><td class="num">${esc(doc.paid)}</td></tr>
          <tr class="due"><td>Balance due</td><td class="num">${esc(doc.remaining)}</td></tr>
        </table>
        ${
          doc.payments.length
            ? `<h3>Payments received</h3><table class="items compact"><thead><tr><th>Receipt</th><th>Date</th><th class="num">Amount</th></tr></thead><tbody>${doc.payments
                .map((p) => `<tr><td>${esc(p.receiptNumber)}</td><td>${esc(p.date)}</td><td class="num">${esc(p.amount)}</td></tr>`)
                .join("")}</tbody></table>`
            : ""
        }`
      : `<div class="received">
          <div class="label">Amount received</div>
          <div class="big">${esc(doc.amount)}</div>
          <div class="muted">${esc(doc.method)}${doc.reference ? ` · Ref. ${esc(doc.reference)}` : ""}</div>
        </div>
        ${
          doc.invoices.length
            ? `<h3>Applied to</h3><table class="items compact"><thead><tr><th>Invoice</th><th class="num">Amount</th></tr></thead><tbody>${doc.invoices
                .map((i) => `<tr><td>${esc(i.number)}</td><td class="num">${esc(i.amount)}</td></tr>`)
                .join("")}</tbody></table>`
            : ""
        }
        ${doc.reversed ? `<div class="notice void">This payment was reversed on ${esc(doc.reversed.at)}${doc.reversed.reason ? `: ${esc(doc.reversed.reason)}` : ""}. It no longer counts as received.</div>` : ""}`;

  const instructions = doc.kind === "INVOICE" && b.paymentInstructions ? `<section><h3>How to pay</h3><p>${lines(b.paymentInstructions)}</p></section>` : "";
  const terms = b.terms ? `<section><h3>Terms</h3><p class="small">${lines(b.terms)}</p></section>` : "";
  const sign =
    b.signatureName || signature
      ? `<div class="sign">${signature ? `<img src="${signature}" alt="">` : '<div class="sign-space"></div>'}<div class="sign-line"></div><div>${esc(b.signatureName ?? "Authorised signature")}</div>${b.signatureTitle ? `<div class="muted small">${esc(b.signatureTitle)}</div>` : ""}</div>`
      : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} ${esc(doc.number)}</title>
<style>
  @page { size: ${page}; margin: 14mm; }
  :root { --accent: ${accent}; }
  * { box-sizing: border-box; }
  html { background: #eef0f3; }
  body { margin: 0; font: 13px/1.5 "Segoe UI", system-ui, -apple-system, "Noto Sans", "Noto Sans Bengali", Arial, sans-serif; color: #1c2430; }
  .sheet { background: #fff; max-width: 820px; margin: 24px auto; padding: 44px 48px; box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06); position: relative; }
  .bar { position: absolute; inset: 0 0 auto 0; height: 6px; background: var(--accent); }
  header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .brand img { max-height: 64px; max-width: 220px; display: block; margin-bottom: 8px; }
  .brand-name { font-size: 18px; font-weight: 700; }
  .doc-title { text-align: right; }
  .doc-title h1 { margin: 0; font-size: 28px; letter-spacing: .02em; color: var(--accent); text-transform: uppercase; }
  .muted { color: #5b6573; } .small { font-size: 11.5px; } .strong { font-weight: 700; }
  .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: #5b6573; margin-bottom: 4px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 28px 0 22px; }
  .party-name { font-weight: 700; font-size: 15px; }
  dl.meta { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; justify-self: end; }
  dl.meta dt { color: #5b6573; } dl.meta dd { margin: 0; font-weight: 600; text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  table.items th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: #fff; background: var(--accent); padding: 8px 10px; }
  table.items td { padding: 10px; border-bottom: 1px solid #e3e6ea; vertical-align: top; }
  table.compact td { padding: 6px 10px; }
  .item { font-weight: 600; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.totals { width: 320px; margin: 14px 0 0 auto; }
  table.totals td { padding: 6px 10px; }
  table.totals tr.due td { border-top: 2px solid var(--accent); font-weight: 700; font-size: 15px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); margin: 26px 0 8px; }
  section p { margin: 0; }
  .received { border: 1px solid #e3e6ea; border-left: 4px solid var(--accent); padding: 16px 18px; border-radius: 6px; }
  .big { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .notice { margin-top: 18px; padding: 10px 14px; border-radius: 6px; font-weight: 600; }
  .notice.void { background: #fdecec; color: #8a1c1c; }
  .stamp { position: absolute; top: 120px; right: 48px; transform: rotate(-12deg); border: 3px solid; border-radius: 6px; padding: 4px 14px; font-size: 22px; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; opacity: .75; }
  .stamp.paid { color: #1d7a46; } .stamp.void { color: #b42318; } .stamp.warn { color: #b25e09; }
  .sign { width: 220px; margin: 36px 0 0 auto; text-align: center; }
  .sign img { max-height: 60px; max-width: 200px; }
  .sign-space { height: 48px; } .sign-line { border-top: 1px solid #1c2430; margin: 4px 0 6px; }
  footer { margin-top: 34px; padding-top: 12px; border-top: 1px solid #e3e6ea; color: #5b6573; font-size: 11.5px; display: flex; justify-content: space-between; gap: 16px; }
  @media (max-width: 640px) { .sheet { margin: 0; padding: 28px 18px; } .grid { grid-template-columns: 1fr; } dl.meta { justify-self: start; } table.totals { width: 100%; } .stamp { top: 90px; right: 18px; font-size: 16px; } }
  @media print { html { background: #fff; } .sheet { margin: 0; padding: 0; box-shadow: none; max-width: none; } .bar { display: none; } h3, table, .received { break-inside: avoid; } }
</style></head>
<body><div class="sheet"><div class="bar"></div>
<header>
  <div class="brand">${logo ? `<img src="${logo}" alt="">` : ""}<div class="brand-name">${esc(b.displayName)}</div>
    ${b.address ? `<div class="muted small">${lines(b.address)}</div>` : ""}
    <div class="muted small">${[b.phone, b.email, b.website].filter(Boolean).map(esc).join(" · ")}</div>
    ${b.taxNumber ? `<div class="muted small">${esc(b.taxLabel)} ${esc(b.taxNumber)}</div>` : ""}
  </div>
  <div class="doc-title"><h1>${esc(title)}</h1><div class="muted">${esc(doc.number)}</div></div>
</header>
${mark ? `<div class="stamp ${mark.tone}">${esc(mark.text)}</div>` : ""}
<div class="grid">
  ${partyHtml(doc.kind === "INVOICE" ? "Bill to" : "Received from", doc.client)}
  <dl class="meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
</div>
${body}
${instructions}
${terms}
${sign}
<footer><div>${b.footer ? lines(b.footer) : doc.kind === "INVOICE" ? "Thank you for your business." : "Thank you for your payment."}</div><div>${esc(doc.number)}</div></footer>
</div></body></html>`;
}
