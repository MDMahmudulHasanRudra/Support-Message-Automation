# 00 — Current system audit (Phase 0)

**Branch:** `rudra` @ `4a19fca` (29 Oct 2026). **Method:** read from code, schema, tests and docs. Nothing was run
against any database, container or production host. A feature is only called "production-verified" when this audit
could see evidence of that; documentation alone is never treated as proof.

## How to read the status column

| Status | Meaning |
|---|---|
| **PROD** | Implemented, and the repo records it as deployed and used live (incident write-ups, operator confirmation recorded in docs/memory). Still not re-verified by this audit. |
| **NOT-DEPLOYED** | Implemented and tested in the repo; docs state it is not deployed. |
| **NOT-LIVE-TESTED** | Implemented; only mock/integration-tested; never exercised against the real provider. |
| **PARTIAL** | Some of the described scope exists in code; gaps listed. |
| **DOC-ONLY** | Described in a spec/plan; no code. |
| **NONE** | Not implemented. |
| **UNKNOWN** | Code exists; deployment state cannot be established from the repo. Needs a server check (§6). |

## 1. Topology (verified)

| Component | What it is | Evidence |
|---|---|---|
| `apps/web` | Next.js 16.3 / React 19.2 App Router, server components + server actions, Tailwind 4, custom UI kit (26 components), hand-rolled SVG charts, `lucide-react`. No Radix/shadcn, no charting or virtualization library. | `apps/web/package.json`, `src/components/ui`, `src/components/charts` |
| `apps/worker` | One Node 22 process. Owns **every** OpenWA/Chromium session (`ProviderRegistry` Map) and runs **38** `setInterval` loops plus one untracked 15 s billing timer. | `apps/worker/src/index.ts:156-244`, `provider/ProviderRegistry.ts:56`, `billing/billingProcessor.ts:90` |
| `packages/db` | Prisma 5.22 schema: **158 models, 120 enums, 142 migrations**; tenant-scoped clients; secret encryption (AES-256-GCM, key-id rotation). | `packages/db/prisma/schema.prisma`, `src/index.ts:776-921` |
| `packages/engine` | Pure rule evaluator + regex safety. | `packages/engine/src` |
| `packages/shared` | Canonical enums, pure business rules (team report, reports, intelligence, identity, clients, features, permissions). | `packages/shared/src` |
| `packages/ai-client` | Text-only completion client: Anthropic + OpenAI-compatible (OpenAI, OpenRouter, Ollama, Google). No tools by contract. | `packages/ai-client/src/AiClient.ts` |
| `packages/forge-client` | Read-only Softify Forge REST client + knowledge-safety gate. | `packages/forge-client/src` |
| `packages/media-storage` | `LocalMediaStorage` on a Docker volume. | `packages/media-storage/src` |
| `packages/teams-client` | **Dead**: untracked `dist/` + `node_modules/` only, no source, nothing imports it; root `build:packages` still names it. | `git ls-files packages/teams-client` → empty |
| Postgres | `postgres:16-alpine`, `max_connections=100`, no published port. | `docker-compose.yml` |
| Proxy/TLS | Caddy on the host (config not in repo), on-demand TLS gated by `/api/platform/tls-allowed`. | `SAAS_PLATFORM_PLAN.md:35` |

Web ⇄ worker coordination is entirely through Postgres (status columns, `WorkerCommand` rows, queue tables). There is
**no SSE/WebSocket anywhere**; the UI polls (`components/AutoRefresh.tsx`, 4 s default, ~18 pages;
`whatsappOperations/operationsStore.ts`).

Tenancy: two layers — the platform (`/platform`, `PlatformOperator`) and each customer's copy of the software
(`customerId` on platform-ish tables, `projectId` on 70+ project tables). Project isolation is enforced three times:
scoped Prisma clients (web and worker), `rawSqlProjectFilter` build-time tests, and 96 Postgres same-project
constraint triggers (`enforce_same_project()`, `enforce_project_immutable()`).

## 2. Feature flags (verified, `packages/shared/src/projectFeatures.ts`)

18 project features. Default **on**: WHATSAPP_CHAT, AI_REPLY, AI_LEARNING, CONVERSATION_LEARNING, TEAM_MANAGEMENT,
TEAM_REPORTS, BULK_MESSAGING, ESCALATIONS, SUPPORT_ASSIGNMENT, SUPPORT_ACTIVITY, PRODUCT_KNOWLEDGE_FORGE.
Default **off**: GOOGLE_SHEETS, OMNICHANNEL, CLIENT_CENTER, CHAT_UI_V2, UNIFIED_REPORTING, WHATSAPP_AVATARS
(manualOnly), CLIENT_SMART_IMPORT (manualOnly).

