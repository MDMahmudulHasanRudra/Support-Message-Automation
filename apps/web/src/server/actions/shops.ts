"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { decryptSecret, encryptSecret } from "@support-automation/db";
import { normalizeShopUrl, SHOP_LABELS, SHOP_PROVIDERS, type ShopProvider } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { ProviderError, ProviderUnknownOutcome } from "@/server/integrations/http";
import { clientForConnection, runShopImport } from "@/server/integrations/shopSync";

/**
 * Shop actions (COMMERCE_INTEGRATIONS.md §Shops). Each provider has its own key (woocommerce.manage /
 * shopify.manage), which is also its feature's. Credentials and the webhook secret are write-only.
 */

export interface ShopResult {
  error?: string;
  success?: string;
}

const KEY = { WOOCOMMERCE: "woocommerce.manage", SHOPIFY: "shopify.manage" } as const;
const PAGE = { WOOCOMMERCE: "/settings/woocommerce", SHOPIFY: "/settings/shopify" } as const;

function isShopProvider(v: unknown): v is ShopProvider {
  return typeof v === "string" && (SHOP_PROVIDERS as readonly string[]).includes(v);
}

async function revalidate(...paths: string[]) {
  for (const p of paths) revalidatePath(await projectPath(p));
}

export interface ShopConnectionInput {
  provider: string;
  label: string;
  shopUrl: string;
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  /** Shopify: the app's API secret key, which signs its webhooks. WooCommerce: generated here. */
  webhookSecret: string;
  importOrders: boolean;
  isActive: boolean;
}

export async function saveShopConnection(input: ShopConnectionInput): Promise<ShopResult> {
  if (!isShopProvider(input.provider)) return { error: "Unknown shop." };
  const provider: ShopProvider = input.provider;
  const access = await checkPermission(KEY[provider]);
  if ("denied" in access) return { error: access.denied };
  const url = normalizeShopUrl(provider, String(input.shopUrl ?? ""));
  if (!url.ok) return { error: url.error };
  const existing = await prisma.shopConnection.findFirst({ where: { provider } });
  let saved: Record<string, string> = {};
  if (existing) {
    try {
      saved = JSON.parse(decryptSecret(existing.credentialsCiphertext)) as Record<string, string>;
    } catch {
      saved = {};
    }
  }
  const pick = (typed: string, key: string) => String(typed ?? "").trim() || saved[key] || "";
  const credentials =
    provider === "WOOCOMMERCE"
      ? { consumerKey: pick(input.consumerKey, "consumerKey"), consumerSecret: pick(input.consumerSecret, "consumerSecret") }
      : { accessToken: pick(input.accessToken, "accessToken") };
  if (provider === "WOOCOMMERCE" && (!credentials.consumerKey || !credentials.consumerSecret)) return { error: "Enter the consumer key and consumer secret." };
  if (provider === "WOOCOMMERCE" && !/^ck_[A-Za-z0-9]{20,64}$/.test(credentials.consumerKey!)) return { error: "A WooCommerce consumer key starts with ck_." };
  if (provider === "SHOPIFY" && !credentials.accessToken) return { error: "Enter the Admin API access token." };

  let webhookSecretCiphertext = existing?.webhookSecretCiphertext ?? null;
  const typedSecret = String(input.webhookSecret ?? "").trim();
  if (typedSecret) webhookSecretCiphertext = encryptSecret(typedSecret.slice(0, 200));
  else if (!webhookSecretCiphertext && provider === "WOOCOMMERCE") webhookSecretCiphertext = encryptSecret(randomBytes(24).toString("base64url"));

  const data = {
    label: String(input.label ?? "").trim().slice(0, 80) || SHOP_LABELS[provider],
    shopUrl: url.url,
    credentialsCiphertext: encryptSecret(JSON.stringify(credentials)),
    webhookSecretCiphertext,
    importOrders: Boolean(input.importOrders),
    isActive: Boolean(input.isActive),
    // A new address may be a different shop: its currency is read again on the next test.
    ...(existing && existing.shopUrl !== url.url ? { currency: null } : {}),
  };
  try {
    const row = existing
      ? await prisma.shopConnection.update({ where: { id: existing.id }, data: { ...data, lastError: null } })
      : await prisma.shopConnection.create({ data: { ...data, provider, webhookKey: randomBytes(24).toString("base64url"), createdByUsername: access.session.username } });
    await logSystemEvent("INFO", "commerce", `${SHOP_LABELS[provider]} connection ${existing ? "updated" : "added"}`, { provider, shop: url.url, by: access.session.username }, { actorUserId: access.session.userId, targetType: "ShopConnection", targetId: row.id });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: `This project already has a ${SHOP_LABELS[provider]} connection.` };
    throw err;
  }
  await revalidate(PAGE[provider]);
  return { success: `${SHOP_LABELS[provider]} saved. Test it, then import products.` };
}

