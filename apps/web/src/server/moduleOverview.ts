import { OPEN_SHIPMENT_STATUSES, PROJECT_FEATURES, resolveAiCommercePolicy, AI_COMMERCE_CAPABILITY_LABELS, type ProjectFeatureKey } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";

/**
 * The Overview's module-aware parts (PROJECT_MODULES.md §Dashboard): commerce figures, shown only while
 * a commerce module is on, and the setup checklist — modules that are ON but cannot do their job yet.
 * Read-only; every query goes through the project-scoped client. A module that is off contributes
 * nothing, so a project that never switched one on sees exactly the Overview it always had.
 */

const LOW_STOCK = 5;

export interface CommerceOverview {
  catalog: { active: number; outOfStock: number; lowStock: number } | null;
  orders: { today: number; toConfirm: number; unpaid: number } | null;
  shipments: { inTransit: number; toCheck: number } | null;
  leads: { open: number; overdue: number } | null;
}

function dhakaMidnight(now: Date): Date {
  const d = new Date(now.getTime() + 6 * 3_600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 6 * 3_600_000);
}

/** Null when no commerce module is on (the Overview then shows no commerce section at all). */
export async function getCommerceOverview(now = new Date()): Promise<CommerceOverview | null> {
  const off = await activeDisabledFeatures();
  const on = (k: ProjectFeatureKey) => !off.has(k);
  if (!on("PRODUCT_CATALOG") && !on("ORDERS") && !on("SALES_PIPELINE") && !on("COURIER")) return null;

  const [catalog, orders, shipments, leads] = await Promise.all([
    on("PRODUCT_CATALOG")
      ? Promise.all([
          prisma.product.count({ where: { status: "ACTIVE" } }),
          // Products counted by their own stock; products with variants are counted per variant elsewhere.
          prisma.product.count({ where: { status: "ACTIVE", trackInventory: true, stockQuantity: 0, variants: { none: {} } } }),
          prisma.product.count({ where: { status: "ACTIVE", trackInventory: true, stockQuantity: { gt: 0, lte: LOW_STOCK }, variants: { none: {} } } }),
        ]).then(([active, outOfStock, lowStock]) => ({ active, outOfStock, lowStock }))
      : null,
    on("ORDERS")
      ? Promise.all([
          prisma.commerceOrder.count({ where: { createdAt: { gte: dhakaMidnight(now) } } }),
          prisma.commerceOrder.count({ where: { status: "DRAFT" } }),
          prisma.commerceOrder.count({ where: { status: { in: ["CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"] }, paymentStatus: { in: ["UNPAID", "PARTIAL"] } } }),
        ]).then(([today, toConfirm, unpaid]) => ({ today, toConfirm, unpaid }))
      : null,
    on("COURIER")
      ? Promise.all([
          prisma.shipment.count({ where: { status: { in: [...OPEN_SHIPMENT_STATUSES] } } }),
          prisma.shipment.count({ where: { status: "UNKNOWN" } }),
        ]).then(([inTransit, toCheck]) => ({ inTransit, toCheck }))
      : null,
    on("SALES_PIPELINE")
      ? Promise.all([
          prisma.salesLead.count({ where: { stage: { notIn: ["WON", "LOST"] } } }),
          prisma.salesLead.count({ where: { stage: { notIn: ["WON", "LOST"] }, nextFollowUpAt: { lt: now } } }),
        ]).then(([open, overdue]) => ({ open, overdue }))
      : null,
  ]);
  return { catalog, orders, shipments, leads };
}

export interface SetupItem {
  module: string;
  text: string;
  href: string;
  linkLabel: string;
}

const LABEL = new Map(PROJECT_FEATURES.map((f) => [f.key, f.label]));

/**
 * Modules that are on but cannot do their job yet: nothing configured, or a connection whose last check
 * failed. Never a module that is off, and never a choice the project made on purpose (an AI switch left
 * off is not a problem).
 */
