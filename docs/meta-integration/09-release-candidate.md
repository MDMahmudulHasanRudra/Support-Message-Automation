# 09 — Release candidate: Messenger and Instagram DM for existing customers

The goal is the **fastest safe launch** of "Connect with Facebook" (OAuth) plus the Messenger and
Instagram-only AI disclosure. Nothing else: no comments, lead ads, publishing or analytics before
launch.

**Branch:** `release/meta-rc1`. It contains `feat/meta-oauth` and `feat/ai-disclosure`, and
`github/main` merged in so that a PR into `main` has no conflicts.

**Defaults:** `META_INTEGRATION_ENABLED` is **unset (off)** everywhere. Every Omnichannel feature is
off per project, as before. The disclosure is off per connection.

## Launch gates

**Customer launch is NOT ready until gates B, C and D have passed.** Today only gate A is satisfied.

| Gate | Meaning | Status |
|---|---|---|
| **A** | All local tests pass (shared, engine, web, worker), plus typecheck, lint and builds | **passed** (25 Oct 2026, isolated DB): shared 1,125 · engine 79 · web 1,040 (7 skipped) · worker 1,407 (6 skipped) · tsc clean · lint 0 errors · web + worker builds OK. The release branch's code tree is identical to the tested one; only docs were added after. |
| **B** | Real Meta OAuth and messaging pass, in Development mode with an app-role tester (§2) | **not started**: needs the platform Meta app |
| **C** | Advanced Access approved for the messaging permissions, and Business Verification done (§3) | **not started** |
| **D** | A controlled pilot with one real customer passes (§5) | **not started** |

---

## 1. Operator checklist: what you can do NOW, before any Meta approval

**HOST is `https://admin.getassist.pro`** (decided 26 Oct 2026): the platform address, which belongs to
no customer. One Meta app serves every customer, so its callback, webhook, deauthorize and
data-deletion addresses must not sit on one customer's address. These four routes read only Meta's own
tables (`MetaOAuthSession`, `ChannelConnection`, `ChannelInboundEvent`), which the customer-scoped
client does not narrow, so they work on the platform address. The callback then sends the person back
to the customer address they started from (`returnOrigin`), where the claim needs their own session
and binding cookie. In Meta's **App Domains**, enter `getassist.pro`.

### 1a. Meta for Developers (developers.facebook.com)

1. **Create the app.**
   - My Apps → Create app → type **Business**.
   - Use cases: **Engage with customers on Messenger from Meta**, and **Manage messaging and
     content on Instagram**. For Instagram, choose the one that uses **Facebook Login**, not
     "Instagram Login".
   - Connect the app to your own business portfolio.
2. **App settings → Basic.**
   - Copy the **App ID** and the **App Secret**. They go into the server's `.env` in step 1b.
     **Never paste them into chat.**
   - **Privacy Policy URL** and **Terms of Service URL**: your public pages. They are required
     before going Live.
   - **User data deletion → Data Deletion Request URL:** `https://HOST/api/meta/data-deletion`
3. **Facebook Login for Business → Settings.**
   - **Valid OAuth Redirect URIs:** `https://HOST/api/meta/oauth/callback`. It must match exactly,
     with no trailing slash.
   - **Enforce HTTPS:** on. **Strict mode:** on.
   - **Deauthorize callback URL:** `https://HOST/api/meta/deauthorize`
4. *(Optional)* **Facebook Login for Business → Configurations → Create.**
   - Login variation: General.
   - Token: **User access token**.
   - Assets: Pages and Instagram accounts.
   - Permissions: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`,
     `instagram_manage_messages`.
   - Keep the **Configuration ID**. Without it the app asks for the same permissions by scope.
5. **Webhooks** (after the server has the variables, step 1b):

   | Object | Callback URL | Verify token | Fields |
   |---|---|---|---|
   | Page | `https://HOST/api/meta/webhook` | your `META_WEBHOOK_VERIFY_TOKEN` | `messages`, `message_echoes`, `message_deliveries`, `message_reads` |
   | Instagram | `https://HOST/api/meta/webhook` | same | `messages`, `messaging_seen` |

