"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import {
  canTransitionOrder,
  computeOrderTotals,
  formatMinor,
  formatOrderNumber,
  isOrderStatus,
  normalizeCurrencyCode,
  normalizeSku,
  ORDER_LIMITS,
  ORDER_STATUS_LABELS,
  orderPaymentStatus,
  orderStockEffect,
  PRODUCT_STATUSES,
  toMinor,
  type OrderStatus,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";

/**
 * Commerce actions (COMMERCE.md). Each checks its own key (commerce.manage / orders.manage), which
 * also gates the module's feature, and writes through the project-scoped client. Stock and money
 * change only inside transactions with conditional updates, so two people confirming the last item at
 * once cannot both take it, and a status move cannot happen twice.
 */

export interface CommerceResult {
  error?: string;
  success?: string;
  id?: string;
}

type Tx = Prisma.TransactionClient;
class Refusal extends Error {}

const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max) || null;

async function revalidate(...paths: string[]) {
  for (const p of paths) revalidatePath(await projectPath(p));
}

// ── Products ───────────────────────────────────────────────────────────────────────────────────

export interface ProductInput {
  name: string;
  description: string;
  sku: string;
  categoryId: string;
  newCategory: string;
  status: string;
  currency: string;
  price: string;
  compareAt: string;
  trackInventory: boolean;
  openingStock: string;
  imageUrl: string;
}

export async function saveProduct(id: string | null, input: ProductInput): Promise<CommerceResult> {
  const access = await checkPermission("commerce.manage");
  if ("denied" in access) return { error: access.denied };
  const name = text(input.name, 200);
  if (!name) return { error: "Give the product a name." };
  const sku = normalizeSku(String(input.sku ?? ""));
  if (!sku.ok) return { error: sku.error };
  const currency = normalizeCurrencyCode(String(input.currency ?? ""));
  if (!currency) return { error: "Choose a currency, as a three-letter code such as BDT." };
  const price = toMinor(String(input.price ?? ""));
  if (price === null) return { error: "Enter the price as a number with at most two decimals." };
  const compareAt = String(input.compareAt ?? "").trim() ? toMinor(String(input.compareAt)) : null;
  if (String(input.compareAt ?? "").trim() && compareAt === null) return { error: "The compare-at price must be a number with at most two decimals." };
  const status = (PRODUCT_STATUSES as readonly string[]).includes(input.status) ? (input.status as (typeof PRODUCT_STATUSES)[number]) : "ACTIVE";
  const imageUrl = text(input.imageUrl, 1000);
  if (imageUrl && !/^https:\/\/[^\s]+$/i.test(imageUrl)) return { error: "The image address must start with https://." };
  const opening = id ? 0 : Number(String(input.openingStock ?? "0").trim() || "0");
  if (!Number.isInteger(opening) || opening < 0 || opening > 10_000_000) return { error: "Opening stock must be a whole number, 0 or more." };

  try {
    const productId = await prisma.$transaction(async (tx) => {
      let categoryId = text(input.categoryId, 40);
      const newCategory = text(input.newCategory, 120);
      if (newCategory) {
        const cat = await tx.productCategory.upsert({
          where: { projectId_name: { projectId: await activeProjectId(), name: newCategory } },
          create: { name: newCategory },
          update: {},
          select: { id: true },
        });
        categoryId = cat.id;
      } else if (categoryId && !(await tx.productCategory.findFirst({ where: { id: categoryId }, select: { id: true } }))) {
        categoryId = null;
      }
      const data = {
        name,
        description: text(input.description, 5000),
        sku: sku.sku,
        status,
        currency,
        priceMinor: price,
        compareAtMinor: compareAt,
        trackInventory: Boolean(input.trackInventory),
        imageUrl,
        categoryId,
      };
      if (id) {
        const updated = await tx.product.updateMany({ where: { id }, data });
        if (updated.count !== 1) throw new Refusal("That product no longer exists.");
        return id;
      }
      const created = await tx.product.create({ data: { ...data, stockQuantity: data.trackInventory ? opening : 0, createdByUsername: access.session.username }, select: { id: true } });
      if (data.trackInventory && opening > 0) {
        await tx.inventoryMovement.create({ data: { productId: created.id, delta: opening, reason: "ADJUSTMENT", note: "Opening stock", balanceAfter: opening, actorUsername: access.session.username } });
      }
      return created.id;
    });
    await revalidate("/commerce/products", `/commerce/products/${productId}`);
    return { success: id ? "Product saved." : "Product created.", id: productId };
  } catch (err) {
    if (err instanceof Refusal) return { error: err.message };
    if (isUniqueViolation(err)) return { error: "Another product in this project already has that SKU." };
    throw err;
  }
}