Env kill switches (all `_DISABLED`): `SMART_IMPORT_PROCESSOR_DISABLED`, `SAAS_HOST_ROUTING_DISABLED`,
`PROJECT_ROLES_DISABLED`, `PROJECT_ROLE_PAGES_DISABLED`, `WHATSAPP_AVATARS_DISABLED`. Meta platform OAuth is gated
by `META_INTEGRATION_ENABLED` + `META_ALLOWED_PROJECT_IDS` (fails closed).

Permissions: 74 keys / 27 prefixes in `packages/shared/src/permissions.ts`; enforced in every page and action
(`server/authorize.ts`), narrowed by project access levels and project roles (`resolveRoleKeys`).

## 3. Feature inventory and preservation matrix

"Tests" lists the main suites that pin the behaviour; these are the regression net any change must keep green.

### 3.1 WhatsApp (OpenWA)

| Feature | Status | Key code | Pinning tests |
|---|---|---|---|
| QR / phone-code linking, resume after scan, orphan-browser kill | PROD | `provider/openwa/OpenWAProvider.ts`, `linkLoading.ts`, `orphanBrowsers.ts` | `connectTimeouts`, `orphanBrowsers`, `qrGenerationRace`, `pairingMethod`, `providerLifecycle` |
| Multiple accounts, Primary answers, routing for notifications | PROD | `ProviderRegistry.ts`, `accountRegistrySync.ts`, `packages/db` `resolveWhatsAppAccount` | `multiAccount*` |
| Reconnect / auto-recovery / health check | PROD | `accountRegistrySync.ts` `recoverIfDropped`, `checkSessionHealth` | `providerLifecycle`, `collectionWatchdog` |
| Group sync (arrival passes, FULL, recovery, daily check, sweep guard) | PROD (confirmed working by operator 19 Oct) | `commands/commandProcessor.ts`, `commands/groupRecovery.ts`, `groupSyncGuard.ts` | `groupSync*`, `groupRecovery`, `groupDiscoverySlowRoster`, `groupArrivalSettling` |
| Message collection: live listener, catch-up, store sweep, reconcile, watchdog, CollectionGap | PROD; personal-message hotfix **NOT-DEPLOYED** per README | `pipeline/*`, `health/collectionWatchdog.ts`, `health/collectionGaps.ts` | `highVolumeCollection`, `storeSweep`, `personalCatchUp`, `collectionGaps`, `catchUpWindow` |
| Dedup (`Message @@unique([accountId, whatsappMessageId])`), logical-message key | PROD | `persistIncomingMessage`, `packages/shared/src/whatsappIdentity.ts` | `pipeline.integration`, identity suites |
| Outbound queue (idempotency key, rate limits, deferral, membership check) | PROD | `queue/outboundQueueProcessor.ts`, `queue/rateLimiter.ts` | `pipeline`, `aiReplyHardening`, `accountSafety` |
| Broadcast, Add to Groups, Groups Admin Maker, job indicator | PROD | `queue/group*Processor.ts`, `components/whatsappOperations` | `groupBroadcast`, `groupParticipant*`, `groupAdminPromotion`, `whatsappOperations` |
| Media storage (streaming decrypt, retention) | PROD (UNKNOWN which version) | `media/*`, `packages/media-storage` | `messageMedia`, `mediaCleanup`, `whatsappMediaCrypto` |
| Sender identity, LID handling, own-number detection, reattribution | PROD | `whatsappIdentity.ts`, `pipeline/ownAccounts.ts`, `teamManagement/reattribution.ts` | `whatsappIdentityReports`, `identityReattribution` |
| WhatsApp Chat v1 inbox (multi-account, personal chats, categories, saved replies) | PROD | `(dashboard)/chat`, `server/chatInbox.ts` | `chatMultiAccount`, `chatConversationType`, `personalChat*` |
| Chat v2 (CHAT_UI_V2) incl. rich messaging and file sending | NOT-DEPLOYED / NOT-LIVE-TESTED (flag off; needs a lab number) | `chat/v2`, `server/chatThreadV2.ts` | `chatV2`, `chatRich`, `chatFileSend` |
| Profile pictures + group descriptions (WHATSAPP_AVATARS) | NOT-DEPLOYED (flag off) | `avatars/whatsappPictures.ts` | `whatsappPictures` |

### 3.2 Support, team and reporting

