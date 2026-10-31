# Integration Hub — public API and signed webhooks

Work package WP11 (first slice). Feature `API_ACCESS` ("API & Webhooks"), **off by default**; key `api.manage`;
page Settings → API & Webhooks (`/settings/api`). Migration `20261029170000_integration_hub` (additive): `ApiKey`,
`WebhookEndpoint`, `WebhookDelivery`.

Built: scoped API keys, the public API v1, signed outbound webhooks with retries and a delivery history. Works with
n8n, Zapier and Make through their webhook and HTTP nodes. **Not built**: the visual workflow builder (Automation
Studio, shown as planned in the Module Builder), a WHMCS connector, OAuth apps.

## API keys and the public API

- A key is `ga_` + 40 random characters, **shown once**; only its SHA-256 is stored. It belongs to one project and
  carries its scopes; nothing in a request can widen either. Optional expiry; revoke is immediate and final.
- `Authorization: Bearer ga_…`. Every query runs inside the key's project through the scoped client
  (`runWithProject`), so a key cannot read another project. 120 requests a minute per key (in-process).
- Each route needs its scope AND its module on (otherwise 404), and the project active (otherwise 403):

| Route | Scope | Module |
|---|---|---|
| `GET /api/public/v1/products?search=&page=` | `products:read` | Product Catalog |
| `GET /api/public/v1/orders?status=&since=&page=` | `orders:read` | Orders |
| `GET /api/public/v1/orders/<number>` | `orders:read` | Orders |
| `GET /api/public/v1/shipments?order=<number>` | `shipments:read` | Courier Management |
| `POST /api/public/v1/leads` `{name, phone?, email?, company?, source?, value?, currency?, notes?}` | `leads:write` | Sales Pipeline |

Money is returned as decimal strings ("1250.00") with the currency beside it.

## Webhooks

- Events: `order.created`, `order.status_changed`, `order.payment_recorded`, `shipment.status_changed`,
  `lead.created`, `lead.stage_changed` (and `ping` from "Send test"). Raised by `emitWebhookEvent` AFTER the change
  is committed; it only queues one `WebhookDelivery` per subscribed endpoint and never throws.
- Body: `{ id, event, createdAt, data }`. Headers: `X-GetAssist-Event`, `X-GetAssist-Event-Id` (the same for every
  retry — deduplicate on it), `X-GetAssist-Delivery`, and
  `X-GetAssist-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret>`.
  Receivers should refuse a `t` older than five minutes.
- **At least once.** Retries after 1 min, 5 min, 30 min, 2 h, 6 h and 24 h, then DEAD (Retry by hand). A delivery
  left SENDING by a restart goes back in line after five minutes. A held project or the feature switched off makes
  deliveries wait, not fail.
- **No requests into our own network**: an address must be https with a public host when saved
  (`webhookUrlProblem`), and every address it resolves to is checked again before each send
  (`webhookDelivery.ts`). Redirects are not followed.
- The endpoint secret is shown once (at creation or "New secret") and stored encrypted.
- Delivery runs in the app process (`server/integrationsProcessor.ts`, every minute, 25 per tick);
  `INTEGRATIONS_PROCESSOR_DISABLED=true` turns it off.

## Limits worth knowing

- The rate limit is per app process, not shared between replicas (one app container today).
- The DNS check narrows, but does not fully close, a rebinding window between the check and the connection.
- Verified by typecheck and lint only; no live receiver has been exercised. Test with "Send test" to a request
  inspector (e.g. a self-hosted n8n webhook node) and check the signature there.
