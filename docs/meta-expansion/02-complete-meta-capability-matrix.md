# 02 — Complete Meta capability matrix

Documentation checked: **1 Nov 2026.** Current Graph/Marketing API version: **v26.0** (29 Jul 2026; the
code still defaults to v25.0). Meta is moving pages from `/docs/...` to `/documentation/...`.

Source tags: **[F]** read on an official Meta page that day · **[S]** search snippet only · **[K]** background
knowledge, not confirmed that day. Anything [S]/[K] that matters for a decision is listed under "Needs
verification" and must be confirmed before building or selling it.

Classifications: SUPPORTED_AND_ELIGIBLE · SUPPORTED_REQUIRES_APPROVAL · PAID_OR_BILLABLE ·
RESTRICTED_OR_SPECIAL_ELIGIBILITY · UNAVAILABLE_OR_DEPRECATED · NEEDS_VERIFICATION.

**A product appearing in our Meta Developer App dashboard is not proof that we may offer it to customers.**

## 1. Summary

| Product | Classification | Code today | Recommended release |
|---|---|---|---|
| Messenger | SUPPORTED_REQUIRES_APPROVAL (free) | Implemented, mock-tested | A (live-verify), C (menus/postbacks) |
| Instagram DM | SUPPORTED_REQUIRES_APPROVAL | Implemented, mock-tested | A |
| Instagram comments / private replies / mentions | SUPPORTED_REQUIRES_APPROVAL | Absent | C |
| Instagram publishing | SUPPORTED_REQUIRES_APPROVAL | Implemented (Social Studio), mock-tested | A |
| Instagram insights | SUPPORTED_REQUIRES_APPROVAL | Per-post counts only | C |
| Facebook Pages publishing | SUPPORTED_REQUIRES_APPROVAL | Implemented, mock-tested | A |
| Facebook comments / Page insights | SUPPORTED_REQUIRES_APPROVAL | Absent | C |
| WhatsApp Cloud API + Embedded Signup | SUPPORTED_REQUIRES_APPROVAL + PAID_OR_BILLABLE | Absent | B |
| WhatsApp template management | SUPPORTED_REQUIRES_APPROVAL + PAID_OR_BILLABLE | Absent | B |
| Marketing API — read (Ads Manager) | SUPPORTED_REQUIRES_APPROVAL | Absent | D |
| Marketing API — manage | SUPPORTED_REQUIRES_APPROVAL + PAID_OR_BILLABLE (customer ad spend) | Absent | D (separate approval) |
| Lead Ads | SUPPORTED_REQUIRES_APPROVAL | Absent | D |
| Conversions API / Pixel / App Events | own-business SUPPORTED_AND_ELIGIBLE; partner multi-tenant NEEDS_VERIFICATION | Absent | E |
| Webhooks | SUPPORTED_AND_ELIGIBLE (app must be Live for real users) | Implemented for page/instagram | A/B |
| Facebook Login for Business | SUPPORTED_REQUIRES_APPROVAL | Partly (optional `config_id`) | A/B |
| Audience Network | RESTRICTED_OR_SPECIAL_ELIGIBILITY (in-app publishers; no fit) | — | Not built |
| Fundraisers | RESTRICTED_OR_SPECIAL_ELIGIBILITY (nonprofits; BD unconfirmed) | — | Not built |
| Jobs on Facebook | UNAVAILABLE_OR_DEPRECATED (outside US/CA since 2022 [S]) | — | Not built |
| Web payments / Meta Pay | UNAVAILABLE_OR_DEPRECATED ([S]; docs 404) | — | Not built |

## 2. Detailed matrix

Columns per row: feature · use case · docs · permissions · Advanced Access / Business Verification / App Review ·
availability · API cost · other cost · webhook · rate limits · code status · reuse · complexity · tests · phase.

### 2.1 Messenger Platform
| Feature | Details |
|---|---|
| Inbound/outbound messages, receipts, echoes | Use: customer support inbox. Docs: https://developers.facebook.com/docs/messenger-platform/overview [F]. Permissions: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `pages_read_engagement`, `business_management` (dependency) [F]. App Review + Advanced Access to serve Pages we do not own; Business Verification when people without an app role use it [F]. API free [F]. Webhook object `page`, fields `messages`, `message_echoes`, `message_deliveries`, `message_reads` (+ `messaging_postbacks`, `messaging_optins`, `messaging_referrals`, `messaging_handovers`, `message_reactions`, `message_edits`, …) [F]. Rate: no numbers; high volume may disable the inbox [F]. Code: implemented, mock-tested. Complexity: low (live verification). Phase A. |
| Quick replies, postbacks, persistent menu, Get Started, ice breakers | Same permissions; `messaging_postbacks` field. Code: postbacks recorded and ignored; rest absent. Complexity: medium. Phase C. |
| Human Agent tag (7 days) | Code implemented behind a per-connection switch. Current tag rules NEEDS_VERIFICATION (tag pages did not render). |
| Handover protocol | Absent. Only needed if another app shares the Page. Phase: not planned. |

