/**
 * Commerce integrations (COMMERCE_INTEGRATIONS.md): couriers (Steadfast, Pathao, RedX) and shops
 * (WooCommerce, Shopify). Pure — the provider calls live in the web app; this decides what a
 * provider's answer MEANS, so every adapter and the background refresh read it one way.
 *
 * The shipment domain is provider-neutral: one status vocabulary, and each provider's own status kept
 * beside it as text. A provider status nobody mapped is IN_TRANSIT when the parcel is plainly moving
 * and UNKNOWN otherwise — never DELIVERED by guess.
 */

import type { OrderPaymentStatus, OrderStatus } from "./commerce.js";

// ── Couriers ───────────────────────────────────────────────────────────────────────────────────

export const COURIER_PROVIDERS = ["STEADFAST", "PATHAO", "REDX"] as const;
export type CourierProvider = (typeof COURIER_PROVIDERS)[number];
export const COURIER_LABELS: Record<CourierProvider, string> = { STEADFAST: "Steadfast", PATHAO: "Pathao Courier", REDX: "RedX" };

export function isCourierProvider(value: unknown): value is CourierProvider {
  return typeof value === "string" && (COURIER_PROVIDERS as readonly string[]).includes(value);
}

/** Production and sandbox addresses, from each provider's merchant API documentation. */
export const COURIER_BASE_URLS: Record<CourierProvider, { live: string; sandbox: string | null }> = {
  STEADFAST: { live: "https://portal.packzy.com/api/v1", sandbox: null },
  PATHAO: { live: "https://api-hermes.pathao.com", sandbox: "https://courier-api-sandbox.pathao.com" },
  REDX: { live: "https://openapi.redx.com.bd/v1.0.0-beta", sandbox: "https://sandbox.redx.com.bd/v1.0.0-beta" },
};

/** The secrets each provider needs. Stored encrypted; never shown again after saving. */
export const COURIER_CREDENTIAL_FIELDS: Record<CourierProvider, ReadonlyArray<{ key: string; label: string }>> = {
  STEADFAST: [
    { key: "apiKey", label: "API key" },
    { key: "secretKey", label: "Secret key" },
  ],
  PATHAO: [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret" },
    { key: "username", label: "Merchant login email" },
    { key: "password", label: "Merchant login password" },
  ],
  REDX: [{ key: "accessToken", label: "API access token" }],
};

/** What each provider can genuinely do through its API. Nothing else is offered. */
export const COURIER_CAPABILITIES: Record<CourierProvider, { book: true; status: true; areas: boolean; lookupByInvoice: boolean }> = {
  STEADFAST: { book: true, status: true, areas: false, lookupByInvoice: true },
  PATHAO: { book: true, status: true, areas: false, lookupByInvoice: false },
  REDX: { book: true, status: true, areas: true, lookupByInvoice: false },
};

export const SHIPMENT_STATUSES = [
  "BOOKING",
  "BOOKED",
  "PICKED_UP",
  "IN_TRANSIT",
  "ON_HOLD",
  "DELIVERED",
  "PARTIAL_DELIVERED",
  "RETURNED",
  "CANCELLED",
  "FAILED",
  "UNKNOWN",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  BOOKING: "Booking…",
  BOOKED: "Booked",
  PICKED_UP: "Picked up",
  IN_TRANSIT: "In transit",
  ON_HOLD: "On hold",
  DELIVERED: "Delivered",
  PARTIAL_DELIVERED: "Partly delivered",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
  FAILED: "Booking failed",
  UNKNOWN: "Check with the courier",
};

/** A shipment the courier is done with. The background refresh skips these. */
export function isFinalShipmentStatus(status: ShipmentStatus): boolean {
  return status === "DELIVERED" || status === "PARTIAL_DELIVERED" || status === "RETURNED" || status === "CANCELLED" || status === "FAILED";
}

/** Shipments the courier may still move: refreshed in the background. */
export const OPEN_SHIPMENT_STATUSES: readonly ShipmentStatus[] = ["BOOKED", "PICKED_UP", "IN_TRANSIT", "ON_HOLD"];

