import { decryptSecret } from "@support-automation/db";
import { formatMinor, formatOrderNumber, SHOP_LABELS, type ShopOrderRecord, type ShopProductRecord, type ShopProvider } from "@support-automation/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { emitWebhookEvent, orderEventData } from "@/server/integrationHub/webhooks";
import { ProviderError, ProviderUnknownOutcome } from "./http";
import { shopClient, type ShopClient, type ShopCredentials, type ShopPage } from "./shopClients";

/**
 * Applying shop records to the catalogue and the order list (COMMERCE_INTEGRATIONS.md §Shops). Always
 * inside a project (scoped client). Rules:
 *   - A product is matched by (shop, its id), never by name or SKU; a SKU another product already uses is
 *     left off the import (counted), never stolen.
 *   - The shop owns imported stock: a different figure is written as a SYNC movement, so stock history
 *     still explains every change. Imported orders never move stock here.
 *   - A variant the shop no longer lists is hidden, never deleted (old orders point at it).
 *   - An imported order keeps our own number and records the shop's; later imports update its status and
 *     payment state only.
 */

type Tx = Prisma.TransactionClient;
export type ApplyOutcome = "CREATED" | "UPDATED" | "UNCHANGED" | "SKIPPED";

export async function clientForConnection(connectionId: string): Promise<{ client: ShopClient; provider: ShopProvider; currency: string | null; id: string; importOrders: boolean } | { refused: string }> {
  const c = await prisma.shopConnection.findFirst({ where: { id: connectionId } });
  if (!c) return { refused: "That shop connection no longer exists." };
  if (!c.isActive) return { refused: `${SHOP_LABELS[c.provider]} is switched off for this project.` };
  let credentials: ShopCredentials;
  try {
    credentials = JSON.parse(decryptSecret(c.credentialsCiphertext)) as ShopCredentials;
  } catch {
    return { refused: `The saved ${SHOP_LABELS[c.provider]} credentials cannot be read. Enter them again.` };
  }
  return { client: shopClient(c.provider, c.shopUrl, credentials), provider: c.provider, currency: c.currency, id: c.id, importOrders: c.importOrders };
}

async function categoryId(tx: Tx, projectId: string, name: string | undefined): Promise<string | null> {
  const clean = name?.trim().slice(0, 120);
  if (!clean) return null;
  const row = await tx.productCategory.upsert({ where: { projectId_name: { projectId, name: clean } }, create: { name: clean }, update: {}, select: { id: true } });
  return row.id;
}

async function syncStock(tx: Tx, args: { productId: string; variantId: string | null; current: number; next: number; actor: string; provider: ShopProvider }) {
  if (args.next === args.current) return;
  if (args.variantId) await tx.productVariant.update({ where: { id: args.variantId }, data: { stockQuantity: args.next } });
  else await tx.product.update({ where: { id: args.productId }, data: { stockQuantity: args.next } });
  await tx.inventoryMovement.create({
    data: { productId: args.productId, variantId: args.variantId, delta: args.next - args.current, reason: "SYNC", note: `${SHOP_LABELS[args.provider]} stock`, balanceAfter: args.next, actorUsername: args.actor },
  });
}