### 2.2 Instagram
Three setups [F]: Instagram Login (graph.instagram.com, no Page), Facebook Login (Page-linked; **our current
model**), Unified Login (BISU token). Professional (Business/Creator) accounts only [F].

| Feature | Details |
|---|---|
| DMs | Permissions (FB Login): `instagram_basic`, `instagram_manage_messages` + Page perms [F]. 24 h window; 7-day Human Agent [F]. Limits: Conversations API 2/s, Send API 100/s text, 10/s audio/video [F]. Implemented. Phase A. |
| Comments read/reply/moderate | `instagram_manage_comments` (+ `pages_read_engagement`, `pages_show_list`, `pages_manage_metadata`); `comments`/`live_comments` webhooks need Advanced Access [F]. Absent. Phase C. |
| Private replies | `POST /<IG_ID>/messages` with `recipient.comment_id`; within 7 days; one message until the user replies; 750/hour [F]. Absent. Phase C. |
| Mentions | `mentions` webhook field; `instagram_manage_comments` [F]. Absent. Phase C. |
| Content publishing | `instagram_content_publish` (+ `pages_read_engagement`) [F]. Images (JPEG), video, REELS, STORIES, carousel ≤20; public media URL; limit 50 or 100 posts/24 h (docs conflict → read `content_publishing_limit`) [F]. Implemented. Phase A. |
| Insights | `instagram_manage_insights` [F]; some metrics need ≥100 followers; impressions→views change NEEDS_VERIFICATION. Phase C. |

Webhook object: `instagram` [K]; fields `messages`, `message_reactions`, `messaging_postbacks`, `messaging_seen`, `messaging_referral`, `messaging_optins`, `messaging_handover`, `standby`, `message_echoes`, `comments`, `live_comments`, `mentions`, `story_insights` [F]. App must be Live to receive notifications [F]. Rate limit: 4800 × impressions / 24 h for most endpoints [F]. API cost: none found [K].

