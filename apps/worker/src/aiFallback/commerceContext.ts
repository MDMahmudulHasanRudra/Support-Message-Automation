import { deriveQueryTerms } from "@support-automation/engine";
import {
  commercePromptRules,
  COURIER_LABELS,
  detectCommerceIntent,
  formatMinor,
  normalizePhoneNumber,
  ORDER_PAYMENT_LABELS,
  ORDER_STATUS_LABELS,
  resolveAiCommercePolicy,
  SHIPMENT_STATUS_LABELS,
  type AiCommercePolicy,
  type AiCommerceSwitches,
  type CourierProvider,
  type OrderPaymentStatus,
  type OrderStatus,
  type ShipmentStatus,
} from "@support-automation/shared";
import { callBusinessApp, resolveBusinessAppCapability, type PrismaClient } from "@support-automation/db";
import type { ProductSummary } from "@support-automation/shared";
import { platformPrisma, prisma } from "../db.js";
import { currentProjectId } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import type { KnowledgeSnippet } from "./knowledgeContext.js";

/**
 * Commerce grounding for the AI (AI_COMMERCE.md). Returns GROUNDING, never a reply: catalogue products
 * and the customer's own orders as reference entries the normal prompt answers from, plus the rules
 * the prompt adds about what the AI may and may not do with them. Every gate after this point —
 * scope, confidence, the business-question guard, the send-time safety check — applies unchanged.
 *
 * With every commerce switch off (the default) this returns nothing and touches nothing, so the
 * prompt is byte-identical to what it was before this existed. Never throws: a lookup that fails
 * leaves the answer exactly as it would have been without commerce data.
 *
 * Order details are given only for orders whose phone number IS the sender's verified WhatsApp
 * number (`…@c.us`). A LID, a channel id, or an order number typed by somebody else proves nothing,
 * so it unlocks nothing.
 *
 * Two sources, one set of rules. The project's own catalogue (PRODUCT_CATALOG / ORDERS Core Modules) and a
 * connected Commerce Business App (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md): live price, stock and offers
 * read from Commerce through `callBusinessApp` — the ONE gated path (ACTIVE installation, project not held,
 * declared capability, the installation's own key). Either source counts as "the module is on" for the same
 * AI switches; a disabled, pending or failed installation is simply not a source. Commerce data is never
 * cached here: every answer quotes what Commerce said at that moment, and a failed call adds nothing.
 */

export interface CommerceGrounding {
  snippets: KnowledgeSnippet[];
  rules: string[];
  /** A request to buy, cancel, return or change an order, with hand-over switched on: a person handles it. */
  handoverRequest: boolean;
  policy: AiCommercePolicy | null;
  /** The text the figure check compares a reply against (only the commerce entries). */
  groundingText: string;
}

const NONE: CommerceGrounding = { snippets: [], rules: [], handoverRequest: false, policy: null, groundingText: "" };
const MAX_PRODUCTS = 5;
const MAX_ORDERS = 3;
/** Commerce products put in front of the AI: each costs one search share and one detail read from Commerce. */
const COMMERCE_APP_MAX_PRODUCTS = 3;
const ORDER_LOOKBACK_DAYS = 180;

const day = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric" }).format(d);
const when = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);

function snippet(id: string, title: string, answer: string): KnowledgeSnippet {
  return { id, title, question: null, answer, procedure: null, module: "Commerce", version: 0, scope: "GLOBAL", fromSameGroup: false };
}

/** The sender's own phone number, only when WhatsApp itself delivered it (`<digits>@c.us`). */
export async function verifiedWhatsAppPhone(messageId: string): Promise<string | null> {
  try {
    const m = await prisma.message.findFirst({ where: { id: messageId }, select: { senderJid: true } });
    const jid = m?.senderJid ?? "";
    if (!jid.endsWith("@c.us")) return null;
    return normalizePhoneNumber(jid.slice(0, -"@c.us".length));
  } catch {
    return null;
  }
}

/**
 * `customerPhone` is asked for only when an order lookup is actually needed (a lazy read: the default,
 * everything off, costs no query at all). Null = this channel has no verifiable number (Messenger,
 * Telegram, the Sandbox).
 */
