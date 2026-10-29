/**
 * Commerce core rules (COMMERCE.md): products and stock, orders, the sales pipeline. Pure — the web
 * actions and the AI call these, so a status move, a stock effect or a total is decided in one place.
 *
 * Money is integer minor units (bigint), never floats, and never summed across currencies: an order
 * has ONE currency. Commerce orders are the customer's own sales — never the platform's SaaS billing.
 */

export const PRODUCT_STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = { ACTIVE: "Active", DRAFT: "Draft", ARCHIVED: "Archived" };

export const ORDER_STATUSES = ["DRAFT", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: "Draft",
  CONFIRMED: "Confirmed",
  PROCESSING: "Processing",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
};

export const ORDER_PAYMENT_STATUSES = ["UNPAID", "PARTIAL", "PAID", "REFUNDED"] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];
export const ORDER_PAYMENT_LABELS: Record<OrderPaymentStatus, string> = { UNPAID: "Unpaid", PARTIAL: "Part paid", PAID: "Paid", REFUNDED: "Refunded" };

/** The moves a person may make. Anything else is refused. */
const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "SHIPPED", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "RETURNED"],
  DELIVERED: ["RETURNED"],
  CANCELLED: [],
  RETURNED: [],
};

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function nextOrderStatuses(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_TRANSITIONS[from];
}

/**
 * What a move does to stock: confirming takes the items out of stock (refused when there is not
 * enough); cancelling a confirmed order, or a return, puts them back. A draft never touches stock.
 */
export function orderStockEffect(from: OrderStatus, to: OrderStatus): "DEDUCT" | "RESTORE" | null {
  if (from === "DRAFT" && to === "CONFIRMED") return "DEDUCT";
  if ((from === "CONFIRMED" || from === "PROCESSING") && to === "CANCELLED") return "RESTORE";
  if (to === "RETURNED") return "RESTORE";
  return null;
}

/** Items can be changed only while the order is a draft (prices and stock are settled on confirm). */
export function orderItemsEditable(status: OrderStatus): boolean {
  return status === "DRAFT";
}

export interface OrderLineInput {
  quantity: number;
  unitPriceMinor: bigint;
}

export type OrderTotals = { ok: true; subtotalMinor: bigint; totalMinor: bigint } | { ok: false; error: string };

export const ORDER_LIMITS = { items: 100, quantity: 100_000, note: 2000, name: 160 } as const;

/** Subtotal = Σ quantity × unit price; total = subtotal − discount + shipping. Exact integer arithmetic. */
export function computeOrderTotals(lines: readonly OrderLineInput[], discountMinor: bigint, shippingMinor: bigint): OrderTotals {
  if (lines.length === 0) return { ok: false, error: "Add at least one item." };
  if (lines.length > ORDER_LIMITS.items) return { ok: false, error: `An order can have at most ${ORDER_LIMITS.items} items.` };
  let subtotal = 0n;
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > ORDER_LIMITS.quantity) return { ok: false, error: "Each quantity must be a whole number of at least 1." };
    if (line.unitPriceMinor < 0n) return { ok: false, error: "A price cannot be negative." };
    subtotal += BigInt(line.quantity) * line.unitPriceMinor;
  }
  if (discountMinor < 0n || shippingMinor < 0n) return { ok: false, error: "Discount and shipping cannot be negative." };
  if (discountMinor > subtotal) return { ok: false, error: "The discount cannot be more than the items' total." };
  return { ok: true, subtotalMinor: subtotal, totalMinor: subtotal - discountMinor + shippingMinor };
}

/** Payment state from what was received against the total. A refund is recorded explicitly, never inferred. */
export function orderPaymentStatus(paidMinor: bigint, totalMinor: bigint): Exclude<OrderPaymentStatus, "REFUNDED"> {
  if (paidMinor <= 0n) return "UNPAID";
  return paidMinor >= totalMinor ? "PAID" : "PARTIAL";
}

export function formatOrderNumber(n: number): string {
  return `ORD-${String(n).padStart(6, "0")}`;
}

/** A SKU: 1–64 letters, digits, dot, dash, underscore or slash. Empty = none. */
export function normalizeSku(raw: string): { ok: true; sku: string | null } | { ok: false; error: string } {
  const sku = raw.trim();
  if (!sku) return { ok: true, sku: null };
  if (!/^[A-Za-z0-9._\-/]{1,64}$/.test(sku)) return { ok: false, error: "A SKU is up to 64 letters, digits, dots, dashes, underscores or slashes." };
  return { ok: true, sku };
}

// ── Sales pipeline ─────────────────────────────────────────────────────────────────────────────

export const LEAD_STAGES = ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL", "WON", "LOST"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  PROPOSAL: "Proposal",
  WON: "Won",
  LOST: "Lost",
};
export const OPEN_LEAD_STAGES: readonly LeadStage[] = ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL"];

export function isLeadStage(value: unknown): value is LeadStage {
  return typeof value === "string" && (LEAD_STAGES as readonly string[]).includes(value);
}

export const LEAD_SOURCES = ["WHATSAPP", "MESSENGER", "INSTAGRAM", "TELEGRAM", "WEBSITE", "PHONE", "WALK_IN", "REFERRAL", "OTHER"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  WHATSAPP: "WhatsApp",
  MESSENGER: "Messenger",
  INSTAGRAM: "Instagram",
  TELEGRAM: "Telegram",
  WEBSITE: "Website",
  PHONE: "Phone",
  WALK_IN: "Walk-in",
  REFERRAL: "Referral",
  OTHER: "Other",
};

export function isLeadSource(value: unknown): value is LeadSource {
  return typeof value === "string" && (LEAD_SOURCES as readonly string[]).includes(value);
}

/** A lost lead needs a reason; a won or lost lead is closed and leaves the open pipeline. */
export function validateLeadStageMove(to: LeadStage, lostReason: string | null): string | null {
  if (to === "LOST" && !(lostReason ?? "").trim()) return "Say why the lead was lost.";
  return null;
}