### 2.3 WhatsApp Business Platform (Cloud API)
| Feature | Details |
|---|---|
| Tech Provider onboarding | Required for a multi-tenant SaaS that onboards other businesses [F]. Steps: app with WhatsApp use case → Tech Provider onboarding → **Business Verification** (before App Review) → **App Review** with two videos (a message sent from our app arriving in WhatsApp; our app creating a template) → Advanced Access to `whatsapp_business_messaging` and `whatsapp_business_management` [F]. Without Advanced Access, calls on businesses we don't own fail with error 200 [F]. |
| Embedded Signup (v4 only) | v2/v3 deprecated 15 Oct 2026 [F]. Returns `waba_id`, `phone_number_id` (session-logging event) and a `code` → exchanged server-side for a **business (BISU) token** [F]. Then `POST /<WABA_ID>/subscribed_apps`, `POST /<PHONE_NUMBER_ID>/register` (6-digit PIN; skipped for coexistence), customer adds a payment method in WhatsApp Manager [F]. |
| Messaging (text, media, interactive buttons/lists, templates) | Cloud API `/messages`. Non-template messages only inside the 24 h customer service window [F]. |
| Templates | `POST /<WABA_ID>/message_templates`; automatic review ≤24 h; `message_template_status_update` webhook; 250 templates per account while unverified, up to 6,000 when verified; ≤100 creations/hour [F]. |
| Business account / phone number status, quality, limits | Messaging limit per business portfolio: 250 → 2,000 → 10,000 → 100,000 → unlimited unique users outside a window per 24 h; read `whatsapp_business_manager_messaging_limit` (`messaging_limit_tier` deprecated) [F]. Throughput NEEDS_VERIFICATION. |
| Webhooks | Object `whatsapp_business_account`, field `messages` (`messages` and `statuses` arrays) [F]; `message_template_status_update` [F]; `account_update`, `phone_number_quality_update`, `history`, `smb_message_echoes` [K]. Optional per-WABA `override_callback_uri` [S]. Optional mTLS (new Meta CA `meta-outbound-api-ca-2025-12.pem`) [F]. |
| Coexistence (WhatsApp Business app + Cloud API on one number) | Supported via customised Embedded Signup [F]; country list NEEDS_VERIFICATION (official page 404). |
| Pricing | **PAID_OR_BILLABLE**: per message since 1 Jul 2025; categories marketing, utility, authentication (templates), service and Meta Business Agent (non-template) [F]. From 1 Oct 2026: 1,000 free service messages per number per month, then charged; utility replies inside the window now billed [F]. Click-to-WhatsApp ad replies open a 7-day free window [F]. **Bangladesh has its own rate-card market from 1 Oct 2026** [F] (third-party figures disagree — use Meta's rate card). |
| Who pays | As a **Tech Provider, each customer's Messaging account (WABA) has its own payment method and pays Meta directly** [F]. Get Assist pays nothing for customers' messages unless it becomes a Solution Partner sharing a credit line. |

Code: absent (and today's webhook would drop these events — see 01 §4 G2). Complexity: high. Phase B.

### 2.4 Marketing API
| Feature | Details |
|---|---|
| Read (ad accounts, campaigns, ad sets, ads, insights, spend) | `ads_read` [F]. Access tiers renamed: **Limited Access** (default, heavily rate-limited, development only) and **Full Access** (App Review per permission; needs ≥500 API calls in 15 days and <15% errors, sustained) [F]. Business Verification if accessing sensitive data [F]. All calls hit production data [F]. API free; ad spend billed to the customer's ad account [K]. Phase D. |
| Manage (create/edit campaigns, budgets) | `ads_management` [F]. PAID_OR_BILLABLE (customer ad spend). Separate approval inside Get Assist; Phase D, after read-only proves out. |

### 2.5 Lead Ads
`leads_retrieval`, `ads_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads` (+ `pages_manage_metadata` for webhooks); the token's person must be able to advertise on the ad account and Page [F]. **`leadgen` is a field of the `page` object** (value: `leadgen_id`, `form_id`, `ad_id`, `adgroup_id`, `page_id`, `created_time`) [F]. Lead Access Manager can restrict access [F]. Rate: 200 × 24 × leads in the last 90 days per 24 h [F]. API free; leads come from paid ads. Reuse: commerce `SalesLead` (`SALES_PIPELINE`) and Clients. Phase D.

### 2.6 Conversions API / App Events / Pixel
Pixel ID + a system-user token; **no App Review for a business sending its own events** [F]. Partner (multi-tenant) requirements are on a separate page not read → NEEDS_VERIFICATION; likely BISU via Facebook Login for Business [F/K]. No fees for one-click setup [F]. Privacy: send only minimal hashed identifiers with consent; **never conversation content**. Phase E.

### 2.7 Special-eligibility products
| Product | Finding | Decision |
|---|---|---|
| Audience Network | App Bidding for Android/iOS/Unity publishers [F]; mobile web shut down [S]. A web support SaaS has no inventory to monetise. | Not built, not advertised |
| Fundraisers | Public via App Review, nonprofit must be onboarded to Meta fundraising tools, country-limited [F]; Bangladesh eligibility unconfirmed | Not built until a nonprofit customer and confirmed eligibility exist |
| Jobs on Facebook | Retired outside US/Canada from Feb 2022 [S] | Not built |
| Web payments / Meta Pay | "Deprecated, not accepting new partners" [S]; docs 404 [F] | Not built |

### 2.8 Webhooks product and Facebook Login for Business
- Webhooks: GET verify (`hub.*`), POST signed `X-Hub-Signature-256` with the App Secret, batches up to 1,000, retried ~36 h, duplicates possible [F]. Callback configured per object/use case; every payload carries `object`, so one endpoint routing on `object` is workable — that one URL may be used for all objects is inference, NEEDS_VERIFICATION in the dashboard. WhatsApp may also override per WABA.
- Facebook Login for Business: configurations with `config_id` (replaces `scope`) [F]; token types user (short) or **BISU** (client's business portfolio, chosen assets only, non-expiring by default or 60-day) [F]; BISU login requires `response_type=code` + `override_default_response_type=true`, server-side exchange, web only, client must have a business portfolio, our app linked to our portfolio [F]. Advanced Access via App Review [F].

## 3. Needs verification before building or selling
1. Messenger message-tag rules (HUMAN_AGENT) on current docs.
2. WhatsApp throughput (MPS) and coexistence country list (Bangladesh).
3. Whether a Tech Provider has an access-verification step or a customer cap before review.
4. Instagram publishing limit 50 vs 100 / 24 h (read `content_publishing_limit` at runtime regardless).
5. Conversions API partner requirements.
6. Exact Page permission names per endpoint (comments, insights) in the App Review screen.
7. One callback URL for all objects — confirm in the dashboard per use case.
8. Business Verification of a Bangladeshi company (the owner must start it to find out).
9. Fundraisers country list; Jobs official Help Center status.

## 4. URLs read [F]
WhatsApp: /docs/whatsapp/pricing; /documentation/business-messaging/whatsapp/pricing; /docs/whatsapp/solution-providers/get-started-for-tech-providers; /docs/whatsapp/embedded-signup/overview; /docs/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider; /docs/whatsapp/cloud-api/webhooks/components; /docs/whatsapp/messaging-limits; /docs/whatsapp/business-management-api/message-templates.
Graph/webhooks: /docs/graph-api/webhooks/getting-started; /docs/graph-api/webhooks/reference/page; /docs/graph-api/reference/app/subscriptions; /docs/graph-api/changelog.
Marketing: /docs/marketing-api/guides/lead-ads/retrieving; /docs/marketing-api/overview/authorization; /docs/marketing-api/conversions-api; /docs/marketing-api/conversions-api/get-started.
Instagram: /docs/instagram-platform/overview; /content-publishing; /instagram-api-with-instagram-login/messaging-api; /private-replies; /webhooks; /documentation/instagram-platform/webhooks/fields; /documentation/instagram-platform/webhooks/setup; /insights.
Other: /docs/messenger-platform/overview; /docs/facebook-login/facebook-login-for-business; /docs/pages-api/overview; /docs/fundraiser-api/faq; /docs/audience-network.
(All under https://developers.facebook.com.)