export async function findCommerceGrounding(input: { text: string; switches: AiCommerceSwitches; customerPhone: (() => Promise<string | null>) | null }): Promise<CommerceGrounding> {
  const s = input.switches;
  if (!s.commerceProductAnswers && !s.commerceOrderAnswers && !s.commerceDeliveryAnswers) return NONE;
  try {
    const enabled = new Set<string>();
    for (const key of ["PRODUCT_CATALOG", "ORDERS", "COURIER"] as const) if (await projectHasFeature(key)) enabled.add(key);
    const app = await connectedCommerceApp();
    const policy = resolveAiCommercePolicy(new Set([...enabled, ...(app.products ? ["PRODUCT_CATALOG"] : []), ...(app.orders ? ["ORDERS"] : [])]), s);
    if (!policy.active) return NONE;

    const intent = detectCommerceIntent(input.text);
    if (policy.handoverRequests && intent.request) return { ...NONE, handoverRequest: true, policy };

    const snippets: KnowledgeSnippet[] = [];
    if (policy.product && enabled.has("PRODUCT_CATALOG")) snippets.push(...(await productSnippets(input.text, policy)));
    if (policy.product && app.products) snippets.push(...(await commerceAppProductSnippets(input.text, policy)));
    let ordersFound = false;
    let phone: string | null = null;
    if (policy.orders && intent.status && input.customerPhone) {
      phone = await input.customerPhone();
      if (phone) {
        const orders = [...(enabled.has("ORDERS") ? await orderSnippets(phone, policy) : []), ...(app.orders ? await commerceAppOrderSnippets(phone) : [])];
        ordersFound = orders.length > 0;
        snippets.push(...orders);
      }
    }
    return {
      snippets,
      rules: commercePromptRules(policy, { ordersFound, customerVerified: Boolean(phone) }),
      handoverRequest: false,
      policy,
      groundingText: snippets.map((x) => `${x.title}\n${x.answer}`).join("\n"),
    };
  } catch (err) {
    console.error("[aiFallback] commerce grounding failed; answering without it", (err as Error).name);
    return NONE;
  }
}

