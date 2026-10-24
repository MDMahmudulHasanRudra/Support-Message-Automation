# Meta developer setup — for the platform operator

This guide sets up the **one** Meta app that every customer connects through. Customers never do any
of this: they press "Connect with Facebook" and choose their Pages.

Do every step yourself, in Meta's dashboard and on the server. **Never paste the App Secret or any
access token into a chat, a ticket or the repository.** Put them only in the server's `.env`.

Meta renames dashboard screens often. The steps below follow the dashboard as documented in
October 2026. If a label differs, look for the same idea nearby. Each step says how to check it
worked.

---

## 0. Before you start

- A **business portfolio** in Meta Business Suite, owned by you, the platform owner.
- The production address the app is served on over **https**, for example
  `https://assist.example.com`. It must be the installation's `NEXTAUTH_URL`, or another address
  this installation serves (Caddy → port 8668). In the steps below it is written as `https://HOST`.
- A privacy policy and terms of service page. Meta requires them before going Live.

## 1. Create the app

1. developers.facebook.com → **My Apps** → **Create app**.
2. Choose the **Business** app type. When asked for use cases, add the messaging ones:
   - **Engage with customers on Messenger from Meta**;
   - **Manage messaging and content on Instagram**, the one that uses **Facebook Login**, not the
     one called "Instagram Login".
3. Connect the app to your business portfolio.

**Check:** the app appears under My Apps, in **Development** mode.

## 2. Basic settings

**App settings → Basic:**

| Field | Value |
|---|---|
| App ID | Copy into `META_APP_ID` (see §7). |
| App Secret | **Show** → copy into `META_APP_SECRET`. |
| Privacy Policy URL, Terms of Service URL | Your public pages. |
| User data deletion | Choose **Data Deletion Request URL** → `https://HOST/api/meta/data-deletion` |
| App icon, category | As you like. |

**Check:** saving shows no red field.

## 3. Facebook Login for Business

**Facebook Login for Business → Settings:**

1. **Valid OAuth Redirect URIs:** exactly `https://HOST/api/meta/oauth/callback`. This must match
   `META_OAUTH_REDIRECT_URI` to the letter, with no trailing slash.
2. **Enforce HTTPS:** on. **Use Strict Mode for redirect URIs:** on.
3. **Deauthorize callback URL:** `https://HOST/api/meta/deauthorize`
4. *(Optional, recommended)* **Configurations → Create configuration**:
   - Login variation: **General**.
   - Access token: **User access token**.
   - Assets: **Pages**, and **Instagram accounts** if offered.
   - Permissions: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`,
     `instagram_manage_messages`.

   Save it and copy its **Configuration ID** into `META_LOGIN_CONFIG_ID`. Without it the app asks for
   the same permissions by `scope`.

**Check:** the redirect URI is listed exactly once.

## 4. Webhooks

**Webhooks**, or each use case's **Configure webhooks**. Use the **same** callback for both objects:

| Object | Callback URL | Verify token | Fields to subscribe |
|---|---|---|---|
| **Page** | `https://HOST/api/meta/webhook` | the value of `META_WEBHOOK_VERIFY_TOKEN` | `messages`, `message_echoes`, `message_deliveries`, `message_reads` |
| **Instagram** | `https://HOST/api/meta/webhook` | same | `messages`, `messaging_seen` |

1. Make up the verify token yourself, for example `openssl rand -hex 24`. Put it in `.env` and
   deploy **before** pressing "Verify and save": Meta calls the URL at that moment.
2. The app answers the handshake only while `META_INTEGRATION_ENABLED=true` and the configuration is
   complete. Otherwise the URL returns 404.

**Check:** "Verify and save" succeeds. The server's log shows no "wrong signature" lines when Meta
sends its sample event.

You do **not** subscribe Pages here. The app subscribes each customer's Page when they connect it.

## 5. Permissions, App Review and Business Verification

In **Development** mode, only people who have a role on the app can connect, and only their Pages
send webhooks. That is enough for live testing (§8).

To serve customers' Pages, request **Advanced Access** through **App Review** for:

| Permission | Why the app needs it (for the review form) |
|---|---|
| `pages_show_list` | List the Pages the customer chose, so they can pick which to connect. |
| `pages_manage_metadata` | Subscribe the chosen Page to the app's webhook, so its messages arrive. |
| `pages_messaging` | Read and answer the Page's Messenger conversations in the support inbox. |
| `instagram_basic` | Read the Instagram professional account linked to the chosen Page. |
| `instagram_manage_messages` | Read and answer that account's DMs in the support inbox. |
| `public_profile` | Required by Facebook Login for Business before going Live. |

Optional, only if you will use it: the **Human Agent** feature. It lets a person reply between 24
hours and 7 days, and needs its own review. It is switched on per connection under Settings →
Messaging Channels.

