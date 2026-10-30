# Commerce integrations — couriers and shops

Work package WP10 of the modular platform. Three project features, each **off by default**:

| Feature | Pages | Keys |
|---|---|---|
| `COURIER` (needs `ORDERS`) | `/commerce/shipments`, `/settings/couriers`, the Delivery card on an order | `shipments.view`, `shipments.manage`, `couriers.manage` |
| `WOOCOMMERCE` (needs `PRODUCT_CATALOG`) | `/settings/woocommerce`, the Shop card on an order | `woocommerce.manage` |
| `SHOPIFY` (needs `PRODUCT_CATALOG`) | `/settings/shopify`, the Shop card on an order | `shopify.manage` |

Migration `20261029160000_commerce_integrations` (additive): `CourierConnection`, `Shipment`, `ShipmentEvent`
(append-only), `ShopConnection`, `ShopSyncRun`, plus `ProductVariant.externalId` and partial unique indexes so an
imported product, variant or order is matched to the same row every time.

## Status — be honest about it

| | Code | Locally verified | Live-provider verified |
|---|---|---|---|
| Steadfast booking / status | yes | typecheck + lint only | **no** — needs a merchant account |
| Pathao booking / status | yes | typecheck + lint only | **no** — needs merchant API credentials (sandbox exists) |
| RedX booking / status / areas | yes | typecheck + lint only | **no** — needs an access token (sandbox exists) |
| WooCommerce import, webhooks, send order | yes | typecheck + lint only | **no** — needs a shop with REST keys |
| Shopify import, webhooks, draft order | yes | typecheck + lint only | **no** — needs a custom app token |

The adapters follow each provider's published merchant/API documentation. Field names and status texts must be
checked against a real account before anyone relies on them: book one parcel on each courier's sandbox (or one real
low-value parcel), and import one shop, then compare with the provider's own panel.

## Couriers (`apps/web/src/server/integrations/`)

- **Provider-neutral shipments.** One status vocabulary (`SHIPMENT_STATUSES` in `packages/shared/src/commerceIntegrations.ts`)
  with each provider's own text kept beside it (`providerStatus`). The mapping functions (`mapSteadfastStatus`,
  `mapPathaoStatus`, `mapRedxStatus`) are pure; a text nobody mapped keeps the shipment's last known status — never
  "Delivered" by guess.
- **Only what the API offers**: test, book, read status; RedX delivery areas; Steadfast lookup by our invoice.
  **No cancellation** (none of the three documents one for merchants) — cancel in the courier's panel, then "Mark
  cancelled at courier".
- **Booking is written first, then sent once.** The `Shipment` row (BOOKING) carries a unique invoice per project
  (`ORD-000042`, `ORD-000042-2` for a second attempt) and a partial unique index allows one live shipment per order.
  Booked → the order becomes Shipped. Refused → FAILED (book again). **No answer → UNKNOWN, never retried by
  itself**: a person checks the courier's panel and records "It was booked" (with the consignment id) or "It was not
  booked". `ProviderUnknownOutcome` vs `ProviderError` (`http.ts`) is that distinction; only an error that proves the
  request never left (DNS, refused connection) is a plain failure.
- **Background refresh** (`server/integrationsProcessor.ts`, app process, every minute, 20 shipments a tick): open
  shipments not checked for 30 minutes. Delivered moves the order to Delivered. A return is recorded on the shipment
  only — putting stock back is a person's "Mark returned" on the order. Skips held projects and the feature off.
  `INTEGRATIONS_PROCESSOR_DISABLED=true` turns it off.
- Phone numbers are sent as 11-digit `01…` (`courierPhone`); the address needs 10+ characters; the amount to collect
  defaults to what is still due and can never exceed the order total.
- Credentials are encrypted (`encryptSecret`), write-only on the form, decrypted only in `shipments.ts` /
  `couriers.ts`. Pathao tokens are cached in memory per credential set.

## Shops

- **WooCommerce**: REST API v3 with a consumer key/secret (HTTPS basic auth). **Shopify**: Admin GraphQL API
  (`SHOPIFY_API_VERSION`) with a custom app's Admin API access token; scopes `read_products`, `read_inventory`,
  `read_orders`, `write_draft_orders`. The two are not forced into one shape beyond the neutral records
  (`ShopProductRecord`, `ShopOrderRecord`).
- **Import** (Settings → the shop → Import): products always; orders only with "Import orders" on, from the last
  1–90 days. Bounded (3,000 products / 1,000 orders a run); every run is a `ShopSyncRun` with counts and the first
  errors. Re-importing updates the same rows; nothing is duplicated.
- **Matching is by the shop's id**, never by name or SKU. A SKU another product already uses is left off the import,
  never stolen. A variant the shop no longer lists is hidden, never deleted. A product deleted in the shop is archived.
- **The shop owns imported stock**: a different figure is written as a SYNC `InventoryMovement`. **Imported orders
  never move our stock** (the shop already did) — `moveOrderStatus` skips the stock effect for an order with
  `externalSource`, and its items cannot be edited here.
- **Webhooks** (`/api/shops/<webhookKey>`, outside any project): the key selects the connection and with it the
  project; the body is accepted only with the provider's signature — base64 HMAC-SHA256 of the raw body
  (`X-WC-Webhook-Signature` with the secret generated here; `X-Shopify-Hmac-Sha256` with the app's API secret key).
  Topics: product created/updated/deleted, order created/updated (orders only with import on). A held project
  answers 503 so the shop retries; a feature that is off answers 200 and ignores.
- **Approved order creation** (the Shop card on an order): sends one of OUR confirmed orders to the shop —
  WooCommerce creates an order, Shopify a **draft** order. Every item must be a product imported from that shop.
  Sent once: a `ShopSyncRun` row is claimed first under a partial unique index; only FAILED frees it; an UNKNOWN
  outcome keeps it until a person records what the shop shows.

## What you need to run

1. Before deploying: `docker compose run --rm migrate` (applies `20261029160000_commerce_integrations` and
   `20261029170000_integration_hub` with the others pending on `rudra`).
2. `NEXTAUTH_URL` must be the public address, or the webhook URLs cannot be shown.
3. For each provider: create credentials in its panel, save them under Settings, press Test, then do one real or
   sandbox booking / import and compare it with the provider's own panel.
