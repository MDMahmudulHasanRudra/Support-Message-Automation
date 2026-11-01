# Meta owner setup — Get Assist platform app

For the person who owns the Get Assist Meta Business Portfolio. Checked against Meta's docs on 1 Nov 2026
(Graph API v26.0). Meta's dashboard wording changes often; where a label differs, look for the closest match.

**HOST = `https://admin.getassist.pro`** (the platform address; belongs to no customer).
**App Domains:** `getassist.pro`.

Legend: **[LIVE ROUTE]** exists in the code on `rudra` today · **[PROPOSED]** not built yet — do not enter it in
Meta until the release that adds it is deployed. **Never paste the App Secret, tokens or verify token into chat,
tickets or screenshots.**

The existing step-by-step guide for messaging, `docs/meta-integration/META_DEVELOPER_SETUP.md`, stays valid; this
file adds the other products and the approvals around them.

## 1. Business Portfolio (business.facebook.com)
- Create or use your Business Portfolio (legal name, address, phone, website on `getassist.pro`, business email).
- Settings → Security Center → **Start Verification** (Business Verification). Have your trade licence / company
  registration and a utility bill or bank statement in the company name ready.
- Needed for: serving customers who have no role on your app (Messenger, Instagram, Pages), **WhatsApp Tech
  Provider** (must finish before App Review), Marketing API sensitive data.
- Success: Security Center shows **Verified**. Common failure: name/address on documents ≠ portfolio details.
- Cost: none.

## 2. App settings (developers.facebook.com → My Apps → your app)
- Type: **Business**, connected to your Business Portfolio.
- App settings → Basic:
  - **App ID** → server `META_APP_ID` (not secret).
  - **App Secret** → server `META_APP_SECRET` (**secret**).
  - Privacy Policy URL, Terms of Service URL (public pages on getassist.pro) — required before Live.
  - App icon, category, contact email.
  - **Data Deletion Request URL:** `https://admin.getassist.pro/api/meta/data-deletion` [LIVE ROUTE].
- Success: no red warnings on Basic; App Review "Requirements" list shows these as complete.

## 3. Facebook Login for Business
- Settings: **Valid OAuth Redirect URIs** = `https://admin.getassist.pro/api/meta/oauth/callback` [LIVE ROUTE]
  (exact, no trailing slash). Enforce HTTPS on, Strict mode on.
- **Deauthorize callback URL:** `https://admin.getassist.pro/api/meta/deauthorize` [LIVE ROUTE].
- Social Studio today also uses `https://admin.getassist.pro/api/social/meta/callback` [LIVE ROUTE, to be retired
  by work package A2 — after A2 ships it is no longer needed]. Until A2, Social Studio connect works only when
  started on the same address as `NEXTAUTH_URL` (see 01 §4 G1).
- **Configurations** (one per capability; copy each `config_id` into the server env):
  | Configuration | Token | Permissions | Env |
  |---|---|---|---|
  | Messaging | User access token | `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`, `instagram_manage_messages` | `META_LOGIN_CONFIG_ID` [LIVE] |
  | Publishing | User access token | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` | `META_SOCIAL_LOGIN_CONFIG_ID` [LIVE, add to `.env`] |
  | Engagement (comments, insights) | User access token | names confirmed in the App Review screen | [PROPOSED, Release C] |
- Success: the Get Assist "Connect" button opens Meta's dialog listing exactly these permissions.

## 4. Messenger
- Add use case **Engage with customers on Messenger from Meta**.
- Webhooks for the `page` object: callback `https://admin.getassist.pro/api/meta/webhook` [LIVE ROUTE], verify token
  = server `META_WEBHOOK_VERIFY_TOKEN` (**secret**, you choose it), fields `messages`, `message_echoes`,
  `message_deliveries`, `message_reads` (Release C adds `messaging_postbacks`).
- Success: "Verify and save" succeeds; a test message to a Page you administer appears in All Conversations.
- Cost: free.

## 5. Instagram
- Add use case **Manage messaging and content on Instagram** — the variant using **Facebook Login** (not Instagram Login).
- Webhooks `instagram` object: same callback and verify token; field `messages` (Release C adds `comments`, `mentions`).
- The Instagram account must be Professional (Business or Creator) and linked to a Facebook Page.
- Cost: free.

