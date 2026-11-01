# 05 — Webhooks and tenant isolation

Status: **proposal**, extending `/api/meta/webhook` (implemented for `page` / `instagram`).

## 1. One endpoint, routed on `object`
`https://admin.getassist.pro/api/meta/webhook` — GET verify with `META_WEBHOOK_VERIFY_TOKEN`; POST requires a
valid `X-Hub-Signature-256` (App Secret) over the raw body before anything is parsed.

| `object` | Fields | Routed by | Status |
|---|---|---|---|
| `page` | messaging fields | `entry.id` = Page → live PLATFORM MESSENGER row | implemented |
| `page` | `feed` (comments), `mention`, `leadgen` | `entry.id` = Page → publishing / lead connection of the same Page | Release C / D |
| `instagram` | messaging fields | `entry.id` = IG account → live INSTAGRAM row | implemented |
| `instagram` | `comments`, `mentions` | IG account → Social account | Release C |
| `whatsapp_business_account` | `messages`, `message_template_status_update`, `phone_number_quality_update`, `account_update` | `entry.id` = WABA, then `value.metadata.phone_number_id` → live `WHATSAPP_CLOUD` row | Release B |
| anything else | — | 200, counted, dropped | — |

Whether Meta lets one callback URL serve every product is confirmed per use case in the dashboard
(02 §3 item 7). If WhatsApp requires its own, use Meta's per-WABA `override_callback_uri` to
`/api/meta/webhook/whatsapp` handled by the same code — and only once that handler exists.

## 2. Isolation rules (all existing ones kept)
1. The project is never read from the payload; only from the authorised asset row.
2. Only rows with `authMode=PLATFORM`, status ≠ DISCONNECTED, and project in `META_ALLOWED_PROJECT_IDS` receive events.
3. One live row per asset per capability across the installation (partial unique indexes).
4. Unknown, revoked or ambiguous assets are dropped and counted, never guessed.
5. Recording only (`ChannelInboundEvent`, `skipDuplicates` on `(projectId, connectionId, dedupKey)`); processing in the worker.
6. Failure to record → 500 so Meta retries (~36 h); duplicates are expected and harmless.
7. Phase-7 database triggers refuse cross-project parents for every new table.

## 3. New tests required
Signature failure; wrong object; WhatsApp event for a phone number in another project's WABA; same Page with
messaging in project A and publishing in project B (each event goes to its own capability only); revoked asset;
duplicate delivery; batch of 1,000 entries; a WhatsApp `statuses` before its `messages` arrives.