const lower = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Steadfast `delivery_status`. "…_approval_pending" is the merchant panel waiting on Steadfast's own review. */
export function mapSteadfastStatus(raw: string | null | undefined): ShipmentStatus {
  const s = lower(raw ?? "");
  if (s === "delivered") return "DELIVERED";
  if (s === "partial_delivered") return "PARTIAL_DELIVERED";
  if (s === "cancelled") return "CANCELLED";
  if (s === "hold") return "ON_HOLD";
  if (s === "in_review" || s === "pending") return "BOOKED";
  if (s.endsWith("_approval_pending")) return "IN_TRANSIT";
  return "UNKNOWN";
}

/** Pathao `order_status_slug` / `order_status`. */
export function mapPathaoStatus(raw: string | null | undefined): ShipmentStatus {
  const s = lower(raw ?? "");
  if (s === "delivered") return "DELIVERED";
  if (s === "partial_delivery" || s === "partial_delivered") return "PARTIAL_DELIVERED";
  if (s === "return" || s === "returned" || s === "paid_return") return "RETURNED";
  if (s === "pickup_cancelled" || s === "pickup_cancel" || s === "cancelled") return "CANCELLED";
  if (s === "on_hold" || s === "hold") return "ON_HOLD";
  if (s === "pending" || s === "pickup_requested" || s === "assigned_for_pickup") return "BOOKED";
  if (s === "picked" || s === "pickup_picked") return "PICKED_UP";
  if (s === "at_the_sorting_hub" || s === "in_transit" || s === "received_at_last_mile_hub" || s === "assigned_for_delivery" || s === "delivery_failed" || s === "pickup_failed")
    return "IN_TRANSIT";
  return "UNKNOWN";
}

/** RedX parcel `status`. */
export function mapRedxStatus(raw: string | null | undefined): ShipmentStatus {
  const s = lower(raw ?? "");
  if (s === "delivered") return "DELIVERED";
  if (s === "partial_delivered" || s === "partially_delivered") return "PARTIAL_DELIVERED";
  if (s === "returned" || s === "agent_returned") return "RETURNED";
  if (s === "pickup_cancelled" || s === "cancelled" || s === "rejected") return "CANCELLED";
  if (s === "agent_hold" || s === "hold" || s === "on_hold") return "ON_HOLD";
  if (s === "pickup_pending" || s === "pending") return "BOOKED";
  if (s === "picked_up" || s === "pickup_completed") return "PICKED_UP";
  if (s.includes("delivery") || s.includes("transit") || s === "ready_for_delivery" || s === "agent_returning" || s === "agent_area_change") return "IN_TRANSIT";
  return "UNKNOWN";
}

export function mapCourierStatus(provider: CourierProvider, raw: string | null | undefined): ShipmentStatus {
  return provider === "STEADFAST" ? mapSteadfastStatus(raw) : provider === "PATHAO" ? mapPathaoStatus(raw) : mapRedxStatus(raw);
}

/**
 * A Bangladeshi mobile number the way couriers want it: 11 digits starting 01. "+8801…", "8801…" and
 * spaces/dashes are accepted; anything else is refused (a courier rejects it anyway, after the call).
 */
export function courierPhone(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const local = digits.startsWith("880") ? digits.slice(2) : digits;
  return /^01[3-9]\d{8}$/.test(local) ? local : null;
}

/** Our reference sent to the courier as the merchant invoice: unique per project, and safe for every provider. */
export function shipmentInvoice(orderNumber: string, attempt: number): string {
  return `${orderNumber}${attempt > 1 ? `-${attempt}` : ""}`.replace(/[^A-Za-z0-9-]/g, "");
}

// ── Shops ──────────────────────────────────────────────────────────────────────────────────────

export const SHOP_PROVIDERS = ["WOOCOMMERCE", "SHOPIFY"] as const;
export type ShopProvider = (typeof SHOP_PROVIDERS)[number];
export const SHOP_LABELS: Record<ShopProvider, string> = { WOOCOMMERCE: "WooCommerce", SHOPIFY: "Shopify" };

/** The Shopify Admin API version every call names. */
export const SHOPIFY_API_VERSION = "2025-01";

/**
 * The shop's address as stored: https, no path, no trailing slash. Shopify must be the store's
 * permanent `*.myshopify.com` domain (the API is only served there).
 */
export function normalizeShopUrl(provider: ShopProvider, raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let value = raw.trim();
  if (!value) return { ok: false, error: "Enter the shop's address." };
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "That is not a web address." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "The shop must be reached over https://." };
  const host = url.hostname.toLowerCase();
  if (provider === "SHOPIFY") {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) return { ok: false, error: "Use the store's permanent address, like your-store.myshopify.com." };
    return { ok: true, url: `https://${host}` };
  }
  if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, error: "Use the shop's public address." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `https://${host}${url.port ? `:${url.port}` : ""}${path}` };
}

