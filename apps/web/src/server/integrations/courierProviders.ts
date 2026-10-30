import { createHash } from "node:crypto";
import { COURIER_BASE_URLS, type CourierProvider } from "@support-automation/shared";
import { asObj, callProvider, ProviderError, providerMessage } from "./http";

/**
 * Courier adapters (COMMERCE_INTEGRATIONS.md §Couriers). Each offers only what the provider's merchant
 * API documents: test the account, book a parcel, read its status (and RedX's delivery areas, Steadfast's
 * lookup by our invoice). Cancellation is not offered: none of the three documents one for merchants.
 *
 * Verified against the providers' published documentation, NOT against live accounts — the first live
 * booking on each must be checked in the courier's own panel (COMMERCE_INTEGRATIONS.md §Verification).
 */

export interface CourierCredentials {
  [key: string]: string;
}

export interface CourierSettings {
  /** Pathao: the store parcels are picked up from (required). */
  storeId?: string;
  /** Pathao: kg, 0.5–10. RedX: grams. */
  weight?: string;
  /** RedX: pickup store id (optional). */
  pickupStoreId?: string;
}

export interface BookingInput {
  invoice: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  codAmountMinor: bigint;
  orderValueMinor: bigint;
  itemCount: number;
  itemDescription: string;
  note: string | null;
  /** RedX: the delivery area chosen for this parcel. */
  areaId?: string | null;
  areaName?: string | null;
}

export interface BookingResult {
  consignmentId: string | null;
  trackingCode: string | null;
  providerStatus: string | null;
  details: Record<string, unknown>;
}

export interface CourierAdapter {
  test(): Promise<string>;
  book(input: BookingInput): Promise<BookingResult>;
  /** The provider's own status text for a parcel. */
  status(ref: { consignmentId: string | null; trackingCode: string | null; invoice: string }): Promise<string>;
  areas?(): Promise<Array<{ id: string; name: string; district: string | null }>>;
}

const taka = (minor: bigint) => Number(minor) / 100;

export function courierAdapter(provider: CourierProvider, credentials: CourierCredentials, settings: CourierSettings, sandbox: boolean): CourierAdapter {
  const urls = COURIER_BASE_URLS[provider];
  const base = sandbox && urls.sandbox ? urls.sandbox : urls.live;
  if (provider === "STEADFAST") return steadfast(base, credentials);
  if (provider === "PATHAO") return pathao(base, credentials, settings);
  return redx(base, credentials, settings);
}

// Steadfast (Packzy) --------------------------------------------------------------------------

function steadfast(base: string, c: CourierCredentials): CourierAdapter {
  const who = "Steadfast";
  const headers = { "Api-Key": c.apiKey ?? "", "Secret-Key": c.secretKey ?? "", "Content-Type": "application/json", Accept: "application/json" };
  const get = async (path: string) => {
    const r = await callProvider(`${base}${path}`, { method: "GET", headers, who });
    if (r.status === 401 || r.status === 403) throw new ProviderError("Steadfast refused the API key or secret key.", r.status);
    if (r.status >= 400) throw new ProviderError(providerMessage(r.body, `Steadfast answered ${r.status}.`), r.status);
    return asObj(r.body);
  };
  return {
    async test() {
      const body = await get("/get_balance");
      if (body.status !== 200 && body.current_balance === undefined) throw new ProviderError(providerMessage(body, "Steadfast did not confirm the account."));
      return `Connected. Balance: ${String(body.current_balance ?? "?")} BDT.`;
    },
    async book(input) {
      const r = await callProvider(`${base}/create_order`, {
        method: "POST",
        headers,
        who,
        body: JSON.stringify({
          invoice: input.invoice,
          recipient_name: input.recipientName,
          recipient_phone: input.recipientPhone,
          recipient_address: input.recipientAddress,
          cod_amount: taka(input.codAmountMinor),
          note: input.note ?? undefined,
          item_description: input.itemDescription,
          total_lot: input.itemCount,
        }),
      });
      const body = asObj(r.body);
      const consignment = asObj(body.consignment);
      if (r.status >= 400 || body.status !== 200 || !consignment.consignment_id) throw new ProviderError(providerMessage(body, `Steadfast did not book the parcel (${r.status}).`), r.status);
      return {
        consignmentId: String(consignment.consignment_id),
        trackingCode: consignment.tracking_code ? String(consignment.tracking_code) : null,
        providerStatus: consignment.status ? String(consignment.status) : null,
        details: {},
      };
    },
    async status(ref) {
      const path = ref.consignmentId ? `/status_by_cid/${encodeURIComponent(ref.consignmentId)}` : ref.trackingCode ? `/status_by_trackingcode/${encodeURIComponent(ref.trackingCode)}` : `/status_by_invoice/${encodeURIComponent(ref.invoice)}`;
      const body = await get(path);
      if (!body.delivery_status) throw new ProviderError(providerMessage(body, "Steadfast does not know this parcel."));
      return String(body.delivery_status);
    },
  };
}

