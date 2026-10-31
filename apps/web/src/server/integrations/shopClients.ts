import {
  shopifyGqlOrderRecord,
  shopifyGqlProductRecord,
  SHOPIFY_API_VERSION,
  wooOrderRecord,
  wooProductRecord,
  type ShopOrderRecord,
  type ShopProductRecord,
  type ShopProvider,
} from "@support-automation/shared";
import { asObj, callProvider, ProviderError, providerMessage } from "./http";

/**
 * Shop clients (COMMERCE_INTEGRATIONS.md §Shops). WooCommerce through its REST API v3 (consumer key and
 * secret, HTTPS basic auth); Shopify through the Admin GraphQL API (a custom app's Admin API access token).
 * The two are deliberately not forced into one shape beyond the neutral records they return.
 */

export interface ShopCredentials {
  consumerKey?: string;
  consumerSecret?: string;
  accessToken?: string;
}

export interface ShopPage<T> {
  records: T[];
  /** Raw rows the page held that could not be read as records. */
  unreadable: number;
  next: string | null;
}

export interface PushOrderInput {
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  shippingAddress: string | null;
  note: string | null;
  paid: boolean;
  lines: Array<{ productExternalId: string; variantExternalId: string | null; quantity: number }>;
}

export interface ShopClient {
  /** A sentence for the person, and the shop's currency. */
  test(): Promise<{ message: string; currency: string | null }>;
  products(cursor: string | null): Promise<ShopPage<ShopProductRecord>>;
  /** Orders created since a moment, newest first. */
  orders(cursor: string | null, since: Date): Promise<ShopPage<ShopOrderRecord>>;
  /** One product by its shop id (webhooks that carry too little). */
  product(externalId: string): Promise<ShopProductRecord | null>;
  /** Approved order creation: WooCommerce creates an order, Shopify a draft order. Returns the shop's id and number. */
  pushOrder(input: PushOrderInput): Promise<{ externalId: string; number: string }>;
}

export function shopClient(provider: ShopProvider, shopUrl: string, credentials: ShopCredentials): ShopClient {
  return provider === "WOOCOMMERCE" ? woo(shopUrl, credentials) : shopify(shopUrl, credentials);
}

// WooCommerce ---------------------------------------------------------------------------------