/** Create or update one imported product with its variants and stock. */
export async function applyShopProduct(provider: ShopProvider, record: ShopProductRecord, currency: string, actor: string, projectId: string): Promise<ApplyOutcome> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.product.findFirst({ where: { externalSource: provider, externalId: record.externalId }, include: { variants: true } });
    let sku = record.sku;
    if (sku) {
      const clash = await tx.product.findFirst({ where: { sku, ...(existing ? { id: { not: existing.id } } : {}) }, select: { id: true } });
      if (clash) sku = null;
    }
    const catId = await categoryId(tx, projectId, record.categories[0]);
    const data = {
      name: record.name,
      description: record.description,
      sku,
      status: record.status,
      currency,
      priceMinor: record.priceMinor ?? BigInt(0),
      trackInventory: record.trackInventory,
      imageUrl: record.imageUrl && record.imageUrl.startsWith("https://") ? record.imageUrl.slice(0, 1000) : null,
      ...(catId ? { categoryId: catId } : {}),
    };
    let productId: string;
    let outcome: ApplyOutcome;
    if (existing) {
      productId = existing.id;
      const same =
        existing.name === data.name &&
        existing.description === data.description &&
        existing.sku === data.sku &&
        existing.status === data.status &&
        existing.priceMinor === data.priceMinor &&
        existing.trackInventory === data.trackInventory &&
        existing.imageUrl === data.imageUrl &&
        existing.currency === data.currency;
      if (!same) await tx.product.update({ where: { id: existing.id }, data });
      outcome = same ? "UNCHANGED" : "UPDATED";
      if (record.trackInventory && record.variants.length === 0 && record.stockQuantity !== null && record.stockQuantity !== existing.stockQuantity) {
        await syncStock(tx, { productId, variantId: null, current: existing.stockQuantity, next: record.stockQuantity, actor, provider });
        outcome = "UPDATED";
      }
    } else {
      const created = await tx.product.create({
        data: { ...data, externalSource: provider, externalId: record.externalId, stockQuantity: 0, createdByUsername: actor },
        select: { id: true },
      });
      productId = created.id;
      outcome = "CREATED";
      if (record.trackInventory && record.variants.length === 0 && record.stockQuantity) {
        await syncStock(tx, { productId, variantId: null, current: 0, next: record.stockQuantity, actor, provider });
      }
    }

    const known = new Map((existing?.variants ?? []).filter((v) => v.externalId).map((v) => [v.externalId!, v]));
    const seen = new Set<string>();
    for (const v of record.variants) {
      seen.add(v.externalId);
      const current = known.get(v.externalId);
      let vsku = v.sku;
      if (vsku && vsku === sku) vsku = null;
      if (current) {
        const same = current.name === v.name && current.sku === vsku && current.priceMinor === v.priceMinor && current.isActive === v.isActive;
        if (!same) {
          await tx.productVariant.update({ where: { id: current.id }, data: { name: v.name, sku: vsku, priceMinor: v.priceMinor, isActive: v.isActive } });
          if (outcome === "UNCHANGED") outcome = "UPDATED";
        }
        if (record.trackInventory && v.stockQuantity !== null && v.stockQuantity !== current.stockQuantity) {
          await syncStock(tx, { productId, variantId: current.id, current: current.stockQuantity, next: v.stockQuantity, actor, provider });
          if (outcome === "UNCHANGED") outcome = "UPDATED";
        }
      } else {
        const created = await tx.productVariant.create({ data: { productId, externalId: v.externalId, name: v.name, sku: vsku, priceMinor: v.priceMinor, isActive: v.isActive, stockQuantity: 0 }, select: { id: true } });
        if (record.trackInventory && v.stockQuantity) await syncStock(tx, { productId, variantId: created.id, current: 0, next: v.stockQuantity, actor, provider });
        if (outcome === "UNCHANGED") outcome = "UPDATED";
      }
    }
    for (const [externalId, v] of known) {
      if (!seen.has(externalId) && v.isActive) {
        await tx.productVariant.update({ where: { id: v.id }, data: { isActive: false } });
        if (outcome === "UNCHANGED") outcome = "UPDATED";
      }
    }
    return outcome;
  });
}

/** The shop deleted a product: archive ours (orders keep pointing at it). */
export async function archiveShopProduct(provider: ShopProvider, externalId: string): Promise<boolean> {
  const r = await prisma.product.updateMany({ where: { externalSource: provider, externalId, status: { not: "ARCHIVED" } }, data: { status: "ARCHIVED" } });
  return r.count > 0;
}

/** Create or update one imported order. Never moves stock: the shop already did. */
export async function applyShopOrder(provider: ShopProvider, record: ShopOrderRecord, actor: string): Promise<ApplyOutcome> {
  const outcome = await applyShopOrderRow(provider, record, actor);
  if (outcome === "CREATED" || outcome === "UPDATED") {
    const o = await prisma.commerceOrder.findFirst({ where: { externalSource: provider, externalId: record.externalId } });
    if (o) await emitWebhookEvent(outcome === "CREATED" ? "order.created" : "order.status_changed", orderEventData(o));
  }
  return outcome;
}

