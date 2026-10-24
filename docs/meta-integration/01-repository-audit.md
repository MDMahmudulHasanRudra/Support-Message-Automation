# 01 — Repository audit (Meta one-click OAuth)

Read-only audit made on 24 Oct 2026, before any change for this work. Everything below was checked
against the repository, not taken from the brief.

## 1. Git state

| Fact | Finding |
|---|---|
| Working tree | Clean on `rudra` at `e9fb6a5`. |
| `rudra` vs `github/main` | `rudra` is **0 ahead, 13 behind**. All 13 are PR merge commits (#20–#33) and `git diff rudra github/main` is empty, so the two trees are **identical**. The brief's note ("12 behind, 1 ahead; Clients, Billing, Subscriptions, Smart Import and Pagination differ") is out of date: PR #33 merged all of that. |
| `rudra` vs `github/dev` | `dev` stops at PR #23; `rudra` is 15 commits ahead. `dev` is not a useful base. |
| `origin` (GitLab) | `origin/main` is an old line (restored to 16 Sep). `origin/rudra` is behind `github/rudra`. |
| Production | Zoventio (`zoventio.udboy.com`) last deployed with Smart Bulk Import (`587a3b3`). The two newest merges (expiry review grid, list page sizes) include one migration, `20261024120000_client_recorded_expiry`, that is **not yet deployed**. |
| Chosen base | `rudra` at `e9fb6a5` (= `github/main`'s tree). Implementation branch: **`feat/meta-oauth`**, local only. Nothing is pushed until approved. |

## 2. What already exists (and is reused)

The Omnichannel module (`OMNICHANNEL.md`, Oct 2026) already covers most of the message path. It was
built and tested against mocked providers only. **It has never run with live credentials.**

| Piece | Where | Reused as is? |
|---|---|---|
| Four channel tables: `ChannelConnection`, `ChannelConversation`, `ChannelMessage`, `ChannelInboundEvent` | `schema.prisma`, migration `20261011091600_messaging_channels` | Yes. `ChannelConnection` is extended, nothing is replaced. |
| Webhook ingest: HMAC check over the raw body, events split and recorded, a worker processes them | `server/channels/webhookIngest.ts`, `/api/channels/meta/[key]` | The split / record logic is reused. A second, platform route is added beside it. |
| Event normalising, dedup keys, reply windows, text limits, error reading and redaction | `packages/shared/src/channels.ts` | Yes, unchanged. |
| Worker loops: `channel-inbound`, `channel-outbound`, `channel-ai` | `apps/worker/src/channels/` | Yes. Two small changes: the app secret for a one-click connection comes from the environment. |
| AI on channels: the WhatsApp answering functions, the same gates, a 15-minute age limit, the kill switch, takeover by a person (Business Suite echo) | `channels/aiReply.ts` | Yes, untouched. |
| Encryption | `encryptSecret` / `decryptSecret` (AES-GCM, `AI_CREDENTIALS_ENCRYPTION_KEY`) | Yes. |
| An OAuth pattern: one fixed callback, sealed state, PKCE, a refusal code per failure | Google Sheets (`server/google/oauth.ts`, `/api/google/oauth/callback`) | Used as the model. Meta needs a stronger browser binding, see §4. |
| Permissions | `channels.view`, `channels.manage`, `conversations.reply`; feature `OMNICHANNEL` (off by default) | Yes. No new key is needed. |
| Audit trail | `logSystemEvent` → the project's System Log | Yes. No new audit table. |
| Tenant isolation | Project-scoped Prisma client; Phase 7 triggers `enforce_same_project` / `enforce_project_immutable`; `rawSqlProjectFilter` tests | Every new project-owned table follows the same rules. |

The WhatsApp side (`Message`, `OutboundMessage`, OpenWA, about 40 readers) does not change. No Meta
event can reach `Message`. Channel rows live only in the channel tables, which is how the module was
built.

## 3. How Meta connections work today

An admin creates their **own** Meta app. They paste its App ID, App Secret and a Page access token
under Settings → Messaging Channels. They then paste a per-connection callback URL
(`/api/channels/meta/<webhookKey>`) and verify token into their app's Webhooks settings. The app
secret is stored encrypted on the connection row and signs that connection's webhooks. This is the
"manual" connection mode. It stays exactly as it is.

## 4. Conflicts and risks found

1. **One webhook URL for every customer.** With a platform-owned app, Meta sends every Page's
   events to one callback URL, signed with one app secret. The per-connection key that routes today
   no longer exists for these connections. Routing must use the **asset id** (`entry.id`), and the
   project must come only from our own mapping. Consequence:
   - **One asset can be connected through the platform app to only one project at a time.** If two
     projects subscribed the same Page to the same app, an event could not be told apart.
   - This is enforced by a database partial unique index across the whole installation.
   - A second project that tries is told the account is "connected in another workspace", and is
     never told which one.
   - This is stricter than manual mode, which allows the same Page in two projects through two
     different apps.
2. **Customer addresses differ from the callback address.** SaaS hostname routing binds sessions to
   the address they were made on. Meta's redirect URI must be registered exactly, so it cannot follow
   each customer's domain. The callback therefore lives on one fixed address
   (`META_OAUTH_REDIRECT_URI`) and needs no session there. It only redeems the code against a
   single-use server-side state and hands the result back to the customer's own address. That
   hand-back needs three things together: the signed-in user who started, a browser-binding cookie
   set when they started, and a one-time claim code. The Google flow's cookie-only state cannot do
   this across addresses.
3. **OAuth CSRF (attacker's state, victim's Meta login).** Without that browser binding, an attacker
   could get a victim to authorise their Pages into the attacker's project. Mitigated as described in
   item 2. Tested.
4. **Meta approvals the platform does not have yet.** To serve Pages it does not own, the app needs
   **Advanced Access** through **App Review** for `pages_messaging`, `pages_manage_metadata`,
   `pages_show_list`, `instagram_basic`, `instagram_manage_messages` and Facebook Login for
   Business's `public_profile`. It also needs **Business Verification**. Until then, only people who
   hold a role on the app can complete the flow and receive webhooks. This is a Meta-side gate that
   code cannot remove. `META_DEVELOPER_SETUP.md` lists the steps.
5. **Disconnecting one Page must not break its sibling.** Messenger and Instagram for the same Page
   share one Page subscription to the app. In platform mode, unsubscribing on a Messenger disconnect
   would cut off an Instagram connection on the same Page. The Page is only unsubscribed when no
   other active one-click connection uses it.
6. **Meta batches up to 1,000 updates per POST.** The existing 1 MB body limit could reject a real
   batch. The platform route allows 8 MB.
7. **Automated-chat policy.** Meta's Messenger policy requires automated replies to disclose
   automation where the law requires it (California, Germany), and bots must answer within 30
   seconds. The existing AI path answers within its own pipeline and states nothing about being
   automated. This is recorded as a product decision for the owner; no behaviour is changed silently.
8. **The Graph version default is `v25.0`; Meta now documents `v26.0`.** The default is kept so that
   existing behaviour does not change. `META_GRAPH_API_VERSION` overrides it.

## 5. Baseline before changes (throwaway database on 127.0.0.1:5434)

| Suite | Result |
|---|---|
| `apps/web` isolated | 87 files, 1,013 passed, 7 skipped (run on `e9fb6a5` today) |
| `packages/shared` | see `07-test-and-release-plan.md` §Baseline |
| `apps/worker` isolated | see `07-test-and-release-plan.md` §Baseline |
| `tsc --noEmit` (web) and eslint on the touched areas | clean |

## 6. Decision

The work proceeds as **additive** work packages on `feat/meta-oauth`:

- **Configuration:** platform Meta config from the environment, off unless `META_INTEGRATION_ENABLED=true`.
- **OAuth:** a server-side state and a fixed callback, with the claim hand-back to the customer's address.
- **Data model:** additive only — two tables, a mode column, and one partial unique index.
- **Shared webhook:** routed by asset.
- **Health:** a bounded worker check.
- **UI:** "Connect with Facebook" beside the existing manual form, which stays.

Manual connections keep their routes, secrets and behaviour byte for byte.