6. **App roles → Roles:** add the Facebook accounts that will test. In Development mode only they can
   connect and send test messages.

### 1b. Server `.env` (on the server only; never commit it)

```
META_INTEGRATION_ENABLED=true
META_APP_ID=<App ID>
META_APP_SECRET=<App Secret>
META_WEBHOOK_VERIFY_TOKEN=<make one: openssl rand -hex 24>
META_OAUTH_REDIRECT_URI=https://HOST/api/meta/oauth/callback
# optional
META_LOGIN_CONFIG_ID=<Configuration ID from step 4>
```

`docker-compose.yml` passes these variables to both `app` and `worker`.

**Production rule.** Only set `META_INTEGRATION_ENABLED=true` in production when you approve gate B
testing there. Until then it is set only on a test or staging installation.

### 1c. Prepare the App Review material (it can be recorded during gate B)

- A **screencast**:
  1. Settings → Messaging Channels → Connect Facebook Page.
  2. Meta's dialog.
  3. Choose the Page.
  4. Connected.
  5. A customer message appears in All Conversations.
  6. An agent replies.
  7. Disconnect.
- A short **use-case text** per permission (§3).
- A **test account** for Meta's reviewers: a login to the dashboard with `channels.manage` in a test
  project, plus written steps to follow.

## 2. Gate B: real Meta test (Development mode, app-role testers only)

Use a test Page you administer, with an Instagram **professional** account linked to it. In the
Instagram app: Settings → Messages → Connected tools → **Allow access to messages**.

| # | Step | Expect |
|---|---|---|
| 1 | Settings → Messaging Channels | The "Connect with Facebook" card with two buttons |
| 2 | Connect Facebook Page → Meta → choose the Page and its Instagram | Back on "Choose what to connect"; both "Ready to connect" |
| 3 | Tick both → Connect | "2 of 2 connected" |
| 4 | Test connection on each | All checks pass |
| 5 | From another (app-role) account, message the Page and the Instagram account | Both appear in All Conversations within seconds |
| 6 | Reply from the inbox | It arrives. Messenger shows the delivered/read ticks. |
| 7 | Reply from Meta Business Suite | It appears in the thread as the business, and AI is paused |
| 8 | Switch AI on for the connection, ask a question the knowledge base covers | The AI answers; record the time with the §6a query |
| 9 | Switch the disclosure on, then start a new conversation | The first AI reply starts with the disclosure line; the next does not |
| 10 | Wait 24 h without a customer message, then message again | Messenger refuses the AI reply ("outside the window"); a person can still reply with Human Agent if approved |
| 11 | Facebook → Settings → Business integrations → remove the app | Within about a minute the connection shows "Reconnect with Facebook" and nothing is sent |
| 12 | Reconnect with Facebook | Connected again; the earlier conversations are still there |
| 13 | Disconnect Messenger only | Instagram keeps working on the same Page |
| 14 | Turn `META_INTEGRATION_ENABLED` off and restart | The buttons disappear, `/api/meta/webhook` answers 404, and manual connections still work |

Record the date, the Graph API version (`v25.0` unless overridden) and any differences from the
table.

## 3. Gate C: App Review submission checklist

Request **Advanced Access** for each permission below, with the screencast and the matching text.

| Permission | What to write |
|---|---|
| `pages_show_list` | We list the Pages the business chose in Facebook Login so they can pick which to connect to their support inbox. |
| `pages_manage_metadata` | We subscribe the chosen Page to our app's webhook so its customer messages reach the business's support inbox. |
| `pages_messaging` | The business reads and answers its Messenger conversations in our support inbox; optional AI replies follow Meta's 24-hour window and are disclosed as automated where configured. |
| `instagram_basic` | We read the Instagram professional account linked to the chosen Page, to connect it. |
| `instagram_manage_messages` | The business reads and answers its Instagram DMs in our support inbox. |
| `public_profile` | Required by Facebook Login for Business before going Live. |