/** A shop's decimal money string ("19.99", "20", "19.995") as minor units, rounded half-up to 2 places. */
export function shopMoneyToMinor(raw: unknown): bigint | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? "").padEnd(3, "0");
  let cents = whole * BigInt(100) + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += BigInt(1);
  return cents;
}

/** "gid://shopify/Product/123" or 123 → "123". */
export function shopifyNumericId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  const m = /(\d+)$/.exec(s);
  return m ? m[1]! : null;
}

export interface ShopVariantRecord {
  externalId: string;
  name: string;
  sku: string | null;
  priceMinor: bigint | null;
  stockQuantity: number | null;
  isActive: boolean;
}

export interface ShopProductRecord {
  externalId: string;
  name: string;
  description: string | null;
  sku: string | null;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  priceMinor: bigint | null;
  /** Whether the shop counts stock for it. */
  trackInventory: boolean;
  stockQuantity: number | null;
  imageUrl: string | null;
  categories: string[];
  variants: ShopVariantRecord[];
}

export interface ShopOrderItemRecord {
  externalProductId: string | null;
  externalVariantId: string | null;
  name: string;
  sku: string | null;
  quantity: number;
  unitPriceMinor: bigint;
  totalMinor: bigint;
}

export interface ShopOrderRecord {
  externalId: string;
  /** The shop's own order number, shown beside ours. */
  number: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  currency: string;
  subtotalMinor: bigint;
  discountMinor: bigint;
  shippingMinor: bigint;
  totalMinor: bigint;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  shippingAddress: string | null;
  note: string | null;
  createdAt: Date | null;
  items: ShopOrderItemRecord[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : typeof v === "string" && /^-?\d+$/.test(v) ? Math.max(0, Number(v)) : null);
const stripHtml = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const text = s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 5000) : null;
};
const sku = (v: unknown): string | null => {
  const s = str(v);
  return s && /^[A-Za-z0-9._\-/]{1,64}$/.test(s) ? s : null;
};
const sumBig = (xs: bigint[]) => xs.reduce((a, b) => a + b, BigInt(0));
const join = (...parts: Array<string | null | undefined>) => parts.filter((p) => p && p.trim()).join(", ") || null;

// WooCommerce REST v3 ---------------------------------------------------------------------------

/** A WooCommerce product (`GET /wp-json/wc/v3/products`), variations passed separately. */
export function wooProductRecord(p: unknown, variations: unknown[] = []): ShopProductRecord | null {
  const o = obj(p);
  const id = str(o.id);
  const name = str(o.name);
  if (!id || !name) return null;
  const status = o.status === "publish" ? "ACTIVE" : o.status === "trash" ? "ARCHIVED" : "DRAFT";
  return {
    externalId: id,
    name: name.slice(0, 200),
    description: stripHtml(o.short_description) ?? stripHtml(o.description),
    sku: sku(o.sku),
    status,
    priceMinor: shopMoneyToMinor(o.price) ?? shopMoneyToMinor(o.regular_price),
    trackInventory: o.manage_stock === true,
    stockQuantity: o.manage_stock === true ? int(o.stock_quantity) : null,
    imageUrl: str(obj(arr(o.images)[0]).src),
    categories: arr(o.categories).map((c) => str(obj(c).name)).filter((c): c is string => Boolean(c)),
    variants: variations.map(wooVariationRecord).filter((v): v is ShopVariantRecord => v !== null),
  };
}

export function wooVariationRecord(v: unknown): ShopVariantRecord | null {
  const o = obj(v);
  const id = str(o.id);
  if (!id) return null;
  const name =
    arr(o.attributes)
      .map((a) => str(obj(a).option))
      .filter(Boolean)
      .join(" / ") || `Variant ${id}`;
  return {
    externalId: id,
    name: name.slice(0, 120),
    sku: sku(o.sku),
    priceMinor: shopMoneyToMinor(o.price) ?? shopMoneyToMinor(o.regular_price),
    stockQuantity: o.manage_stock === true || o.manage_stock === "parent" ? int(o.stock_quantity) : null,
    isActive: o.status !== "private" && o.status !== "trash",
  };
}

