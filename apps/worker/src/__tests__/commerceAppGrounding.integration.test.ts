import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, encryptSecret, prisma as rawPrisma } from "@support-automation/db";
import type { AiCommerceSwitches } from "@support-automation/shared";
import { withProject } from "../project/context.js";
import { findCommerceGrounding } from "../aiFallback/commerceContext.js";
import { FakeCommerce } from "./helpers/fakeCommerce.js";

/**
 * The AI's commerce grounding with a connected Commerce Business App (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md).
 * Proves, against a real database and a Commerce that behaves as Commerce does:
 *   - an ACTIVE installation grounds the AI in Commerce's live price, regular price, stock and the offer Commerce
 *     applies — as reference entries, never as a reply;
 *   - a disabled installation, or a held project, is no source at all: not one request reaches Commerce;
 *   - with every commerce switch off nothing is asked of Commerce either;
 *   - another project's installation is never used.
 */

const tag = randomUUID().slice(0, 8);
const commerce = new FakeCommerce();
const ON: AiCommerceSwitches = { commerceProductAnswers: true, commerceOrderAnswers: true, commerceDeliveryAnswers: false, commerceShowStockCount: true, commerceHandoverRequests: true };
const OFF: AiCommerceSwitches = { commerceProductAnswers: false, commerceOrderAnswers: false, commerceDeliveryAnswers: false, commerceShowStockCount: false, commerceHandoverRequests: false };
let project = "";
let other = "";

beforeAll(async () => {
  await commerce.start();
  process.env.COMMERCE_API_URL = commerce.url;
  project = (await createProjectWithDefaults({ name: `AI Commerce ${tag}`, slug: `ai-commerce-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: null }, rawPrisma)).id;
  other = (await createProjectWithDefaults({ name: `AI Commerce other ${tag}`, slug: `ai-commerce-o-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: null }, rawPrisma)).id;
  // A connection Commerce already holds for this project, and the key the host stored for it at connect time.
  const workspaceId = commerce.workspace(0);
  const apiKey = `cmk_${tag}ab_${randomUUID().replace(/-/g, "")}`;
  commerce.connections.push({ hostCustomerId: "founding", hostProjectId: project, tenantId: randomUUID(), workspaceId, connectionId: randomUUID(), status: "Active", apiKey });
  await rawPrisma.projectAppInstallation.create({
    data: { projectId: project, appKey: "commerce", status: "ACTIVE", contractVersion: "v1", externalWorkspaceId: workspaceId, lastConnectedAt: new Date(), credentialCiphertext: encryptSecret(apiKey), credentialHint: apiKey.slice(0, 14) },
  });
});

afterAll(async () => {
  await commerce.stop();
  delete process.env.COMMERCE_API_URL;
  await rawPrisma.projectAppInstallation.deleteMany({ where: { projectId: { in: [project, other] } } });
});

const ground = (projectId: string, text: string, switches = ON) => withProject(projectId, () => findCommerceGrounding({ text, switches, customerPhone: null }));

describe("AI grounding from a connected Commerce app", () => {
  it("quotes Commerce's live price, regular price, stock and applied offer as reference entries", async () => {
    const g = await ground(project, "Do you have the Anker power bank? How much is it?");
    const entry = g.snippets.find((s) => s.id === "commerce-app:product:6bc7a01f-63de-4b3e-95b8-489dfa0fa06f");
    expect(entry?.title).toBe("Product: Anker 737 Power Bank 24K");
    expect(entry?.answer).toContain("Price now: USD 103.55 (regular price USD 109.00).");
    expect(entry?.answer).toContain("Availability: 70 in stock.");
    expect(entry?.answer).toContain("Offer applied: Accessory Bundle (5% off)");
    expect(entry?.answer).toContain("(Live from Commerce at");
    // The figure check later compares a reply's amounts against exactly this text.
    expect(g.groundingText).toContain("USD 103.55");
    const headphones = g.snippets.find((s) => s.title === "Product: Anker Soundcore Space One");
    expect(headphones?.answer).toContain("Availability: out of stock.");
    expect(commerce.requests.filter((r) => r.startsWith("GET /api/v1/integrations/products/")).length).toBeGreaterThan(0);
  });

  it("asks Commerce nothing while every commerce switch is off", async () => {
    const before = commerce.requests.length;
    expect((await ground(project, "Anker power bank price?", OFF)).snippets).toEqual([]);
    expect(commerce.requests.length).toBe(before);
  });

  it("never uses another project's installation", async () => {
    const before = commerce.requests.length;
    expect((await ground(other, "Anker power bank price?")).snippets.filter((s) => s.id.startsWith("commerce-app:"))).toEqual([]);
    expect(commerce.requests.length).toBe(before);
  });

  it("a disabled installation or a held project is no source: not one request reaches Commerce", async () => {
    await rawPrisma.projectAppInstallation.updateMany({ where: { projectId: project }, data: { status: "DISABLED", disabledAt: new Date() } });
    let before = commerce.requests.length;
    expect((await ground(project, "Anker power bank price?")).snippets.filter((s) => s.id.startsWith("commerce-app:"))).toEqual([]);
    expect(commerce.requests.length).toBe(before);

    await rawPrisma.projectAppInstallation.updateMany({ where: { projectId: project }, data: { status: "ACTIVE", disabledAt: null } });
    await rawPrisma.project.update({ where: { id: project }, data: { billingHoldAt: new Date() } });
    before = commerce.requests.length;
    expect((await ground(project, "Anker power bank price?")).snippets.filter((s) => s.id.startsWith("commerce-app:"))).toEqual([]);
    expect(commerce.requests.length).toBe(before);
    await rawPrisma.project.update({ where: { id: project }, data: { billingHoldAt: null } });
  });

  it("Commerce refusing the key adds nothing — never an invented product", async () => {
    commerce.connections[0]!.status = "Disabled";
    try {
      expect((await ground(project, "Anker power bank price?")).snippets.filter((s) => s.id.startsWith("commerce-app:"))).toEqual([]);
    } finally {
      commerce.connections[0]!.status = "Active";
    }
  });
});