Then:

- **Business Verification** of your business portfolio: Business Settings → Security Center. Meta
  asks for it after approval.
- **App Mode → Live.**
- **Human Agent** (7-day replies by people only) is a separate, optional request. It is **not
  needed for launch**.

## 4. Production deployment (only after you approve)

1. Merge `release/meta-rc1` into `main` through a PR (you do this).
2. On the Zoventio server, in `~/Support-Message-Automation`, follow `DEPLOY.md` exactly:

```bash
git pull
mkdir -p ~/backups
docker compose exec -T postgres sh -c 'pg_dump -U $POSTGRES_USER -d $POSTGRES_DB' | gzip > ~/backups/pre-deploy-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M).sql.gz
docker compose build migrate
docker compose run --rm --entrypoint "npx prisma migrate status" migrate
docker compose run --rm migrate
docker compose up -d --build --no-deps --force-recreate app
docker compose up -d --build --no-deps --force-recreate worker
docker compose ps
docker compose run --rm --entrypoint "npx prisma migrate status" migrate
docker compose logs --since 10m app worker | grep -i "P2022\|does not exist"
```

**Migrations that will run** (all additive):

- `20261024120000_client_recorded_expiry`, which was already pending from Smart Import;
- `20261025090000_meta_platform_oauth`;
- `20261025100000_channel_ai_disclosure`.

**`META_INTEGRATION_ENABLED` stays unset.** Deploying changes nothing for customers until you set it.

The worker restart reconnects WhatsApp sessions for a few minutes, so pick a quiet time.

## 5. Gate D: pilot customer checklist

- [ ] One customer, one Page (and its Instagram account), chosen with them. Not one connected
      anywhere else.
- [ ] Main Admin → the customer's project → Features → **Omnichannel inbox** on. It stays off for
      everyone else.
- [ ] Their admin connects through "Connect with Facebook". You watch the System Log.
- [ ] 48 hours of real traffic:
  - [ ] every customer message appears;
  - [ ] replies arrive;
  - [ ] no `[channels]` errors in `docker compose logs worker`;
  - [ ] `/health` lists the `channel-inbound`, `channel-outbound` and `meta-connection-health` loops
        as recent.
- [ ] AI only if they want it. Disclosure on if their audience may include California or Germany.
- [ ] Test connection shows all green. One deliberate disconnect and reconnect done together.
- [ ] Their WhatsApp numbers, reports and Team Report figures are unchanged over the pilot window.
- [ ] Then widen the rollout, per project, by switching the Omnichannel feature on.

## 6. Production readiness: what was verified, and how

