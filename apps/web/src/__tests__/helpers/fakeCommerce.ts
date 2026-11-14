import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the Commerce API that behaves as Commerce's own code does (E-Commerce/backend
 * ProvisioningService.cs + IntegrationEndpoints.cs, contract v1), with response bodies copied from a real
 * Commerce run (14 Nov 2026). It exists so the adapter is tested against Commerce's actual rules, not against
 * the adapter's own assumptions:
 *   - provisioning needs a valid HMAC-SHA256 over `{timestamp}.{rawBody}` within five minutes, else 401;
 *   - a (platform, customer, project) is provisioned ONCE: a second call returns the same ids and `apiKey: null`;
 *   - linking a workspace already linked elsewhere is 409; an unknown one is 404;
 *   - every host read needs the issued key and an Active connection (403 INTEGRATION_DISABLED otherwise).
 * Knobs (`fake.contractVersion`, `fake.connection(...)`) let a test make Commerce say something else.
 */

export interface FakeConnection {
  hostCustomerId: string;
  hostProjectId: string;
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  status: "Active" | "Disabled" | "Revoked";
  apiKey: string;
}

const PRODUCTS = [
  {
    id: "6bc7a01f-63de-4b3e-95b8-489dfa0fa06f",
    name: "Anker 737 Power Bank 24K",
    sku: "ANK-737",
    shortDescription: "24,000mAh 140W fast-charging power bank with smart display.",
    category: "Accessories",
    brand: "Anker",
    price: 103.55,
    compareAtPrice: null,
    currencyCode: "USD",
    available: 70,
    inStock: true,
    imageUrl: null,
    status: "Active",
    listPrice: 109,
    offer: { id: "7db8cd90-1170-4020-995b-bb6a9d6fe6c9", name: "Accessory Bundle", type: "Percentage", value: 5, startsAtUtc: "2026-11-09T10:22:24Z", endsAtUtc: "2026-12-09T10:22:24Z", appliesTo: "Accessories", productId: null, categoryId: "c1" },
  },
  {
    id: "2de62a6d-8c19-4cf8-b6cf-f5f4a290a693",
    name: "Anker Soundcore Space One",
    sku: "ANK-SPACE1",
    shortDescription: "Adaptive noise cancelling over-ear headphones, 40h battery.",
    category: "Audio",
    brand: "Anker",
    price: 84,
    compareAtPrice: 129,
    currencyCode: "USD",
    available: 0,
    inStock: false,
    imageUrl: null,
    status: "Active",
    listPrice: 99,
    offer: null,
  },
];

const CUSTOMERS = [
  { id: "3ce335e7-e06d-45d8-af0b-43189a31da94", displayName: "Lucas Martin", email: "lucas.martin@example.com", phone: "+33 6 12 34 56 78", companyName: null, isBusiness: false, tags: "retail", orderCount: 1, totalSpent: 1499, lastOrderAtUtc: "2026-10-31T10:22:24Z", externalSource: null, externalId: null },
  // Two customers sharing one number: an order lookup by that number must unlock nothing.
  { id: "11111111-1111-4111-8111-111111111111", displayName: "Shared A", email: null, phone: "+8801711000222", companyName: null, isBusiness: false, tags: null, orderCount: 1, totalSpent: 10, lastOrderAtUtc: null, externalSource: null, externalId: null },
  { id: "22222222-2222-4222-8222-222222222222", displayName: "Shared B", email: null, phone: "01711000222", companyName: null, isBusiness: false, tags: null, orderCount: 1, totalSpent: 10, lastOrderAtUtc: null, externalSource: null, externalId: null },
];
const ORDERS: Record<string, unknown[]> = {
  "3ce335e7-e06d-45d8-af0b-43189a31da94": [
    { id: "30ddffb5-9d6b-4e85-92e9-b1690242ffb1", orderNumber: "ORD-1006", customerName: "Lucas Martin", status: "Processing", paymentStatus: "Partial", fulfillmentStatus: "Unfulfilled", grandTotal: 1499, paidTotal: 749.5, currencyCode: "USD", placedAtUtc: "2026-10-31T10:22:24Z", shippedAtUtc: null, deliveredAtUtc: null, items: null, invoiceNumber: null },
  ],
  "11111111-1111-4111-8111-111111111111": [{ id: "o1", orderNumber: "ORD-9001", customerName: "Shared A", status: "Pending", paymentStatus: "Unpaid", fulfillmentStatus: "Unfulfilled", grandTotal: 10, paidTotal: 0, currencyCode: "USD", placedAtUtc: "2026-11-01T00:00:00Z", shippedAtUtc: null, deliveredAtUtc: null }],
};

export class FakeCommerce {
  readonly secret = `fake-secret-${randomUUID()}`;
  /** Workspaces that exist in this Commerce and may be linked. */
  readonly workspaces = new Set<string>([randomUUID(), randomUUID(), randomUUID()]);
  readonly connections: FakeConnection[] = [];
  /** What provisioning reports as `apiContractVersion`. */
  contractVersion = "v1";
  /** Every request this Commerce received, method + path. */
  readonly requests: string[] = [];
  private server: Server | null = null;
  url = "";

  workspace(i: number): string {
    return [...this.workspaces][i]!;
  }

