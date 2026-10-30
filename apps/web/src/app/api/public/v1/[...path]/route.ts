import { NextResponse, type NextRequest } from "next/server";
import { API_SCOPE_FEATURE, isLeadSource, normalizeCurrencyCode, toMinor, type ApiScope } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { runWithProject } from "@/server/projectContext";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { apiRateLimited, authenticateApiKey, type ApiCaller } from "@/server/integrationHub/apiKeys";
import { emitWebhookEvent } from "@/server/integrationHub/webhooks";

/**
 * The public API, v1 (INTEGRATION_HUB.md §API). Authenticated by a project API key; every query runs
 * inside that key's project through the scoped client, so a key can never read another project. Each
 * route needs its scope AND the module it reads to be on.
 *
 *   GET  /api/public/v1/products            products:read
 *   GET  /api/public/v1/orders              orders:read     (?status=&since=&page=)
 *   GET  /api/public/v1/orders/<number>     orders:read
 *   GET  /api/public/v1/shipments           shipments:read  (?order=<number>)
 *   POST /api/public/v1/leads               leads:write
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const money = (minor: bigint | null) => (minor === null ? null : (Number(minor) / 100).toFixed(2));

async function guard(request: NextRequest, scope: ApiScope): Promise<ApiCaller | NextResponse> {
  const caller = await authenticateApiKey(request.headers.get("authorization"));
  if ("error" in caller) return json(caller.status, { error: caller.error });
  if (apiRateLimited(caller.keyId)) return json(429, { error: "Too many requests; at most 120 a minute per key." });
  if (!caller.scopes.includes(scope)) return json(403, { error: `This key does not have the ${scope} scope.` });
  const disabled = await disabledFeaturesFor(caller.project.id);
  if (disabled.has("API_ACCESS")) return json(403, { error: "The API is switched off for this workspace." });
  if (disabled.has(API_SCOPE_FEATURE[scope] as never)) return json(404, { error: "That module is not enabled for this workspace." });
  return caller;
}

const page = (request: NextRequest) => Math.max(1, Math.min(1000, Math.trunc(Number(request.nextUrl.searchParams.get("page") ?? "1")) || 1));

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const { path } = await params;
  const [resource, id] = path;
  try {
    if (resource === "products" && !id) {
      const caller = await guard(request, "products:read");
      if (caller instanceof NextResponse) return caller;
      return await runWithProject(caller.project, async () => {
        const q = request.nextUrl.searchParams.get("search")?.trim();
        const rows = await prisma.product.findMany({
          where: { status: { not: "ARCHIVED" }, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] } : {}) },
          orderBy: { name: "asc" },
          skip: (page(request) - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          include: { category: { select: { name: true } }, variants: { where: { isActive: true } } },
        });
        return json(200, {
          data: rows.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            status: p.status,
            category: p.category?.name ?? null,
            currency: p.currency,
            price: money(p.priceMinor),
            trackStock: p.trackInventory,
            stock: p.trackInventory && p.variants.length === 0 ? p.stockQuantity : null,
            variants: p.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku, price: money(v.priceMinor ?? p.priceMinor), stock: p.trackInventory ? v.stockQuantity : null })),
            updatedAt: p.updatedAt.toISOString(),
          })),
          page: page(request),
        });
      });
    }
    if (resource === "orders") {
      const caller = await guard(request, "orders:read");
      if (caller instanceof NextResponse) return caller;
      return await runWithProject(caller.project, async () => {
        const shape = (o: { id: string; number: string; status: string; paymentStatus: string; currency: string; subtotalMinor: bigint; discountMinor: bigint; shippingMinor: bigint; totalMinor: bigint; paidMinor: bigint; customerName: string; customerPhone: string | null; customerEmail: string | null; shippingAddress: string | null; channel: string | null; externalSource: string | null; createdAt: Date; items: Array<{ name: string; sku: string | null; quantity: number; unitPriceMinor: bigint; totalMinor: bigint }> }) => ({
          id: o.id,
          number: o.number,
          status: o.status,
          paymentStatus: o.paymentStatus,
          currency: o.currency,
          subtotal: money(o.subtotalMinor),
          discount: money(o.discountMinor),
          shipping: money(o.shippingMinor),
          total: money(o.totalMinor),
          paid: money(o.paidMinor),
          customer: { name: o.customerName, phone: o.customerPhone, email: o.customerEmail, address: o.shippingAddress },
          channel: o.channel,
          source: o.externalSource,
          items: o.items.map((i) => ({ name: i.name, sku: i.sku, quantity: i.quantity, unitPrice: money(i.unitPriceMinor), total: money(i.totalMinor) })),
          createdAt: o.createdAt.toISOString(),
        });
        if (id) {
          const o = await prisma.commerceOrder.findFirst({ where: { number: id }, include: { items: true } });
          return o ? json(200, { data: shape(o) }) : json(404, { error: "No order with that number." });
        }
        const status = request.nextUrl.searchParams.get("status")?.toUpperCase();
        const sinceRaw = request.nextUrl.searchParams.get("since");
        const since = sinceRaw ? new Date(sinceRaw) : null;
        if (since && Number.isNaN(since.getTime())) return json(400, { error: "since must be an ISO date." });
        const rows = await prisma.commerceOrder.findMany({
          where: { ...(status ? { status: status as never } : {}), ...(since ? { updatedAt: { gte: since } } : {}) },
          orderBy: { createdAt: "desc" },
          skip: (page(request) - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          include: { items: true },
        });
        return json(200, { data: rows.map(shape), page: page(request) });
      });
    }
    if (resource === "shipments" && !id) {
      const caller = await guard(request, "shipments:read");
      if (caller instanceof NextResponse) return caller;
      return await runWithProject(caller.project, async () => {
        const orderNumber = request.nextUrl.searchParams.get("order")?.trim();
        const rows = await prisma.shipment.findMany({
          where: orderNumber ? { order: { number: orderNumber } } : {},
          orderBy: { createdAt: "desc" },
          skip: (page(request) - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          include: { order: { select: { number: true } } },
        });
        return json(200, {
          data: rows.map((s) => ({ id: s.id, order: s.order.number, courier: s.provider, status: s.status, courierStatus: s.providerStatus, consignmentId: s.consignmentId, trackingCode: s.trackingCode, cod: money(s.codAmountMinor), currency: s.currency, updatedAt: s.updatedAt.toISOString() })),
          page: page(request),
        });
      });
    }
    return json(404, { error: "Unknown endpoint." });
  } catch (err) {
    console.error("[api] request failed", (err as Error).name);
    return json(500, { error: "The request could not be completed." });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const { path } = await params;
  if (path.length !== 1 || path[0] !== "leads") return json(404, { error: "Unknown endpoint." });
  const caller = await guard(request, "leads:write");
  if (caller instanceof NextResponse) return caller;
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 20_000) return json(413, { error: "Body too large." });
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(400, { error: "Send a JSON body." });
  }
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) || null : null);
  const name = text(body.name, 160);
  if (!name) return json(422, { error: "name is required." });
  const valueRaw = body.value === undefined || body.value === null ? "" : String(body.value);
  const value = valueRaw ? toMinor(valueRaw) : null;
  if (valueRaw && value === null) return json(422, { error: "value must be a number with at most two decimals." });
  const currency = valueRaw ? normalizeCurrencyCode(String(body.currency ?? "")) : null;
  if (valueRaw && !currency) return json(422, { error: "currency (e.g. BDT) is required with value." });
  try {
    return await runWithProject(caller.project, async () => {
      const lead = await prisma.$transaction(async (tx) => {
        const row = await tx.salesLead.create({
          data: {
            name,
            phone: text(body.phone, 40),
            email: text(body.email, 200),
            company: text(body.company, 200),
            source: isLeadSource(body.source) ? body.source : "OTHER",
            currency,
            valueMinor: value,
            notes: text(body.notes, 4000),
            createdByUsername: `api:${caller.keyId.slice(-6)}`,
          },
          select: { id: true, name: true, stage: true, source: true },
        });
        await tx.salesLeadEvent.create({ data: { leadId: row.id, kind: "CREATED", toStage: "NEW", note: "Created through the API", actorUsername: `api:${caller.keyId.slice(-6)}` } });
        return row;
      });
      await emitWebhookEvent("lead.created", { leadId: lead.id, name: lead.name, stage: lead.stage, source: lead.source, via: "api" });
      return json(201, { data: { id: lead.id, stage: lead.stage } });
    });
  } catch (err) {
    console.error("[api] lead create failed", (err as Error).name);
    return json(500, { error: "The lead could not be created." });
  }
}