async function productSnippets(text: string, policy: AiCommercePolicy): Promise<KnowledgeSnippet[]> {
  const terms = deriveQueryTerms(text).filter((t) => t.length >= 3).slice(0, 8);
  if (terms.length === 0) return [];
  const rows = await prisma.product.findMany({
    where: { status: "ACTIVE", OR: terms.flatMap((t) => [{ name: { contains: t, mode: "insensitive" as const } }, { sku: { equals: t, mode: "insensitive" as const } }]) },
    take: 40,
    include: { category: { select: { name: true } }, variants: { where: { isActive: true }, orderBy: { createdAt: "asc" }, take: 20 } },
  });
  const scored = rows
    .map((p) => {
      const name = p.name.toLowerCase();
      const score = terms.filter((t) => name.includes(t.toLowerCase()) || p.sku?.toLowerCase() === t.toLowerCase()).length;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, MAX_PRODUCTS);

  const availability = (tracked: boolean, qty: number) => (!tracked ? "available to order" : qty <= 0 ? "out of stock" : policy.showStockCount ? `${qty} in stock` : "in stock");
  return scored.map(({ p }) => {
    const lines = [`Price: ${formatMinor(p.priceMinor, p.currency)}${p.compareAtMinor && p.compareAtMinor > p.priceMinor ? ` (was ${formatMinor(p.compareAtMinor, p.currency)})` : ""}.`];
    if (p.variants.length) {
      lines.push(
        `Options: ${p.variants.map((v) => `${v.name} — ${formatMinor(v.priceMinor ?? p.priceMinor, p.currency)}, ${availability(p.trackInventory, v.stockQuantity)}`).join("; ")}.`,
      );
    } else {
      lines.push(`Availability: ${availability(p.trackInventory, p.stockQuantity)}.`);
    }
    if (p.category) lines.push(`Category: ${p.category.name}.`);
    if (p.sku) lines.push(`SKU: ${p.sku}.`);
    if (p.description) lines.push(p.description.slice(0, 400));
    return snippet(`commerce:product:${p.id}`, `Product: ${p.name}`, lines.join(" "));
  });
}

async function orderSnippets(phone: string, policy: AiCommercePolicy): Promise<KnowledgeSnippet[]> {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return [];
  const tail = digits.slice(-9);
  const projectId = currentProjectId();
  const since = new Date(Date.now() - ORDER_LOOKBACK_DAYS * 86_400_000);
  // Narrowed by the last nine digits in SQL (phones are stored as typed), then compared exactly after
  // normalising both sides, so "01712…" and "+880 1712…" are the same customer and nobody else is.
  const candidates = await prisma.$queryRaw<Array<{ id: string; customerPhone: string | null }>>`
    SELECT "id", "customerPhone" FROM "CommerceOrder"
    WHERE "projectId" = ${projectId}
      AND "createdAt" >= ${since}
      AND regexp_replace(coalesce("customerPhone", ''), '\\D', '', 'g') LIKE ${`%${tail}`}
    ORDER BY "createdAt" DESC
    LIMIT 20`;
  const mine = candidates.filter((c) => c.customerPhone && normalizePhoneNumber(c.customerPhone) === phone).slice(0, MAX_ORDERS);
  if (mine.length === 0) return [];
  const orders = await prisma.commerceOrder.findMany({
    where: { id: { in: mine.map((m) => m.id) } },
    orderBy: { createdAt: "desc" },
    include: { items: { select: { name: true, quantity: true } }, shipments: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  return orders.map((o) => {
    const status = ORDER_STATUS_LABELS[o.status as OrderStatus] ?? o.status;
    const payment = ORDER_PAYMENT_LABELS[o.paymentStatus as OrderPaymentStatus] ?? o.paymentStatus;
    const lines = [
      `Placed ${day(o.createdAt)}. Status: ${status}. Payment: ${payment} (${formatMinor(o.paidMinor, o.currency)} paid of ${formatMinor(o.totalMinor, o.currency)}).`,
      `Items: ${o.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}.`,
    ];
    const shipment = o.shipments[0];
    if (policy.delivery) {
      if (shipment && shipment.status !== "FAILED" && shipment.status !== "CANCELLED") {
        lines.push(
          `Delivery: ${COURIER_LABELS[shipment.provider as CourierProvider]} — ${SHIPMENT_STATUS_LABELS[shipment.status as ShipmentStatus]}${shipment.lastCheckedAt ? `, as the courier reported at ${when(shipment.lastCheckedAt)}` : ""}.${shipment.trackingCode ? ` Tracking id: ${shipment.trackingCode}.` : ""}`,
        );
      } else {
        lines.push("Delivery: not booked with a courier yet.");
      }
    }
    return snippet(`commerce:order:${o.id}`, `Your order ${o.number}`, lines.join(" "));
  });
}

// ── A connected Commerce Business App ─────────────────────────────────────────────────────────────

/** Which Commerce capabilities this project may use right now (the gate only; no call to Commerce). */
async function connectedCommerceApp(): Promise<{ products: boolean; orders: boolean }> {
  const projectId = currentProjectId();
  const db = platformPrisma as unknown as PrismaClient;
  const [products, orders] = await Promise.all([
    resolveBusinessAppCapability(db, projectId, "commerce", "commerce.searchProducts"),
    resolveBusinessAppCapability(db, projectId, "commerce", "commerce.getOrderStatus"),
  ]);
  return { products: products.allowed, orders: orders.allowed };
}

const appMoney = (m: { amountMinor: string; currency: string } | null | undefined) => (m ? formatMinor(BigInt(m.amountMinor), m.currency) : null);

/**
 * Products from Commerce matching the customer's words: one search per distinctive term (Commerce's search is
 * a single "contains" match), merged and ranked by how many terms a name carries; then Commerce's own detail
 * for the best few, which names the offers that apply to that product (Commerce's offers are mostly by
 * category, so matching them here would be a guess). Every figure is Commerce's own — the price a customer
 * pays now (offers already applied) and the regular price — and a product Commerce gave no price for says so.
 */
async function commerceAppProductSnippets(text: string, policy: AiCommercePolicy): Promise<KnowledgeSnippet[]> {
  const projectId = currentProjectId();
  const db = platformPrisma as unknown as PrismaClient;
  const terms = deriveQueryTerms(text)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  if (terms.length === 0) return [];
  const results = await Promise.all(terms.map((query) => callBusinessApp(db, projectId, "commerce", "commerce.searchProducts", { query, limit: 5 })));
  const byId = new Map<string, ProductSummary>();
  for (const r of results) if (r.ok) for (const p of r.data.products) byId.set(p.productId, p);
  if (byId.size === 0) return [];
  const ranked = [...byId.values()]
    .map((p) => ({ p, score: terms.filter((t) => p.name.toLowerCase().includes(t.toLowerCase()) || p.sku?.toLowerCase() === t.toLowerCase()).length }))
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, COMMERCE_APP_MAX_PRODUCTS);
  const details = await Promise.all(ranked.map(({ p }) => callBusinessApp(db, projectId, "commerce", "commerce.getProductDetails", { productId: p.productId })));
  const checkedAt = when(new Date());

  return ranked.map(({ p }, i) => {
    const detail = details[i]!.ok ? details[i]!.data : null;
    const price = appMoney(detail?.price ?? p.price);
    const variant = detail?.variants[0];
    const regularMinor = variant?.listPrice && detail?.price && BigInt(variant.listPrice.amountMinor) > BigInt(detail.price.amountMinor) ? variant.listPrice : (p.compareAtPrice ?? null);
    const regular = appMoney(regularMinor);
    const lines = [price ? `Price now: ${price}${regular ? ` (regular price ${regular})` : ""}.` : "Price: not given by Commerce."];
    const inStock = detail?.inStock ?? p.inStock;
    const qty = p.quantityAvailable ?? null;
    lines.push(
      inStock === null
        ? "Availability: not given by Commerce."
        : !inStock
          ? "Availability: out of stock."
          : policy.showStockCount && qty !== null
            ? `Availability: ${qty} in stock.`
            : "Availability: in stock.",
    );
    if (detail && detail.variants.length > 1) {
      lines.push(`Options: ${detail.variants.map((v) => `${v.name} — ${appMoney(v.price) ?? "price not given"}, ${v.inStock === null ? "availability not given" : v.inStock ? "in stock" : "out of stock"}`).join("; ")}.`);
    }
    if (p.category) lines.push(`Category: ${p.category}.`);
    if (p.brand) lines.push(`Brand: ${p.brand}.`);
    if (p.sku) lines.push(`SKU: ${p.sku}.`);
    if (detail) {
      const offers = detail.offers;
      lines.push(
        offers.length
          ? `Offer applied: ${offers.map((o) => `${o.title}${o.description ? ` (${o.description})` : ""}${o.endsAt ? `, until ${day(new Date(o.endsAt))}` : ""}`).join("; ")}.`
          : "No offer applies to it right now.",
      );
    }
    if (p.shortDescription) lines.push(p.shortDescription.slice(0, 300));
    lines.push(`(Live from Commerce at ${checkedAt}.)`);
    return snippet(`commerce-app:product:${p.productId}`, `Product: ${p.name}`, lines.join(" "));
  });
}

/** The verified customer's recent Commerce orders (exact phone match inside Commerce's own customer list). */
async function commerceAppOrderSnippets(phone: string): Promise<KnowledgeSnippet[]> {
  const projectId = currentProjectId();
  const db = platformPrisma as unknown as PrismaClient;
  const answer = await callBusinessApp(db, projectId, "commerce", "commerce.getOrderStatus", { orderReference: null, verifiedCustomer: { kind: "PHONE_E164", value: phone } });
  if (!answer.ok) return [];
  return answer.data.orders.map((o) => {
    const parts = [o.placedAt ? `Placed ${day(new Date(o.placedAt))}.` : null, `Status: ${o.status}.`, o.paymentStatus ? `Payment: ${o.paymentStatus}.` : null, o.fulfillmentStatus ? `Fulfilment: ${o.fulfillmentStatus}.` : null];
    const total = appMoney(o.total);
    if (total) parts.push(`Total: ${total}.`);
    return snippet(`commerce-app:order:${o.orderReference}`, `Your order ${o.orderReference}`, parts.filter(Boolean).join(" "));
  });
}