## 6. WhatsApp Cloud API [PROPOSED — Release B]
- Add use case **Connect with customers through WhatsApp**.
- Use cases → Customize → **Tech Provider onboarding** (Get Assist onboards other businesses).
- Prerequisite: Business Verification (§1) **before** App Review.
- App Review for `whatsapp_business_management` and `whatsapp_business_messaging` with two screen recordings:
  (1) a message sent from Get Assist arriving in WhatsApp, (2) Get Assist creating a message template.
- Webhooks `whatsapp_business_account`: callback `https://admin.getassist.pro/api/meta/webhook` (handler added in
  Release B; until then Meta's events are acknowledged and dropped), fields `messages`,
  `message_template_status_update`, `phone_number_quality_update`, `account_update`.
- Cost: **per delivered message, billed by Meta to each customer's own WhatsApp account** (they add a payment method
  in WhatsApp Manager). Get Assist's own test number is billed to Get Assist's WhatsApp account.

## 7. WhatsApp Embedded Signup [PROPOSED — Release B]
- WhatsApp → **Embedded Signup** → create a configuration (version **v4**; v2/v3 were deprecated 15 Oct 2026).
- Copy its `config_id` → server `META_WHATSAPP_SIGNUP_CONFIG_ID` [PROPOSED].
- **Allowed domains for the JavaScript SDK:** `admin.getassist.pro`, `app.getassist.pro` and each customer address
  that will run the signup (Embedded Signup runs on the page the customer is using).
- Success: the Get Assist "Connect WhatsApp (Official API)" button opens Meta's signup popup and returns to Get Assist
  showing the WABA and phone number.

## 8. Marketing API [PROPOSED — Release D]
- Add use case **Create & manage ads with Marketing API**. Start in **Limited Access** (development only).
- Request **Full Access** for `ads_read` (and later `ads_management`) after ≥500 API calls in 15 days with <15% errors.
- Cost: API free; ad spend is billed to each customer's ad account.

## 9. App Events / Conversions API [PROPOSED — Release E, after verification]
Not needed for messaging or publishing. Requirements for a partner app serving many businesses must be confirmed
first (02 §3 item 5).

## 10. Webhooks product — summary
One callback `https://admin.getassist.pro/api/meta/webhook` [LIVE ROUTE], one verify token, payloads signed with the
App Secret. Subscribe only the objects/fields the deployed release handles. The app must be **Live** for real users'
events to arrive.

## 11. App Review
Request only the permissions the current release uses. For each: a screencast of the real Get Assist flow on a test
Page/account, a written description of why it is needed, and test credentials for reviewers (a reviewer login on a
test workspace with `META_ALLOWED_PROJECT_IDS` including it). Typical failures: screencast doesn't show the permission
being used; privacy policy missing data-deletion instructions; the app can't be reached by the reviewer.

## 12. Development-mode tests (Gate B)
Add yourself and testers under **App Roles**. Follow `docs/meta-integration/10-gate-b-runbook.md` with
`META_INTEGRATION_ENABLED=true` and `META_ALLOWED_PROJECT_IDS=<one test workspace id>` on staging. Record every
result in that runbook's table.

## 13. Live mode
Switch the app to **Live** only after Business Verification and App Review are approved for every permission in use.
Then widen `META_ALLOWED_PROJECT_IDS` one pilot workspace at a time.

## Server env summary
| Var | Secret | Status |
|---|---|---|
| `META_INTEGRATION_ENABLED` | no | live |
| `META_APP_ID` | no | live |
| `META_APP_SECRET` | **yes** | live |
| `META_WEBHOOK_VERIFY_TOKEN` | **yes** | live |
| `META_OAUTH_REDIRECT_URI` | no | live (default `NEXTAUTH_URL` + `/api/meta/oauth/callback`; set it to the HOST value) |
| `META_LOGIN_CONFIG_ID` | no | live |
| `META_SOCIAL_LOGIN_CONFIG_ID` | no | live (missing from `.env.example` — fixed in A3) |
| `META_GRAPH_API_VERSION` | no | live (default v25.0; current is v26.0) |
| `META_ALLOWED_PROJECT_IDS` | no | live (empty = no workspace) |
| `META_WHATSAPP_SIGNUP_CONFIG_ID` | no | proposed (Release B) |