/** WooCommerce order status → ours. `refunded` also refunds the payment. */
export function mapWooOrderStatus(status: unknown): OrderStatus {
  switch (status) {
    case "processing":
      return "PROCESSING";
    case "completed":
      return "DELIVERED";
    case "cancelled":
    case "failed":
      return "CANCELLED";
    case "refunded":
      return "RETURNED";
    case "checkout-draft":
    case "draft":
      return "DRAFT";
    default:
      // pending, on-hold and custom statuses: the order exists and is waiting.
      return "CONFIRMED";
  }
}

export function wooOrderRecord(order: unknown): ShopOrderRecord | null {
  const o = obj(order);
  const id = str(o.id);
  const currency = str(o.currency)?.toUpperCase();
  if (!id || !currency) return null;
  const items: ShopOrderItemRecord[] = arr(o.line_items).map((li) => {
    const l = obj(li);
    const quantity = Math.max(1, int(l.quantity) ?? 1);
    const total = shopMoneyToMinor(l.subtotal) ?? shopMoneyToMinor(l.total) ?? BigInt(0);
    return {
      externalProductId: str(l.product_id) === "0" ? null : str(l.product_id),
      externalVariantId: str(l.variation_id) === "0" ? null : str(l.variation_id),
      name: (str(l.name) ?? "Item").slice(0, 200),
      sku: sku(l.sku),
      quantity,
      unitPriceMinor: total / BigInt(quantity),
      totalMinor: total,
    };
  });
  const status = mapWooOrderStatus(o.status);
  const subtotal = sumBig(items.map((i) => i.totalMinor));
  const discount = shopMoneyToMinor(o.discount_total) ?? BigInt(0);
  const billing = obj(o.billing);
  const shipping = obj(o.shipping);
  const name = join(str(shipping.first_name) ?? str(billing.first_name), str(shipping.last_name) ?? str(billing.last_name))?.replace(", ", " ") ?? "Shop customer";
  const total = shopMoneyToMinor(o.total) ?? BigInt(0);
  return {
    externalId: id,
    number: str(o.number) ?? id,
    status,
    paymentStatus: o.status === "refunded" ? "REFUNDED" : o.date_paid || o.date_paid_gmt ? "PAID" : "UNPAID",
    currency,
    subtotalMinor: subtotal,
    discountMinor: discount > subtotal ? subtotal : discount,
    shippingMinor: shopMoneyToMinor(o.shipping_total) ?? BigInt(0),
    totalMinor: total,
    customerName: name.slice(0, 160),
    customerPhone: str(shipping.phone) ?? str(billing.phone),
    customerEmail: str(billing.email),
    shippingAddress: join(str(shipping.address_1) ?? str(billing.address_1), str(shipping.address_2) ?? str(billing.address_2), str(shipping.city) ?? str(billing.city), str(shipping.postcode) ?? str(billing.postcode)),
    note: str(o.customer_note),
    createdAt: str(o.date_created_gmt) ? new Date(`${str(o.date_created_gmt)}Z`) : null,
    items,
  };
}

// Shopify -------------------------------------------------------------------------------------

/** A product from the Admin GraphQL API (the shape the import query asks for). */
export function shopifyGqlProductRecord(p: unknown): ShopProductRecord | null {
  const o = obj(p);
  const id = shopifyNumericId(o.id);
  const name = str(o.title);
  if (!id || !name) return null;
  const variants = arr(obj(o.variants).nodes).map((v): ShopVariantRecord | null => {
    const n = obj(v);
    const vid = shopifyNumericId(n.id);
    if (!vid) return null;
    const qty = int(n.inventoryQuantity);
    return {
      externalId: vid,
      name: (str(n.title) ?? `Variant ${vid}`).slice(0, 120),
      sku: sku(n.sku),
      priceMinor: shopMoneyToMinor(n.price),
      stockQuantity: qty,
      isActive: true,
    };
  });
  return shopifyProduct(id, name, o.descriptionHtml ?? o.description, o.status, str(obj(o.featuredImage).url), variants.filter((v): v is ShopVariantRecord => v !== null), str(o.productType));
}

