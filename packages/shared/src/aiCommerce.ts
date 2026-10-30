/**
 * Commerce-aware AI (AI_COMMERCE.md). Pure rules shared by the worker's three answering paths
 * (WhatsApp AI fallback, channel AI, the Sandbox) and the AI Settings page.
 *
 * The policy is built from what is EFFECTIVELY on — the project's modules and its own AI switches —
 * never from the project type's label. A project without Courier Management never hears the AI
 * claim to track a parcel, whatever its type says. Every switch is off by default, so a project that
 * never touches these settings answers exactly as it did before.
 */

export const AI_COMMERCE_CAPABILITIES = ["PRODUCT_INFO", "ORDER_STATUS", "DELIVERY_STATUS"] as const;
export type AiCommerceCapability = (typeof AI_COMMERCE_CAPABILITIES)[number];

export const AI_COMMERCE_CAPABILITY_LABELS: Record<AiCommerceCapability, string> = {
  PRODUCT_INFO: "Product details, prices and availability from the catalogue",
  ORDER_STATUS: "The status of the customer's own orders",
  DELIVERY_STATUS: "Where the customer's own delivery is, as the courier last reported it",
};

export interface AiCommerceSwitches {
  commerceProductAnswers: boolean;
  commerceOrderAnswers: boolean;
  commerceDeliveryAnswers: boolean;
  commerceShowStockCount: boolean;
  commerceHandoverRequests: boolean;
}

export interface AiCommercePolicy {
  product: boolean;
  orders: boolean;
  delivery: boolean;
  showStockCount: boolean;
  handoverRequests: boolean;
  /** Any capability at all: the commerce rules are added to the prompt only then. */
  active: boolean;
  /** Why a switched-on capability is not available (a module is off), for the settings page. */
  blocked: Array<{ capability: AiCommerceCapability; reason: string }>;
}

/** `enabled` is the set of the project's modules that are on (ProjectFeature keys). */
export function resolveAiCommercePolicy(enabled: ReadonlySet<string>, s: AiCommerceSwitches): AiCommercePolicy {
  const blocked: AiCommercePolicy["blocked"] = [];
  const product = s.commerceProductAnswers && enabled.has("PRODUCT_CATALOG");
  if (s.commerceProductAnswers && !product) blocked.push({ capability: "PRODUCT_INFO", reason: "Product Catalog is off for this project." });
  const orders = s.commerceOrderAnswers && enabled.has("ORDERS");
  if (s.commerceOrderAnswers && !orders) blocked.push({ capability: "ORDER_STATUS", reason: "Order Management is off for this project." });
  const delivery = s.commerceDeliveryAnswers && orders && enabled.has("COURIER");
  if (s.commerceDeliveryAnswers && !delivery) {
    blocked.push({ capability: "DELIVERY_STATUS", reason: !orders ? "Delivery answers need order answers on." : "Courier Management is off for this project." });
  }
  return {
    product,
    orders,
    delivery,
    showStockCount: s.commerceShowStockCount,
    handoverRequests: s.commerceHandoverRequests,
    active: product || orders,
    blocked,
  };
}

const BENGALI_DIGITS = "০১২৩৪৫৬৭৮৯";
export function asciiDigits(text: string): string {
  return text.replace(/[০-৯]/g, (d) => String(BENGALI_DIGITS.indexOf(d)));
}

const ORDER_NUMBER = /\bORD-?\s?(\d{1,9})\b/gi;

/** Order numbers written in a message ("ORD-000042", "ord 42"), normalised to ORD-000042. */
export function orderNumbersIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of asciiDigits(text).matchAll(ORDER_NUMBER)) out.add(`ORD-${m[1]!.padStart(6, "0")}`);
  return [...out];
}