| Feature | Status | Key code | Pinning tests |
|---|---|---|---|
| Team Report (group scope), exports, tables | PROD | `packages/shared/src/teamReport.ts`, `server/teamReport.ts` | `teamReport*`, `reportAccuracy*`, **`teamReportParity` (committed snapshot)** |
| Unified reporting (personal/combined scope, ranking, identity preview) | NOT-DEPLOYED (flag off) | `server/unifiedReporting.ts`, `packages/shared/src/unifiedReporting/*` | `personalReport`, `employeeRanking`, `unifiedReportingDataQuality` |
| Reports catalogue + Support Intelligence (5 reports) | PROD (catalogue); intelligence carries its own "not validated against real groups" caveat | `server/reports/*`, `server/intelligence/loader.ts` | `reports`, `reportsCatalogue`, `supportIntelligence` |
| Support Response episodes (Unanswered / Response Time) | PROD (UNKNOWN version) | `worker supportResponse/tracker.ts` | `supportResponse` ×2 |
| Support Assignment (cases on episodes, SLA, overdue, escalation) | PROD (UNKNOWN version) | `worker supportAssignment/*`, `server/supportAssignment.ts` | `supportAssignment` ×2 |
| Priority Escalation ladder | PROD | `worker escalation/*` | `supportEscalation` |
| Support Activity (rules, keywords, sessions) | PROD (off by default per project) | `worker supportActivity/*` | `supportActivity`, `supportSession` |
| Team Management: shifts, roster, leave, attendance, overtime, Duty History | PROD | `worker teamManagement/attendance.ts`, `server/teamManagementReports.ts` | `teamAttendance` (concurrency), `teamOvertime`, `dutyPunctuality` |
| Mood detection | UNKNOWN (off by default) | `worker mood/*` | `moodDetection` |
| Notification Center, templates, Teams **webhook** | PROD | `worker notifications/*` | `notificationEvents`, `notificationTemplates` |
| Microsoft Teams **Graph** integration | **NONE** — removed 27 Sep 2026; tables kept, no code | `commandProcessor.ts` (retired command) | — |

### 3.3 AI

| Feature | Status | Key code | Pinning tests |
|---|---|---|---|
| Rule engine + Rule Tester | PROD | `packages/engine/src/evaluate.ts`, `actions/ruleTester.ts` | engine unit suites; **no Rule Tester test** |
| AI fallback (gates, BM25F retrieval, 4 response modes, business-question guard, language rules, takeover, holding reply, handover mention) | PROD | `worker aiFallback/*` | `aiFallback`, `aiReplyHardening`, `bm25Ranking`, `knowledgeIsolation`, `evidenceProvenance`, `handoverMention` |
| Deep answer (Forge live research) | UNKNOWN (needs Forge configured) | `aiFallback/deepAnswer.ts` | `deepAnswer` |
| Knowledge base, verification, import (text/file/URL/PDF/DOCX/sheet) | PROD | `worker knowledge/*`, `actions/aiKnowledge.ts` | `knowledgeImportRows`, `importPrompt` |
| Group knowledge builder, conversation analysis, communication style | UNKNOWN (all off by default) | `worker knowledge/*` | `groupKnowledgePrompt`, `communicationStyle*` |
| Forge product knowledge | UNKNOWN (needs `FORGE_API_*`) | `worker forge/*`, `packages/forge-client` | `forgePrompts`, `knowledgeSafety` |
| Conversation Learning (segmentation, patterns, AI analysis, proposals) | PROD code; off by default; **must never run tests against live DB** | `worker learning/*` | `sessionSegmentation`, `patternDetectionJob`, `aiAnalysisJob` (isolated DB only) |
| AI Sandbox | PROD | `worker sandbox/*` | `sandboxWorkflow` (shared only; **no worker integration test**) |
| AI Admin Assistant (Anthropic tool-calling, 7 read-only tools) | PROD | `server/aiAdmin/*` | **none** |
| Agent copilot / AI draft in composer | **NONE** | — | — |
| AI cost tracking | **PARTIAL**: `tokensUsed` stored only on `AiFallbackDecision` and `SandboxTurn`; no price, no per-workspace cost, learning/Forge/mood/admin/channel AI calls untracked | — | — |
| VISION / DOCUMENT / EMBEDDING model slots | **DOC-ONLY** (configurable slots with no consumer) | `AiModelJob` enum | — |
| Dead AI settings (form fields with no consumer) | `screenshotResponseEnabled`, `announcementAiEnabled`, `chatLearningEnabled`, `softwareLearningEnabled`, `requirementLearningEnabled`, `duplicateSimilarityThreshold`, `autoApprovalThreshold` | `actions/aiSettings.ts` | — |

### 3.4 Business, platform, channels

