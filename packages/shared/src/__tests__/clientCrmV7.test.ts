import { describe, expect, it } from "vitest";
import {
  batchApprovalRefusal,
  clientMessageState,
  documentFileName,
  effectiveSettingsVersion,
  emailEligibility,
  followUpDue,
  isPdfStandardText,
  nextOfferStatus,
  offerLapsed,
  readDocumentSettings,
  renderMessageTemplate,
  sniffDocumentImage,
  templateVariables,
  toPdfStandardText,
  validateDocumentSettings,
  validateMessageTemplate,
  validateRenewalOffer,
  whatsappClickToChatUrl,
} from "../index.js";

const offerInput = (over: Partial<Record<string, string>> = {}) => ({ service: "Internet 20 Mbps", durationValue: "12", durationUnit: "MONTH", amount: "", currency: "", validUntil: "", followUpDate: "", note: "", ...over });

describe("renewal offers", () => {
  it("needs a service and a whole duration; a price is optional", () => {
    const ok = validateRenewalOffer(offerInput(), ["BDT"], "2026-11-01");
    expect(ok.ok && ok.value).toMatchObject({ service: "Internet 20 Mbps", durationValue: 12, durationUnit: "MONTH", amount: null, currency: null });
    const bad = validateRenewalOffer(offerInput({ service: " ", durationValue: "1.5" }), ["BDT"], "2026-11-01");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.length).toBe(2);
  });

  it("an amount needs an enabled currency and its decimals, exactly as an invoice does", () => {
    expect(validateRenewalOffer(offerInput({ amount: "1500", currency: "" }), ["BDT"], "2026-11-01").ok).toBe(false);
    expect(validateRenewalOffer(offerInput({ amount: "1500", currency: "USD" }), ["BDT"], "2026-11-01").ok).toBe(false);
    expect(validateRenewalOffer(offerInput({ amount: "1500.50", currency: "JPY" }), ["JPY"], "2026-11-01").ok).toBe(false);
    expect(validateRenewalOffer(offerInput({ amount: "1.555", currency: "BDT" }), ["BDT"], "2026-11-01").ok).toBe(false);
    const ok = validateRenewalOffer(offerInput({ amount: "1,500.5", currency: "bdt" }), ["BDT"], "2026-11-01");
    expect(ok.ok && ok.value).toMatchObject({ amount: "1500.50", currency: "BDT" });
  });

  it("refuses an offer valid only until a past day", () => {
    expect(validateRenewalOffer(offerInput({ validUntil: "2026-10-31" }), [], "2026-11-01").ok).toBe(false);
    expect(validateRenewalOffer(offerInput({ validUntil: "2026-11-01" }), [], "2026-11-01").ok).toBe(true);
  });

  it("moves only along the allowed transitions; renewing needs a recorded acceptance", () => {
    expect(nextOfferStatus("PREPARED", "RECORD_CONTACT")).toEqual({ ok: true, to: "CONTACTED" });
    expect(nextOfferStatus("AWAITING_RESPONSE", "RECORD_CONTACT")).toEqual({ ok: true, to: "AWAITING_RESPONSE" });
    expect(nextOfferStatus("CONTACTED", "ACCEPT")).toEqual({ ok: true, to: "ACCEPTED" });
    expect(nextOfferStatus("ACCEPTED", "RENEW")).toEqual({ ok: true, to: "RENEWED" });
    expect(nextOfferStatus("AWAITING_RESPONSE", "RENEW").ok).toBe(false);
    expect(nextOfferStatus("RENEWED", "RENEW").ok).toBe(false);
    expect(nextOfferStatus("DECLINED", "ACCEPT").ok).toBe(false);
    expect(nextOfferStatus("WITHDRAWN", "RECORD_CONTACT").ok).toBe(false);
  });

  it("lapsed and follow-up are warnings on open offers only", () => {
    expect(offerLapsed({ status: "CONTACTED", validUntil: "2026-10-31" }, "2026-11-01")).toBe(true);
    expect(offerLapsed({ status: "ACCEPTED", validUntil: "2026-10-31" }, "2026-11-01")).toBe(false);
    expect(offerLapsed({ status: "DECLINED", validUntil: "2026-10-31" }, "2026-11-01")).toBe(false);
    expect(followUpDue({ status: "AWAITING_RESPONSE", followUpDate: "2026-11-01" }, "2026-11-01")).toBe(true);
    expect(followUpDue({ status: "RENEWED", followUpDate: "2026-10-01" }, "2026-11-01")).toBe(false);
  });
});