/** Show the WooCommerce webhook secret once more, to paste into the shop's webhook settings. */
export async function revealShopWebhookSecret(provider: string): Promise<{ secret?: string; error?: string }> {
  if (!isShopProvider(provider)) return { error: "Unknown shop." };
  const access = await checkPermission(KEY[provider]);
  if ("denied" in access) return { error: access.denied };
  const row = await prisma.shopConnection.findFirst({ where: { provider }, select: { webhookSecretCiphertext: true } });
  if (!row?.webhookSecretCiphertext) return { error: "No webhook secret is saved." };
  try {
    return { secret: decryptSecret(row.webhookSecretCiphertext) };
  } catch {
    return { error: "The saved secret cannot be read. Save a new one." };
  }
}

export async function testShopConnection(provider: string): Promise<ShopResult> {
  if (!isShopProvider(provider)) return { error: "Unknown shop." };
  const access = await checkPermission(KEY[provider]);
  if ("denied" in access) return { error: access.denied };
  const row = await prisma.shopConnection.findFirst({ where: { provider }, select: { id: true } });
  if (!row) return { error: "Save the connection first." };
  const resolved = await clientForConnection(row.id);
  if ("refused" in resolved) return { error: resolved.refused };
  try {
    const t = await resolved.client.test();
    await prisma.shopConnection.update({ where: { id: row.id }, data: { lastSyncOk: true, lastError: null, ...(t.currency ? { currency: t.currency } : {}) } });
    await revalidate(PAGE[provider]);
    return { success: t.message };
  } catch (err) {
    const message = err instanceof ProviderError || err instanceof ProviderUnknownOutcome ? err.message : "The test could not be completed.";
    await prisma.shopConnection.update({ where: { id: row.id }, data: { lastSyncOk: false, lastError: message } });
    await revalidate(PAGE[provider]);
    return { error: message };
  }
}

/** Import now: the products, or the orders of the last `days` days (1–90). */
export async function importFromShop(provider: string, kind: string, days = 30): Promise<ShopResult> {
  if (!isShopProvider(provider)) return { error: "Unknown shop." };
  const access = await checkPermission(KEY[provider]);
  if ("denied" in access) return { error: access.denied };
  if (kind !== "PRODUCTS" && kind !== "ORDERS") return { error: "Unknown import." };
  const row = await prisma.shopConnection.findFirst({ where: { provider }, select: { id: true, importOrders: true } });
  if (!row) return { error: "Save the connection first." };
  if (kind === "ORDERS" && !row.importOrders) return { error: "Switch on “Import orders” for this shop first." };
  try {
    const span = Math.min(90, Math.max(1, Math.trunc(Number(days) || 30)));
    const r = await runShopImport(row.id, kind, access.session.username, await activeProjectId(), new Date(Date.now() - span * 86_400_000));
    await revalidate(PAGE[provider], "/commerce/products", "/commerce/orders");
    return r.status === "FAILED" ? { error: r.message } : { success: r.message };
  } catch (err) {
    if (err instanceof ProviderError) return { error: err.message };
    throw err;
  }
}

/** Disconnect: the connection and its run history go; imported products and orders stay. */
export async function removeShopConnection(provider: string): Promise<ShopResult> {
  if (!isShopProvider(provider)) return { error: "Unknown shop." };
  const access = await checkPermission(KEY[provider]);
  if ("denied" in access) return { error: access.denied };
  const row = await prisma.shopConnection.findFirst({ where: { provider }, select: { id: true } });
  if (!row) return { error: "There is no connection to remove." };
  await prisma.shopConnection.delete({ where: { id: row.id } });
  await logSystemEvent("INFO", "commerce", `${SHOP_LABELS[provider]} connection removed`, { provider, by: access.session.username }, { actorUserId: access.session.userId, targetType: "ShopConnection", targetId: row.id });
  await revalidate(PAGE[provider]);
  return { success: `${SHOP_LABELS[provider]} disconnected. Imported products and orders are kept; remove the webhooks in the shop too.` };
}

/**
 * Approved order creation: send one of OUR orders to the shop (WooCommerce: an order; Shopify: a draft
 * order the merchant completes there). Every item must be a product imported from that shop. Sent once:
 * a run row is claimed first under a partial unique index; only a FAILED send frees it. An UNKNOWN outcome
 * keeps it — check the shop before sending again.
 */