| Feature | Status | Key code | Pinning tests |
|---|---|---|---|
| Client Center + Clients V3 (subscriptions, numbered invoices = `ClientDue`, payments + allocations + reversal, WhatsApp chat/group links, photos, deletes) | UNKNOWN — `CLIENTS_V3.md` says not deployed; `docs/meta-integration/01-repository-audit.md` says Zoventio has Smart Import, which is later | `actions/client*.ts`, `server/clientBillingStore` | `clients*`, `clientBilling`, `clientDeletes` |
| Smart Bulk Import | UNKNOWN (same) ; processor runs in the **web** process | `server/smartImportProcessor.ts` | `smartImport*` |
| Email over SMTP | PARTIAL: `EmailPurpose` has only `TEST`; no client-facing mail exists | `worker email/*` | `clientEmail`, `emailOutbox` |
| Omnichannel inbox (Messenger, Instagram, Telegram) — manual connections | UNKNOWN (flag off) | `server/channels/*`, `worker channels/*` | `channels` ×2 |
| Connect with Facebook (platform Meta app) + AI disclosure | NOT-LIVE-TESTED: gate A passed 25 Oct; gates B–D not started; Meta app does not exist yet | `server/channels/metaOAuth.ts`, `api/meta/*` | `metaOAuth`, `metaPlatform`, `aiDisclosureIsolation` |
| `ChannelConversation` lifecycle | PARTIAL: status `OPEN`/`CLOSED` only, `assignedUserId`, no notes/tags/priority | `schema.prisma:6288,~6384` | — |
| Google Sheets work management (10 phases) | UNKNOWN (flag off) | `server/google/*`, `worker googleSheets/*` | `google*` (7) |
| SaaS platform: customers, plans, subscriptions, billing hold, domains, support access, operators | UNKNOWN — `SAAS_PLATFORM_PLAN.md` §7/§10–12 say not deployed; memory records a 22 Oct deploy of the two-layer split | `server/platform/*` | `saasBilling`, `saasTwoLayers` |
| Customer removal / permanent delete | NOT-DEPLOYED (migration `20261026090000` is newer than every deploy note) | `server/platform/customerRemoval.ts` | `customerRemoval` |
| Main Admin portal, workspace tabs, project roles, page-level roles, branding | PROD (UNKNOWN version) | `app/admin`, `server/permissions.ts` | `projectRoles`, `projectRolePages`, `navigationPermissions`, `workspace*` |
| Release notes | PROD | `actions/releaseNotes.ts` | — |
| Website live chat, commerce, catalog, orders, couriers, leads/pipeline, tickets, workflow engine, public API, outbound webhooks, social comments/publishing, WooCommerce/Shopify/WHMCS/n8n | **NONE** | — | — |

## 4. Overlap map for the requested new domains

The new prompt lists several "new" models. These already exist and must be **extended, not duplicated**:

| Requested | Existing structure to build on |
|---|---|
| ChannelConnection / ChannelMessage / ChannelEvent / UnifiedConversation | `ChannelConnection`, `ChannelMessage`, `ChannelInboundEvent`, `ChannelConversation` (+ WhatsApp `Message` read in place via `getChatInbox`) |
| Ticket | `SupportEscalationCase` (the schema calls it the "ticket"), `SupportAssignment`, `SupportResponseEpisode` |
| SlaPolicy / SlaEvent | `SupportPriorityPolicy`, `SupportAssignmentSettings`, `SupportEscalationEvent`, `SupportAssignmentEvent` |
| Business-hours / holidays | `Holiday`, `ShiftTemplate` exist but are **staff** calendars — a customer SLA calendar is a different concept (prompt §12.1) |
| CustomerIdentity / ChannelIdentity | `Client`, `ClientChannel`, `ClientWhatsAppChatLink`, `ClientWhatsAppGroupLink`, `InternalTeamMember` identity rules |
| Internal notes | `ClientNote` (client-level only) |
| Tags / labels | `Client.tags String[]`, `ChatCategory` |
| Workflow definitions | `AutomationRule` / `AutomationExecution` / `RuleProposal` (deterministic, WhatsApp-only) |
| AiInteraction / AiToolExecution | `AiFallbackDecision`, `AiEvidenceSnapshot`, `AiEvidenceItem`, `SandboxSession/Turn` |
| IntegrationConnection / Credential | `ChannelConnection`, `GoogleIntegrationAccount`, `GoogleIntegrationConfig`, `ForgeSettings`, `AiProvider`, `EmailSettings` (five parallel shapes today) |
| Invoice / payment | `ClientDue` (is the invoice), `ClientPayment`, `ClientPaymentAllocation`; SaaS `SubscriptionInvoice`, `SubscriptionPayment` — **separate domains, keep separate** |

