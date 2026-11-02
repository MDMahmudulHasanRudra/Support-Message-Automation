# 03 — WhatsApp (Official API): proposed architecture

Status: **proposal, not built.** Release B. Requires: Tech Provider onboarding, Business Verification, App
Review for `whatsapp_business_management` + `whatsapp_business_messaging` (see 02 §2.3).

## 1. Hard boundary with WhatsApp (Legacy)

| | WhatsApp (Legacy) — OpenWA | WhatsApp (Official API) — Cloud API |
|---|---|---|
| Engine | Chromium session in `apps/worker`, QR login | Meta Cloud API over HTTPS |
| Tables | `WhatsAppAccount`, `WhatsAppGroup`, `Message`, `OutboundMessage`, … | `ChannelConnection` / `ChannelConversation` / `ChannelMessage` / `ChannelInboundEvent` (Omnichannel) + new template/usage tables |
| Queue | `OutboundMessage` (unchanged semantics) | `ChannelMessage` send queue |
| Reports | Team Report, Support Activity, Duty History, … (read `Message`) | Not in Legacy reports; Omnichannel reports only |
| Groups | Yes (OpenWA) | **No group features claimed** |

Rules:
- Nothing is copied or moved between them: no automatic transfer of numbers, sessions, conversations or accounts.
- A phone number used by Legacy WhatsApp cannot be connected as Official in the same project without an
  explicit warning (a number registered to Cloud API stops working in the consumer/Business app unless coexistence is used).
- No identifier, table, enum, worker loop or report of Legacy WhatsApp changes. Only the visible channel label
  becomes **"WhatsApp (Legacy)"**.
- Regression tests pin this (see 10).

## 2. Data model (additive)

1. `ChannelType` gains `WHATSAPP_CLOUD` (own migration: `ALTER TYPE ... ADD VALUE`, precedent `WEBCHAT`).
2. `ChannelConnection` row per connected **phone number**:
   - `externalAccountId` = `phone_number_id` (what sends use),
   - new nullable `wabaId` (what webhooks are keyed by),
   - `externalAccountName` = verified display name, `externalUsername` = display phone number,
   - `accessTokenCiphertext` = the customer's BISU business token,
   - `authMode = PLATFORM`.
   - Partial unique: one live PLATFORM row per `phone_number_id` across the installation (same rule as Pages).
3. New tables (project-owned, same-project triggers, immutable `projectId`):
   - `WhatsAppCloudTemplate` (connection/WABA, name, language, category, status, components JSON, quality, rejected reason, last sync).
   - `ChannelUsageRecord` (connection, message id, pricing category, billable flag, pricing model, occurred at) — written from `statuses[].pricing`/`conversation` fields; display-only cost awareness, **never our invoice**.
4. `ChannelMessage` gains nullable `templateName`, `templateLanguage`, `pricingCategory`.

## 3. Provider adapter (fixes G3)

Introduce `ChannelProviderAdapter` (worker + web) with explicit implementations for MESSENGER, INSTAGRAM,
TELEGRAM, WEBCHAT, WHATSAPP_CLOUD:
`normalizeInbound(event)`, `sendText`, `sendMedia?`, `sendTemplate?`, `replyWindow(conversation)`, `healthCheck`,
`webhookUrlFor`. Every `else = Meta` branch becomes an exhaustive `switch` with a `never` check, so a missing
case fails to compile. Messenger/Instagram/Telegram/Webchat behaviour is byte-identical (existing tests pin it).

## 4. Onboarding (Embedded Signup v4)

1. Customer: Integrations → **WhatsApp (Official API)** → Connect (needs `channels.manage`, `OMNICHANNEL`,
   new feature `WHATSAPP_OFFICIAL`, platform-operator approval).
2. Browser runs Meta's JS SDK `FB.login` with our Embedded Signup `config_id` (`response_type=code`,
   `override_default_response_type=true`); the session-logging message event supplies `waba_id` and `phone_number_id`.
3. Browser posts `{code, waba_id, phone_number_id}` plus a one-time server-issued nonce (bound to user, project,
   browser cookie; 10 min) to `/p/<slug>/api/whatsapp-cloud/signup`.
4. Server: exchange `code` → BISU token (server-to-server, platform App Secret); verify with Graph that the
   token can read that WABA and that the phone number belongs to it; `POST /<WABA_ID>/subscribed_apps`;
   `POST /<PHONE_NUMBER_ID>/register` with a PIN the customer chooses (skipped for coexistence); create the
   connection; sync templates; show "Add a payment method in WhatsApp Manager" with Meta's help link.
5. All of it audited (System Log) and refused when the project is not allowlisted / not approved.

Embedded Signup runs on the customer's own address (Meta's JS SDK uses a popup; no redirect URI), so the
cross-host problem of G1 does not arise — but the app's **allowed domains** in the Meta dashboard must list
every customer address that may host the SDK (see META_OWNER_SETUP).

## 5. Webhooks (fixes G2)

- Same `/api/meta/webhook` endpoint (one App Secret), extended to `object = whatsapp_business_account`.
- New splitter reads `entry[].changes[].value` (`messages`, `statuses`, `metadata.phone_number_id`), and
  `message_template_status_update`, `phone_number_quality_update`, `account_update`.
- Routing: `entry.id` = WABA → candidate connections; then `metadata.phone_number_id` → exactly one live
  PLATFORM `WHATSAPP_CLOUD` row. Unknown/revoked → dropped and counted, never guessed.
- Dedup keys: `wa-msg:<wamid>`, `wa-status:<wamid>:<status>`, `wa-tpl:<template id>:<event>:<ts>`.
- Fast ack (record only), worker processes — the existing pattern.

## 6. Messaging rules

- Customer service window: 24 h from the customer's last message. Inside it: free-form text/media/interactive.
  Outside it: **template only**.
- AI replies: inside the window only, through `channels/aiReply.ts`'s gates. AI never sends a template by itself.
- Templates are sent only by a person (or an explicitly approved automation later), after a **cost confirmation**
  showing category and that Meta bills the customer's WhatsApp account.
- Statuses `sent → delivered → read` / `failed` move `ChannelMessage.deliveryStatus` forward only.
- UNKNOWN after the request left is never auto-retried (existing rule).
- No AI disclosure line (that rule is Messenger/Instagram-only and test-pinned); WhatsApp's own business-AI
  policy must be checked before enabling AI on this channel (NEEDS_VERIFICATION).

## 7. Cost controls
See 08. Summary: show pricing category and "billed by Meta to your WhatsApp account" on every template send;
optional per-workspace monthly cap on **template sends we initiate** (enforceable because we are the sender);
usage records from webhook pricing data; no billable action is ever enabled by default.

## 8. Out of scope
Groups (Cloud API group features are limited/eligibility-gated — not promised), calling, payments, Flows (later
review), Meta Business Agent messages, Solution-Partner credit lines.