const tpl = (over: Partial<Record<string, string>> = {}) => ({ name: "Renewal", category: "RENEWAL_REMINDER", channel: "ANY", language: "", subject: "", body: "Hello {{client_name}}", ...over });

describe("message templates", () => {
  it("refuses unknown variables, stray braces, and an email with no subject", () => {
    expect(validateMessageTemplate(tpl()).ok).toBe(true);
    const unknown = validateMessageTemplate(tpl({ body: "Hi {{clientName}} {{client_name}}" }));
    expect(!unknown.ok && unknown.errors[0]).toContain("{{clientName}}");
    expect(validateMessageTemplate(tpl({ body: "Hi {{client_name}" })).ok).toBe(false);
    expect(validateMessageTemplate(tpl({ channel: "EMAIL" })).ok).toBe(false);
    expect(validateMessageTemplate(tpl({ channel: "EMAIL", subject: "Invoice {{nope}}" })).ok).toBe(false);
    expect(validateMessageTemplate(tpl({ channel: "EMAIL", subject: "Invoice {{invoice_number}}" })).ok).toBe(true);
  });

  it("lists variables once, in order", () => {
    expect(templateVariables("{{a}} {{ b }} {{a}}")).toEqual(["a", "b"]);
  });

  it("fills values as plain text and drops a line whose variables are all empty", () => {
    const r = renderMessageTemplate(
      { subject: "Invoice {{invoice_number}}", body: "Dear {{client_name}},\nInvoice: {{invoice_number}}\nDue: {{amount_due}}\n\n\n\nThanks" },
      { client_name: "<b>Rahim</b> {{client_code}}", invoice_number: "", amount_due: "BDT 500.00" },
    );
    expect(r.body).toBe("Dear <b>Rahim</b> {{client_code}},\nDue: BDT 500.00\n\nThanks");
    expect(r.subject).toBe("Invoice");
    expect(r.missing).toEqual(["invoice_number"]);
  });

  it("a line with text and a filled variable keeps the text", () => {
    expect(renderMessageTemplate({ subject: null, body: "Paid {{payment_amount}} on {{payment_date}}" }, { payment_amount: "BDT 1.00" }).body).toBe("Paid BDT 1.00 on");
  });
});

describe("WhatsApp click-to-chat", () => {
  it("uses international digits and encodes the text; refuses an unusable number", () => {
    expect(whatsappClickToChatUrl("+880 1700-000000", "Hi & bye")).toBe("https://wa.me/8801700000000?text=Hi%20%26%20bye");
    expect(whatsappClickToChatUrl("12345")).toBeNull();
    expect(whatsappClickToChatUrl("+8801700000000")).toBe("https://wa.me/8801700000000");
  });
});

describe("email eligibility", () => {
  const client = (emails: Array<{ value: string; consent: string; isPrimary?: boolean }>, archived = false) => ({ archived, emails });
  it("one message needs an address that is not opted out", () => {
    expect(emailEligibility(client([]), { bulk: false })).toMatchObject({ ok: false, reason: "NO_EMAIL" });
    expect(emailEligibility(client([{ value: "a@x.com", consent: "OPTED_OUT" }]), { bulk: false })).toMatchObject({ ok: false, reason: "OPTED_OUT" });
    expect(emailEligibility(client([{ value: "a@x.com", consent: "UNKNOWN" }]), { bulk: false })).toEqual({ ok: true, address: "a@x.com" });
    expect(emailEligibility(client([{ value: "a@x.com", consent: "OPTED_IN" }], true), { bulk: false })).toMatchObject({ ok: false, reason: "ARCHIVED" });
  });
  it("a bulk send needs recorded consent; unknown is never consent", () => {
    expect(emailEligibility(client([{ value: "a@x.com", consent: "UNKNOWN" }]), { bulk: true })).toMatchObject({ ok: false, reason: "CONSENT_UNKNOWN" });
    expect(emailEligibility(client([{ value: "a@x.com", consent: "UNKNOWN", isPrimary: true }, { value: "b@x.com", consent: "OPTED_IN" }]), { bulk: true })).toEqual({ ok: true, address: "b@x.com" });
  });
});