export interface VariantInput {
  name: string;
  sku: string;
  price: string;
  isActive: boolean;
  openingStock: string;
}

export async function saveVariant(productId: string, variantId: string | null, input: VariantInput): Promise<CommerceResult> {
  const access = await checkPermission("commerce.manage");
  if ("denied" in access) return { error: access.denied };
  const name = text(input.name, 120);
  if (!name) return { error: "Name the variant, for example “Red / XL”." };
  const sku = normalizeSku(String(input.sku ?? ""));
  if (!sku.ok) return { error: sku.error };
  const price = String(input.price ?? "").trim() ? toMinor(String(input.price)) : null;
  if (String(input.price ?? "").trim() && price === null) return { error: "The price must be a number with at most two decimals, or empty to use the product's." };
  const opening = variantId ? 0 : Number(String(input.openingStock ?? "0").trim() || "0");
  if (!Number.isInteger(opening) || opening < 0) return { error: "Opening stock must be a whole number, 0 or more." };
  const product = await prisma.product.findFirst({ where: { id: productId }, select: { id: true, trackInventory: true } });
  if (!product) return { error: "That product no longer exists." };
  try {
    await prisma.$transaction(async (tx) => {
      if (variantId) {
        const updated = await tx.productVariant.updateMany({ where: { id: variantId, productId }, data: { name, sku: sku.sku, priceMinor: price, isActive: Boolean(input.isActive) } });
        if (updated.count !== 1) throw new Refusal("That variant no longer exists.");
        return;
      }
      const created = await tx.productVariant.create({ data: { productId, name, sku: sku.sku, priceMinor: price, isActive: true, stockQuantity: product.trackInventory ? opening : 0 }, select: { id: true } });
      if (product.trackInventory && opening > 0) {
        await tx.inventoryMovement.create({ data: { productId, variantId: created.id, delta: opening, reason: "ADJUSTMENT", note: "Opening stock", balanceAfter: opening, actorUsername: access.session.username } });
      }
    });
  } catch (err) {
    if (err instanceof Refusal) return { error: err.message };
    throw err;
  }
  await revalidate(`/commerce/products/${productId}`);
  return { success: variantId ? "Variant saved." : "Variant added." };
}

/** Change stock by hand (count, damage, delivery from a supplier). Never below zero. */
export async function adjustStock(productId: string, variantId: string | null, deltaRaw: string, note: string): Promise<CommerceResult> {
  const access = await checkPermission("commerce.manage");
  if ("denied" in access) return { error: access.denied };
  const delta = Number(String(deltaRaw).trim());
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10_000_000) return { error: "Enter a whole number to add (e.g. 10) or remove (e.g. -3)." };
  const reason = text(note, 500);
  if (!reason) return { error: "Say why the stock changes (a count, damage, a delivery…)." };
  try {
    const balance = await prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({ where: { id: productId }, select: { trackInventory: true } });
      if (!product) throw new Refusal("That product no longer exists.");
      if (!product.trackInventory) throw new Refusal("This product does not track stock. Switch “Track stock” on first.");
      return changeStock(tx, { productId, variantId, delta, reason: "ADJUSTMENT", note: reason, orderId: null, actor: access.session.username });
    });
    await revalidate(`/commerce/products/${productId}`, "/commerce/products");
    return { success: `Stock is now ${balance}.` };
  } catch (err) {
    if (err instanceof Refusal) return { error: err.message };
    throw err;
  }
}

/** One stock change, with its movement row. A removal that would go below zero is refused. */
async function changeStock(
  tx: Tx,
  input: { productId: string; variantId: string | null; delta: number; reason: string; note: string | null; orderId: string | null; actor: string },
): Promise<number> {
  const removing = input.delta < 0;
  const need = -input.delta;
  let balance: number;
  if (input.variantId) {
    const moved = await tx.productVariant.updateMany({
      where: { id: input.variantId, productId: input.productId, ...(removing ? { stockQuantity: { gte: need } } : {}) },
      data: { stockQuantity: { increment: input.delta } },
    });
    if (moved.count !== 1) throw new Refusal("Not enough stock for that variant.");
    balance = (await tx.productVariant.findFirstOrThrow({ where: { id: input.variantId }, select: { stockQuantity: true } })).stockQuantity;
  } else {
    const moved = await tx.product.updateMany({
      where: { id: input.productId, ...(removing ? { stockQuantity: { gte: need } } : {}) },
      data: { stockQuantity: { increment: input.delta } },
    });
    if (moved.count !== 1) throw new Refusal("Not enough stock for that product.");
    balance = (await tx.product.findFirstOrThrow({ where: { id: input.productId }, select: { stockQuantity: true } })).stockQuantity;
  }
  await tx.inventoryMovement.create({
    data: { productId: input.productId, variantId: input.variantId, delta: input.delta, reason: input.reason, note: input.note, orderId: input.orderId, balanceAfter: balance, actorUsername: input.actor },
  });
  return balance;
}