  connection(hostProjectId: string): FakeConnection | undefined {
    return this.connections.find((c) => c.hostProjectId === hostProjectId);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body }) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    const url = new URL(req.url ?? "/", "http://x");
    this.requests.push(`${req.method} ${url.pathname}`);
    const raw = await new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });
    if (req.method === "POST" && url.pathname === "/api/v1/integrations/provision") return this.provision(req, raw);

    const host = url.pathname.match(/^\/api\/v1\/integrations\/(.+)$/);
    if (!host || req.method !== "GET") return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
    const key = req.headers["x-api-key"];
    const conn = this.connections.find((c) => c.apiKey === key);
    if (!conn) return { status: 401 };
    if (conn.status !== "Active") return { status: 403, body: { error: { code: "INTEGRATION_DISABLED", message: "The host connection is not active." } } };
    const path = host[1]!;
    if (path === "products/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const size = Number(url.searchParams.get("pageSize") ?? 20);
      const items = PRODUCTS.filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.shortDescription.toLowerCase().includes(q)).map(summary);
      return { status: 200, body: { items: items.slice(0, size), page: 1, pageSize: size, totalCount: items.length, totalPages: Math.ceil(items.length / size) } };
    }
    const product = path.match(/^products\/([0-9a-f-]{36})$/);
    if (product) {
      const p = PRODUCTS.find((x) => x.id === product[1]);
      if (!p) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Product not found." } } };
      return {
        status: 200,
        body: {
          id: p.id, name: p.name, sku: p.sku, shortDescription: p.shortDescription, description: p.shortDescription, category: p.category, brand: p.brand, status: "Active",
          effectivePrice: p.price, compareAtPrice: p.compareAtPrice, currencyCode: p.currencyCode, inStock: p.inStock,
          variants: [{ id: randomUUID(), name: "Default", sku: p.sku, attributesJson: null, effectivePrice: p.price, listPrice: p.listPrice, available: p.available, isActive: true }],
          images: [], activeOffers: p.offer ? [p.offer] : [], checkedAtUtc: new Date().toISOString(),
        },
      };
    }
    if (path === "offers/active") return { status: 200, body: PRODUCTS.flatMap((p) => (p.offer ? [p.offer] : [])) };
    if (path === "customers/search") {
      const q = url.searchParams.get("q") ?? "";
      const items = CUSTOMERS.filter((c) => !q || (c.phone ?? "").replace(/\D/g, "").includes(q) || (c.phone ?? "").includes(q));
      return { status: 200, body: { items, page: 1, pageSize: 20, totalCount: items.length, totalPages: 1 } };
    }
    const orders = path.match(/^customers\/([0-9a-f-]{36})\/orders$/);
    if (orders) return { status: 200, body: ORDERS[orders[1]!] ?? [] };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
  }

  private provision(req: IncomingMessage, raw: string): { status: number; body?: unknown } {
    const ts = String(req.headers["x-getassist-timestamp"] ?? "");
    const sig = String(req.headers["x-getassist-signature"] ?? "");
    const expected = createHmac("sha256", this.secret).update(`${ts}.${raw}`).digest("hex");
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
    const valid = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!fresh || !valid) return { status: 401, body: { error: { code: "UNAUTHORIZED", message: "The provisioning signature is invalid or has expired." } } };
    const body = JSON.parse(raw) as { hostCustomerId: string; hostProjectId: string; commerceWorkspaceId: string | null };
    const existing = this.connections.find((c) => c.hostCustomerId === body.hostCustomerId && c.hostProjectId === body.hostProjectId);
    if (existing) {
      return { status: 200, body: { tenantId: existing.tenantId, workspaceId: existing.workspaceId, connectionId: existing.connectionId, workspaceReference: existing.workspaceId, status: existing.status, apiContractVersion: this.contractVersion, apiKey: null, note: "This project is already provisioned. No duplicate workspace was created." } };
    }
    let workspaceId: string;
    if (body.commerceWorkspaceId) {
      if (!this.workspaces.has(body.commerceWorkspaceId)) return { status: 404, body: { error: { code: "NOT_FOUND", message: "The Commerce workspace to link was not found." } } };
      if (this.connections.some((c) => c.workspaceId === body.commerceWorkspaceId)) return { status: 409, body: { error: { code: "CONFLICT", message: "That Commerce workspace is already linked to another host project." } } };
      workspaceId = body.commerceWorkspaceId;
    } else {
      workspaceId = randomUUID();
      this.workspaces.add(workspaceId);
    }
    const conn: FakeConnection = { hostCustomerId: body.hostCustomerId, hostProjectId: body.hostProjectId, tenantId: randomUUID(), workspaceId, connectionId: randomUUID(), status: "Active", apiKey: `cmk_${randomUUID().slice(0, 10)}_${randomUUID().replace(/-/g, "")}` };
    this.connections.push(conn);
    return { status: 200, body: { tenantId: conn.tenantId, workspaceId, connectionId: conn.connectionId, workspaceReference: workspaceId, status: "Active", apiContractVersion: this.contractVersion, apiKey: conn.apiKey, note: "Store this API key now. It is shown only once." } };
  }
}

function summary(p: (typeof PRODUCTS)[number]) {
  const rest: Record<string, unknown> = { ...p };
  delete rest.listPrice;
  delete rest.offer;
  return rest;
}