async function applyShopOrderRow(provider: ShopProvider, record: ShopOrderRecord, actor: string): Promise<ApplyOutcome> {
  if (record.items.length === 0) return "SKIPPED";
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.commerceOrder.findFirst({ where: { externalSource: provider, externalId: record.externalId }, select: { id: true, status: true, paymentStatus: true } });
      const paidMinor = record.paymentStatus === "PAID" ? record.totalMinor : BigInt(0);
      if (existing) {
        if (existing.status === record.status && existing.paymentStatus === record.paymentStatus) return "UNCHANGED";
        await tx.commerceOrder.update({ where: { id: existing.id }, data: { status: record.status, paymentStatus: record.paymentStatus, paidMinor, ...(record.status === "CANCELLED" ? { cancelledAt: new Date() } : {}) } });
        await tx.commerceOrderEvent.create({
          data: {
            orderId: existing.id,
            kind: "SYNC",
            fromStatus: existing.status,
            toStatus: record.status,
            detail: { source: SHOP_LABELS[provider], payment: record.paymentStatus },
            actorUsername: actor,
          },
        });
        return "UPDATED";
      }
      const productIds = [...new Set(record.items.map((i) => i.externalProductId).filter((x): x is string => Boolean(x)))];
      const products = productIds.length ? await tx.product.findMany({ where: { externalSource: provider, externalId: { in: productIds } }, select: { id: true, externalId: true, variants: { select: { id: true, externalId: true } } } }) : [];
      const byExternal = new Map(products.map((p) => [p.externalId!, p]));
      const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('commerce_order_seq')::bigint AS n`;
      const order = await tx.commerceOrder.create({
        data: {
          number: formatOrderNumber(Number(n)),
          externalSource: provider,
          externalId: record.externalId,
          customerName: record.customerName,
          customerPhone: record.customerPhone?.slice(0, 40) ?? null,
          customerEmail: record.customerEmail?.slice(0, 200) ?? null,
          shippingAddress: record.shippingAddress?.slice(0, 1000) ?? null,
          channel: "WEBSITE",
          status: record.status,
          paymentStatus: record.paymentStatus,
          currency: record.currency,
          subtotalMinor: record.subtotalMinor,
          discountMinor: record.discountMinor,
          shippingMinor: record.shippingMinor,
          totalMinor: record.totalMinor,
          paidMinor,
          notes: `${SHOP_LABELS[provider]} order ${record.number}${record.note ? `\n${record.note}` : ""}`.slice(0, 2000),
          createdByUsername: actor,
          ...(record.status !== "DRAFT" ? { confirmedAt: record.createdAt ?? new Date() } : {}),
          items: {
            create: record.items.map((i) => {
              const p = i.externalProductId ? byExternal.get(i.externalProductId) : undefined;
              const v = p && i.externalVariantId ? p.variants.find((x) => x.externalId === i.externalVariantId) : undefined;
              return { productId: p?.id ?? null, variantId: v?.id ?? null, name: i.name, sku: i.sku, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, totalMinor: i.totalMinor };
            }),
          },
        },
        select: { id: true },
      });
      await tx.commerceOrderEvent.create({
        data: { orderId: order.id, kind: "IMPORTED", toStatus: record.status, detail: { source: SHOP_LABELS[provider], shopNumber: record.number, total: formatMinor(record.totalMinor, record.currency) }, actorUsername: actor },
      });
      return "CREATED";
    });
  } catch (err) {
    // Two imports of the same new order at once (a webhook and a manual import): the second is a no-op.
    if (isUniqueViolation(err)) return "UNCHANGED";
    throw err;
  }
}

export interface RunCounts {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  errors: string[];
}

const MAX_PAGES = { PRODUCTS: 60, ORDERS: 20 } as const;

/**
 * Import the shop's products (or its orders since `since`), page by page, recording a ShopSyncRun.
 * Bounded (3,000 products / 1,000 orders a run). A page that fails stops the run as PARTIAL with what was done.
 */
export async function runShopImport(connectionId: string, kind: "PRODUCTS" | "ORDERS", actor: string, projectId: string, since?: Date): Promise<{ runId: string; status: string; counts: RunCounts; message: string }> {
  const resolved = await clientForConnection(connectionId);
  if ("refused" in resolved) throw new ProviderError(resolved.refused);
  const run = await prisma.shopSyncRun.create({ data: { connectionId, kind, status: "RUNNING", actorUsername: actor }, select: { id: true } });
  const counts: RunCounts = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, errors: [] };
  let currency = resolved.currency;
  let status = "SUCCEEDED";
  try {
    if (!currency) {
      const t = await resolved.client.test();
      currency = t.currency;
      if (currency) await prisma.shopConnection.update({ where: { id: connectionId }, data: { currency } });
    }
    if (!currency) throw new ProviderError("The shop's currency is unknown; test the connection first.");
    let cursor: string | null = null;
    let pages = 0;
    const from = since ?? new Date(Date.now() - 30 * 86_400_000);
    do {
      const page: ShopPage<ShopProductRecord | ShopOrderRecord> = kind === "PRODUCTS" ? await resolved.client.products(cursor) : await resolved.client.orders(cursor, from);
      counts.skipped += page.unreadable;
      for (const record of page.records) {
        try {
          const outcome = kind === "PRODUCTS" ? await applyShopProduct(resolved.provider, record as ShopProductRecord, currency, actor, projectId) : await applyShopOrder(resolved.provider, record as ShopOrderRecord, actor);
          counts[outcome === "CREATED" ? "created" : outcome === "UPDATED" ? "updated" : outcome === "SKIPPED" ? "skipped" : "unchanged"] += 1;
        } catch (err) {
          counts.failed += 1;
          if (counts.errors.length < 20) counts.errors.push(`${(record as { name?: string; number?: string }).name ?? (record as { number?: string }).number ?? record.externalId}: ${(err as Error).message.slice(0, 160)}`);
        }
      }
      cursor = page.next;
      pages += 1;
    } while (cursor && pages < MAX_PAGES[kind]);
    if (cursor) counts.errors.push(`Stopped after ${pages} pages; run the import again to continue.`);
    if (counts.failed > 0 || cursor) status = "PARTIAL";
  } catch (err) {
    status = counts.created + counts.updated + counts.unchanged > 0 ? "PARTIAL" : "FAILED";
    counts.errors.unshift(err instanceof ProviderError || err instanceof ProviderUnknownOutcome ? err.message : "The import stopped unexpectedly.");
    if (!(err instanceof ProviderError || err instanceof ProviderUnknownOutcome)) console.error("[shops] import failed", (err as Error).name);
  }
  await prisma.shopSyncRun.update({
    where: { id: run.id },
    data: { status, finishedAt: new Date(), created: counts.created, updated: counts.updated, unchanged: counts.unchanged, skipped: counts.skipped, failed: counts.failed, errors: counts.errors.length ? counts.errors : undefined },
  });
  await prisma.shopConnection.update({ where: { id: connectionId }, data: { lastSyncAt: new Date(), lastSyncOk: status === "SUCCEEDED", lastError: status === "SUCCEEDED" ? null : (counts.errors[0] ?? null) } });
  const what = kind === "PRODUCTS" ? "products" : "orders";
  return {
    runId: run.id,
    status,
    counts,
    message: `${status === "FAILED" ? "Import failed" : "Imported"}: ${counts.created} new, ${counts.updated} updated, ${counts.unchanged} unchanged ${what}${counts.failed ? `, ${counts.failed} failed` : ""}${counts.skipped ? `, ${counts.skipped} skipped` : ""}.${counts.errors[0] ? ` ${counts.errors[0]}` : ""}`,
  };
}