export async function saveCategory(name: string): Promise<CommerceResult> {
  const access = await checkPermission("commerce.manage");
  if ("denied" in access) return { error: access.denied };
  const clean = text(name, 120);
  if (!clean) return { error: "Give the category a name." };
  try {
    const row = await prisma.productCategory.create({ data: { name: clean }, select: { id: true } });
    await revalidate("/commerce/products");
    return { success: `Category “${clean}” added.`, id: row.id };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "That category already exists." };
    throw err;
  }
}

export async function deleteCategory(id: string): Promise<CommerceResult> {
  const access = await checkPermission("commerce.manage");
  if ("denied" in access) return { error: access.denied };
  // Products keep existing; they simply lose the category (the foreign key sets null).
  const removed = await prisma.productCategory.deleteMany({ where: { id } });
  await revalidate("/commerce/products");
  return removed.count ? { success: "Category removed. Its products are kept, without a category." } : { error: "That category no longer exists." };
}

// ── Orders ─────────────────────────────────────────────────────────────────────────────────────

export interface OrderLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  /** Empty = the catalogue price. */
  unitPrice: string;
}

export interface OrderInput {
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  shippingAddress: string;
  channel: string;
  clientId: string;
  notes: string;
  discount: string;
  shipping: string;
  lines: OrderLine[];
  leadId?: string;
}

const CHANNELS = ["WHATSAPP", "MESSENGER", "INSTAGRAM", "TELEGRAM", "WEBSITE", "PHONE", "WALK_IN", "OTHER"];

/** Validate the input and price each line from the catalogue (or the typed price). One currency per order. */
async function buildOrder(tx: Tx, input: OrderInput) {
  const customerName = text(input.customerName, ORDER_LIMITS.name);
  if (!customerName) throw new Refusal("Enter the customer's name.");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Refusal("Add at least one item.");
  if (input.lines.length > ORDER_LIMITS.items) throw new Refusal(`An order can have at most ${ORDER_LIMITS.items} items.`);
  const productIds = [...new Set(input.lines.map((l) => String(l.productId)))];
  const products = await tx.product.findMany({ where: { id: { in: productIds } }, include: { variants: true } });
  const byId = new Map(products.map((p) => [p.id, p]));
  let currency: string | null = null;
  const lines = input.lines.map((l) => {
    const product = byId.get(String(l.productId));
    if (!product) throw new Refusal("An item's product no longer exists. Remove it and add it again.");
    if (product.status === "ARCHIVED") throw new Refusal(`${product.name} is archived and cannot be ordered.`);
    const variant = l.variantId ? product.variants.find((v) => v.id === l.variantId) : null;
    if (l.variantId && !variant) throw new Refusal(`A variant of ${product.name} no longer exists.`);
    if (currency && currency !== product.currency) throw new Refusal("All items of an order must be in one currency.");
    currency = product.currency;
    const typed = String(l.unitPrice ?? "").trim();
    const unit = typed ? toMinor(typed) : (variant?.priceMinor ?? product.priceMinor);
    if (unit === null) throw new Refusal(`The price for ${product.name} must be a number with at most two decimals.`);
    const quantity = Number(l.quantity);
    return { productId: product.id, variantId: variant?.id ?? null, name: variant ? `${product.name} — ${variant.name}` : product.name, sku: variant?.sku ?? product.sku, quantity, unitPriceMinor: unit };
  });
  const discount = String(input.discount ?? "").trim() ? toMinor(String(input.discount)) : BigInt(0);
  const shipping = String(input.shipping ?? "").trim() ? toMinor(String(input.shipping)) : BigInt(0);
  if (discount === null || shipping === null) throw new Refusal("Discount and shipping must be numbers with at most two decimals.");
  const totals = computeOrderTotals(lines, discount, shipping);
  if (!totals.ok) throw new Refusal(totals.error);
  let clientId = text(input.clientId, 40);
  if (clientId && !(await tx.client.findFirst({ where: { id: clientId }, select: { id: true } }))) clientId = null;
  return {
    header: {
      customerName,
      customerPhone: text(input.customerPhone, 40),
      customerEmail: text(input.customerEmail, 200),
      shippingAddress: text(input.shippingAddress, 1000),
      channel: CHANNELS.includes(String(input.channel)) ? String(input.channel) : null,
      clientId,
      notes: text(input.notes, ORDER_LIMITS.note),
      currency: currency!,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: discount,
      shippingMinor: shipping,
      totalMinor: totals.totalMinor,
    },
    lines: lines.map((l) => ({ ...l, totalMinor: BigInt(l.quantity) * l.unitPriceMinor })),
  };
}

