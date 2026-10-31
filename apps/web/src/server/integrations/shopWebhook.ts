import { createHmac, timingSafeEqual } from "node:crypto";
import { decryptSecret } from "@support-automation/db";
import {
  shopifyNumericId,
  shopifyRestOrderRecord,
  shopifyRestProductRecord,
  shopWebhookSubject,
  wooOrderRecord,
  wooProductRecord,
  type ShopProvider,
} from "@support-automation/shared";
import { globalPrisma, prisma } from "@/server/db";
import { runWithProject } from "@/server/projectContext";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { applyShopOrder, applyShopProduct, archiveShopProduct, clientForConnection } from "./shopSync";

/**
 * Shop webhooks (COMMERCE_INTEGRATIONS.md §Webhooks): `/api/shops/<webhookKey>`. The unguessable key
 * selects the connection — and with it the project; nothing in the body can choose another. The body is
 * accepted only with the provider's signature: base64 HMAC-SHA256 of the raw body with the connection's
 * webhook secret (WooCommerce: `X-WC-Webhook-Signature`; Shopify: `X-Shopify-Hmac-Sha256`).
 *
 * One record per webhook, applied at once (an upsert is idempotent, so a provider's retry is harmless).
 */

export const MAX_SHOP_WEBHOOK_BYTES = 2_000_000;

export interface ShopWebhookAnswer {
  status: number;
  body: string;
}

const OK: ShopWebhookAnswer = { status: 200, body: "OK" };

function signatureValid(rawBody: Buffer, header: string | null, secret: string | null): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("base64"));
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function ingestShopWebhook(input: { key: string; rawBody: Buffer; headers: Headers }): Promise<ShopWebhookAnswer> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(input.key)) return { status: 404, body: "Not found" };
  const connection = await globalPrisma.shopConnection.findUnique({
    where: { webhookKey: input.key },
    select: { id: true, projectId: true, provider: true, isActive: true, currency: true, importOrders: true, webhookSecretCiphertext: true },
  });
  if (!connection) return { status: 404, body: "Not found" };
  const provider = connection.provider as ShopProvider;
  const topic = provider === "WOOCOMMERCE" ? input.headers.get("x-wc-webhook-topic") : input.headers.get("x-shopify-topic");
  const signature = provider === "WOOCOMMERCE" ? input.headers.get("x-wc-webhook-signature") : input.headers.get("x-shopify-hmac-sha256");

  // WooCommerce pings a new webhook with a form body and no topic: acknowledge it, nothing else.
  if (provider === "WOOCOMMERCE" && !topic) return OK;

  let secret: string | null = null;
  try {
    secret = connection.webhookSecretCiphertext ? decryptSecret(connection.webhookSecretCiphertext) : null;
  } catch {
    secret = null;
  }
  if (!signatureValid(input.rawBody, signature, secret)) {
    console.warn(`[shops] ${provider} webhook with a missing or wrong signature for connection ${connection.id}; refused.`);
    return { status: 401, body: "Invalid signature" };
  }
  if (!connection.isActive) return { status: 200, body: "Connection off; ignored" };

  const project = await globalPrisma.project.findUnique({ where: { id: connection.projectId }, select: { id: true, slug: true, name: true, status: true, customerId: true, billingHoldAt: true } });
  // A held project takes no writes; answering 503 makes the shop retry later rather than lose the event.
  if (!project) return { status: 404, body: "Not found" };
  if (project.status !== "ACTIVE" || project.billingHoldAt) return { status: 503, body: "Project unavailable" };
  if ((await disabledFeaturesFor(project.id)).has(provider)) return { status: 200, body: "Feature off; ignored" };

  const subject = shopWebhookSubject(provider, topic);
  if (!subject) return OK;
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    return { status: 400, body: "Body is not JSON" };
  }
  const actor = `${provider.toLowerCase()}-webhook`;

  await runWithProject({ id: project.id, slug: project.slug, name: project.name, status: project.status, tenant: project.customerId }, async () => {
    try {
      if (subject === "PRODUCT_DELETED") {
        const id = provider === "SHOPIFY" ? shopifyNumericId((payload as { id?: unknown }).id) : String((payload as { id?: unknown }).id ?? "");
        if (id) await archiveShopProduct(provider, id);
      } else if (subject === "PRODUCT") {
        let record = provider === "SHOPIFY" ? shopifyRestProductRecord(payload) : wooProductRecord(payload);
        // A variable WooCommerce product's webhook names its variations without their stock: read it.
        if (provider === "WOOCOMMERCE" && record && (payload as { type?: string }).type === "variable") {
          const resolved = await clientForConnection(connection.id);
          if (!("refused" in resolved)) record = (await resolved.client.product(record.externalId)) ?? record;
        }
        if (record) await applyShopProduct(provider, record, connection.currency ?? "BDT", actor, project.id);
      } else if (subject === "ORDER" && connection.importOrders) {
        const record = provider === "SHOPIFY" ? shopifyRestOrderRecord(payload) : wooOrderRecord(payload);
        if (record) await applyShopOrder(provider, record, actor);
      }
      await prisma.shopConnection.update({ where: { id: connection.id }, data: { lastWebhookAt: new Date() } });
    } catch (err) {
      await prisma.shopConnection.update({ where: { id: connection.id }, data: { lastError: `Webhook ${topic}: ${(err as Error).message}`.slice(0, 300) } }).catch(() => undefined);
      throw err;
    }
  });
  return OK;
}