export async function pushOrderToShop(orderId: string, provider: string): Promise<ShopResult> {
  if (!isShopProvider(provider)) return { error: "Unknown shop." };
  const access = await checkPermission(KEY[provider]);
  if ("denied" in access) return { error: access.denied };
  const order = await prisma.commerceOrder.findFirst({
    where: { id: orderId },
    include: { items: { include: { product: { select: { externalSource: true, externalId: true } }, variant: { select: { externalId: true } } } } },
  });
  if (!order) return { error: "That order no longer exists." };
  if (order.externalSource) return { error: "This order came from a shop; it is not sent back." };
  if (order.status !== "CONFIRMED" && order.status !== "PROCESSING") return { error: "Only a confirmed or processing order can be sent to the shop." };
  const foreign = order.items.find((i) => i.product?.externalSource !== provider || !i.product?.externalId);
  if (foreign) return { error: `“${foreign.name}” is not a ${SHOP_LABELS[provider]} product, so the shop cannot take this order.` };
  const conn = await prisma.shopConnection.findFirst({ where: { provider }, select: { id: true } });
  if (!conn) return { error: `Connect ${SHOP_LABELS[provider]} first.` };
  const resolved = await clientForConnection(conn.id);
  if ("refused" in resolved) return { error: resolved.refused };

  let runId: string;
  try {
    const run = await prisma.shopSyncRun.create({ data: { connectionId: conn.id, kind: "PUSH_ORDER", status: "RUNNING", orderId, actorUsername: access.session.username }, select: { id: true } });
    runId = run.id;
  } catch (err) {
    if (isUniqueViolation(err)) return { error: `This order was already sent to ${SHOP_LABELS[provider]} (or is being sent).` };
    throw err;
  }
  try {
    const pushed = await resolved.client.pushOrder({
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerEmail: order.customerEmail,
      shippingAddress: order.shippingAddress,
      note: `${order.number}${order.notes ? ` — ${order.notes}` : ""}`.slice(0, 500),
      paid: order.paymentStatus === "PAID",
      lines: order.items.map((i) => ({ productExternalId: i.product!.externalId!, variantExternalId: i.variant?.externalId ?? null, quantity: i.quantity })),
    });
    await prisma.$transaction([
      prisma.shopSyncRun.update({ where: { id: runId }, data: { status: "SUCCEEDED", externalId: pushed.externalId, created: 1, finishedAt: new Date() } }),
      prisma.commerceOrderEvent.create({ data: { orderId, kind: "PUSHED", detail: { shop: SHOP_LABELS[provider], shopOrder: pushed.number, externalId: pushed.externalId }, actorUsername: access.session.username } }),
    ]);
    await revalidate(`/commerce/orders/${orderId}`, PAGE[provider]);
    return { success: `Sent to ${SHOP_LABELS[provider]} as ${provider === "SHOPIFY" ? "draft order" : "order"} ${pushed.number}.` };
  } catch (err) {
    const unknown = err instanceof ProviderUnknownOutcome;
    const message = err instanceof ProviderError || unknown ? err.message : "The order could not be sent.";
    await prisma.shopSyncRun.update({ where: { id: runId }, data: { status: unknown ? "UNKNOWN" : "FAILED", failed: 1, errors: [message], finishedAt: new Date() } });
    await revalidate(`/commerce/orders/${orderId}`, PAGE[provider]);
    return { error: unknown ? `${message} It may have reached the shop: check there before sending again.` : `Not sent: ${message}` };
  }
}

/** A person records what the shop shows for a send whose outcome was unknown. NOT_SENT frees the order to be sent again. */
export async function resolveShopPush(runId: string, sent: boolean, shopOrder: string): Promise<ShopResult> {
  const run = await prisma.shopSyncRun.findFirst({ where: { id: runId, kind: "PUSH_ORDER" }, select: { id: true, status: true, orderId: true, connection: { select: { provider: true } } } });
  if (!run) return { error: "That send no longer exists." };
  const access = await checkPermission(KEY[run.connection.provider]);
  if ("denied" in access) return { error: access.denied };
  if (run.status !== "UNKNOWN") return { error: "Only a send whose outcome is unknown can be resolved." };
  const reference = String(shopOrder ?? "").trim().slice(0, 64);
  if (sent && !reference) return { error: "Enter the shop's order number." };
  await prisma.shopSyncRun.update({ where: { id: run.id }, data: sent ? { status: "SUCCEEDED", externalId: reference, errors: [`Recorded by ${access.session.username}`] } : { status: "FAILED", errors: [`Not in the shop, recorded by ${access.session.username}`] } });
  if (sent && run.orderId) {
    await prisma.commerceOrderEvent.create({ data: { orderId: run.orderId, kind: "PUSHED", detail: { shop: SHOP_LABELS[run.connection.provider], shopOrder: reference, recorded: true }, actorUsername: access.session.username } });
  }
  if (run.orderId) await revalidate(`/commerce/orders/${run.orderId}`);
  return { success: sent ? "Recorded as sent." : "Recorded as not sent. The order can be sent again." };
}
