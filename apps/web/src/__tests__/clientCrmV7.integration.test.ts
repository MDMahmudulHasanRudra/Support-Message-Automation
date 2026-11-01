import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { addCalendarDays, dhakaToday, PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Client CRM & Billing V7 (CLIENT_CRM_V7.md): invoice and receipt documents, the versioned Invoice & Receipt
 * setup, renewal offers, renewing once, client message templates, one-to-one email, prepared WhatsApp messages
 * and bulk email with a second person's approval — in two projects, so none of it crosses.
 *
 * What must hold, beyond "it saves":
 *   - an offer — prepared, sent, even accepted — creates no due; only "renew from offer" with an explicit invoice does;
 *   - a term is renewed once, also when two presses race; an offer renews once;
 *   - a document is drawn with the setup version in force when it was issued, never a later one; history rows and
 *     images are never rewritten;
 *   - a document is served only to a billing viewer of its own project, escaped, and the PDF never draws a script it
 *     cannot (it refuses and points at Print);
 *   - choosing or previewing a template sends nothing; a WhatsApp message is PREPARED, never sent by Get Assist;
 *   - an email is queued once per press, never to someone opted out, never while the channel is unverified;
 *   - a bulk email is never approved by the person who prepared it, never after 24 hours, never includes unknown
 *     consent, and re-checks consent at approval.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], projects: [] as string[] };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const billing = await import("@/server/actions/clientBilling");