/** A product from a Shopify webhook (REST shape: `variants[]` with numeric ids). */
export function shopifyRestProductRecord(p: unknown): ShopProductRecord | null {
  const o = obj(p);
  const id = shopifyNumericId(o.id);
  const name = str(o.title);
  if (!id || !name) return null;
  const variants = arr(o.variants).map((v): ShopVariantRecord | null => {
    const n = obj(v);
    const vid = shopifyNumericId(n.id);
    if (!vid) return null;
    return {
      externalId: vid,
      name: (str(n.title) ?? `Variant ${vid}`).slice(0, 120),
      sku: sku(n.sku),
      priceMinor: shopMoneyToMinor(n.price),
      stockQuantity: int(n.inventory_quantity),
      isActive: true,
    };
  });
  return shopifyProduct(id, name, o.body_html, typeof o.status === "string" ? o.status.toUpperCase() : o.status, str(obj(o.image).src), variants.filter((v): v is ShopVariantRecord => v !== null), str(o.product_type));
}

function shopifyProduct(id: string, name: string, description: unknown, status: unknown, imageUrl: string | null, variants: ShopVariantRecord[], productType: string | null): ShopProductRecord {
  // A product with only Shopify's placeholder "Default Title" variant is a simple product.
  const simple = variants.length === 1 && /^default title$/i.test(variants[0]!.name);
  const only = simple ? variants[0]! : null;
  const tracked = variants.some((v) => v.stockQuantity !== null);
  return {
    externalId: id,
    name: name.slice(0, 200),
    description: stripHtml(description),
    sku: only?.sku ?? null,
    status: status === "ACTIVE" ? "ACTIVE" : status === "ARCHIVED" ? "ARCHIVED" : "DRAFT",
    priceMinor: only?.priceMinor ?? variants[0]?.priceMinor ?? null,
    trackInventory: tracked,
    stockQuantity: only ? only.stockQuantity : null,
    imageUrl,
    categories: productType ? [productType] : [],
    variants: simple ? [] : variants,
  };
}

/** Shopify's financial + fulfillment status → ours. A cancelled order is cancelled whatever else it says. */
export function mapShopifyOrderStatus(input: { cancelled: boolean; financial: string | null; fulfillment: string | null }): { status: OrderStatus; paymentStatus: OrderPaymentStatus } {
  const fin = (input.financial ?? "").toUpperCase();
  const ful = (input.fulfillment ?? "").toUpperCase();
  const paymentStatus: OrderPaymentStatus =
    fin === "PAID" ? "PAID" : fin === "PARTIALLY_PAID" ? "PARTIAL" : fin === "REFUNDED" ? "REFUNDED" : fin === "PARTIALLY_REFUNDED" ? "PAID" : "UNPAID";
  if (input.cancelled) return { status: "CANCELLED", paymentStatus };
  if (fin === "REFUNDED") return { status: "RETURNED", paymentStatus };
  if (ful === "FULFILLED") return { status: "SHIPPED", paymentStatus };
  if (ful === "PARTIALLY_FULFILLED" || ful === "IN_PROGRESS") return { status: "PROCESSING", paymentStatus };
  return { status: "CONFIRMED", paymentStatus };
}

const money = (set: unknown) => shopMoneyToMinor(obj(obj(set).shopMoney).amount);

/** An order from the Admin GraphQL API (the shape the import query asks for). */
export function shopifyGqlOrderRecord(order: unknown): ShopOrderRecord | null {
  const o = obj(order);
  const id = shopifyNumericId(o.id);
  const currency = str(o.currencyCode)?.toUpperCase();
  if (!id || !currency) return null;
  const items = arr(obj(o.lineItems).nodes).map((li) => {
    const l = obj(li);
    const quantity = Math.max(1, int(l.quantity) ?? 1);
    const unit = money(l.originalUnitPriceSet) ?? BigInt(0);
    return {
      externalProductId: shopifyNumericId(obj(l.product).id),
      externalVariantId: shopifyNumericId(obj(l.variant).id),
      name: (str(l.title) ?? "Item").slice(0, 200),
      sku: sku(l.sku),
      quantity,
      unitPriceMinor: unit,
      totalMinor: unit * BigInt(quantity),
    };
  });
  const { status, paymentStatus } = mapShopifyOrderStatus({ cancelled: Boolean(o.cancelledAt), financial: str(o.displayFinancialStatus), fulfillment: str(o.displayFulfillmentStatus) });
  const subtotal = sumBig(items.map((i) => i.totalMinor));
  const discount = money(o.totalDiscountsSet) ?? BigInt(0);
  const address = obj(o.shippingAddress);
  const customer = obj(o.customer);
  const total = money(o.totalPriceSet) ?? subtotal;
  return {
    externalId: id,
    number: str(o.name) ?? id,
    status,
    paymentStatus,
    currency,
    subtotalMinor: subtotal,
    discountMinor: discount > subtotal ? subtotal : discount,
    shippingMinor: money(o.totalShippingPriceSet) ?? BigInt(0),
    totalMinor: total,
    customerName: (str(address.name) ?? str(customer.displayName) ?? "Shop customer").slice(0, 160),
    customerPhone: str(address.phone) ?? str(customer.phone),
    customerEmail: str(customer.email) ?? str(o.email),
    shippingAddress: join(str(address.address1), str(address.address2), str(address.city), str(address.zip), str(address.country)),
    note: str(o.note),
    createdAt: str(o.createdAt) ? new Date(str(o.createdAt)!) : null,
    items,
  };
}