export async function getSetupChecklist(): Promise<SetupItem[]> {
  const off = await activeDisabledFeatures();
  const on = (k: ProjectFeatureKey) => !off.has(k);
  const items: SetupItem[] = [];
  const add = (module: ProjectFeatureKey, text: string, href: string, linkLabel: string) => items.push({ module: LABEL.get(module) ?? module, text, href, linkLabel });

  const checks: Array<Promise<void>> = [];
  if (on("PRODUCT_CATALOG")) {
    checks.push(
      prisma.product.count({ where: { status: "ACTIVE" } }).then((n) => {
        if (n === 0) add("PRODUCT_CATALOG", "The catalogue has no active products, so no order can be made and AI has nothing to quote.", "/commerce/products/new", "Add a product");
      }),
    );
  }
  if (on("COURIER")) {
    checks.push(
      prisma.courierConnection.findMany({ select: { label: true, isActive: true, lastCheckOk: true } }).then((rows) => {
        const active = rows.filter((r) => r.isActive);
        if (active.length === 0) add("COURIER", "No courier is connected, so orders cannot be booked for delivery.", "/settings/couriers", "Connect a courier");
        for (const r of active.filter((x) => x.lastCheckOk === false)) add("COURIER", `${r.label}: the last connection test failed.`, "/settings/couriers", "Check it");
      }),
    );
  }
  for (const shop of ["WOOCOMMERCE", "SHOPIFY"] as const) {
    if (!on(shop)) continue;
    checks.push(
      prisma.shopConnection.findFirst({ where: { provider: shop }, select: { isActive: true, lastSyncAt: true, lastSyncOk: true, lastError: true } }).then((c) => {
        const page = shop === "WOOCOMMERCE" ? "/settings/woocommerce" : "/settings/shopify";
        if (!c) add(shop, "The shop is not connected yet.", page, "Connect");
        else if (c.isActive && c.lastSyncOk === false) add(shop, `The last import or test failed${c.lastError ? `: ${c.lastError.slice(0, 120)}` : "."}`, page, "Open");
        else if (c.isActive && !c.lastSyncAt) add(shop, "Connected, but nothing has been imported yet.", page, "Import products");
      }),
    );
  }
  if (on("OMNICHANNEL")) {
    checks.push(
      prisma.channelConnection.count({ where: { status: { not: "DISCONNECTED" } } }).then((n) => {
        if (n === 0) add("OMNICHANNEL", "No Messenger, Instagram, Telegram or website chat is connected.", "/settings/channels", "Connect a channel");
      }),
    );
  }
  if (on("GOOGLE_SHEETS")) {
    checks.push(
      prisma.googleIntegrationAccount.count({ where: { status: "CONNECTED" } }).then((n) => {
        if (n === 0) add("GOOGLE_SHEETS", "No Google account is connected, so no spreadsheet can be listed.", "/settings/google-sheets", "Connect Google");
      }),
    );
  }
  checks.push(
    prisma.aiSettings.findFirst({ select: { commerceProductAnswers: true, commerceOrderAnswers: true, commerceDeliveryAnswers: true, commerceShowStockCount: true, commerceHandoverRequests: true } }).then((s) => {
      if (!s) return;
      const enabled = new Set<string>(PROJECT_FEATURES.map((f) => f.key).filter((k) => !off.has(k)));
      for (const b of resolveAiCommercePolicy(enabled, s).blocked) {
        items.push({ module: "AI", text: `${AI_COMMERCE_CAPABILITY_LABELS[b.capability]} is switched on, but ${b.reason.charAt(0).toLowerCase()}${b.reason.slice(1)}`, href: "/ai-learning/settings", linkLabel: "AI Settings" });
      }
    }),
  );
  await Promise.all(checks.map((c) => c.catch((err) => console.error("[overview] setup check failed", (err as Error).name))));
  return items;
}
