# 00b — Audit update for the 4 vCPU / 16 GB plan (5 Nov 2026)

**Branch:** `feature/project-delete` @ `05da3e1` = `rudra` @ `31f1b10` + one commit. **Method:** read from git, code,
compose and docs. Nothing was run against a database, container, CI runner or the production host.

This updates [`00-current-system-audit.md`](00-current-system-audit.md) (29 Oct, `4a19fca`). It does not repeat it.
The new owner documents (`Get_Assist_Ultimate_4vCPU_16GB_Blueprint.md`, `Get_Assist_Execution_Prompt_For_Coding_Agent.md`,
repo root, untracked) restate the Phase 0 programme. Their Task A is mostly answered by `00`. What follows is the part
that changed since then, the part the new server changes, and the corrections to the new documents.

## 1. Git state (verified)

| Fact | Evidence |
|---|---|
| `github/main` contains all of `github/rudra` (PR #41 merge `2a46fb6`, 2 Nov). The local `main` is 304 commits stale. | `git rev-list --left-right --count github/main...github/rudra` → `1 0` |
| Local `rudra` = `github/rudra` = `31f1b10`, the SHA the blueprint names. | same command, local vs remote → `0 0` |
| V5, V6, V7, module approval and Meta expansion branches are all in `main`. | `git merge-base --is-ancestor` |
| 52 non-merge commits since Phase 0. | `git log 4a19fca..HEAD` |
| Which commit production runs, and which migrations are applied: **unknown**. | needs a server check (`00` §6) |

**README status is stale:** it says Client CRM V7 is "not merged, not deployed". It is merged. Deployment is unknown.

## 2. What shipped since Phase 0

`00` §3.4 marked these **NONE**. All of them are now **IMPLEMENTED** in code, behind a flag that is off by default.
Deployment is **UNKNOWN** for every row.

| Area | Commits (29 Oct – 2 Nov) | Flag |
|---|---|---|
| Website live chat V1 → V3 (widget builder, photos, business hours, WordPress plugin) | `feat(webchat)` ×3 | `OMNICHANNEL` |
| Inbox workspace: notes, priority, tags, Team, AI Copilot, saved views, bulk actions, @mentions | `feat(inbox)` ×3, `fix(copilot)` | `INBOX_COLLABORATION`, `AI_COPILOT` |
| Commerce: products and stock, orders, sales pipeline | WP8 | `PRODUCT_CATALOG`, `ORDERS`, `SALES_PIPELINE` |
| Couriers, WooCommerce/Shopify, public API v1, signed outbound webhooks | WP10, WP11 | `COURIER`, `WOOCOMMERCE`, `SHOPIFY`, `API_ACCESS` |
| Social Studio: Meta publishing, durable engine, AI content, RSS | `feat(social)` ×4 | `SOCIAL_STUDIO` (approval-only) |
| Project types, Module Builder, templates, module-aware Overview | WP1–WP6 | — |
| Platform approval gate for approval-only modules | `feat(modules)` | — |
| Client CRM V5–V7: lists, codes, invoice/receipt documents, renewal offers, templates, bulk email | `feat(clients)` ×12 | `CLIENT_CENTER` |
| My account: TOTP two-step sign-in, devices (this closes "no MFA" in `00` Q7) | `feat(admin)` | — |

Feature catalogue: **28** project features, 11 on by default, 17 off (`packages/shared/src/projectFeatures.ts`).

## 3. The blueprint's 15 modules vs the code

The blueprint lists these modules as future work. Most already exist. Extend these; do not rebuild them.

| Blueprint module | Status in code | Build on |
|---|---|---|
| Unified Communication Hub | IMPLEMENTED (WhatsApp Legacy, Messenger, Instagram, Telegram, Website chat, SMTP email) | `server/channels/*`, `/conversations` |
| Customer 360° CRM | PARTIAL: Client Center + chat/group links; no verified cross-channel identity | `Client`, `ClientChannel`, `ClientWhatsApp*Link` |
| Advanced Support Desk | PARTIAL: escalation cases, Support Assignment SLA, response episodes; **no customer-visible case**, no business-hours SLA calendar | `SupportEscalationCase`, `SupportAssignment*` |
| Team Operations | IMPLEMENTED | Team Management, Team Report |
| AI Assistant & Copilot | IMPLEMENTED (flag off); cost ledger still PARTIAL (`00` §3.3) | `aiFallback/*`, Copilot processor |
| Automation Studio | **MISSING**: only the deterministic rule engine (WhatsApp only) | `AutomationRule`, `packages/engine` |
| Clients & Billing | IMPLEMENTED (V7) | `ClientDue`, `ClientPayment`, `ClientSubscription` |
| Knowledge Hub | PARTIAL: internal knowledge base; **no public Help Center** | `AiKnowledgeItem`, import pipeline |
| Social Studio | IMPLEMENTED, mock-tested; Meta App Review pending | `SOCIAL_STUDIO.md` |
| Sales & Lead CRM | IMPLEMENTED (pipeline) | `COMMERCE.md` |
| Notifications Center | IMPLEMENTED (staff alerts); no customer notification preferences | Notification Center |
| Customer Portal | **MISSING** (no customer-facing route under `apps/web/src/app`) | — |
| Integration Hub | IMPLEMENTED (API keys, signed webhooks, shop connectors) | `INTEGRATION_HUB.md` |
| Analytics & Intelligence | IMPLEMENTED; Support Intelligence still carries its "not validated against real groups" caveat | `server/reports/*` |
| Platform Management | IMPLEMENTED | `server/platform/*` |

Only three modules are genuinely new: **Automation Studio, Customer Portal, public Help Center**.
Two need real extension: Customer 360 (verified identity) and Support Desk (customer-visible cases, business hours).

## 4. Release 1 (reliability) status — almost nothing has moved

Since Phase 0 the work went into features. The reliability foundation that both new documents put first is still open.

| Phase 1 item | Status | Evidence |
|---|---|---|
| P1-1 CI | **Runs and is green** (52 runs; green since 30 Oct 15:02 UTC). Required checks not confirmed. See `18`. | GitHub Actions, run #52 |
| P1-3 Web port on 127.0.0.1 | OPEN: `"${WEB_PORT:-8668}:3000"` on all interfaces | `docker-compose.yml:117` |
| P1-4 Scheduled backup + rehearsed restore, media volume | Scripts + runbook written 5 Nov; **not yet run on the server** | `19-backup-and-restore.md` |
| P1-5 Structured logs + correlation id | OPEN: no logger dependency | `apps/*/package.json` |
| P1-6 Prometheus metrics, event-loop delay | OPEN | `health/metrics.ts` |
| P1-7 Global security headers | OPEN: none in `next.config.ts` | — |
| P1-8 Per-IP rate limits (login, webhooks, exports) | OPEN: only the public API v1 route limits | `api/public/v1/[...path]/route.ts` |
| P1-9 `FOR UPDATE SKIP LOCKED` claims | OPEN: no occurrence in source | — |
| P1-10 Playwright harness | OPEN | — |
| MFA (`00` Q7) | **DONE**: TOTP, 1 Nov | `ACCOUNT_SELF_SERVICE.md` |

## 5. What the 16 GB server actually changes

The execution prompt asks to "remove outdated assumptions tied to the old 2-vCPU / 8-GB server". **There are none in
the repository.** No doc, compose file or constant names a CPU or RAM size. The only concurrency knob is
`MEDIA_DOWNLOAD_CONCURRENCY` (2). What the new host makes relevant:

| # | Finding | Evidence | Why it matters on 16 GB |
|---|---|---|---|
| S1 | Postgres runs with **stock memory settings** (only `max_connections=100` is set). `shared_buffers` 128 MB, `work_mem` 4 MB. | `docker-compose.yml:18-21` | The extra RAM does not reach the database unless it is configured. Size from the baseline, not by guess. |
| S2 | **No memory or CPU limit on any container**; no log rotation. Only `shm_size: 1gb` on the worker. | `docker-compose.yml` | One leaking Chromium can push the kernel into OOM-killing Postgres. More RAM delays this; it does not prevent it. |
| S3 | Prisma pool is 10 per process (`DATABASE_POOL_SIZE`). | `packages/db/src/index.ts:67` | Fine for 100 connections. Change it only together with S1. |
| S4 | The **web** process now runs three background processors: Smart Import, integrations, Social Studio. | `apps/web/src/instrumentation.ts` | Workload isolation now has two sides. A heavy import or publish run competes with page rendering, not only with WhatsApp. |
| S5 | The worker has **41** `setInterval` sites (38 + billing timer at Phase 0), all in the process that holds every Chromium session. | `grep setInterval apps/worker/src` | P1-14 (browserless background worker) is still the main isolation step. The new host makes it affordable, but it is not done. |
| S6 | Capacity is still unmeasured: the baseline script has never run. | `15-performance-benchmarks.md`, `scripts/baseline-readonly.sh` | Every sizing number above depends on it. |

## 6. Corrections to the new documents

- **Redis**: the blueprint's server table lists "Redis যেখানে প্রয়োজন". No Redis exists in either compose file or any
  package. The documents themselves say not to add it without a measured need. That rule stands.
- **"rudra head 31f1b10"** is correct. `main` on GitHub is identical (plus the merge commit). Only the local `main` is stale.
- **The module list** treats ten implemented modules as future work (§3). Building them again would break the
  "no duplicate tables, abstractions or flows" guardrail.
- **The 15 reference repositories** are mostly AGPL or restricted SaaS licences (blueprint §11). Use them for design
  patterns only. Copying code from them into this proprietary SaaS needs a licence review first.

## 7. Top 10 next changes

Ordered by what protects users first. Severity = harm if left; Risk = chance the change breaks something.

| # | Change | User value | Severity | Complexity | Risk | Depends on |
|---|---|---|---|---|---|---|
| 1 | Scheduled Postgres + media backup, and a restore rehearsed into the test stack (P1-4) | Nothing is lost after a disk or operator failure | High | Low | Low | — |
| 2 | CI is green (checked 5 Nov). Remaining: make it required on PRs into `main`, explain run #38 (P1-1) | Regressions are caught before release | High | Low | Low | — |
| 3 | Run the read-only baseline on the new server (P0-4/P0-5), with approval | Every sizing decision rests on numbers | High | Low | Low | owner approval |
| 4 | Container memory limits, log rotation, Postgres memory tuning (S1, S2) | One runaway process can no longer take the database down | High | Low | Medium | 3 |
| 5 | Bind the web port to 127.0.0.1 if Caddy is the only client (P1-3) | Closes a bypass of the proxy | High if exposed | Low | Medium | server check |
| 6 | Deployment-state matrix: deployed SHA, applied migrations, flags per project; fix the README status line | Built features actually reach users; no repeat of the P2022 incident | High | Low | Low | server access |
| 7 | Security headers (CSP report-only first) and per-IP limits on login and webhooks (P1-7, P1-8) | Account takeover and abuse are harder | Medium | Medium | Medium | 2 |
| 8 | Structured logs, correlation id, Prometheus metrics with event-loop delay (P1-5, P1-6) | Incidents are diagnosed in minutes, not hours | Medium | Medium | Low | 2 |
| 9 | `SKIP LOCKED` queue claims, pinned by the existing suites (P1-9) | Prerequisite for a second worker; no behaviour change on one | Medium | Medium | Medium | 2 |
| 10 | Browserless background worker for non-session loops and the three web-process processors (P1-14 + S4) | Reports, imports and AI never slow message collection or pages | High at scale | High | High | 3, 8, 9 |

New product work (Automation Studio, Customer Portal, Help Center, verified Customer 360) should start after 1–6.
Those six are small, and the new modules will sit on top of them.

## 8. Not covered by this update

- Accessibility and mobile behaviour of the 52 new commits. Not browser-tested here.
- A fresh tenant-boundary review of the new modules. Each one ships its own isolation tests (`projectAcceptance`,
  `rawSqlProjectFilter`, `projectIntegrity` triggers). Those were not run here, and no exploit testing was done.
- No test was run locally for this update. CI results were read from GitHub afterwards (`18`, 5 Nov).

## 9. Production impact

None. Only this file, the index in `README.md` and the log in `18` were changed.