describe("bulk batch approval", () => {
  const at = new Date("2026-11-01T00:00:00Z");
  it("never by the submitter, never after 24 hours, only while pending", () => {
    expect(batchApprovalRefusal({ status: "PENDING_APPROVAL", submittedById: "u1", submittedAt: at }, "u1", at)).toContain("someone other");
    expect(batchApprovalRefusal({ status: "PENDING_APPROVAL", submittedById: "u1", submittedAt: at }, "u2", new Date(at.getTime() + 25 * 3_600_000))).toContain("24 hours");
    expect(batchApprovalRefusal({ status: "QUEUED", submittedById: "u1", submittedAt: at }, "u2", at)).not.toBeNull();
    expect(batchApprovalRefusal({ status: "PENDING_APPROVAL", submittedById: "u1", submittedAt: at }, "u2", new Date(at.getTime() + 3_600_000))).toBeNull();
  });
  it("never claims a prepared message was sent, nor 'delivered'", () => {
    expect(clientMessageState({ status: "PREPARED", channel: "WHATSAPP" }, null)).toBe("PREPARED");
    expect(clientMessageState({ status: "QUEUED", channel: "EMAIL" }, "ACCEPTED")).toBe("ACCEPTED");
    expect(clientMessageState({ status: "QUEUED", channel: "EMAIL" }, "UNKNOWN")).toBe("UNKNOWN");
  });
});

describe("documents", () => {
  it("validates the setup and keeps the images it was given", () => {
    const r = validateDocumentSettings({ businessName: " Acme  Ltd ", accentColor: "#1f3a5f", taxNumber: "123" }, { logoSha256: "a".repeat(64), signatureSha256: null });
    expect(r.ok).toBe(false);
    const ok = validateDocumentSettings({ businessName: " Acme  Ltd ", accentColor: "#1f3a5f", taxLabel: "BIN", taxNumber: "123" }, { logoSha256: "a".repeat(64), signatureSha256: null });
    expect(ok.ok && ok.value).toMatchObject({ businessName: "Acme Ltd", accentColor: "#1F3A5F", invoiceTitle: "Invoice", logoSha256: "a".repeat(64), paperSize: "A4" });
    expect(validateDocumentSettings({ accentColor: "red" }, { logoSha256: null, signatureSha256: null }).ok).toBe(false);
  });

  it("reads a stored version defensively", () => {
    expect(readDocumentSettings({ accentColor: "javascript:", paperSize: "LETTER", logoSha256: "../x" })).toMatchObject({ accentColor: "#1F3A5F", paperSize: "LETTER", logoSha256: null });
  });

  it("draws a document with the version in force when it was issued, and never a later one", () => {
    const v = (version: number, iso: string) => ({ version, createdAt: new Date(iso) });
    const versions = [v(1, "2026-10-01T00:00:00Z"), v(2, "2026-10-10T00:00:00Z"), v(3, "2026-10-20T00:00:00Z")];
    expect(effectiveSettingsVersion(versions, new Date("2026-10-15T00:00:00Z"))?.version).toBe(2);
    expect(effectiveSettingsVersion(versions, new Date("2026-10-10T00:00:00Z"))?.version).toBe(2);
    expect(effectiveSettingsVersion(versions, new Date("2026-12-01T00:00:00Z"))?.version).toBe(3);
    // Issued before any setup existed: the FIRST version, fixed from then on.
    expect(effectiveSettingsVersion(versions, new Date("2026-01-01T00:00:00Z"))?.version).toBe(1);
    expect(effectiveSettingsVersion([], new Date())).toBeNull();
  });

  it("sniffs images from their bytes", () => {
    expect(sniffDocumentImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffDocumentImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffDocumentImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });

  it("knows what the standard PDF fonts can draw", () => {
    expect(isPdfStandardText("Café Ltd — €100 “ok”\nLine 2")).toBe(true);
    expect(isPdfStandardText("রহিম উদ্দিন")).toBe(false);
    expect(isPdfStandardText("محمد")).toBe(false);
    expect(toPdfStandardText("A B − ​")).toBe("A B - ");
  });

  it("makes a safe file name", () => {
    expect(documentFileName("INVOICE", "INV-000123", "abc")).toBe("Invoice-INV-000123.pdf");
    expect(documentFileName("RECEIPT", "../../etc/passwd", "abc")).toBe("Receipt-..-..-etc-passwd.pdf");
    expect(documentFileName("INVOICE", null, "cuid123")).toBe("Invoice-cuid123.pdf");
  });
});
