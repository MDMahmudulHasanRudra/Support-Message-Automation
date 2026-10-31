import type { Prisma } from "@prisma/client";
import { formatMinor, type LeadStage, type OrderStatus } from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * Commerce reads (COMMERCE.md). Through the project-scoped client, so every list and record is this
 * project's only. Money leaves here as strings (minor units and formatted), never as bigint, so it
 * crosses to the browser safely.
 */

export interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  status: string;
  category: string | null;
  categoryId: string | null;
  currency: string;
  priceMinor: string;
  price: string;
  trackInventory: boolean;
  stockQuantity: number;
  variantCount: number;
  imageUrl: string | null;
}

export async function listProducts(filter: { q?: string; status?: string; categoryId?: string; take?: number }): Promise<ProductRow[]> {
  const q = filter.q?.trim();
  const where: Prisma.ProductWhereInput = {
    ...(filter.status ? { status: filter.status as never } : { status: { not: "ARCHIVED" } }),
    ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const rows = await prisma.product.findMany({
    where,
    orderBy: { name: "asc" },
    take: Math.min(filter.take ?? 500, 5000),
    include: { category: { select: { name: true } }, _count: { select: { variants: true } } },
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    status: p.status,
    category: p.category?.name ?? null,
    categoryId: p.categoryId,
    currency: p.currency,
    priceMinor: p.priceMinor.toString(),
    price: formatMinor(p.priceMinor, p.currency),
    trackInventory: p.trackInventory,
    stockQuantity: p.stockQuantity,
    variantCount: p._count.variants,
    imageUrl: p.imageUrl,
  }));
}

export async function listCategories() {
  return prisma.productCategory.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true, name: true, _count: { select: { products: true } } } });
}

