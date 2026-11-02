# Meta owner setup — the existing "Get Assist" Meta app

For the person who owns the Get Assist Meta Business Portfolio. Updated 1 Nov 2026.

**The platform Meta app already exists. Do not create another one.**

| | |
|---|---|
| App name | Get Assist |
| App ID | 1780470116576079 |
| Type | Business |
| Mode | Development |
| Products added | Messenger, Facebook Login for Business, Webhooks |

**What remains:**
1. The exact configuration below.
2. Server credentials (already present on the server; see §0).
3. Live provider tests (Gate B).
4. Business Verification and App Review (Gate C).

Then a pilot (Gate D).

**Legend:**
- **[LIVE ROUTE]**: the route exists in the code running on the server today.
- **[AFTER DEPLOY]**: exists on `feature/meta-expansion` only. It works once that code is merged and deployed.
- **[PROPOSED]**: not built. Do not enter it in Meta.

Never paste the App Secret, tokens or the verify token into chat, tickets or screenshots.

---

## 0. What the server has today (read-only check, 1 Nov 2026)
**Source:** `ssh` and `curl` against `201.18.218.251` / `admin.getassist.pro`. Secret values were not read; only
whether each is set, and the secret's length.

**Running code**
- Commit `76827f0`, branch `hotfix/worker-strip-types`. That is `main` (43f543a) plus a worker hotfix.
- 160 migrations are applied, the last being `20261101090000_client_code_series`.
- None of Client CRM V7 or this branch's Meta work is deployed.

**Meta settings**

| Setting | State |
|---|---|
| `META_INTEGRATION_ENABLED` | `true` |
| `META_APP_ID` | 1780470116576079 (matches the app) |
| `META_APP_SECRET` | set (32 characters) |
| `META_WEBHOOK_VERIFY_TOKEN` | set |
| `META_OAUTH_REDIRECT_URI` | `https://admin.getassist.pro/api/meta/oauth/callback` |
| `META_ALLOWED_PROJECT_IDS` | one workspace (no `*`) |
| `META_LOGIN_CONFIG_ID`, `META_SOCIAL_LOGIN_CONFIG_ID` | not set (permissions are asked for by scope) |
| `META_GRAPH_API_VERSION` | not set (v25.0) |

**Public routes on admin.getassist.pro**
- `GET /api/meta/webhook` without a token → 403. The route is live and refuses a wrong verify token.
- `GET /api/meta/oauth/callback` → 303, "expired". The route is live.
- `GET /api/meta/deauthorize` → 405. It accepts POST only, which is what Meta sends.
- `GET /api/meta/data-deletion` (no code) → 404. Correct: Meta POSTs, and GET needs `?code=`.
- `GET /api/social/meta/callback` → 303. Live in the old code; retired after A2 deploys.

**Consequence:** messaging "Connect with Facebook" can already be tried in Development mode, by app-role users, in
the one allowlisted workspace (Gate B). Social Studio connect works today only when started on
`noorvip.getassist.pro` (NEXTAUTH_URL); that limit goes away when A2 is deployed.

## 1. App settings → Basic
| Field | Value |
|---|---|
| App Domains | `getassist.pro` |
| Privacy Policy URL | a public page on getassist.pro. Required before Live; must describe data deletion. |
| Terms of Service URL | a public page on getassist.pro |
| Data Deletion Request URL | `https://admin.getassist.pro/api/meta/data-deletion` **[LIVE ROUTE]** |
| App icon (1024×1024), category, contact email | — |
| Business Portfolio | the Get Assist portfolio (needed for Business Verification) |

**Success:** no warnings on Basic, and App Review → Requirements shows these complete.

## 2. Facebook Login for Business → Settings
**Valid OAuth Redirect URIs:**
- `https://admin.getassist.pro/api/meta/oauth/callback` **[LIVE ROUTE]**. Exact match, no trailing slash. Keep it.
- `https://admin.getassist.pro/api/social/meta/callback` **[LIVE ROUTE, retiring]**. Needed by Social Studio only
  until A2 is deployed. After the deploy, Social Studio returns through the first URI. Remove this one then; nothing
  else needs adding.

**Other settings:**
- Client OAuth login: on.
- Web OAuth login: on.
- Enforce HTTPS: on.
- Use Strict Mode for redirect URIs: on.