export async function createOrder(input: OrderInput): Promise<CommerceResult> {
  const access = await checkPermission("orders.manage");
  if ("denied" in access) return { error: access.denied };
  try {
    const order = await prisma.$transaction(async (tx) => {
      const built = await buildOrder(tx, input);
      const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('commerce_order_seq')::bigint AS n`;
      const created = await tx.commerceOrder.create({
        data: { ...built.header, number: formatOrderNumber(Number(n)), createdByUsername: access.session.username, items: { create: built.lines } },
        select: { id: true, number: true },
      });
      await tx.commerceOrderEvent.create({ data: { orderId: created.id, kind: "CREATED", toStatus: "DRAFT", detail: { total: formatMinor(built.header.totalMinor, built.header.currency), items: built.lines.length }, actorUsername: access.session.username } });
      // An order made from a lead closes it as won.
      if (input.leadId) {
        const lead = await tx.salesLead.findFirst({ where: { id: String(input.leadId) }, select: { id: true, stage: true } });
        if (lead && lead.stage !== "WON") {
          await tx.salesLead.update({ where: { id: lead.id }, data: { stage: "WON", wonOrderId: created.id, closedAt: new Date() } });
          await tx.salesLeadEvent.create({ data: { leadId: lead.id, kind: "STAGE", fromStage: lead.stage, toStage: "WON", note: `Order ${created.number} created`, actorUsername: access.session.username } });
        }
      }
      return created;
    });
    await logSystemEvent("INFO", "commerce", `Order ${order.number} created`, { orderId: order.id, by: access.session.username });
    await revalidate("/commerce/orders", "/sales");
    return { success: `Order ${order.number} created as a draft.`, id: order.id };
  } catch (err) {
    if (err instanceof Refusal) return { error: err.message };
    throw err;
  }
}

/** Replace a draft's customer details and items. Refused once the order is confirmed. */
export async function updateDraftOrder(orderId: string, input: OrderInput): Promise<CommerceResult> {
  const access = await checkPermission("orders.manage");
  if ("denied" in access) return { error: access.denied };
  try {
    await prisma.$transaction(async (tx) => {
      const built = await buildOrder(tx, input);
      const moved = await tx.commerceOrder.updateMany({ where: { id: orderId, status: "DRAFT" }, data: built.header });
      if (moved.count !== 1) throw new Refusal("Only a draft order can be edited.");
      await tx.commerceOrderItem.deleteMany({ where: { orderId } });
      for (const line of built.lines) await tx.commerceOrderItem.create({ data: { ...line, orderId } });
      await tx.commerceOrderEvent.create({ data: { orderId, kind: "EDITED", detail: { total: formatMinor(built.header.totalMinor, built.header.currency), items: built.lines.length }, actorUsername: access.session.username } });
    });
    await revalidate(`/commerce/orders/${orderId}`, "/commerce/orders");
    return { success: "Draft updated.", id: orderId };
  } catch (err) {
    if (err instanceof Refusal) return { error: err.message };
    throw err;
  }
}

/**
 * Move an order to its next status. Confirming takes the tracked items out of stock (refused, with
 * nothing changed, when any is short); cancelling a confirmed order or a return puts them back. The
 * move is conditional on the status the person saw, so it happens once.
 */
export async function moveOrderStatus(orderId: string, toRaw: string, note: string): Promise<CommerceResult> {
  const access = await checkPermission("orders.manage");
  if ("denied" in access) return { error: access.denied };
  if (!isOrderStatus(toRaw)) return { error: "Unknown status." };
  const to: OrderStatus = toRaw;
  try {
    const number = await prisma.$transaction(async (tx) => {
      const order = await tx.commerceOrder.findFirst({ where: { id: orderId }, include: { items: { include: { product: { select: { trackInventory: true } } } } } });
      if (!order) throw new Refusal("That order no longer exists.");
      const from = order.status as OrderStatus;
      if (!canTransitionOrder(from, to)) throw new Refusal(`A ${ORDER_STATUS_LABELS[from].toLowerCase()} order cannot become ${ORDER_STATUS_LABELS[to].toLowerCase()}.`);
      const now = new Date();
      const moved = await tx.commerceOrder.updateMany({
        where: { id: orderId, status: from },
        data: { status: to, ...(to === "CONFIRMED" ? { confirmedAt: now } : {}), ...(to === "CANCELLED" ? { cancelledAt: now } : {}) },
      });
      if (moved.count !== 1) throw new Refusal("The order changed while you were looking. Reload and try again.");
      const effect = orderStockEffect(from, to);
      if (effect) {
        for (const item of order.items) {
          if (!item.productId || !item.product?.trackInventory) continue;
          await changeStock(tx, {
            productId: item.productId,
            variantId: item.variantId,
            delta: effect === "DEDUCT" ? -item.quantity : item.quantity,
            reason: effect === "DEDUCT" ? "ORDER" : to === "RETURNED" ? "RETURN" : "CANCEL",
            note: `${order.number}`,
            orderId,
            actor: access.session.username,
          });
        }
      }
      await tx.commerceOrderEvent.create({ data: { orderId, kind: "STATUS", fromStatus: from, toStatus: to, detail: { note: text(note, 500), stock: effect }, actorUsername: access.session.username } });
      return order.number;
    });
    await logSystemEvent("INFO", "commerce", `Order ${number} → ${ORDER_STATUS_LABELS[to]}`, { orderId, to, by: access.session.username });
    await revalidate(`/commerce/orders/${orderId}`, "/commerce/orders", "/commerce/products");
    return { success: `Order is now ${ORDER_STATUS_LABELS[to].toLowerCase()}.` };
  } catch (err) {
    if (err instanceof Refusal) return { error: err.message };
    throw err;
  }
}

/** Record money received for an order (cash on delivery, bKash, bank…). Never more than is due. */
export async function recordOrderPayment(orderId: string, amountRaw: string, method: string, reference: string): Promise<CommerceResult> {
  const access = await checkPermission("orders.manage");
  if ("denied" in access) return { error: access.denied };
  const amount = toMinor(String(amountRaw ?? ""));
  if (amount === null || amount <= BigInt(0)) return { error: "Enter the amount received, more than zero." };
  try {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.commerceOrder.findFirst({ where: { id: orderId }, select: { paidMinor: true, totalMinor: true, currency: true, status: true, paymentStatus: true } });
      if (!order) throw new Refusal("That order no longer exists.");
      if (order.status === "CANCELLED") throw new Refusal("A cancelled order cannot take a payment.");
      if (order.paymentStatus === "REFUNDED") throw new Refusal("This order was refunded.");
      const paid = order.paidMinor + amount;
      if (paid > order.totalMinor) throw new Refusal(`That is more than is due (${formatMinor(order.totalMinor - order.paidMinor, order.currency)}).`);
      const moved = await tx.commerceOrder.updateMany({ where: { id: orderId, paidMinor: order.paidMinor }, data: { paidMinor: paid, paymentStatus: orderPaymentStatus(paid, order.totalMinor) } });
      if (moved.count !== 1) throw new Refusal("Another payment was recorded at the same moment. Reload and try again.");
      await tx.commerceOrderEvent.create({ data: { orderId, kind: "PAYMENT", detail: { amount: formatMinor(amount, order.currency), method: text(method, 40), reference: text(reference, 120) }, actorUsername: access.session.username } });
      return formatMinor(amount, order.currency);
    });
    await revalidate(`/commerce/orders/${orderId}`, "/commerce/orders");
    return { success: `${result} recorded.` };
  } catch (err) {
    if (err instanceof Refusal) return { error: err.message };
    throw err;
  }
}

export async function markOrderRefunded(orderId: string, note: string): Promise<CommerceResult> {
  const access = await checkPermission("orders.manage");
  if ("denied" in access) return { error: access.denied };
  const reason = text(note, 500);
  if (!reason) return { error: "Say why the order was refunded." };
  const moved = await prisma.commerceOrder.updateMany({ where: { id: orderId, paymentStatus: { in: ["PAID", "PARTIAL"] } }, data: { paymentStatus: "REFUNDED" } });
  if (moved.count !== 1) return { error: "Only an order with a payment can be marked refunded." };
  await prisma.commerceOrderEvent.create({ data: { orderId, kind: "REFUND", detail: { note: reason }, actorUsername: access.session.username } });
  await revalidate(`/commerce/orders/${orderId}`, "/commerce/orders");
  return { success: "Marked refunded. Record the money returned in your own accounts." };
}