export async function getProduct(id: string) {
  const p = await prisma.product.findFirst({
    where: { id },
    include: {
      category: { select: { id: true, name: true } },
      variants: { orderBy: { createdAt: "asc" } },
      movements: { orderBy: { createdAt: "desc" }, take: 50, include: { variant: { select: { name: true } }, order: { select: { id: true, number: true } } } },
    },
  });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    sku: p.sku,
    status: p.status,
    categoryId: p.categoryId,
    currency: p.currency,
    priceMinor: p.priceMinor.toString(),
    compareAtMinor: p.compareAtMinor?.toString() ?? null,
    trackInventory: p.trackInventory,
    stockQuantity: p.stockQuantity,
    imageUrl: p.imageUrl,
    externalSource: p.externalSource,
    variants: p.variants.map((v) => ({
      id: v.id,
      name: v.name,
      sku: v.sku,
      priceMinor: v.priceMinor?.toString() ?? null,
      price: formatMinor(v.priceMinor ?? p.priceMinor, p.currency),
      stockQuantity: v.stockQuantity,
      isActive: v.isActive,
    })),
    movements: p.movements.map((m) => ({
      id: m.id,
      delta: m.delta,
      reason: m.reason,
      note: m.note,
      balanceAfter: m.balanceAfter,
      variant: m.variant?.name ?? null,
      order: m.order ? { id: m.order.id, number: m.order.number } : null,
      actorUsername: m.actorUsername,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export interface OrderRow {
  id: string;
  number: string;
  customerName: string;
  customerPhone: string | null;
  status: OrderStatus;
  paymentStatus: string;
  total: string;
  itemCount: number;
  channel: string | null;
  createdAt: string;
}

export async function listOrders(filter: { status?: string; q?: string; take?: number }): Promise<{ rows: OrderRow[]; counts: Record<string, number> }> {
  const q = filter.q?.trim();
  const search: Prisma.CommerceOrderWhereInput = q
    ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { customerName: { contains: q, mode: "insensitive" } }, { customerPhone: { contains: q } }] }
    : {};
  const [rows, grouped] = await Promise.all([
    prisma.commerceOrder.findMany({
      where: { ...search, ...(filter.status ? { status: filter.status as never } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(filter.take ?? 200, 5000),
      include: { _count: { select: { items: true } } },
    }),
    prisma.commerceOrder.groupBy({ by: ["status"], where: search, _count: { _all: true } }),
  ]);
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  return {
    rows: rows.map((o) => ({
      id: o.id,
      number: o.number,
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      status: o.status as OrderStatus,
      paymentStatus: o.paymentStatus,
      total: formatMinor(o.totalMinor, o.currency),
      itemCount: o._count.items,
      channel: o.channel,
      createdAt: o.createdAt.toISOString(),
    })),
    counts,
  };
}

export async function getOrder(id: string) {
  const o = await prisma.commerceOrder.findFirst({
    where: { id },
    include: {
      items: { orderBy: { id: "asc" } },
      events: { orderBy: { createdAt: "desc" }, take: 100 },
      client: { select: { id: true, name: true, code: true } },
      shipments: { orderBy: { createdAt: "desc" }, include: { events: { orderBy: { createdAt: "desc" }, take: 20 } } },
    },
  });
  if (!o) return null;
  const pushes = await prisma.shopSyncRun.findMany({ where: { kind: "PUSH_ORDER", orderId: o.id }, orderBy: { startedAt: "desc" }, include: { connection: { select: { provider: true } } } });
  return {
    id: o.id,
    number: o.number,
    externalSource: o.externalSource,
    externalId: o.externalId,
    shipments: o.shipments.map((s) => ({
      id: s.id,
      provider: s.provider,
      status: s.status,
      providerStatus: s.providerStatus,
      invoice: s.invoice,
      consignmentId: s.consignmentId,
      trackingCode: s.trackingCode,
      cod: formatMinor(s.codAmountMinor, s.currency),
      recipientName: s.recipientName,
      recipientPhone: s.recipientPhone,
      recipientAddress: s.recipientAddress,
      error: s.error,
      lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      events: s.events.map((e) => ({ id: e.id, status: e.status, providerStatus: e.providerStatus, note: e.note, actorUsername: e.actorUsername, createdAt: e.createdAt.toISOString() })),
    })),
    pushes: pushes.map((r) => ({ id: r.id, provider: r.connection.provider, status: r.status, externalId: r.externalId, errors: (r.errors as string[] | null) ?? [], startedAt: r.startedAt.toISOString() })),
    status: o.status as OrderStatus,
    paymentStatus: o.paymentStatus,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    customerEmail: o.customerEmail,
    shippingAddress: o.shippingAddress,
    channel: o.channel,
    notes: o.notes,
    client: o.client,
    currency: o.currency,
    subtotal: formatMinor(o.subtotalMinor, o.currency),
    discount: formatMinor(o.discountMinor, o.currency),
    shipping: formatMinor(o.shippingMinor, o.currency),
    total: formatMinor(o.totalMinor, o.currency),
    paid: formatMinor(o.paidMinor, o.currency),
    due: formatMinor(o.totalMinor > o.paidMinor ? o.totalMinor - o.paidMinor : BigInt(0), o.currency),
    dueMinor: (o.totalMinor > o.paidMinor ? o.totalMinor - o.paidMinor : BigInt(0)).toString(),
    discountMinor: o.discountMinor.toString(),
    shippingMinor: o.shippingMinor.toString(),
    createdByUsername: o.createdByUsername,
    createdAt: o.createdAt.toISOString(),
    items: o.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      variantId: i.variantId,
      name: i.name,
      sku: i.sku,
      quantity: i.quantity,
      unitPriceMinor: i.unitPriceMinor.toString(),
      unitPrice: formatMinor(i.unitPriceMinor, o.currency),
      total: formatMinor(i.totalMinor, o.currency),
    })),
    events: o.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      detail: e.detail as Record<string, unknown> | null,
      actorUsername: e.actorUsername,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

/** Products an order can be made of: active ones, with their active variants. */
export async function orderableProducts() {
  const rows = await prisma.product.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    take: 2000,
    include: { variants: { where: { isActive: true }, orderBy: { createdAt: "asc" } } },
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    currency: p.currency,
    priceMinor: p.priceMinor.toString(),
    trackInventory: p.trackInventory,
    stockQuantity: p.stockQuantity,
    variants: p.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku, priceMinor: (v.priceMinor ?? p.priceMinor).toString(), stockQuantity: v.stockQuantity })),
  }));
}

export interface LeadCard {
  id: string;
  name: string;
  phone: string | null;
  company: string | null;
  source: string;
  stage: LeadStage;
  value: string | null;
  nextFollowUpAt: string | null;
  overdue: boolean;
  clientName: string | null;
  updatedAt: string;
}