// First-person requests only, in English, Banglish (Bengali in Latin letters) and Bengali script.
// "What is your return policy?" is a question the AI may answer from verified knowledge; "I want to
// return this" is a request a person handles. So a bare "return" or "ফেরত" never counts on its own.
const REQUEST_PATTERNS: RegExp[] = [
  /\b(i want to|i'd like to|i would like to|i need to|please|want to|can i|could i)\s+(buy|purchase|order|cancel|return|refund|exchange|replace)\b/i,
  /\b(cancel|return|refund|exchange|replace)\s+(my|this|the|it)\b/i,
  /\b(place (an |my |the )?order|order (it|this|now)|add to cart|checkout|book (it|this) for me)\b/i,
  /\b(kinbo|kinte chai|kinte chacchi|order dibo|order debo|order korbo|order korte chai|order dite chai|nite chai)\b/i,
  /\b(cancel korbo|cancel korte chai|batil korbo|batil korte chai|ferot dibo|ferot dite chai|return dibo|return korte chai|refund chai|bodlate chai|exchange korbo|exchange korte chai)\b/i,
  /(কিনব|কিনতে চাই|অর্ডার দিব|অর্ডার দেব|অর্ডার করব|অর্ডার করতে চাই|অর্ডার দিতে চাই|নিতে চাই|বাতিল করব|বাতিল করতে চাই|ফেরত দিব|ফেরত দিতে চাই|রিফান্ড চাই|বদলাতে চাই|এক্সচেঞ্জ করতে চাই|ক্যানসেল করতে চাই|ক্যানসেল করব)/,
];

const STATUS_PATTERNS: RegExp[] = [
  /\b(my order|order status|the order|delivery|deliver|delivered|parcel|courier|shipment|shipped|tracking|track)\b/i,
  /\b(where is|when will .* (arrive|come)|kobe pabo|kokhon pabo|kobe asbe|kokhon asbe|pathaisen|pathaiche|pathano hoyeche|parcel kothay)\b/i,
  /(অর্ডার|ডেলিভারি|পার্সেল|কুরিয়ার|কবে পাব|কখন পাব|কবে আসবে|কখন আসবে|পাঠানো হয়েছে)/,
];

export interface CommerceIntent {
  /** Wants something done to an order: buy, cancel, return, refund, change. A person handles these. */
  request: boolean;
  /** Asks about an existing order or its delivery. */
  status: boolean;
  orderNumbers: string[];
}

export function detectCommerceIntent(text: string): CommerceIntent {
  const orderNumbers = orderNumbersIn(text);
  return {
    request: REQUEST_PATTERNS.some((p) => p.test(text)),
    status: orderNumbers.length > 0 || STATUS_PATTERNS.some((p) => p.test(text)),
    orderNumbers,
  };
}

/** The lines added to the prompt when commerce answers are on. Never present otherwise. */
export function commercePromptRules(policy: AiCommercePolicy, ctx: { ordersFound: boolean; customerVerified: boolean }): string[] {
  if (!policy.active) return [];
  const can = [policy.product ? "product details, prices and availability" : null, policy.orders ? "the status of the customer's own orders" : null, policy.delivery ? "where their own delivery is" : null]
    .filter(Boolean)
    .join(", ");
  return [
    "",
    `COMMERCE. This business sells through this system. You may help with: ${can}. Nothing else about orders or money.`,
    "Prices, stock, payments, order details and delivery details may be stated ONLY exactly as they are written in reference entries titled \"Product:\" or \"Your order\". Never state, round, estimate or convert a price, discount, stock level, delivery date or order status that is not written there.",
    "You cannot create, change, cancel or refund an order, book or change a delivery, or reserve stock. If the customer wants any of that, answer SHOULD_REPLY: NO so a person handles it.",
    policy.orders
      ? ctx.ordersFound
        ? "Order details are given only for orders of this customer's own verified number. Never discuss any other order, even when the customer gives its number."
        : ctx.customerVerified
          ? "No recent order was found for this customer's number. If they ask about an order, answer SHOULD_REPLY: NO."
          : "This customer's number could not be verified, so no order can be discussed. If they ask about an order, answer SHOULD_REPLY: NO."
      : "Order status is not available here. If the customer asks about an order, answer SHOULD_REPLY: NO.",
    policy.delivery ? "Delivery status is what the courier last reported, at the time shown; say when it was checked." : "Delivery tracking is not available here: never say where a parcel is or when it will arrive.",
    policy.product && !policy.showStockCount ? "Say only whether something is in stock, never how many." : "",
  ].filter((line) => line !== "");
}

/**
 * Every money amount in a reply must appear in the commerce grounding — the mechanical check behind
 * "never invent a price". An amount is a number written next to a currency (৳, Tk, taka, টাকা, BDT, $,
 * USD, Rs). Bengali digits are compared as ASCII; thousands separators and a ".00" are ignored.
 */
export function validateCommerceFigures(reply: string, groundingText: string): { ok: true } | { ok: false; unsupported: string[] } {
  const amounts = extractAmounts(reply);
  if (amounts.length === 0) return { ok: true };
  const allowed = new Set(extractNumbers(groundingText));
  const unsupported = amounts.filter((a) => !allowed.has(a));
  return unsupported.length ? { ok: false, unsupported } : { ok: true };
}

const CURRENCY = "(?:৳|tk\\.?|taka|টাকা|bdt|usd|\\$|rs\\.?|inr|€|£)";
const NUMBER = "(\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)";

function normalizeAmount(raw: string): string {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : raw;
}

function extractAmounts(text: string): string[] {
  const t = asciiDigits(text);
  const out: string[] = [];
  const after = new RegExp(`${NUMBER}\\s?(?:/-)?\\s?${CURRENCY}`, "gi");
  const before = new RegExp(`${CURRENCY}\\s?${NUMBER}`, "gi");
  for (const m of t.matchAll(after)) out.push(normalizeAmount(m[1]!));
  for (const m of t.matchAll(before)) out.push(normalizeAmount(m[1]!));
  return [...new Set(out)];
}

function extractNumbers(text: string): string[] {
  return [...asciiDigits(text).matchAll(new RegExp(NUMBER, "g"))].map((m) => normalizeAmount(m[1]!));
}