**Deauthorize callback URL:** `https://admin.getassist.pro/api/meta/deauthorize` **[LIVE ROUTE]**.

## 3. Facebook Login for Business → Configurations (optional, recommended before App Review)
Keep two separate configurations, so a messaging grant never carries publishing permissions or the reverse. Copy
each `config_id` into the server `.env`.

| Configuration | Login variation | Token | Permissions | Env |
|---|---|---|---|---|
| Get Assist — Messaging | General | User access token | `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`, `instagram_manage_messages` | `META_LOGIN_CONFIG_ID` |
| Get Assist — Publishing | General | User access token | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` | `META_SOCIAL_LOGIN_CONFIG_ID` (passed to the app container after deploy; A3) |

**Created by the owner (1 Nov 2026):**
- Messaging configuration id `1810289800278935` → `META_LOGIN_CONFIG_ID`.
- Publishing configuration id `1087085577482339` → `META_SOCIAL_LOGIN_CONFIG_ID`.

Both are not yet in the server `.env` (§11). With a configuration id the dialog sends `config_id` and no `scope`,
so each configuration must hold exactly the permissions in its row above.

- Without a configuration, the code asks for exactly these permissions by `scope`. That is fine in Development mode.
- **Success:** pressing Connect shows Meta's dialog with exactly that list.

## 4. Webhooks
**Page object:**
- Callback URL: `https://admin.getassist.pro/api/meta/webhook` **[LIVE ROUTE]**.
- Verify token: the server's `META_WEBHOOK_VERIFY_TOKEN` (typed into Meta by the owner; never shared).
- Subscribe to `messages`, `message_echoes`, `message_deliveries`, `message_reads`.

**Instagram object:**
- Same callback and token.
- Subscribe to `messages`.

**Do not subscribe** `whatsapp_business_account`, `comments`, `feed`, `leadgen` or anything else yet:
- the deployed code acknowledges them and drops them;
- after A3, unknown objects are acknowledged, recorded nowhere and logged once.

Release B adds the WhatsApp object on the same callback.

**Success:** "Verify and save" passes, and a test message to a Page you administer appears in All Conversations.

## 5. Messenger product
- Messenger → Settings: the Pages are added by customers through Connect with Facebook. Nothing to add per customer.
- Use case **Engage with customers on Messenger from Meta**: request `pages_messaging` (App Review, §8).

## 6. Instagram (Facebook Login variant)
- Add use case **Manage messaging and content on Instagram** with **Facebook Login** (not Instagram Login).
- The test Instagram account must be a Professional (Business or Creator) account linked to a test Page.

## 7. Gate B — Development-mode tests (no Meta review needed)
**Who can test:** only people with a role on the app (App Roles → Administrators / Developers / Testers) can
authorise it while it is in Development mode.

1. **App roles.** Add yourself and one tester. Each accepts the invitation at developers.facebook.com.
2. **Test assets.** A test Facebook Page each tester administers. A test Instagram Professional account linked to
   it.
3. **Workspace.** The allowlisted workspace (`META_ALLOWED_PROJECT_IDS`) is the test workspace. Enable OMNICHANNEL
   there; enable SOCIAL_STUDIO through a platform ModuleApproval.
4. **Deploy first** (see §11): A2/A3 must be deployed for Social Studio to be tested from a customer address.
5. **Run `docs/meta-integration/10-gate-b-runbook.md`** and record each result in its table. The cases:
   - **Messenger connect:** Connect with Facebook → choose the Page → CONNECTED.
   - **Messenger receive:** message the Page → it appears in All Conversations.
   - **Messenger reply:** the reply arrives on Messenger.
   - **Messenger echo:** a reply typed in Meta Business Suite shows as Business and pauses AI.
   - **Instagram:** the same receive and reply checks.
   - **Social Studio:** Accounts → Connect Facebook / Instagram, started on `noorvip.getassist.pro` (the customer
     address) → claim → accounts ACTIVE. Then publish a text post and a photo to the test Page, and a photo to
     Instagram.
   - **Revocation:** remove the app in Facebook settings → deauthorize → the connection reads NEEDS_RECONNECT, and
     the CHANNEL_NEEDS_RECONNECT alert arrives (A3).
   - **Data deletion:** Meta's data-deletion test returns a confirmation code.