export async function listLeads(filter: { q?: string; includeClosed?: boolean }): Promise<LeadCard[]> {
  const q = filter.q?.trim();
  const now = new Date();
  const rows = await prisma.salesLead.findMany({
    where: {
      ...(filter.includeClosed ? {} : { stage: { notIn: ["WON", "LOST"] } }),
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { company: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ nextFollowUpAt: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }],
    take: 2000,
    include: { client: { select: { name: true } } },
  });
  return rows.map((l) => ({
    id: l.id,
    name: l.name,
    phone: l.phone,
    company: l.company,
    source: l.source,
    stage: l.stage as LeadStage,
    value: l.valueMinor !== null && l.currency ? formatMinor(l.valueMinor, l.currency) : null,
    nextFollowUpAt: l.nextFollowUpAt?.toISOString() ?? null,
    overdue: Boolean(l.nextFollowUpAt && l.nextFollowUpAt < now && l.stage !== "WON" && l.stage !== "LOST"),
    clientName: l.client?.name ?? null,
    updatedAt: l.updatedAt.toISOString(),
  }));
}

export async function getLead(id: string) {
  const l = await prisma.salesLead.findFirst({
    where: { id },
    include: { events: { orderBy: { createdAt: "desc" }, take: 100 }, client: { select: { id: true, name: true } }, wonOrder: { select: { id: true, number: true } } },
  });
  if (!l) return null;
  return {
    ...l,
    valueMinor: l.valueMinor?.toString() ?? null,
    value: l.valueMinor !== null && l.currency ? formatMinor(l.valueMinor, l.currency) : null,
    nextFollowUpAt: l.nextFollowUpAt?.toISOString() ?? null,
    closedAt: l.closedAt?.toISOString() ?? null,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
    events: l.events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  };
}

/** Clients to link an order or a lead to (Client Management may be off: then none). */
export async function clientOptions(): Promise<Array<{ id: string; name: string; code: string }>> {
  try {
    return await prisma.client.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, take: 2000, select: { id: true, name: true, code: true } });
  } catch {
    return [];
  }
}

// ── Integrations (COMMERCE_INTEGRATIONS.md) ───────────────────────────────────────────────────────

export async function listShipments(filter: { status?: string; q?: string }) {
  const q = filter.q?.trim();
  const rows = await prisma.shipment.findMany({
    where: {
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(q ? { OR: [{ invoice: { contains: q, mode: "insensitive" } }, { consignmentId: { contains: q } }, { recipientPhone: { contains: q } }, { recipientName: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { order: { select: { id: true, number: true } } },
  });
  const grouped = await prisma.shipment.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  return {
    counts,
    rows: rows.map((s) => ({
      id: s.id,
      provider: s.provider,
      status: s.status,
      providerStatus: s.providerStatus,
      invoice: s.invoice,
      consignmentId: s.consignmentId,
      cod: formatMinor(s.codAmountMinor, s.currency),
      recipientName: s.recipientName,
      recipientPhone: s.recipientPhone,
      order: s.order,
      error: s.error,
      lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

/** The project's courier connections. Never the credentials. */
export async function courierConnections() {
  const rows = await prisma.courierConnection.findMany({ orderBy: { provider: "asc" } });
  return rows.map((c) => ({
    id: c.id,
    provider: c.provider,
    label: c.label,
    sandbox: c.sandbox,
    isActive: c.isActive,
    settings: (c.settings ?? {}) as { storeId?: string; weight?: string; pickupStoreId?: string },
    lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
    lastCheckOk: c.lastCheckOk,
    lastError: c.lastError,
  }));
}

/** One shop connection, its webhook address and recent runs. Never the credentials or the secret. */
export async function shopConnectionView(provider: "WOOCOMMERCE" | "SHOPIFY", origin: string | null) {
  const c = await prisma.shopConnection.findFirst({ where: { provider }, include: { runs: { orderBy: { startedAt: "desc" }, take: 15 } } });
  if (!c) return null;
  const imported = await prisma.product.count({ where: { externalSource: provider } });
  const importedOrders = await prisma.commerceOrder.count({ where: { externalSource: provider } });
  return {
    id: c.id,
    label: c.label,
    shopUrl: c.shopUrl,
    currency: c.currency,
    isActive: c.isActive,
    importOrders: c.importOrders,
    hasWebhookSecret: Boolean(c.webhookSecretCiphertext),
    webhookUrl: origin ? `${origin}/api/shops/${c.webhookKey}` : null,
    lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
    lastSyncOk: c.lastSyncOk,
    lastError: c.lastError,
    lastWebhookAt: c.lastWebhookAt?.toISOString() ?? null,
    imported,
    importedOrders,
    runs: c.runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      created: r.created,
      updated: r.updated,
      unchanged: r.unchanged,
      skipped: r.skipped,
      failed: r.failed,
      errors: (r.errors as string[] | null) ?? [],
      actorUsername: r.actorUsername,
      orderId: r.orderId,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
  };
}