Genuinely new: Lead/Opportunity/Pipeline, Product/Variant/Inventory/Store, CommerceOrder, Shipment/Courier,
WorkflowVersion/Execution, OutboundWebhook/Delivery, public API keys, website-chat visitor.

## 5. Quality and operations findings

Ranked by production risk. None of these were changed in Phase 0.

| # | Finding | Evidence | Risk |
|---|---|---|---|
| Q1 | **No CI.** No workflows, hooks or lint-staged; typecheck/lint/test run only when someone runs them. | no `.github/`, `.gitlab-ci.yml`, `.husky` | High — every regression net above is opt-in |
| Q2 | **Single worker process holds every Chromium session and 38 loops.** A second worker is explicitly unsupported (in-memory sync guard; claims without `SKIP LOCKED`). An uncaught exception restarts all sessions. | `commandProcessor.ts:464`, `outboundQueueProcessor.ts:95`, `lifecycle.ts:83-105` | High at scale, accepted at current load |
| Q3 | Web port published on all interfaces (`"${WEB_PORT:-8668}:3000"`), while the platform plan assumes only Caddy reaches it. | `docker-compose.yml:114`, `SAAS_PLATFORM_PLAN.md:56` | High if the VPS firewall is open — verify on server |
| Q4 | Backups are a manual `pg_dump` in the deploy checklist; no schedule, no documented/tested restore for that format, media volume never backed up. | `DEPLOY.md:11-40,62-67` | High |
| Q5 | Containers run as root; worker base image not digest-pinned; no memory/CPU limits; no log rotation. | Dockerfiles, compose | Medium |
| Q6 | No global security headers (CSP/HSTS/frame-ancestors) in the app; only per-route on media/brand. | `next.config.ts`, `proxy.ts` | Medium (Caddy may add HSTS — verify) |
| Q7 | No per-IP rate limiting on login, webhooks or exports; only per-account login lockout. No MFA. | `(auth)/login/actions.ts:79-96` | Medium |
| Q8 | Observability is `console.*` + DB `SystemLog`; `/metrics` is JSON in memory (lost on restart); no tracing; correlation id stops at the AI fallback. | `health/server.ts`, `health/metrics.ts` | Medium |
| Q9 | Learning/knowledge/Forge/sandbox loops have no liveness registration or shutdown tracking; billing's 15 s timer is never cleared. | `index.ts`, `billingProcessor.ts:90` | Low |
| Q10 | Key rotation env vars (`AI_CREDENTIALS_ENCRYPTION_KEY_ID`, `_KEYS_OLD`) exist in code but not in `.env.example`/compose. | `packages/db/src/index.ts` | Low (blocks rotation) |
| Q11 | Teams webhook POST has no timeout. | `notifications/TeamsProvider.ts` | Low (holds the dispatcher loop) |
| Q12 | Dead config: 7 AI settings with no consumer; 3 AI model slots unused; `packages/teams-client` leftovers. Against ENGINEERING_STANDARDS "no unused config". | §3.3 | Low |
| Q13 | Stale docs: README title "Softify Assist" and host `assist.softifybd.com`. The intended domain layout (owner, 29 Oct) is `getassist.pro` public site, `admin.getassist.pro` platform, `app.getassist.pro` shared app entry (not yet verified live), `*.getassist.pro` customer workspaces — `noorvip.getassist.pro` is a customer workspace, **not** the canonical app host. Live routing is unverified. Local `main` is 246 commits behind; `github/main` is 5 commits ahead of `rudra`. | README, git | Low — confusing for any new engineer |

Test inventory: **301 test files** (web 91 / 77 integration; worker 129 / 85 integration; shared 68; engine 8;
ai-client 2; forge-client 2; media-storage 1; db 0). **No E2E, no load/perf tooling.** Integration suites must run
against the isolated DB (`test:isolated`), never the live one.

## 6. Deployment state — what cannot be settled from the repo

| Question | Why it matters |
|---|---|
| Which commit is running on the production VPS, and which migrations are applied (`_prisma_migrations`)? | Every "UNKNOWN" row above. CLAUDE.md records a past P2022 incident from an undeployed migration. |
| Is port 8668 reachable from the internet, or only from Caddy? | Q3 |
| Does Caddy set HSTS and other headers? | Q6 |
| Current host load: number of linked accounts, groups per account, Chromium RSS, Postgres size, message rate. | Architecture decision (01) and benchmarks (15) |

`15-performance-benchmarks.md` provides a **read-only** script for these. It needs your approval to run on the server.

## 7. Production impact of this audit

None. Only files under `docs/get-assist-ultimate/` were added.