const subs = await import("@/server/actions/clientSubscriptions");
const pay = await import("@/server/actions/clientPayments");
const renewals = await import("@/server/actions/clientRenewals");
const messages = await import("@/server/actions/clientMessages");
const documents = await import("@/server/actions/clientDocuments");
const renewalReads = await import("@/server/clientRenewals");
const invoiceRoute = await import("@/app/p/[project]/api/clients/documents/invoice/[id]/route");
const receiptRoute = await import("@/app/p/[project]/api/clients/documents/receipt/[id]/route");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(r.id);
  return r.id;
}
async function user(name: string, roleId: string): Promise<Session> {
  const u = await rawPrisma.user.create({ data: { username: `${name.toLowerCase()}_${tag}`, email: `${name.toLowerCase()}.${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
const people = {} as Record<"admin" | "approver" | "seller" | "viewer", Session>;
const as = <T,>(person: Session, project: Project, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(project, fn);
};
const form = (fields: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const today = dhakaToday(new Date());
const plus = (n: number) => addCalendarDays(today, n);
let seq = 0;

async function client(project: Project, name: string, emails: Array<{ value: string; consent: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT" }> = [], phone?: string) {
  seq += 1;
  const c = await rawPrisma.client.create({ data: { projectId: project.id, code: `V7-${tag}-${seq}`, name } });
  for (const e of emails) await rawPrisma.clientChannel.create({ data: { projectId: project.id, clientId: c.id, kind: "EMAIL", value: e.value, normalizedValue: e.value.toLowerCase(), consentStatus: e.consent } });
  if (phone) await rawPrisma.clientChannel.create({ data: { projectId: project.id, clientId: c.id, kind: "WHATSAPP", value: phone, normalizedValue: phone.replace(/\D/g, "") } });
  return c.id;
}
async function term(project: Project, clientId: string, endIn: number) {
  const r = await as(people.admin, project, () => subs.createSubscription(clientId, {}, form({ service: "Internet 20 Mbps", startDate: plus(endIn - 30), durationValue: "30", durationUnit: "DAY" })));
  if (!r.success) throw new Error(r.error);
  return rawPrisma.clientSubscription.findFirstOrThrow({ where: { clientId }, orderBy: { createdAt: "desc" } });
}
async function invoice(project: Project, clientId: string, amount = "1500") {
  const r = await as(people.admin, project, () => billing.createDue(clientId, {}, form({ dueDate: plus(5), amount, currency: "BDT", status: "UNPAID", service: "Internet 20 Mbps" })));
  if (!r.success) throw new Error(r.error);
  return rawPrisma.clientDue.findFirstOrThrow({ where: { clientId }, orderBy: { createdAt: "desc" } });
}
const getDocument = (project: Project, person: Session, kind: string, id: string, format = "html") =>
  as(person, project, () => (kind === "invoice" ? invoiceRoute : receiptRoute).GET(new NextRequest(`http://x/p/${project.slug}/api/clients/documents/${kind}/${id}?format=${format}`), { params: Promise.resolve({ id }) }));

beforeAll(async () => {
  const base = ["clients.view", "clients.create", "clients.update", "messages.view"];
  const all = [...base, "clients.view_billing", "clients.edit_billing", "clients.manage_subscriptions", "clients.manage_settings", "clients.send_messages", "clients.approve_messages"];
  people.admin = await user("V7Admin", await role("V7 admin", all));
  people.approver = await user("V7Approver", await role("V7 approver", all));
  people.seller = await user("V7Seller", await role("V7 seller", [...base, "clients.manage_subscriptions", "clients.send_messages"]));
  people.viewer = await user("V7Viewer", await role("V7 viewer", ["clients.view"]));
  const make = async (name: string) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.admin.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    await rawPrisma.clientBillingCurrency.create({ data: { projectId: p.id, code: "BDT" } });
    // An email channel switched on and verified under its current settings (no message ever leaves a test).
    await rawPrisma.emailSettings.create({ data: { projectId: p.id, enabled: true, host: "smtp.example.test", fromAddress: "billing@example.test", passwordCiphertext: "x", settingsVersion: 1, verifiedVersion: 1, lastTestOk: true } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("V7A");
  B = await make("V7B");
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientMessage.deleteMany({ where });
  await rawPrisma.clientMessageBatch.deleteMany({ where });
  await rawPrisma.clientMessageTemplate.deleteMany({ where });
  await rawPrisma.emailOutbox.deleteMany({ where });
  await rawPrisma.emailSettings.deleteMany({ where });
  await rawPrisma.clientRenewalOffer.deleteMany({ where });
  await rawPrisma.clientDocumentSettingsVersion.deleteMany({ where });
  await rawPrisma.clientDocumentAsset.deleteMany({ where });
  await rawPrisma.client.updateMany({ where, data: { currentSubscriptionId: null } });
  await rawPrisma.clientPaymentAllocation.deleteMany({ where });
  await rawPrisma.clientPayment.deleteMany({ where });
  await rawPrisma.clientDueEvent.deleteMany({ where });
  await rawPrisma.clientDue.deleteMany({ where });
  await rawPrisma.clientSubscription.deleteMany({ where });
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.clientBillingCurrency.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("1. renewal offers and renewing once", () => {
  it("an offer — prepared, contacted, accepted — creates no due; renewing raises an invoice only when asked", async () => {
    const clientId = await client(A, "Offer Client");
    const t = await term(A, clientId, 5);
    const prepared = await as(people.admin, A, () => renewals.prepareRenewalOffer(t.id, {}, form({ service: "Internet 20 Mbps", durationValue: "12", durationUnit: "MONTH", amount: "18000", currency: "BDT" })));
    expect(prepared.success).toBeTruthy();
    const offer = await rawPrisma.clientRenewalOffer.findFirstOrThrow({ where: { subscriptionId: t.id } });
    expect(offer.status).toBe("PREPARED");
    // A second open offer for the same term is refused (partial unique index).
    expect((await as(people.admin, A, () => renewals.prepareRenewalOffer(t.id, {}, form({ service: "X", durationValue: "1", durationUnit: "MONTH" })))).error).toMatch(/already has an open renewal offer/);

    expect((await as(people.admin, A, () => renewals.updateRenewalOffer(offer.id, "RECORD_CONTACT", { channel: "WHATSAPP" }))).ok).toBe(true);
    expect((await as(people.admin, A, () => renewals.updateRenewalOffer(offer.id, "MARK_AWAITING", {}))).ok).toBe(true);
    // Renewing needs a recorded acceptance first.
    expect((await as(people.admin, A, () => renewals.renewFromOffer(offer.id, {}, form({})))).error).toMatch(/acceptance/);
    expect((await as(people.admin, A, () => renewals.updateRenewalOffer(offer.id, "ACCEPT", { note: "Yes, renew" }))).ok).toBe(true);
    const accepted = await rawPrisma.clientRenewalOffer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(accepted).toMatchObject({ status: "ACCEPTED", contactCount: 1, responseNote: "Yes, renew" });
    expect(await rawPrisma.clientDue.count({ where: { clientId } })).toBe(0);

    const renewed = await as(people.admin, A, () => renewals.renewFromOffer(offer.id, {}, form({ raiseInvoice: "1", invoiceDueDate: plus(7) })));
    expect(renewed.success).toMatch(/Invoice INV-/);
    const after = await rawPrisma.clientRenewalOffer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(after.status).toBe("RENEWED");
    const newTerm = await rawPrisma.clientSubscription.findUniqueOrThrow({ where: { id: after.renewedSubscriptionId! } });
    expect(newTerm).toMatchObject({ renewedFromId: t.id, isRenewal: true, startDate: t.endDate });
    const due = await rawPrisma.clientDue.findUniqueOrThrow({ where: { id: after.invoiceDueId! } });
    expect(due).toMatchObject({ kind: "RENEWAL", currency: "BDT", status: "UNPAID", subscriptionId: newTerm.id });
    expect(due.amount?.toFixed(2)).toBe("18000.00");
    const events = await rawPrisma.clientRenewalOfferEvent.findMany({ where: { offerId: offer.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["PREPARED", "CONTACT", "STATUS", "STATUS", "RENEWED"]);
    // History is append-only.
    await expect(rawPrisma.clientRenewalOfferEvent.update({ where: { id: events[0]!.id }, data: { note: "rewritten" } })).rejects.toThrow(/never changed/);
  });

  it("a decline creates no balance; a declined offer cannot be accepted or renewed", async () => {
    const clientId = await client(A, "Decline Client");
    const t = await term(A, clientId, 3);
    await as(people.admin, A, () => renewals.prepareRenewalOffer(t.id, {}, form({ service: "S", durationValue: "1", durationUnit: "MONTH", amount: "500", currency: "BDT" })));
    const offer = await rawPrisma.clientRenewalOffer.findFirstOrThrow({ where: { subscriptionId: t.id } });
    expect((await as(people.admin, A, () => renewals.updateRenewalOffer(offer.id, "DECLINE", {}))).message).toMatch(/Note what the customer said/);
    expect((await as(people.admin, A, () => renewals.updateRenewalOffer(offer.id, "DECLINE", { note: "Moving away" }))).ok).toBe(true);
    expect((await as(people.admin, A, () => renewals.updateRenewalOffer(offer.id, "ACCEPT", {}))).ok).toBe(false);
    expect(await rawPrisma.clientDue.count({ where: { clientId } })).toBe(0);
    // A declined offer leaves room for a new one.
    expect((await as(people.admin, A, () => renewals.prepareRenewalOffer(t.id, {}, form({ service: "S", durationValue: "1", durationUnit: "MONTH" })))).success).toBeTruthy();
  });

  it("an offer renews once, even when two presses race", async () => {
    const clientId = await client(A, "Race Offer");
    const t = await term(A, clientId, 2);
    await as(people.admin, A, () => renewals.prepareRenewalOffer(t.id, {}, form({ service: "S", durationValue: "1", durationUnit: "MONTH" })));
    const offer = await rawPrisma.clientRenewalOffer.findFirstOrThrow({ where: { subscriptionId: t.id } });
    await as(people.admin, A, () => renewals.updateRenewalOffer(offer.id, "ACCEPT", {}));
    const results = await Promise.all([as(people.admin, A, () => renewals.renewFromOffer(offer.id, {}, form({}))), as(people.approver, A, () => renewals.renewFromOffer(offer.id, {}, form({})))]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(await rawPrisma.clientSubscription.count({ where: { clientId } })).toBe(2);
  });

  it("Renew twice on the same term is refused — sequential and concurrent", async () => {
    const clientId = await client(A, "Double Renew");
    const t = await term(A, clientId, 4);
    expect((await as(people.admin, A, () => subs.renewSubscription(t.id, {}, form({})))).success).toBe(true);
    expect((await as(people.admin, A, () => subs.renewSubscription(t.id, {}, form({})))).error).toMatch(/already renewed/);
    const clientId2 = await client(A, "Double Renew Race");
    const t2 = await term(A, clientId2, 4);
    const raced = await Promise.all([as(people.admin, A, () => subs.renewSubscription(t2.id, {}, form({}))), as(people.approver, A, () => subs.renewSubscription(t2.id, {}, form({})))]);
    expect(raced.filter((r) => r.success)).toHaveLength(1);
    expect(await rawPrisma.clientSubscription.count({ where: { clientId: clientId2 } })).toBe(2);
  });

  it("checks its key and keeps money to billing viewers; another project's term is not found", async () => {
    const clientId = await client(A, "Keys Client");
    const t = await term(A, clientId, 6);
    expect((await as(people.viewer, A, () => renewals.prepareRenewalOffer(t.id, {}, form({ service: "S", durationValue: "1", durationUnit: "MONTH" })))).error).toMatch(/permission/i);
    expect((await as(people.seller, A, () => renewals.prepareRenewalOffer(t.id, {}, form({ service: "S", durationValue: "1", durationUnit: "MONTH", amount: "10", currency: "BDT" })))).error).toMatch(/View Client Billing/);
    expect((await as(people.admin, B, () => renewals.prepareRenewalOffer(t.id, {}, form({ service: "S", durationValue: "1", durationUnit: "MONTH" })))).error).toMatch(/no longer exists/);
    // The workspace lists the term as renewing soon, and nothing of A in B.
    const listA = await as(people.admin, A, () => renewalReads.listRenewals({ view: "renewing", q: "Keys Client", page: 1, windowDays: 7, billing: true }));
    expect(listA.rows.map((r) => r.client.id)).toContain(clientId);
    const listB = await as(people.admin, B, () => renewalReads.listRenewals({ view: "renewing", q: "Keys Client", page: 1, windowDays: 7, billing: true }));
    expect(listB.rows).toHaveLength(0);
  });
});

describe("2. invoice and receipt documents", () => {
  it("serves an escaped HTML document and a PDF to a billing viewer of its own project only", async () => {
    const clientId = await client(A, `Acme <script>alert(1)</script> Ltd`);
    const due = await invoice(A, clientId);
    const html = await getDocument(A, people.admin, "invoice", due.id);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
    const text = await html.text();
    expect(text).toContain("Acme &lt;script&gt;alert(1)&lt;/script&gt; Ltd");
    expect(text).not.toContain("<script>alert(1)");
    expect(text).toContain(due.invoiceNumber!);
    expect(text).toContain("BDT 1,500.00");
    const pdf = await getDocument(A, people.admin, "invoice", due.id, "pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await getDocument(A, people.viewer, "invoice", due.id)).status).toBe(403);
    expect((await getDocument(B, people.admin, "invoice", due.id)).status).toBe(404);
  });

  it("refuses a PDF it cannot draw (Bengali) and keeps the HTML view", async () => {
    const clientId = await client(A, "রহিম উদ্দিন");
    const due = await invoice(A, clientId);
    expect((await getDocument(A, people.admin, "invoice", due.id)).status).toBe(200);
    const pdf = await getDocument(A, people.admin, "invoice", due.id, "pdf");
    expect(pdf.status).toBe(422);
    expect(await pdf.text()).toMatch(/Print/);
  });

  it("draws each document with the setup version in force when it was issued; versions and images never change", async () => {
    const saveV = (version: number, businessName: string) => as(people.admin, A, () => documents.saveDocumentSettings({}, form({ version: String(version), businessName, accentColor: "#123456", paperSize: "A4" })));
    const current = await rawPrisma.clientDocumentSettingsVersion.findFirst({ where: { projectId: A.id }, orderBy: { version: "desc" } });
    const v0 = current?.version ?? 0;
    expect((await saveV(v0, "First Name Ltd")).success).toMatch(/version/);
    const clientId = await client(A, "Branding Client");
    const early = await invoice(A, clientId, "100");
    await new Promise((r) => setTimeout(r, 20));
    // A stale form is refused rather than silently overwriting a newer version.
    expect((await saveV(v0, "Stale")).error).toMatch(/while you were editing/);
    expect((await saveV(v0 + 1, "Second Name Ltd")).success).toBeTruthy();
    const late = await invoice(A, clientId, "200");
    expect(await (await getDocument(A, people.admin, "invoice", early.id)).text()).toContain("First Name Ltd");
    expect(await (await getDocument(A, people.admin, "invoice", late.id)).text()).toContain("Second Name Ltd");
    const v = await rawPrisma.clientDocumentSettingsVersion.findFirstOrThrow({ where: { projectId: A.id, version: v0 + 1 } });
    await expect(rawPrisma.clientDocumentSettingsVersion.update({ where: { id: v.id }, data: { data: {} } })).rejects.toThrow(/never changed/);
    // An image is accepted only when its bytes are PNG/JPEG.
    const svg = new Blob(["<svg onload=alert(1)>"], { type: "image/png" });
    expect((await as(people.admin, A, () => documents.saveDocumentSettings({}, form({ version: String(v0 + 2), logo: svg })))).error).toMatch(/PNG or JPEG/);
    expect((await as(people.viewer, A, () => documents.saveDocumentSettings({}, form({ version: String(v0 + 2) })))).error).toMatch(/permission/i);
  });

  it("a reversed payment's receipt says so; a receipt is a receipt, never an invoice", async () => {
    const clientId = await client(A, "Receipt Client");
    const due = await invoice(A, clientId, "1000");
    const paid = await as(people.admin, A, () => pay.recordPayments({ idempotencyKey: randomUUID().replace(/-/g, ""), method: "CASH", receivedDate: today, reference: "R-1", note: "internal only", lines: [{ dueId: due.id, amount: "400" }] }));
    expect(paid.ok).toBe(true);
    const payment = await rawPrisma.clientPayment.findFirstOrThrow({ where: { clientId } });
    let text = await (await getDocument(A, people.admin, "receipt", payment.id)).text();
    expect(text).toContain("BDT 400.00");
    expect(text).toContain(due.invoiceNumber!);
    expect(text).not.toContain("internal only");
    // The invoice keeps its open balance after a part payment.
    expect(await (await getDocument(A, people.admin, "invoice", due.id)).text()).toContain("BDT 600.00");
    expect((await as(people.admin, A, () => pay.reversePayment(payment.id, "Entered twice"))).ok).toBe(true);
    text = await (await getDocument(A, people.admin, "receipt", payment.id)).text();
    expect(text).toContain("Reversed");
    expect(text).toContain("Entered twice");
  });
});

describe("3. templates and one-to-one messages", () => {
  let templateId = "";
  it("refuses unknown variables, versions every save, refuses a stale edit", async () => {
    const bad = await as(people.admin, A, () => messages.saveMessageTemplate(null, {}, form({ name: `Reminder ${tag}`, category: "PAYMENT_REMINDER", channel: "EMAIL", subject: "Invoice {{invoice_number}}", body: "Hi {{clientName}}", status: "ACTIVE" })));
    expect(bad.error).toMatch(/clientName/);
    const ok = await as(people.admin, A, () =>
      messages.saveMessageTemplate(null, {}, form({ name: `Reminder ${tag}`, category: "PAYMENT_REMINDER", channel: "EMAIL", subject: "Invoice {{invoice_number}}", body: "Dear {{client_name}},\nAmount due: {{amount_due}}\nThanks", status: "ACTIVE" })),
    );
    templateId = ok.templateId!;
    expect(templateId).toBeTruthy();
    expect((await as(people.admin, A, () => messages.saveMessageTemplate(templateId, {}, form({ version: "1", name: `Reminder ${tag}`, category: "PAYMENT_REMINDER", channel: "EMAIL", subject: "Invoice {{invoice_number}}", body: "Dear {{client_name}},\nAmount due: {{amount_due}}", status: "ACTIVE" })))).success).toMatch(/version 2/);
    expect((await as(people.admin, A, () => messages.saveMessageTemplate(templateId, {}, form({ version: "1", name: `Reminder ${tag}`, category: "PAYMENT_REMINDER", channel: "EMAIL", subject: "S", body: "B", status: "ACTIVE" })))).error).toMatch(/Someone saved/);
    expect(await rawPrisma.clientMessageTemplateVersion.count({ where: { templateId } })).toBe(2);
    expect((await as(people.seller, A, () => messages.saveMessageTemplate(null, {}, form({ name: "x", category: "CUSTOM", body: "y" })))).error).toMatch(/permission/i);
  });

  it("previews with the client's own values only; money only for billing viewers; nothing is written or sent", async () => {
    const mine = await client(A, "Preview Client", [{ value: "preview@example.test", consent: "UNKNOWN" }]);
    const other = await client(A, "Other Client");
    const myDue = await invoice(A, mine, "750");
    const otherDue = await invoice(A, other, "999");
    const before = await rawPrisma.emailOutbox.count({ where: { projectId: A.id } });
    const p = await as(people.admin, A, () => messages.previewClientMessage(mine, templateId, { dueId: myDue.id }));
    expect(p.ok && p.body).toBe("Dear Preview Client,\nAmount due: BDT 750.00");
    expect(p.ok && p.subject).toBe(`Invoice ${myDue.invoiceNumber}`);
    // Another client's invoice as "context" is ignored, never read into this client's message.
    const crossed = await as(people.admin, A, () => messages.previewClientMessage(mine, templateId, { dueId: otherDue.id }));
    expect(crossed.ok && crossed.body).toBe("Dear Preview Client,");
    expect(crossed.ok && crossed.missing).toContain("amount_due");
    const seller = await as(people.seller, A, () => messages.previewClientMessage(mine, templateId, { dueId: myDue.id }));
    expect(seller.ok && seller.body).not.toContain("750");
    expect(await rawPrisma.emailOutbox.count({ where: { projectId: A.id } })).toBe(before);
    expect(await rawPrisma.clientMessage.count({ where: { clientId: mine } })).toBe(0);
  });

  it("queues one email per press, never to an opted-out client, never while email is unverified", async () => {
    const ok = await client(A, "Email Client", [{ value: "client@example.test", consent: "UNKNOWN" }]);
    const out = await client(A, "Opted Out", [{ value: "out@example.test", consent: "OPTED_OUT" }]);
    const key = randomUUID().replace(/-/g, "");
    const input = { clientId: ok, templateId, context: {}, subject: "Hello", body: "Your invoice is ready.", submissionKey: key };
    const first = await as(people.admin, A, () => messages.sendClientEmail(input));
    const second = await as(people.admin, A, () => messages.sendClientEmail(input));
    expect(first.ok && second.ok).toBe(true);
    const rows = await rawPrisma.emailOutbox.findMany({ where: { projectId: A.id, toAddress: "client@example.test" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "CLIENT_MESSAGE", status: "QUEUED" });
    expect(await rawPrisma.clientMessage.findFirst({ where: { emailOutboxId: rows[0]!.id } })).toMatchObject({ status: "QUEUED", channel: "EMAIL", templateVersion: 2 });
    expect((await as(people.admin, A, () => messages.sendClientEmail({ ...input, clientId: out, submissionKey: randomUUID().replace(/-/g, "") }))).message).toMatch(/opted out/);
    expect((await as(people.admin, A, () => messages.sendClientEmail({ ...input, body: "Hi {{client_name}}", submissionKey: randomUUID().replace(/-/g, "") }))).message).toMatch(/\{\{ \}\}/);
    expect((await as(people.viewer, A, () => messages.sendClientEmail({ ...input, submissionKey: randomUUID().replace(/-/g, "") }))).message).toMatch(/permission/i);
    await rawPrisma.emailSettings.updateMany({ where: { projectId: A.id }, data: { settingsVersion: 2 } });
    expect((await as(people.admin, A, () => messages.sendClientEmail({ ...input, submissionKey: randomUUID().replace(/-/g, "") }))).message).toMatch(/not connected/);
    await rawPrisma.emailSettings.updateMany({ where: { projectId: A.id }, data: { settingsVersion: 1 } });
  });

  it("a WhatsApp message is recorded as PREPARED — nothing is queued anywhere", async () => {
    const c = await client(A, "WA Client", [], "+8801700000001");
    const outbound = await rawPrisma.outboundMessage.count();
    const emails = await rawPrisma.emailOutbox.count({ where: { projectId: A.id } });
    const r = await as(people.seller, A, () => messages.recordPreparedMessage({ clientId: c, templateId: null, context: {}, channel: "WHATSAPP", subject: "", body: "Hello" }));
    expect(r.ok).toBe(true);
    expect(await rawPrisma.clientMessage.findFirst({ where: { clientId: c } })).toMatchObject({ status: "PREPARED", channel: "WHATSAPP", emailOutboxId: null });
    expect(await rawPrisma.outboundMessage.count()).toBe(outbound);
    expect(await rawPrisma.emailOutbox.count({ where: { projectId: A.id } })).toBe(emails);
    // The database refuses a queued message on any channel but email.
    await expect(rawPrisma.clientMessage.create({ data: { projectId: A.id, clientId: c, channel: "WHATSAPP", status: "QUEUED", body: "x" } })).rejects.toThrow();
  });
});

describe("4. bulk email — prepared by one person, approved by another", () => {
  it("skips unknown consent, opt-outs, no address and duplicates; queues nothing until someone else approves", async () => {
    const t = await rawPrisma.clientMessageTemplate.findFirstOrThrow({ where: { projectId: A.id, status: "ACTIVE" } });
    const yes1 = await client(A, "Bulk Yes 1", [{ value: "yes1@example.test", consent: "OPTED_IN" }]);
    const yes2 = await client(A, "Bulk Yes 2", [{ value: "yes2@example.test", consent: "OPTED_IN" }]);
    const dup = await client(A, "Bulk Dup", [{ value: "YES1@example.test", consent: "OPTED_IN" }]);
    const unknown = await client(A, "Bulk Unknown", [{ value: "unknown@example.test", consent: "UNKNOWN" }]);
    const none = await client(A, "Bulk None");
    const foreign = await client(B, "Bulk Foreign", [{ value: "foreign@example.test", consent: "OPTED_IN" }]);
    const before = await rawPrisma.emailOutbox.count({ where: { projectId: A.id } });
    const prep = await as(people.admin, A, () => messages.prepareMessageBatch(t.id, [yes1, yes2, dup, unknown, none, foreign].map((clientId) => ({ clientId }))));
    expect(prep.ok).toBe(true);
    const batch = await rawPrisma.clientMessageBatch.findUniqueOrThrow({ where: { id: prep.batchId! } });
    // The other project's client is never listed or counted.
    expect(batch).toMatchObject({ status: "PENDING_APPROVAL", recipientCount: 5, eligibleCount: 2, skippedCount: 3 });
    expect(await rawPrisma.emailOutbox.count({ where: { projectId: A.id } })).toBe(before);

    // Not by the person who prepared it — in the action and in the database.
    expect((await as(people.admin, A, () => messages.approveMessageBatch(batch.id))).message).toMatch(/someone other/);
    await expect(rawPrisma.clientMessageBatch.update({ where: { id: batch.id }, data: { status: "QUEUED", decidedById: people.admin.userId } })).rejects.toThrow(/no_self_approval/);

    // Consent is checked again at approval: yes2 opts out meanwhile.
    await rawPrisma.clientChannel.updateMany({ where: { clientId: yes2 }, data: { consentStatus: "OPTED_OUT" } });
    const approved = await as(people.approver, A, () => messages.approveMessageBatch(batch.id));
    expect(approved.ok).toBe(true);
    const queued = await rawPrisma.emailOutbox.findMany({ where: { projectId: A.id, purpose: "CLIENT_MESSAGE", idempotencyKey: { startsWith: `batch:${batch.id}:` } } });
    expect(queued.map((q) => q.toAddress)).toEqual(["yes1@example.test"]);
    expect(await rawPrisma.clientMessage.count({ where: { batchId: batch.id, status: "SKIPPED" } })).toBe(4);
    // A second approval queues nothing more.
    expect((await as(people.approver, A, () => messages.approveMessageBatch(batch.id))).ok).toBe(false);
    expect(await rawPrisma.emailOutbox.count({ where: { idempotencyKey: { startsWith: `batch:${batch.id}:` } } })).toBe(1);
  });

  it("a batch older than 24 hours cannot be approved, and is closed as expired", async () => {
    const t = await rawPrisma.clientMessageTemplate.findFirstOrThrow({ where: { projectId: A.id, status: "ACTIVE" } });
    const c = await client(A, "Bulk Late", [{ value: "late@example.test", consent: "OPTED_IN" }]);
    const prep = await as(people.admin, A, () => messages.prepareMessageBatch(t.id, [{ clientId: c }]));
    await rawPrisma.clientMessageBatch.update({ where: { id: prep.batchId! }, data: { submittedAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect((await as(people.approver, A, () => messages.approveMessageBatch(prep.batchId!))).message).toMatch(/24 hours/);
    expect((await rawPrisma.clientMessageBatch.findUniqueOrThrow({ where: { id: prep.batchId! } })).status).toBe("EXPIRED");
    expect(await rawPrisma.emailOutbox.count({ where: { idempotencyKey: { startsWith: `batch:${prep.batchId}:` } } })).toBe(0);
  });

  it("the preparer cancels, an approver rejects with a reason; neither sends anything", async () => {
    const t = await rawPrisma.clientMessageTemplate.findFirstOrThrow({ where: { projectId: A.id, status: "ACTIVE" } });
    const c = await client(A, "Bulk Close", [{ value: "close@example.test", consent: "OPTED_IN" }]);
    const one = await as(people.admin, A, () => messages.prepareMessageBatch(t.id, [{ clientId: c }]));
    expect((await as(people.approver, A, () => messages.closeMessageBatch(one.batchId!, "CANCEL", ""))).ok).toBe(false);
    expect((await as(people.admin, A, () => messages.closeMessageBatch(one.batchId!, "CANCEL", ""))).ok).toBe(true);
    const two = await as(people.admin, A, () => messages.prepareMessageBatch(t.id, [{ clientId: c }]));
    expect((await as(people.approver, A, () => messages.closeMessageBatch(two.batchId!, "REJECT", ""))).ok).toBe(false);
    expect((await as(people.approver, A, () => messages.closeMessageBatch(two.batchId!, "REJECT", "Wrong wording"))).ok).toBe(true);
    expect(await rawPrisma.emailOutbox.count({ where: { OR: [{ idempotencyKey: { startsWith: `batch:${one.batchId}:` } }, { idempotencyKey: { startsWith: `batch:${two.batchId}:` } }] } })).toBe(0);
  });
});