Meta asks for a **screencast**. Record:

1. Connect with Facebook.
2. Choose a Page.
3. A customer message arrives in All Conversations.
4. An agent replies.
5. Disconnect.

After approval, Meta asks for **Business Verification** of your business portfolio (Business Settings
→ Security Center).

Do **not** request ads, leads, posts, insights or comment permissions unless a later phase is
approved (`02-meta-capability-matrix.md`).

## 6. Go Live

**App Mode → Live**, once App Review is approved.

**Check:** a person with no role on the app can connect a Page (§8, step 6).

## 7. The server

Add to `.env` on the server. These are read by **both** the `app` and the `worker` containers:

```
META_INTEGRATION_ENABLED=true
META_APP_ID=<App ID>
META_APP_SECRET=<App Secret>
META_WEBHOOK_VERIFY_TOKEN=<the token you made up>
META_OAUTH_REDIRECT_URI=https://HOST/api/meta/oauth/callback
# Optional:
META_LOGIN_CONFIG_ID=<Configuration ID>
META_GRAPH_API_VERSION=v25.0
```

Then deploy as usual (`DEPLOY.md`): migrate first, then `app` and `worker`.

**Check:**

1. On Settings → Messaging Channels, the "Connect with Facebook" card shows buttons.
2. A Main Admin who sees "not switched on" instead can open "what is missing". It lists the variable
   names only, never values.

| Credential | Where it comes from | Where it goes | Secret? | Platform or per customer? | How to check it |
|---|---|---|---|---|---|
| App ID | App settings → Basic | `META_APP_ID` | No | Platform, one value | The settings card shows the buttons |
| App Secret | App settings → Basic → Show | `META_APP_SECRET` | **Yes** | Platform | The webhook handshake and signatures work; a wrong secret shows "wrong signature" in the log |
| Verify token | You make it up | `META_WEBHOOK_VERIFY_TOKEN` and the dashboard | Treat as secret | Platform | "Verify and save" succeeds |
| Redirect URI | The address above | `META_OAUTH_REDIRECT_URI` and the dashboard | No | Platform | A connection attempt returns to the app instead of Meta's error page |
| Login configuration id | Facebook Login for Business → Configurations | `META_LOGIN_CONFIG_ID` | No | Platform | The dialog shows the configured permissions |
| Page access tokens | Created by Meta when a customer connects | Encrypted in the database, per connection | **Yes** | Per customer Page | Settings → a connection → Test connection |
| Customer's user token | Created by Meta during the dialog | Encrypted, kept at most 30 minutes, then wiped | **Yes** | Per attempt | Not visible anywhere |

The customer enters **none** of these.

## 8. Live test (Development mode first)

Use a Facebook account with a role on the app, a test Page it administers, and an Instagram
professional account linked to that Page.

1. Settings → Messaging Channels → **Connect Facebook Page** → Meta's dialog → choose the test Page
   and its Instagram account → back on the choice screen. Both show as "Ready to connect".
2. Tick both → **Connect**. Both show "Connected".
3. From another Facebook account, message the Page. The message appears in All Conversations →
   Messenger. Do the same on Instagram.
4. Reply from the inbox. It arrives. The delivery and read ticks follow (Messenger).
5. Reply from Meta Business Suite instead. It appears in the thread as the business, and AI pauses.
6. *(After going Live)* Repeat step 1 with an account that has no role on the app.
7. A connection's page → **Test connection**. Every check passes.
8. Remove the app on Facebook (Settings → Business integrations → Remove). Within a minute the
   connection shows "Reconnect with Facebook". Press it and choose the Page again: it is connected,
   and its conversations are still there.
9. **Disconnect.** Conversations are kept. With Messenger and Instagram on one Page, disconnecting
   one keeps the other working.

Write down, for the release record:

- the Graph API version used;
- the date;
- which permissions had Advanced Access at the time.

## 9. If something goes wrong

| Symptom | Likely cause |
|---|---|
| Meta shows "URL blocked" after the dialog | The redirect URI in the dashboard is not exactly `META_OAUTH_REDIRECT_URI`. |
| Back in the app with "expired or already used" | More than 10 minutes at Meta, the back button, or a second tab. Start again. |
| "Finish the connection in the same browser" | The dialog was opened in one browser and finished in another. Start again in one browser. |
| A Page shows "Your Page role is not enough" | The person needs full control, or a Page role with message and community activity. |
| "Missing permission" | A permission was unticked in Meta's dialog. Reconnect and leave everything ticked. |
| Connected, but nothing arrives | Check the webhook subscriptions (§4). The app must be **Live** with Advanced Access for people without an app role. Meta disables a webhook after an hour of failed deliveries. |
| "Connected in another workspace" | That Page is one-click connected in another customer's workspace; it can be in only one. It must be disconnected there first. |