/** An order from a Shopify webhook (REST shape). */
export function shopifyRestOrderRecord(order: unknown): ShopOrderRecord | null {
  const o = obj(order);
  const id = shopifyNumericId(o.id);
  const currency = str(o.currency)?.toUpperCase();
  if (!id || !currency) return null;
  const items = arr(o.line_items).map((li) => {
    const l = obj(li);
    const quantity = Math.max(1, int(l.quantity) ?? 1);
    const unit = shopMoneyToMinor(l.price) ?? BigInt(0);
    return {
      externalProductId: shopifyNumericId(l.product_id),
      externalVariantId: shopifyNumericId(l.variant_id),
      name: (str(l.title) ?? str(l.name) ?? "Item").slice(0, 200),
      sku: sku(l.sku),
      quantity,
      unitPriceMinor: unit,
      totalMinor: unit * BigInt(quantity),
    };
  });
  const { status, paymentStatus } = mapShopifyOrderStatus({
    cancelled: Boolean(o.cancelled_at),
    financial: str(o.financial_status),
    fulfillment: o.fulfillment_status === null ? "UNFULFILLED" : str(o.fulfillment_status) === "partial" ? "PARTIALLY_FULFILLED" : str(o.fulfillment_status),
  });
  const subtotal = sumBig(items.map((i) => i.totalMinor));
  const discount = shopMoneyToMinor(o.total_discounts) ?? BigInt(0);
  const address = obj(o.shipping_address);
  const customer = obj(o.customer);
  const shippingLines = arr(o.shipping_lines).map((s) => shopMoneyToMinor(obj(s).price) ?? BigInt(0));
  return {
    externalId: id,
    number: str(o.name) ?? id,
    status,
    paymentStatus,
    currency,
    subtotalMinor: subtotal,
    discountMinor: discount > subtotal ? subtotal : discount,
    shippingMinor: sumBig(shippingLines),
    totalMinor: shopMoneyToMinor(o.total_price) ?? subtotal,
    customerName: (str(address.name) ?? join(str(customer.first_name), str(customer.last_name))?.replace(", ", " ") ?? "Shop customer").slice(0, 160),
    customerPhone: str(address.phone) ?? str(customer.phone) ?? str(o.phone),
    customerEmail: str(o.email) ?? str(customer.email),
    shippingAddress: join(str(address.address1), str(address.address2), str(address.city), str(address.zip), str(address.country)),
    note: str(o.note),
    createdAt: str(o.created_at) ? new Date(str(o.created_at)!) : null,
    items,
  };
}

/** What a webhook topic is about. Anything else is acknowledged and ignored. */
export function shopWebhookSubject(provider: ShopProvider, topic: string | null): "PRODUCT" | "PRODUCT_DELETED" | "ORDER" | null {
  const t = (topic ?? "").toLowerCase();
  if (provider === "WOOCOMMERCE") {
    if (t === "product.created" || t === "product.updated" || t === "product.restored") return "PRODUCT";
    if (t === "product.deleted") return "PRODUCT_DELETED";
    if (t === "order.created" || t === "order.updated" || t === "order.restored") return "ORDER";
    return null;
  }
  if (t === "products/create" || t === "products/update") return "PRODUCT";
  if (t === "products/delete") return "PRODUCT_DELETED";
  if (t === "orders/create" || t === "orders/updated" || t === "orders/paid" || t === "orders/cancelled" || t === "orders/fulfilled") return "ORDER";
  return null;
}