function woo(shopUrl: string, c: ShopCredentials): ShopClient {
  const who = "WooCommerce";
  const auth = `Basic ${Buffer.from(`${c.consumerKey ?? ""}:${c.consumerSecret ?? ""}`).toString("base64")}`;
  const call = async (method: string, path: string, query: Record<string, string> = {}, body?: unknown) => {
    const qs = new URLSearchParams(query).toString();
    const r = await callProvider(`${shopUrl}/wp-json/wc/v3${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers: { Authorization: auth, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      who,
      timeoutMs: 30_000,
    });
    if (r.status === 401 || r.status === 403) throw new ProviderError("WooCommerce refused the consumer key or secret (check it has Read/Write permission).", r.status);
    if (r.status === 404) throw new ProviderError("No WooCommerce REST API at that address. Check the shop address and that permalinks are enabled.", r.status);
    if (r.status >= 400) throw new ProviderError(providerMessage(r.body, `WooCommerce answered ${r.status}.`), r.status);
    return r;
  };
  async function withVariations(p: unknown): Promise<ShopProductRecord | null> {
    const o = asObj(p);
    let variations: unknown[] = [];
    if (o.type === "variable" && o.id !== undefined) {
      const r = await call("GET", `/products/${encodeURIComponent(String(o.id))}/variations`, { per_page: "100" });
      variations = Array.isArray(r.body) ? r.body : [];
    }
    return wooProductRecord(p, variations);
  }
  return {
    async test() {
      await call("GET", "/products", { per_page: "1" });
      const cur = await call("GET", "/data/currencies/current").catch(() => null);
      const currency = cur ? String(asObj(cur.body).code ?? "").toUpperCase() || null : null;
      return { message: `Connected to ${shopUrl}.${currency ? ` Currency: ${currency}.` : ""}`, currency };
    },
    async products(cursor) {
      const page = Number(cursor ?? "1");
      const r = await call("GET", "/products", { per_page: "50", page: String(page), orderby: "id", order: "asc" });
      const rows = Array.isArray(r.body) ? r.body : [];
      const records: ShopProductRecord[] = [];
      let unreadable = 0;
      for (const row of rows) {
        const rec = await withVariations(row);
        if (rec) records.push(rec);
        else unreadable += 1;
      }
      const totalPages = Number(r.headers.get("x-wp-totalpages") ?? "0");
      return { records, unreadable, next: rows.length > 0 && (totalPages === 0 || page < totalPages) ? String(page + 1) : null };
    },
    async orders(cursor, since) {
      const page = Number(cursor ?? "1");
      const r = await call("GET", "/orders", { per_page: "50", page: String(page), orderby: "date", order: "desc", after: since.toISOString() });
      const rows = Array.isArray(r.body) ? r.body : [];
      const records = rows.map(wooOrderRecord).filter((x): x is ShopOrderRecord => x !== null);
      const totalPages = Number(r.headers.get("x-wp-totalpages") ?? "0");
      return { records, unreadable: rows.length - records.length, next: rows.length > 0 && (totalPages === 0 || page < totalPages) ? String(page + 1) : null };
    },
    async product(externalId) {
      const r = await call("GET", `/products/${encodeURIComponent(externalId)}`);
      return withVariations(r.body);
    },
    async pushOrder(input) {
      const [first, ...rest] = input.customerName.split(" ");
      const address = { first_name: first ?? "", last_name: rest.join(" "), phone: input.customerPhone ?? "", email: input.customerEmail ?? undefined, address_1: input.shippingAddress ?? "" };
      const r = await call("POST", "/orders", undefined, {
        status: "processing",
        set_paid: input.paid,
        billing: address,
        shipping: { first_name: address.first_name, last_name: address.last_name, address_1: address.address_1, phone: address.phone },
        customer_note: input.note ?? undefined,
        line_items: input.lines.map((l) => ({ product_id: Number(l.productExternalId), ...(l.variantExternalId ? { variation_id: Number(l.variantExternalId) } : {}), quantity: l.quantity })),
      });
      const o = asObj(r.body);
      if (o.id === undefined) throw new ProviderError("WooCommerce did not return the new order.");
      return { externalId: String(o.id), number: String(o.number ?? o.id) };
    },
  };
}

// Shopify -------------------------------------------------------------------------------------

const PRODUCT_FIELDS = `id title descriptionHtml status productType featuredImage { url } variants(first: 100) { nodes { id title sku price inventoryQuantity } }`;
const ORDER_FIELDS = `id name createdAt cancelledAt currencyCode displayFinancialStatus displayFulfillmentStatus note email
  totalPriceSet { shopMoney { amount } } totalDiscountsSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } }
  customer { displayName phone email } shippingAddress { name phone address1 address2 city zip country }
  lineItems(first: 100) { nodes { title sku quantity originalUnitPriceSet { shopMoney { amount } } variant { id } product { id } } }`;

function shopify(shopUrl: string, c: ShopCredentials): ShopClient {
  const who = "Shopify";
  async function gql(query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const r = await callProvider(`${shopUrl}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": c.accessToken ?? "", "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      who,
      timeoutMs: 30_000,
    });
    if (r.status === 401 || r.status === 403) throw new ProviderError("Shopify refused the Admin API access token, or the app lacks a scope it needs.", r.status);
    if (r.status === 429) throw new ProviderError("Shopify is rate limiting this store; try again in a minute.", r.status);
    if (r.status >= 400) throw new ProviderError(providerMessage(r.body, `Shopify answered ${r.status}.`), r.status);
    const body = asObj(r.body);
    if (Array.isArray(body.errors) && body.errors.length) {
      const msg = body.errors.map((e) => String(asObj(e).message ?? e)).join("; ");
      throw new ProviderError(/access denied|scope/i.test(msg) ? `Shopify: ${msg}. Give the custom app the read_products, read_inventory and read_orders scopes (write_draft_orders to send orders).` : `Shopify: ${msg}`.slice(0, 300));
    }
    return asObj(body.data);
  }
  return {
    async test() {
      const data = await gql(`query { shop { name currencyCode } }`);
      const shop = asObj(data.shop);
      return { message: `Connected to ${String(shop.name ?? shopUrl)}. Currency: ${String(shop.currencyCode ?? "?")}.`, currency: shop.currencyCode ? String(shop.currencyCode) : null };
    },
    async products(cursor) {
      const data = await gql(`query($cursor: String) { products(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS} } } }`, { cursor });
      const conn = asObj(data.products);
      const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];
      const records = nodes.map(shopifyGqlProductRecord).filter((x): x is ShopProductRecord => x !== null);
      const info = asObj(conn.pageInfo);
      return { records, unreadable: nodes.length - records.length, next: info.hasNextPage ? String(info.endCursor) : null };
    },
    async orders(cursor, since) {
      const data = await gql(`query($cursor: String, $q: String) { orders(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true, query: $q) { pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`, {
        cursor,
        q: `created_at:>='${since.toISOString()}'`,
      });
      const conn = asObj(data.orders);
      const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];
      const records = nodes.map(shopifyGqlOrderRecord).filter((x): x is ShopOrderRecord => x !== null);
      const info = asObj(conn.pageInfo);
      return { records, unreadable: nodes.length - records.length, next: info.hasNextPage ? String(info.endCursor) : null };
    },
    async product(externalId) {
      const data = await gql(`query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id: `gid://shopify/Product/${externalId}` });
      return data.product ? shopifyGqlProductRecord(data.product) : null;
    },
    async pushOrder(input) {
      const missing = input.lines.find((l) => !l.variantExternalId);
      if (missing) throw new ProviderError("Every item must be a Shopify variant to send the order to Shopify.");
      const [first, ...rest] = input.customerName.split(" ");
      const data = await gql(
        `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } } }`,
        {
          input: {
            lineItems: input.lines.map((l) => ({ variantId: `gid://shopify/ProductVariant/${l.variantExternalId}`, quantity: l.quantity })),
            ...(input.customerEmail ? { email: input.customerEmail } : {}),
            ...(input.customerPhone ? { phone: input.customerPhone } : {}),
            note: input.note ?? undefined,
            ...(input.shippingAddress ? { shippingAddress: { firstName: first ?? "", lastName: rest.join(" ") || "-", address1: input.shippingAddress, phone: input.customerPhone ?? undefined } } : {}),
          },
        },
      );
      const result = asObj(data.draftOrderCreate);
      const errors = Array.isArray(result.userErrors) ? result.userErrors : [];
      if (errors.length) throw new ProviderError(`Shopify: ${errors.map((e) => String(asObj(e).message)).join("; ")}`.slice(0, 300));
      const draft = asObj(result.draftOrder);
      if (!draft.id) throw new ProviderError("Shopify did not return the draft order.");
      return { externalId: String(draft.id).replace(/^.*\//, ""), number: String(draft.name ?? draft.id) };
    },
  };
}