6. **Optional:** set `META_GRAPH_API_VERSION=v26.0` on the server and repeat steps 5–6 (v26.0 review:
   `11-release-a-implementation.md`).

**Pass condition:** every row recorded as passed, with screenshots that do not show tokens.

## 8. Gate C — Business Verification and App Review
1. **Business Verification.**
   - business.facebook.com → Settings → Security Center → Start Verification.
   - Have a trade licence or registration and a utility bill or bank statement, in the exact portfolio name and
     address.
   - Success: "Verified".
2. **Data Use Checkup and the Privacy Policy** are complete.
3. **App Review → Permissions and Features.** Request Advanced Access for only these:

   | Permission | Why (write it in the request) | Screencast shows |
   |---|---|---|
   | `pages_show_list` | list the Pages the person chooses to connect | the choice screen |
   | `pages_manage_metadata` | subscribe the chosen Page to the app's webhooks | connect → CONNECTED |
   | `pages_messaging` | receive and answer customer messages in the shared inbox | message in → reply out |
   | `instagram_basic`, `instagram_manage_messages` | the same for Instagram DMs | IG message in → reply out |
   | `pages_read_engagement`, `pages_manage_posts` | Social Studio publishes approved posts to the Page | create → approve → published on the Page |
   | `instagram_content_publish` | Social Studio publishes approved posts to Instagram | the same on Instagram |
   | Business Asset User Profile Access (if offered) | the customer's name on incoming messages | conversation header |

4. **Reviewer access.**
   - A reviewer login on the test workspace, plus step-by-step instructions.
   - The test workspace must stay on `META_ALLOWED_PROJECT_IDS`.
5. **Typical rejections to avoid:**
   - the screencast does not show the permission in use;
   - the privacy policy lacks deletion instructions;
   - the reviewer cannot sign in.

**Pass condition:** every permission above shows Advanced Access, and Business Verification shows Verified.

## 9. Live mode and the pilot (Gate D)
- Switch the app to **Live** only after Gate C.
- Add **one** pilot customer workspace to `META_ALLOWED_PROJECT_IDS`, enable its features, and watch a week of
  traffic.
- Rollback: remove the workspace from the list. Its events stop being recorded at once; nothing is deleted.

Customers outside the allowlist see "not available in this workspace yet" and cannot start anything. A Main Admin
cannot switch Social Studio on without a platform operator's ModuleApproval.

## 10. WhatsApp (Official API) — Release B, not now **[PROPOSED]**
Nothing to configure yet.
- Release B adds the WhatsApp product.
- It needs **Tech Provider** onboarding and Embedded Signup **v4**.
- Business Verification comes **before** its App Review, which needs two screencasts.
- `whatsapp_business_account` webhooks on the same callback.
- Each customer's WABA pays Meta directly.

The B1 foundation on this branch only makes sure such an event can never be mistaken for a Messenger one.

## 11. Server environment
| Var | Secret | State on server | Notes |
|---|---|---|---|
| `META_INTEGRATION_ENABLED` | no | `true` | `false` turns everything Meta off (routes 404) |
| `META_APP_ID` | no | 1780470116576079 | |
| `META_APP_SECRET` | **yes** | set | app + worker |
| `META_WEBHOOK_VERIFY_TOKEN` | **yes** | set | |
| `META_OAUTH_REDIRECT_URI` | no | `https://admin.getassist.pro/api/meta/oauth/callback` | both messaging and (after A2) publishing |
| `META_LOGIN_CONFIG_ID` | no | empty → set to `1810289800278935` | §3, messaging |
| `META_SOCIAL_LOGIN_CONFIG_ID` | no | empty → set to `1087085577482339` | §3, publishing; reaches the container only after the A3 compose change is deployed |
| `META_GRAPH_API_VERSION` | no | empty (v25.0) | change only during a Gate B run |
| `META_ALLOWED_PROJECT_IDS` | no | 1 workspace | fails closed; widen one pilot at a time |

**Deploying this branch** (only after review and the owner's approval; the order follows `DEPLOY.md`):
1. Backup.
2. Build app, worker and migrate.
3. `docker compose run --rm migrate`. It applies 8 migrations: 3 already on `rudra`, 2 from V7 and 3 from this branch.
4. Recreate app and worker.
5. Check both WhatsApp (Legacy) numbers reconnect.
