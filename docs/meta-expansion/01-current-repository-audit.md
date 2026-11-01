# 01 — Current repository audit (Meta expansion baseline)

Status: **read-only audit, 1 Nov 2026.** No code was changed to produce it.

## 1. Starting point

| Item | Value |
|---|---|
| Branch audited | `rudra` |
| Starting commit | `6cbbaabf3fdee48375ab08b4077add6942d4c7c3` (matches the commit given in the brief) |
| `main` | `15055e2` (PR #40). `rudra` is 3 commits ahead (Client CRM & Billing V7) |
| Local working tree | clean |
| Work branch for this program | `feature/meta-expansion`, from `rudra` 6cbbaab |
| Migrations on `rudra` but not on `main` | `20261101130000_email_purpose_client_message`, `20261101130100_client_crm_v7` |
| Production database | not reachable from this audit; `_prisma_migrations` must be checked on the server before any deploy (CLAUDE.md) |

## 2. What already exists (verified in code, not taken from docs)

### 2.1 Legacy WhatsApp (OpenWA) — untouched by this program
- One `OpenWAProvider` (Chromium) per account in `apps/worker`; `Message`, `OutboundMessage`, `WhatsAppAccount`, `WhatsAppGroup` and ~40 report readers assume OpenWA semantics.
- **WhatsApp is deliberately not a `ChannelType`** (`packages/shared/src/channels.ts:9-11`, `schema.prisma:6239-6242`). All Conversations shows it through `InboxChannel = "WHATSAPP" | ChannelType` (`server/channels/inbox.ts:42`) and opens WhatsApp Chat.
- User-visible "WhatsApp" labels for the OpenWA channel are listed in full in §6, the input for the "WhatsApp (Legacy)" rename.

### 2.2 Messenger and Instagram DM (Omnichannel)
| Area | State |
|---|---|
| Models | `ChannelConnection` (`authMode` MANUAL/PLATFORM, `webhookKey`, encrypted tokens, `grantedScopes`, `pageTasks`), `ChannelConversation`, `ChannelMessage` (the send queue), `ChannelInboundEvent`, `MetaOAuthSession`, `MetaDataDeletionRequest` |
| `ChannelType` | `MESSENGER`, `INSTAGRAM`, `TELEGRAM`, `WEBCHAT` — no WhatsApp value |
| Platform OAuth | `/p/<slug>/api/meta/connect` → `/api/meta/oauth/callback` (one fixed URI, `META_OAUTH_REDIRECT_URI`, host decided as `https://admin.getassist.pro`) → `/p/<slug>/api/meta/claim` on the customer's own host (session + hashed one-time claim + HttpOnly binding cookie) → asset choice screen → `connectMetaAssets` (Page tokens, `subscribed_apps`). Rate limited 20/h/person. Allowlist `META_ALLOWED_PROJECT_IDS` fails closed |
| Scopes | `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`, `instagram_manage_messages` (or `META_LOGIN_CONFIG_ID`) |
| Webhooks | `/api/meta/webhook` (platform, 8 MB) and `/api/channels/meta/<key>` (manual, 1 MB); HMAC `X-Hub-Signature-256`; objects `page` and `instagram` only; `entry[].messaging[]` only; routed by `entry.id` to a live PLATFORM row; dedup `(projectId, connectionId, dedupKey)` |
| Worker | `channel-inbound` (2 s), `channel-outbound` (2 s, QUEUED→SENDING→SENT/FAILED/UNKNOWN, UNKNOWN never auto-retried), `channel-ai` (3 s, same answering functions as WhatsApp), `meta-connection-health` (5 min) |
| Reply window | `decideReplyWindow`: 24 h; 24 h–7 d a person only with HUMAN_AGENT and the connection switch on; AI never past 24 h |
| AI disclosure | Messenger/Instagram only (`isAiDisclosureChannel`), pinned by `aiDisclosureIsolation.test.ts` |
| Revocation | `/api/meta/deauthorize`, `/api/meta/data-deletion` (signed_request) — also revoke Social Studio connections |
| Message features | Text in/out; inbound attachments as references; receipts; echoes and Business Suite takeover. **Absent:** outbound attachments, quick replies, postbacks (recorded and ignored), persistent menu, Get Started, ice breakers, comments, handover protocol, Instagram Login |

### 2.3 Social Studio (publishing)
| Area | State |
|---|---|
| Models | `SocialConnection`, `SocialAccount`, `SocialPost`, `SocialPostTarget` (the durable job), `SocialPublishAttempt`, `SocialPostEvent`, `SocialMediaAsset`, `SocialCampaign`, `SocialTemplate`, `SocialAiRequest`, `SocialRssFeed`, `SocialRssItem` |
| OAuth | `/p/<slug>/api/social/meta/connect` → `/api/social/meta/callback` (built from `NEXTAUTH_URL`), state in an encrypted host-only cookie `softify-social-meta`, path `/api/social/meta/callback` |
| Scopes | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` — no messaging scopes (test-pinned) |
| Facebook | text/link, one photo, several photos (`attached_media`), one video, delete, `published_posts` reconciliation, reaction/comment/share counts |
| Instagram | publishing quota check, image, video as REELS or STORIES, carousel, container polling with lease renewal, like/comment counts |
| Engine | in-app scheduler (`socialProcessor.ts`, 15 s), claim + lease, `markSent` fence, UNKNOWN never re-sent, reconciliation, approval hash |
| Gating | `SOCIAL_STUDIO` `manualOnly` → platform `ModuleApproval` required; keys `social.view/edit/approve/publish/manage` |
| Absent | comments management, private replies, Page/IG insights, mentions, publishing webhooks, Facebook Reels/Stories |

### 2.4 Other
- Telegram and Website Chat channels exist on the same Omnichannel tables.
- Google Sheets OAuth uses the same cookie + `NEXTAUTH_URL` design as Social Studio (same cross-host limit).
- **Not found anywhere:** WhatsApp Cloud API, Embedded Signup, `whatsapp_business_account` handling, Marketing API, Lead Ads, Conversions API/Pixel, Audience Network, Fundraisers, Jobs, Meta Pay.

## 3. Verification status (honest)

| Integration | Implemented | Unit tests | DB integration tests | Mock Meta | Live Meta | Meta-approved | Production |
|---|---|---|---|---|---|---|---|
| Messenger/Instagram DM (platform OAuth) | yes | yes | yes (web 29 + 24, worker 29 + 9) | yes | **no** (Gate B not started) | **no** (Gate C not started) | flag off (`META_INTEGRATION_ENABLED` unset) |
| Messenger/Instagram DM (manual) | yes | yes | yes | yes | not recorded | n/a | off per project |
| Social Studio Facebook/Instagram | yes | yes | yes (20) | yes | **no** | **no** | staging runbook only |
| Social Studio OAuth start/callback | yes | **no tests** | **no** | — | **no** | — | — |

The platform Meta app "does not exist yet" (`docs/meta-integration/09-release-candidate.md` §7); the Gate B results table is empty. Nothing Meta-related may be described as production-ready.

## 4. Defects and gaps found

| # | Finding | Severity | Evidence |
|---|---|---|---|
| G1 | **Social Studio cannot connect from a customer's own address.** Three independent rules stop it: the state cookie is host-only on the customer host; the session cookie and `UserSession.hostname` are host-bound; the platform host opens no projects (`hostAllowsProject(ADMIN)=false`). With `NEXTAUTH_URL=https://admin.getassist.pro` and routing on, Social connect is impossible from ANY host. Fails closed (nothing wrong is connected). | High for SaaS | `api/social/meta/connect/route.ts:17`, `metaConnect.ts:19-96`, `auth.ts:93-142`, `saasDomains.ts:148-157` |
| G2 | WhatsApp Cloud API webhooks would be acknowledged 200 and **silently dropped** (`object` not mapped; only `entry.messaging` read) | Blocker for Official WhatsApp | `webhookIngest.ts:59,79,138`, `channels.ts:314` |
| G3 | No provider adapter: worker inbound/outbound use an implicit "else = Meta Page" branch; `webhookUrlFor` falls back to Telegram for any non-META type | High (a new type would mis-route) | `inboundProcessor.ts:114`, `outboundProcessor.ts:159`, `connections.ts:51` |
| G4 | Graph version default `v25.0` duplicated in three places; Meta's current version is v26.0 | Low | `metaPlatform.ts:14`, web/worker `providerApi.ts` |
| G5 | Page subscription fields duplicated as a literal | Low | `metaHealth.ts:124` |
| G6 | `META_SOCIAL_LOGIN_CONFIG_ID` absent from `docker-compose.yml` / `.env.example` | Low | — |
| G7 | Postbacks recorded and ignored; no quick replies / persistent menu | Feature gap | `channels.ts:433` |
| G8 | No `NotificationEvent` when a connection goes NEEDS_RECONNECT | Medium (silent outage) | — |
| G9 | Manual webhook body limit 1 MB vs Meta batches up to 1,000 events | Low | `api/channels/meta/[key]/route.ts` |
| G10 | Meta routes exclude only TELEGRAM, not WEBCHAT | Low (harmless today) | `webhookIngest.ts:43,64` |

## 5. Approval / environment prerequisites already documented
`docs/meta-integration/09-release-candidate.md` and `10-gate-b-runbook.md` hold the existing operator checklist (host `https://admin.getassist.pro`, callback, webhook, deauthorize, data-deletion routes). This program extends them; it does not replace them.

## 6. Every OpenWA "WhatsApp" label (input for "WhatsApp (Legacy)")
- Navigation (`(dashboard)/navigation.ts`): settings section "WhatsApp" (174), nav link "WhatsApp Chat" (381), nav group "WhatsApp" (507), report modules "WhatsApp support" (319-340).
- All Conversations: tab (`InboxWorkspace.tsx:75`), tooltip (940), `ChannelMark.tsx:13`, account filter (`server/channels/inbox.ts:469`), `inboxScopeLabel("whatsapp")` (`channels.ts:153`), help (`conversations/[scope]/page.tsx:31,52`).
- Settings → Messaging Channels "Also → WhatsApp" card (`settings/channels/page.tsx:111`).
- Module catalogue: `projectFeatures.ts:46,173,180,194,218`; `projectModules.ts:100,107,234,258,260,281,283,307,425,527,534`.
- Page titles: `chat/**/page.tsx`, `group-admin-maker/page.tsx:11`, `ChatInfoPanel.tsx:99`.
- Permissions category "WhatsApp" (`permissions.ts:74-75`); reports (`reportCatalogue.ts:149,249`, `userActivityReports.ts`, `groupReports.ts:250`, `activityReports.ts:174`, `runMetadata.ts:171`, support-response export); admin columns (`admin/page.tsx:89`, `ProjectCard.tsx:32`, `admin/projects/[id]/page.tsx:86`, `platform/(console)/page.tsx:78`).
- **Not to be renamed** (WhatsApp as a contact channel, not the OpenWA engine): Clients channels/templates/renewal offers, commerce order source.

Recommendation: rename only the **channel/module** labels (nav group, All Conversations tab and badge, module catalogue, settings card) to "WhatsApp (Legacy)", keep page titles like "WhatsApp Chat" where the context is unambiguous, and change no identifier, route, table, enum or report key.
