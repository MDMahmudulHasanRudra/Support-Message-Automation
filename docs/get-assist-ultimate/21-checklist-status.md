# 21 — Development checklist status (P1–P12)

**Read from:** `rudra` @ `b3ef5f5` (5 Nov 2026), after O1 was merged (PR #42). Evidence is the code, the schema
(212 models, 168 migrations) and the git history, checked for this list.

**Every status describes code only.** Deployment is unknown for everything not stated otherwise. Many modules
ship behind a project feature that is off by default. Live-provider verification is a third, separate
milestone, and "Implemented" never implies it.

| Mark | Meaning |
|---|---|
| **Done** | Implemented, tested in the repo |
| **Improve** | Implemented; the checklist asks for more than it does |
| **Partial** | Part of the item exists (named); the rest is missing |
| **Missing** | Nothing for it in the code |
| **Blocked** | Needs the owner, the server or an outside party first |

## Phase 1 — Reliability, security, performance

| Item | Mark | Evidence / what is left |
|---|---|---|
| P1-01 Merge CI upgrade | **Blocked** (owner) | `ci/actions-node24`, green (run #53). Needs a PR into `rudra` |
| P1-02 Merge backup package | **Blocked** (owner) | `ops/backup-restore` on the CI branch, green (run 41985069277); review findings BKP-01..05 fixed |
| P1-03 Real database backup | **Blocked** (server) | `scripts/backup.sh` ready; doc 19 §2 |
| P1-04 Isolated database + media restore | **Blocked** (server) | `scripts/restore-rehearsal.sh` ready; doc 19 §4 |
| P1-05 Encrypted off-server copy | **Blocked** (owner) | Destination and its credentials are the owner's choice; doc 19 §3 |
| P1-06 Scheduled backups + failure alert | **Partial** | cron line in doc 19 §2; the alert is doc 20 O10 (not built) |
| P1-07 Structured logging + correlation ids | **Partial** | O1 merged: no customer data in worker logs, central redaction, keyed trace id stored on AI decisions and System Log. Left: O3 logger, O4 correlation across the whole path + message timeline |
| P1-08 Monitoring: CPU, RAM, DB, worker, queue, Chromium | **Partial** | Existing: heartbeat, loop liveness, Platform → Monitoring (queues, failures, gaps). Left: doc 20 O5 (process, Chromium, disk), O6 (latency), O7 (database) |
| P1-09 Slow-query detection | **Missing** | doc 20 O7 + O9 (`pg_stat_statements`, needs a Postgres restart) |
| P1-10 Query / index / pagination optimisation | **Blocked** (measurement) | Needs P1-08/09 figures from the real server; no change without a measured slow query |
| P1-11 Group sync, recovery, message processing | **Done** → measure | Extensive (CLAUDE.md "Collecting every message", GROUP_SYNC.md). Optimise only against measured numbers |
| P1-12 Background workers, no overlapping jobs | **Done** | Every loop overlap-guarded; loop liveness. Left: P1-14 in doc 16 (move non-session loops off the browser process) — needs approval |
| P1-13 Queue claiming, retries, dead letter | **Partial** | Idempotency keys, retries, UNKNOWN states, recovery sweeps exist. Missing: `FOR UPDATE SKIP LOCKED` claims (needed before a second worker), a uniform dead-letter view |
| P1-14 Security headers, rate limiting | **Missing** / **Partial** | No CSP / HSTS / frame-ancestors in `next.config.ts`. Rate limit only on public API v1; login has per-account lockout, no per-IP limit |
| P1-15 Auth, RBAC, isolation, sensitive data | **Done** → review | TOTP, lockout, `authorize.ts`, project and tenant isolation (scoped clients, 96 DB triggers, `projectAcceptance`, `saasTwoLayers` tests). A fresh review of the modules added since 29 Oct is still open |
| P1-16 Load testing, capacity limits | **Missing** | No load or browser test tooling; baseline script never run (doc 15) |

## Phase 2 — Unified Inbox V3

| Item | Mark | Evidence / what is left |
|---|---|---|
| P2-01 Premium Inbox V3 interface | **Partial** | All Conversations (`/conversations`) + WhatsApp Chat v2 (`CHAT_UI_V2`); no V3 shell |
| P2-02 All channels in one workspace | **Done** (flag off) | Messenger, Instagram, Telegram, website chat, WhatsApp read in place (`OMNICHANNEL`) |
| P2-03 Search and filters | **Done** | Server-side filters, search across all groups, views |
| P2-04 Open / Pending / Resolved / Snoozed | **Partial** | `ChannelConversationStatus` is `OPEN`/`CLOSED`; WhatsApp has waiting/seen. No Pending, Resolved, Snoozed |
| P2-05 Internal notes | **Done** (flag off) | `ConversationNote` (`INBOX_COLLABORATION`) |
| P2-06 Assign to employees / teams | **Done** | Assignment + history; Support Assignment for WhatsApp waits |
| P2-07 Priority and tags | **Done** | `ConversationLabel`, priority in the workspace panel |
| P2-08 Real-time updates with fallback | **Partial** | Polling only (4 s); no SSE anywhere |
| P2-09 Typing and collision indicators | **Partial** | Website chat typing/seen only; no agent collision indicator |
| P2-10 Composer: templates, attachments, AI | **Improve** | Saved replies, file sending (`CHAT_UI_V2`), Copilot drafts exist; not one composer across channels |
| P2-11 Bulk actions, saved views | **Done** | Bulk actions; `InboxSavedView`, `ListSavedView` |
| P2-12 History / audit timeline | **Partial** | `ConversationEvent` exists; no full timeline view |

## Phase 3 — Customer 360° and CRM

| Item | Mark | Evidence / what is left |
|---|---|---|
| P3-01 Unified customer profile | **Partial** | `Client` + `ClientChannel`, WhatsApp chat/group links; channel conversations not linked to a client |
| P3-02 Identity linking, duplicates | **Partial** | Duplicates shown, never merged (by design); links are manual; no verified cross-channel identity |
| P3-03 Interaction timeline | **Done** | `ClientActivity` |
| P3-04 Notes, labels, custom fields | **Partial** | `ClientNote`, tags, `Client.customFields` (JSON) — no field definitions or UI found |
| P3-05 Segmentation, filters | **Done** | Smart views, one filter builder |
| P3-06 Leads, opportunities | **Done** (flag off) | `SalesLead` (`SALES_PIPELINE`) |
| P3-07 Configurable pipeline stages | **Partial** | Stages are a fixed enum (NEW…WON/LOST) |
| P3-08 Follow-up reminders, activities | **Partial** | `SalesLead.nextFollowUpAt`; no reminder, task or schedule |
| P3-09 Preferences, consent | **Partial** | Recorded per channel, not enforced (CLIENT_CENTER.md) |
| P3-10 Link conversations, tickets, invoices, subscriptions | **Partial** | Chat links + billing exist; no tickets (P4) |

## Phase 4 — Support Desk

| Item | Mark | Evidence / what is left |
|---|---|---|
| P4-01 Ticket management | **Missing** | Case-like records exist for WhatsApp waits (`SupportAssignment`, `SupportEscalationCase`), not tickets |
| P4-02 Ticket from conversation | **Missing** | |
| P4-03 Categories, priorities, statuses | **Partial** | Group priority policies only |
| P4-04 SLA: first response, resolution | **Partial** | Support Assignment SLA and escalation ladder (first response, WhatsApp groups); no resolution SLA, no customer business hours |
| P4-05 Escalation, overdue | **Done** (WhatsApp groups) | Escalation ladder, overdue + grace |
| P4-06 Assignment, reassignment | **Done** | Support Assignment, rounds |
| P4-07 Workload balancing | **Missing** | |
| P4-08 Merge, link, reopen | **Missing** | |
| P4-09 CSAT | **Missing** | "Customer Appreciation" is inferred from text, not a survey |
| P4-10 Performance and SLA reports | **Done** | Team Report, Response SLA, Human Response SLA, Support Intelligence |

## Phase 5 — AI Copilot

| Item | Mark | Evidence / what is left |
|---|---|---|
| P5-01 Copilot in the conversation | **Done** (flag off) | `AiDraft`, `AI_COPILOT` |
| P5-02 Suggested replies, never auto-sent | **Done** | "Use in reply" fills the composer only |
| P5-03 Citations, evidence | **Partial** | `AiEvidenceSnapshot/Item` stored per AI decision; not shown as citations in drafts |
| P5-04 Intent, topics | **Partial** | `AiFallbackDecision.intent` |
| P5-05 Summaries | **Done** | Copilot summary |
| P5-06 Suggest KB articles | **Partial** | Retrieval exists; not offered to the agent as articles |
| P5-07 Detect human needed | **Done** | Handover reasons, mood alerts |
| P5-08 Approval, AI-to-agent handoff | **Done** | Handover, takeover pause, drafts never sent |
| P5-09 Quality evaluation, feedback | **Missing** | |
| P5-10 Usage, tokens, cost, model performance | **Partial** | Tokens on 2 tables; no cost, no per-workspace usage (doc 00 §3.3) |
| P5-11 Models and policies per project | **Done** | `AiSettings`, `AiModelConfig` per project |
| P5-12 Bangla / English | **Done** → measure | Language rules in the reply prompt |

## Phase 6 — Automation Studio

| Item | Mark | Evidence / what is left |
|---|---|---|
| P6-01 Trigger–condition–action engine | **Partial** | `AutomationRule` + `packages/engine`: WhatsApp message trigger, first match wins |
| P6-02 Workflow UI | **Partial** | Rules + Rule Tester |
| P6-03 Event triggers | **Partial** | Incoming message only |
| P6-04 Scheduled automation | **Missing** | |
| P6-05 Multi-step, branching | **Missing** | |
| P6-06 Delays, retries, timeouts | **Missing** | Rule cooldown only |
| P6-07 Approval steps | **Missing** | |
| P6-08 Versioning, rollback | **Missing** | DRAFT/ACTIVE only |
| P6-09 Dry run, history | **Partial** | Rule Tester; `AutomationExecution` |
| P6-10 Templates | **Missing** | |
| P6-11 Failure alerts | **Missing** | |
| P6-12 Secure webhook actions | **Partial** | Signed outbound webhooks exist (`WebhookEndpoint`), not as a workflow step |

## Phase 7 — Billing and finance

| Item | Mark | Evidence / what is left |
|---|---|---|
| P7-01 Audit Client Billing V7 | **Done** (merged; deployment unknown) | CLIENT_CRM_V7.md |
| P7-02 Invoice create / edit / approval | **Partial** | Manual dues (`ClientDue`); approval only for bulk email |
| P7-03 Branded invoices, receipts | **Done** | V7 documents, versioned setup |
| P7-04 Renewal, expiry automation | **Partial** | Offers + Renewals workspace; nothing sends by itself (by design) |
| P7-05 Partial payments, allocation | **Done** | `ClientPaymentAllocation` |
| P7-06 Refunds, credit notes, reconciliation | **Partial** | Payment reversal only |
| P7-07 Multi-currency, exchange-rate history | **Partial** | Per-currency, never converted; no rates |
| P7-08 Statements, outstanding balance | **Partial** | Billing list; no customer statement |
| P7-09 Tax | **Missing** | No tax field in the schema |
| P7-10 Revenue, collection, aging dashboards | **Missing** | None found for client billing |
| P7-11 Audit trails, approval controls | **Partial** | Append-only events + DB triggers; no invoice approval |
| P7-12 General ledger, double entry | **Missing** | |

## Phase 8 — ERP

| Item | Mark | Evidence / what is left |
|---|---|---|
| P8-01 Products and services | **Done** → improve | `Product`, `ProductVariant`, `ProductCategory` |
| P8-02 Quotations, sales orders | **Partial** | `CommerceOrder` (orders); no quotations |
| P8-03 Purchase requisitions / orders | **Missing** | |
| P8-04 Suppliers | **Missing** | |
| P8-05 Inventory, stock movements | **Done** | `InventoryMovement`, conditional stock updates |
| P8-06 Multiple warehouses | **Missing** | One stock figure per product |
| P8-07 Adjustments, valuation | **Partial** | Movements; no valuation |
| P8-08 Expenses | **Missing** | |
| P8-09 Budgeting | **Missing** | |
| P8-10 Attendance, leave | **Done** | Team Management: shifts, roster, leave, attendance |
| P8-11 Payroll | **Missing** | |
| P8-12 Financial statements | **Missing** | Needs P7-12 first |

## Phase 9 — Social and official integrations

| Item | Mark | Evidence / what is left |
|---|---|---|
| P9-01 Meta approval, live verification | **Blocked** (Meta, owner) | App exists; Gate B/C runbook in docs/meta-integration |
| P9-02 WhatsApp Cloud API onboarding | **Missing** | Channel type `WHATSAPP_CLOUD` reserved; its webhooks are refused on purpose |
| P9-03 Independent Cloud API pipeline | **Missing** | Must stay separate from OpenWA |
| P9-04 Messenger hardening | **Done** → live check | Not live-verified |
| P9-05 Instagram DM hardening | **Done** → live check | Not live-verified |
| P9-06 Post scheduling, publishing | **Done** (flag off) | Social Studio; mock-tested, App Review pending |
| P9-07 Content calendar | **Done** | Social Studio calendar |
| P9-08 Comments management | **Missing** | Comment counts only |
| P9-09 Social analytics | **Partial** | Per-post metrics (reactions, comments, shares) |
| P9-10 Lead forms | **Missing** | |
| P9-11 Website live chat | **Done** | Website Chat V3 |
| P9-12 Health, token expiry, reconnect alerts | **Done** | Meta hygiene (A3), connection health loop |

## Phase 10 — Customer portal and integrations

| Item | Mark | Evidence / what is left |
|---|---|---|
| P10-01 – P10-05 Portal, tickets, invoices, KB search, customer login | **Missing** | No customer-facing area; P10-02 also needs P4-01 |
| P10-06 Public REST API, scoped keys | **Done** (flag off) | `/api/public/v1`, `ApiKey` (SHA-256), rate limited |
| P10-07 Versioned API docs | **Missing** | No OpenAPI |
| P10-08 Outbound webhooks, retries | **Done** | `WebhookEndpoint`, `WebhookDelivery`, signed |
| P10-09 WooCommerce | **Done** → live check | Not live-verified |
| P10-10 Shopify | **Done** → live check | Not live-verified |
| P10-11 Email, calendar | **Partial** | SMTP email; no calendar |
| P10-12 Marketplace framework | **Missing** | Module Builder governs modules, not third-party apps |

## Phase 11 — Analytics and enterprise management

| Item | Mark | Evidence / what is left |
|---|---|---|
| P11-01 Executive dashboard | **Partial** | Overview + Executive report (WhatsApp-centred) |
| P11-02 Omnichannel analytics | **Partial** | Reports read WhatsApp `Message`; channel conversations not in them |
| P11-03 Employee productivity | **Done** | Team Report, Employee Effectiveness, ranking |
| P11-04 Satisfaction analytics | **Partial** | Inferred appreciation only (needs P4-09) |
| P11-05 Revenue, subscription analytics | **Partial** | Platform billing; little for client billing |
| P11-06 AI usage and quality | **Partial** | AI Activity log; no cost (P5-10) or quality (P5-09) |
| P11-07 Workflow analytics | **Missing** | Needs P6 |
| P11-08 Custom report builder | **Missing** | |
| P11-09 Scheduled reports, exports | **Partial** | Exports exist; nothing scheduled |
| P11-10 Security / admin audit dashboard | **Partial** | System Logs, platform activity |
| P11-11 Notification center | **Done** | Events, templates, per-member opt-in |
| P11-12 Platform service health | **Partial** | Platform → Monitoring; doc 20 extends it |

## Phase 12 — UI/UX (applies throughout)

| Item | Mark | Evidence / what is left |
|---|---|---|
| P12-01 Design system | **Done** → improve | Custom kit, tokens, hand-rolled charts |
| P12-02 Responsive | **Partial** | Fixes exist (min-w-0, touch sizing); no systematic check |
| P12-03 Navigation, workspace switching | **Done** | Module sidebar, project switcher, workspace tabs |
| P12-04 Data tables | **Partial** | `ReportDataTable` in reports; not used everywhere |
| P12-05 Loading, empty, error states | **Done** | Group-level loading / error boundaries |
| P12-06 Keyboard, accessibility | **Partial** | Inbox keyboard; no accessibility audit |
| P12-07 Bangla / English UI | **Missing** (UI) | AI answers in Bangla; the interface is English only, no i18n layer |
| P12-08 Dark / light | **Done** | Dark tokens in `globals.css` |
| P12-09 Help, onboarding | **Partial** | Setup checklist, page help on some reports |
| P12-10 Large-dataset performance | **Partial** | Server-side paging in places; unmeasured |

## What this means for order

Phase 1 is mostly blocked on the owner and the server: P1-01 to P1-05 need a merge or a server run. Phase 1
items buildable now, in the recommended order:

1. **P1-14** security headers (CSP report-only first) + per-IP login rate limit. Web only, no worker restart.
2. **P1-08** doc 20 O5 → O6 → O7 (process, latency, database figures on Platform → Monitoring).
3. **P1-07** doc 20 O3 → O4 (logger, correlation through the whole path, message timeline).
4. **P1-13** `SKIP LOCKED` claims, pinned by the existing queue suites.
5. **P1-16** a load-test harness against the isolated stack, then P1-10 against what it measures.

After Phase 1, the gaps with the most customer value are:
- P2-04 conversation states + snooze;
- P2-08 / P2-09 live updates and collision;
- P4-01 / P4-02 tickets built on the existing assignment and escalation records;
- P5-10 AI cost ledger.

Each of those extends existing tables rather than replacing them.