// Pathao Courier (merchant API "Aladdin") -----------------------------------------------------

const pathaoTokens = new Map<string, { token: string; expiresAt: number }>();

function pathao(base: string, c: CourierCredentials, settings: CourierSettings): CourierAdapter {
  const who = "Pathao";
  const cacheKey = createHash("sha256").update(`${base}|${c.clientId}|${c.username}|${c.clientSecret}|${c.password}`).digest("hex");
  async function token(): Promise<string> {
    const cached = pathaoTokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const r = await callProvider(`${base}/aladdin/api/v1/issue-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      who,
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, username: c.username, password: c.password, grant_type: "password" }),
    });
    const body = asObj(r.body);
    if (r.status >= 400 || typeof body.access_token !== "string") throw new ProviderError(providerMessage(body, "Pathao refused the client or login details."), r.status);
    const ttl = typeof body.expires_in === "number" ? body.expires_in * 1000 : 3_600_000;
    pathaoTokens.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + ttl });
    return body.access_token;
  }
  const authed = async (path: string, init: { method: string; body?: string }) => {
    const r = await callProvider(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", Accept: "application/json" },
      who,
    });
    if (r.status === 401) pathaoTokens.delete(cacheKey);
    return r;
  };
  return {
    async test() {
      const r = await authed("/aladdin/api/v1/stores", { method: "GET" });
      if (r.status >= 400) throw new ProviderError(providerMessage(r.body, `Pathao answered ${r.status}.`), r.status);
      const stores = (asObj(asObj(r.body).data).data as unknown[]) ?? [];
      const ids = Array.isArray(stores) ? stores.map((s) => `${asObj(s).store_name ?? "?"} (#${asObj(s).store_id ?? "?"})`) : [];
      if (!settings.storeId) return `Connected. Stores: ${ids.join(", ") || "none"}. Choose the store id to book from.`;
      return `Connected. Booking from store #${settings.storeId}.${ids.length ? ` Stores: ${ids.join(", ")}.` : ""}`;
    },
    async book(input) {
      if (!settings.storeId) throw new ProviderError("Set the Pathao store id on the courier connection first.");
      const weight = Math.min(10, Math.max(0.5, Number(settings.weight) || 0.5));
      const r = await authed("/aladdin/api/v1/orders", {
        method: "POST",
        body: JSON.stringify({
          store_id: Number(settings.storeId),
          merchant_order_id: input.invoice,
          recipient_name: input.recipientName,
          recipient_phone: input.recipientPhone,
          recipient_address: input.recipientAddress,
          delivery_type: 48,
          item_type: 2,
          special_instruction: input.note ?? undefined,
          item_quantity: input.itemCount,
          item_weight: weight,
          amount_to_collect: Math.round(taka(input.codAmountMinor)),
          item_description: input.itemDescription,
        }),
      });
      const body = asObj(r.body);
      const data = asObj(body.data);
      if (r.status >= 400 || !data.consignment_id) throw new ProviderError(providerMessage(body, `Pathao did not book the parcel (${r.status}).`), r.status);
      return {
        consignmentId: String(data.consignment_id),
        trackingCode: String(data.consignment_id),
        providerStatus: data.order_status ? String(data.order_status) : null,
        details: { deliveryFee: data.delivery_fee ?? null, weight },
      };
    },
    async status(ref) {
      if (!ref.consignmentId) throw new ProviderError("This parcel has no Pathao consignment id to look up.");
      const r = await authed(`/aladdin/api/v1/orders/${encodeURIComponent(ref.consignmentId)}/info`, { method: "GET" });
      const data = asObj(asObj(r.body).data);
      if (r.status >= 400 || !(data.order_status_slug || data.order_status)) throw new ProviderError(providerMessage(r.body, `Pathao answered ${r.status}.`), r.status);
      return String(data.order_status_slug ?? data.order_status);
    },
  };
}

// RedX ----------------------------------------------------------------------------------------

const redxAreas = new Map<string, { at: number; areas: Array<{ id: string; name: string; district: string | null }> }>();

function redx(base: string, c: CourierCredentials, settings: CourierSettings): CourierAdapter {
  const who = "RedX";
  const headers = { "API-ACCESS-TOKEN": `Bearer ${c.accessToken ?? ""}`, "Content-Type": "application/json", Accept: "application/json" };
  const cacheKey = createHash("sha256").update(`${base}|${c.accessToken}`).digest("hex");
  const get = async (path: string) => {
    const r = await callProvider(`${base}${path}`, { method: "GET", headers, who });
    if (r.status === 401 || r.status === 403) throw new ProviderError("RedX refused the access token.", r.status);
    if (r.status >= 400) throw new ProviderError(providerMessage(r.body, `RedX answered ${r.status}.`), r.status);
    return asObj(r.body);
  };
  const adapter: CourierAdapter = {
    async test() {
      const areas = await adapter.areas!();
      return `Connected. ${areas.length} delivery areas available.`;
    },
    async areas() {
      const cached = redxAreas.get(cacheKey);
      if (cached && Date.now() - cached.at < 3_600_000) return cached.areas;
      const body = await get("/areas");
      const list = Array.isArray(body.areas) ? body.areas : [];
      const areas = list
        .map((a) => asObj(a))
        .filter((a) => a.id !== undefined && a.name)
        .map((a) => ({ id: String(a.id), name: String(a.name), district: a.district_name ? String(a.district_name) : a.division_name ? String(a.division_name) : null }));
      redxAreas.set(cacheKey, { at: Date.now(), areas });
      return areas;
    },
    async book(input) {
      if (!input.areaId || !input.areaName) throw new ProviderError("Choose the RedX delivery area.");
      const r = await callProvider(`${base}/parcel`, {
        method: "POST",
        headers,
        who,
        body: JSON.stringify({
          customer_name: input.recipientName,
          customer_phone: input.recipientPhone,
          delivery_area: input.areaName,
          delivery_area_id: Number(input.areaId),
          customer_address: input.recipientAddress,
          merchant_invoice_id: input.invoice,
          cash_collection_amount: String(taka(input.codAmountMinor)),
          parcel_weight: Number(settings.weight) || 500,
          instruction: input.note ?? "",
          value: String(taka(input.orderValueMinor)),
          ...(settings.pickupStoreId ? { pickup_store_id: Number(settings.pickupStoreId) } : {}),
        }),
      });
      const body = asObj(r.body);
      if (r.status >= 400 || !body.tracking_id) throw new ProviderError(providerMessage(body, `RedX did not book the parcel (${r.status}).`), r.status);
      return { consignmentId: String(body.tracking_id), trackingCode: String(body.tracking_id), providerStatus: "pickup-pending", details: { areaId: input.areaId, areaName: input.areaName } };
    },
    async status(ref) {
      const id = ref.trackingCode ?? ref.consignmentId;
      if (!id) throw new ProviderError("This parcel has no RedX tracking id to look up.");
      const body = await get(`/parcel/info/${encodeURIComponent(id)}`);
      const parcel = asObj(body.parcel);
      if (!parcel.status) throw new ProviderError(providerMessage(body, "RedX does not know this parcel."));
      return String(parcel.status);
    },
  };
  return adapter;
}