| Item | Evidence |
|---|---|
| Additive migrations and rollback | `04-database-and-migration-plan.md`; three migrations, add-only. Rollback is behavioural (env off) or, before first use, the SQL in 04. |
| Secrets and token encryption | Tokens are `encryptSecret` envelopes. The platform secret comes from the environment only. Tests search every view, action result and System Log row for tokens and secrets. No secret is in Git (checked before the push). |
| Webhook signatures and project routing | web `metaOAuth.integration.test.ts` §4: wrong signature 401; routing by account into the right project; duplicates dropped; unknown and manual accounts dropped. |
| Reconnect and disconnect | §3 (manual → one-click on the same row; reconnect keeps history) and §5 (a shared Page subscription survives a sibling's disconnect; deauthorize → reconnect). |
| AI ON/OFF | worker `channels.integration.test.ts`: AI off → no reply, no disclosure (Messenger and Instagram); AI on → replies through the unchanged gates. |
| Human takeover and messaging windows | worker channel tests: Business Suite echo pauses AI; takeover → SKIPPED; outside the 24 h window → nothing is sent, with or without the disclosure. |
| Health monitoring | Worker loop `meta-connection-health` (every 5 min, each connection at most every 6 h) is in the per-loop liveness on `/health` and `/metrics`. Each connection shows its status and last error on Settings. Every transition goes to the System Log. A Main Admin sees what is missing in the configuration (variable names only). |
| Operational diagnostics | `docker compose logs app worker \| grep "\[channels\]\|\[meta\]"`; Settings → a connection → **Test connection**; `/api/meta/webhook` GET with the verify token answers the challenge. |

## 6a. Meta's 30-second rule, verified against the official policy, and how to measure it

**What Meta's Messenger Platform policy overview says** (read 25 Oct 2026; the page shows no date):

- "Automated bots must respond to user input within 30 seconds."
- "Any input" is defined as "freeform text, quick replies, CTA buttons, and persistent menu clicks";
  the Get Started button is excluded.
- It "applies to all bots that are identified as 'automated'" (the bot type declared for the app);
  **bots typed "hybrid" or "human" are not covered**.

**What that means for this product.** AI here answers only some messages: it hands everything it
cannot answer with verified knowledge to a person, and it stays silent while a person handles a
conversation. That is a **hybrid** experience. When Meta asks for the experience type (App Review or
the app's messaging settings), declare it as **hybrid**, truthfully. If it were declared "automated",
every handover would break the 30-second rule. This is a declaration for you to make; nothing in the
code depends on it.

**The latency budget, from the code:**

| Step | Time |
|---|---|
| Webhook recorded | under 1 s |
| Event processing (`channel-inbound`, every 2 s) | up to 2 s |
| `AI_SETTLE_MS` (a deliberate wait so a burst of lines gets one answer) | 3 s |
| `channel-ai` loop (every 3 s) | up to 3 s |
| Model call(s): optional query expansion + the answer | each capped at 30 s, typically a few seconds |
| Outbound queue (every 2 s) | up to 2 s |

Typical is roughly 8–15 s. The worst case (a slow model) can pass 30 s, which is another reason to
declare the bot hybrid.

**Measure it in gate B** with this query, run read-only on the test installation. It gives the time
from the customer's message (Meta's own timestamp) to Meta accepting the AI reply:

```sql
SELECT c.type,
       count(*)                                                                  AS ai_replies,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM r."sentAt" - m."occurredAt")) AS median_s,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM r."sentAt" - m."occurredAt")) AS p95_s,
       max(extract(epoch FROM r."sentAt" - m."occurredAt"))                      AS max_s
FROM "ChannelMessage" m
JOIN "ChannelMessage" r ON r.id = m."aiReplyMessageId"
JOIN "ChannelConnection" c ON c.id = m."connectionId"
WHERE m."aiOutcome" = 'REPLIED' AND r."sentAt" IS NOT NULL AND m."occurredAt" > now() - interval '7 days'
GROUP BY c.type;
```

Record the result here before App Review:

| Date | Channel | AI replies | Median | p95 | Max | Model |
|---|---|---|---|---|---|---|
| (gate B) | | | | | | |

## 7. Remaining blockers (by gate)

1. **Gate B:** the platform Meta app does not exist yet (§1). This is the critical path.
2. **Gate C:** App Review and Business Verification. Meta's timeline, typically days to weeks.
3. **The bot type** must be declared to Meta as **hybrid** (§6a), and AI latency measured and
   recorded in gate B.
4. **Not built, deliberately:**
   - a Notification Center alert when a connection needs reconnecting (it is visible on Settings and
     in the System Log);
   - sending attachments;
   - Instagram Login (accounts without a Page).
5. **Known limits:**
   - one workspace per Page;
   - more than 500 Pages per person are not all listed;
   - the AI answer time against Meta's 30-second bot rule must be measured in gate B.
