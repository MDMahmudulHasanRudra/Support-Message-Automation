# Nexora SaaS platform — Phase 1 assessment and implementation plan

Status: **proposal, nothing built yet** (21 Oct 2026). Written after a read-only audit of the
repository (`rudra` = `main` at 3e62e1f + the Nexora defaults change) and of the zoventio server.
Production was not touched. Every phase below ends with a review; nothing is deployed without
Rudra's explicit approval.

---

## 1. What already exists (reuse, do not rebuild)

| Need | Already in the code | Gap |
|---|---|---|
| Isolated workspace per customer | `Project` + project-scoped Prisma client in web and worker, raw-SQL lint test, 96 DB triggers refusing cross-project rows, two-project acceptance tests (MULTI_PROJECT_PLAN.md Phases 1–7) | A *customer* (company, owner, plan, domain) above the project |
| Per-customer WhatsApp numbers and sessions | `WhatsAppAccount.projectId`, one Chromium profile per account, every send checks the account's project | Plan limit on how many numbers |
| Separate users, roles, permissions | `ProjectAccess` (who may enter), project Lead + project roles + page-level roles (PROJECT_ROLES.md), access levels READ/WRITE/FULL | Customer Owner = a Lead whose login belongs to one customer only; invitations |
| Separate AI, knowledge, automation | All project-scoped tables | — |
| Turn modules on/off per customer | `ProjectFeature` entitlements, enforced in nav, pages, actions and the worker | Fed by the plan instead of set by hand |
| Suspend without losing data | Project status `SUSPENDED`: web read-only, worker holds queues/scanners and keeps **storing incoming messages without automation**, sessions kept | A *billing* suspension that uses the same hold, separate from the operational status |
| Main Admin portal | `/admin`: projects, users, configuration, branding, workspace | Customers, plans, subscriptions, payments, domains, onboarding wizard |
| White label | `PlatformBranding` (one platform row) | Per-customer branding is a later option, not required now |
| Platform audit trail | `SystemLog` rows with no project, visible only to Main Admins | A filtered "SaaS actions" view |

Two facts shape everything below:

- **Login cookies are already host-only** (`support_automation_session`, no `Domain` attribute).
  A session made on `customer1.example.com` is never sent to `customer2.example.com`. Isolation
  between subdomains comes for free; the plan adds a server-side check on top.
- **Users are platform-wide** (`User` has no project). A customer's people are ordinary users whose
  `ProjectAccess` is limited to their customer's project(s). Usernames are unique platform-wide.

## 2. Infrastructure today (zoventio, read-only check)

- Ubuntu VPS, Docker Compose (`postgres`, `app` on `127.0.0.1:8668`, `worker`).
- **Caddy 2.6.2 on the host** (systemd), one site block: `zoventio.udboy.com → 127.0.0.1:8668`,
  automatic Let's Encrypt. Nothing else on ports 80/443.
- `NEXTAUTH_URL=https://zoventio.udboy.com` (used by Google OAuth and channel webhooks to build
  absolute URLs), `COOKIE_SECURE=true`.
- No wildcard DNS for `udboy.com` (a random subdomain does not resolve).

> **Question 1 for Rudra:** CLAUDE.md names `assist.softifybd.com` as production, while recent work
> treats zoventio as production. Which installation is "Customer #1", and which root domain will the
> SaaS use (keep `udboy.com`, or a new Nexora domain)? The design works for either.

## 3. Target architecture

**One deployment, one database, one worker, many customers.** No new services.

```
            DNS (manual A record per customer, or one wildcard)
                               │
                 Caddy on the host (existing)
   ├─ admin.<root>        ─┐   on-demand TLS: before issuing a certificate Caddy asks the app
   ├─ customer1.<root>    ─┼─► "is this hostname an ACTIVE domain?"  (no config edit per customer)
   └─ customer2.<root>    ─┘
                               │  Host header (trusted: only Caddy can reach 127.0.0.1:8668)
                     Next.js app (existing)
         proxy.ts: normalise Host → header; server resolves host → customer
         /admin/*  only on the admin host
         /p/<slug>/* only for that customer's projects
                               │
                     PostgreSQL (existing, project-scoped)
                     Worker (existing): plan + billing hold checked beside every feature check
```

### 3.1 Data model (additive migrations only)

| Table | Purpose |
|---|---|
| `Customer` | Company name, contact, status, notes. Owns 1..n `Project` rows (starts with one). Platform-level, no `projectId`. |
| `Project.customerId` | Nullable at first; Customer #1's existing project is adopted by setting it. |
| `CustomerDomain` | `hostname` (unique, lower-case), `customerId`, `kind` (SUBDOMAIN / CUSTOM), `status` (PENDING_DNS → DNS_OK → TLS_READY → ACTIVE, or DISABLED / ERROR), last check results, `verificationToken`, timestamps. |
| `PlatformDomainSettings` | Root domain, admin hostname, the VPS public IP(s) DNS must point to, reserved names (`admin`, `www`, `api`, `mail`, …). |
| `Plan` | Name, price, currency, interval (MONTH / YEAR), trial days, limits (`maxWhatsAppAccounts`, `maxUsers`, `aiEnabled`, `features[]` from the existing feature catalogue, optional monthly message cap), active/archived. |
| `Subscription` | One current row per customer: plan snapshot (limits copied at assignment, so editing a plan never silently changes a paying customer), status, period start/end, grace days, `manualOverride`, history kept. |
| `SubscriptionPayment` | Manual payments: amount, currency, method, reference, period covered, confirmed by, receipt note. Separate from the customer's own Client billing (`ClientDue`/`ClientPayment`), which is untouched. |
| `UserInvitation` | Hashed token, customer, project, intended role (Owner / Admin / Staff), expiry, accepted/revoked. |

### 3.2 Two independent states, one effective result

- **Operational status** stays `Project.status` (SETUP / ACTIVE / SUSPENDED / ARCHIVED) — unchanged.
- **Billing status** lives on `Subscription`: TRIALING, ACTIVE, PAST_DUE (inside grace), SUSPENDED
  (unpaid or by an admin), CANCELLED, EXPIRED.
- One pure function, `effectiveAccess(project, subscription, now)` in `packages/shared`, gives
  FULL / GRACE (full, with a renewal banner) / HELD. **HELD reuses the existing SUSPENDED hold**:
  read-only web with a renewal page, no automation, no outbound, no AI; incoming messages still
  stored; sessions kept. Unlock = renew/extend → FULL at the next check, no restart.
- The worker already asks "is this project held?" in every queue and scanner; that one function is
  extended, so enforcement cannot be skipped by a forgotten caller.
- **Customer #1 gets a manual, non-expiring subscription**, so nothing about enforcement can lock
  them out by accident.

### 3.3 Hostname routing and security

- Caddy only forwards to `127.0.0.1:8668`, so the `Host` header is set by Caddy, not by the internet
  (the app port is not public — confirmed). `proxy.ts` lower-cases it, strips the port, and forwards
  it in a header the client cannot set (the same pattern as `x-softify-project` today).
- The server maps hostname → customer (cached for seconds, invalidated on change):
  - **admin host**: `/admin/*` and Main Admin sign-in only; `/p/*` allowed only for Main Admins
    (the existing Workspace).
  - **customer host**: `/p/<slug>` resolves only that customer's projects (another customer's slug
    is a 404, not a 403); `/admin` is a 404; login accepts only users with access to that customer.
  - **unknown host**: a plain 404 page, no branding, no data.
- `UserSession` records the customer it was created for; a session presented on another host is
  refused even if a cookie were copied by hand.
- **Legacy compatibility:** `zoventio.udboy.com` (or whichever host Customer #1 uses) becomes
  Customer #1's ACTIVE domain on day one, and keeps the admin routes until `admin.<root>` is
  verified, so no bookmark or habit breaks. Existing `/p/isp-digital/...` URLs keep working.
- Absolute URLs (Google OAuth callback, Meta/Telegram webhooks) keep using the platform URL;
  per-customer callbacks are a later refinement, not needed for Phase 2.

### 3.4 HTTPS: Caddy on-demand TLS (recommended)

- One-time Caddyfile change: keep the existing `zoventio.udboy.com` block exactly as it is, and add a
  catch-all `https://` site with `tls { on_demand }` plus a global
  `on_demand_tls { ask http://127.0.0.1:8668/api/platform/tls-allowed }`.
- The app answers `200` only for a hostname the admin added and whose DNS check passed. Caddy then
  gets a Let's Encrypt certificate on the first visit. **Onboarding a customer never edits server
  config or reloads Caddy**, and untrusted input never reaches a config file.
- A wildcard (`*.<root>` A record + wildcard certificate) is the optional upgrade later. It needs a
  DNS-provider API token for the DNS-01 challenge and a Caddy build with that provider's module.
  Manual records keep working either way.

### 3.5 Domain verification (in the admin UI)

For each domain, the page shows the exact record to create (`A  customer2  →  <VPS IP>`), then a
**Check now** button runs, in order, with a plain-language result for each:

1. **Format and ownership rules**: valid hostname, under the root domain (or an allowed custom
   domain), not reserved, not used by another customer.
2. **DNS**: resolves to one of the configured VPS IPs (and does not also point elsewhere).
3. **Reaches this app**: `http://host/.well-known/nexora-check/<token>` returns the domain's
   token, which proves the traffic arrives at this deployment, not just the right IP.
4. **HTTPS**: the app requests `https://host/api/health` with normal certificate validation (this
   is what makes Caddy issue the certificate).
5. **Activate**: only after 1–4 pass. Disable or remove takes effect immediately (the hostname then
   gets a 404, and Caddy stops renewing its certificate).

Changing a customer's domain adds the new one alongside the old; the old one is disabled only after
the new one is ACTIVE, so there is never a moment with no working address.

### 3.6 Customer onboarding wizard (Main Admin)

One page with steps and a live checklist: **Company → Subdomain → Plan and dates → Owner (create
login or send invitation) → Features and limits (pre-filled from the plan) → Review → Create**.
Creation is one transaction: `Customer`, `Project` (through the existing
`createProjectWithDefaults()`), `Subscription`, `CustomerDomain`, owner `User` or `UserInvitation`,
`ProjectAccess` + Lead flag. The customer page then shows what still needs attention (DNS not
pointed yet, owner has not accepted, payment due) with the button that fixes each.

Owner access: an invitation link (single use, 72 h, hashed in the database) opens a set-password
page on the customer's own host; or the admin creates the login with a one-time password the owner
must change at first sign-in. The invitation can go out through the existing SMTP outbox, or be
copied and sent by hand. No permanent password is ever shown twice.

Roles map onto what exists: **Platform admin** = global role with `projects.manage`; **Customer
Owner** = project Lead whose login belongs to that customer only; **Customer Admin / Staff** =
project roles the Owner manages (existing `/project-members`, `/project-roles`). The Owner can
never reach plans, other customers or platform settings — those keys are platform-only already, and
the admin host is the only place they are served.

### 3.7 Limits enforcement

- Features: the plan's feature list becomes the project's `ProjectFeature` entitlements (existing
  enforcement in nav, pages, actions and worker; nothing new to forget).
- Counts: checked inside the actions that create the thing (add WhatsApp number, create login /
  accept invitation), under an advisory lock so two clicks cannot pass a limit together.
- AI on/off: the existing `projectHasFeature` checks for the AI features.
- Lowering a plan never deletes anything: over-limit items keep working read-only, and new ones are
  refused with an explanation.

### 3.8 Capacity

All WhatsApp numbers run in the one worker container (one Chromium each). Today 2 numbers use
~1.5 GB on a 7.7 GB / 2 CPU server with no swap. **Before onboarding customers with large numbers,
the VPS needs more memory (16 GB / 4 CPU suggested) or swap**, and plans should cap WhatsApp numbers.
A second worker host is possible later but is not part of this plan.

## 4. Phases

| Phase | Delivers | Production impact |
|---|---|---|
| **1. Audit + plan** | This document. Decisions needed: Questions 1–3. | None |
| **2. SaaS foundation + domains** | `Customer`, domain tables, host routing, session-host binding, TLS-ask endpoint, domain page with verification, Customer #1 adopted (its project, its current hostname as ACTIVE domain, manual subscription), legacy host keeps admin. Two-customer isolation tests (host spoofing, slug from another customer, copied cookie, unknown host). | Additive migrations; one Caddyfile addition (reviewed with you, applied by you or with your approval, existing block untouched) |
| **3. Control center** | Plans, subscriptions, manual payments, renew/extend/suspend/unlock, grace handling, effective-access enforcement in web + worker, onboarding wizard, invitations, limits, customer overview (numbers, status, health, payments, audit). | Additive migrations; Customer #1 unchanged (manual subscription) |
| **4. Second-customer readiness** | A staging run on a throwaway copy: create Customer #2 from the UI, point a real test subdomain, verify DNS/TLS, owner invite, login, data boundary, WhatsApp separation, suspend/unlock. Written test report. | Rehearsal first; then the real onboarding with your approval |
| **5. Self-service** | Public pricing page, signup with email verification and anti-abuse (rate limits, captcha-free challenges where possible, admin approval switch), trial, payment provider integration (to be chosen — e.g. SSLCommerz / Stripe / bKash depending on market). | Later |

Each phase: built on `rudra`, pushed to GitHub only, tested on the throwaway database, reviewed by
you, merged by you. Deployment of each phase is a separate, explicitly approved step with a fresh
backup, the migration list, a rollback plan, and a note on whether WhatsApp sessions restart
(worker image changes do restart them for about a minute; the catch-up sweep recovers the gap).

## 5. Decisions needed before Phase 2

1. Which installation is Customer #1, and which root domain the SaaS uses (see §2).
2. One project per customer for now (recommended), or customers with several projects from day one?
   The model supports both; the UI is simpler with one.
3. The admin hostname (e.g. `admin.<root>`) — you will need to create its DNS record.

## 6. Related change already made (21 Oct 2026)

Nexora is the built-in product name; a fresh install's first project is "Nexora Project 1" and new
projects are offered "Nexora Project 2, 3…". Migration `20261021090000_nexora_white_label_defaults`
stores the old name for any existing install, so live installs look exactly as before (verified on
throwaway databases: existing install → "Softify Assist" kept; install with its own name → kept;
fresh install → "Nexora" / "Nexora Project 1").

---

## 7. Phase 2 — as built (21 Oct 2026, on `rudra`, not deployed)

Decisions: root domain **udboy.com**; **one project per customer**; Customer #1 = the zoventio
installation (`zoventio.udboy.com`); admin address **admin.udboy.com** (a setting, not hard-coded).

**Exclusivity (Rudra's correction, 21 Oct 2026):** `admin.udboy.com` belongs to the Main Admin only and
`zoventio.udboy.com` to Customer #1 only. An address is EITHER an admin address OR a customer address —
`classifyHost` checks the admin list first and `validateCustomerHostname` / the settings form refuse a
hostname on both lists. A customer address never opens the portal or another customer, not even for a
Main Admin; the portal is reached only through `admin.udboy.com` (or localhost / the IP, §8).

| Piece | Where |
|---|---|
| Tables `Customer`, `CustomerDomain`, `PlatformDomainSettings`; `Project.customerId` (unique, nullable); `UserSession.hostname` | migration `20261021120000_saas_customers_domains` (additive; removed Teams tables deliberately not dropped) |
| The rules: hostname format, reserved names, what a hostname opens, status flow, platform-only keys | `packages/shared/src/saasDomains.ts` (pure, unit-tested) |
| Hostname → scope, cached 10 s | `apps/web/src/server/hostScope.ts`; the proxy forwards `Host` as `x-nexora-host` (client copies discarded) |
| Project access by hostname | `decideAccess` / `accessibleProjects` in `server/projectContext.ts` |
| Portal and Workspace only on admin addresses | `requireMainAdminPage` (`server/mainAdmin.ts`), dashboard layout in workspace mode |
| Platform keys (Main Admin, Users & Permissions, release notes) removed on customer addresses | `keysOnHost` in `server/permissions.ts` — so admin Server Actions are refused there too |
| Sign-in by address | `mayUseThisAddress` in `app/(auth)/login/actions.ts` (same message as a wrong password) |
| Session bound to its address | `createSession` / `getSession` in `server/auth.ts` (older sessions, NULL, keep working) |
| Caddy's certificate question / proof a hostname reaches this app | `app/api/platform/tls-allowed`, `app/api/platform/domain-check` |
| DNS / reach / HTTPS checks with plain-language results | `server/domainVerification.ts` (network injectable for tests) |
| Actions (all need `projects.manage`, all logged to System Logs) | `server/actions/saas.ts` |
| Pages | Main Admin → **Customers** (list, add — new workspace or adopt an existing project —, customer page with addresses) and **Domains** (platform settings, routing switch, every address, the one-time Caddy setup) |

Tests: `packages/shared/src/__tests__/saasDomains.test.ts` (15) and
`apps/web/src/__tests__/saasHostRouting.integration.test.ts` (14, real sign-in/session/access
checks). Each of the five protections was removed in turn and the suite went red every time
(project access 3 failures, sign-in 4, session binding 1, platform keys 1, TLS question 2).

### Rollout runbook for zoventio (each step needs Rudra's go-ahead)

Nothing changes for anyone until step 6. Steps 1–5 can be done on any day; step 6 is the switch.

1. **Deploy** as usual (backup → pull → build app + worker + migrate → `run --rm migrate` → recreate).
   Hostname routing ships OFF: every address behaves exactly as today.
2. **Main Admin → Domains → Platform settings**: root domain `udboy.com`; admin address
   `admin.udboy.com` ONLY (never `zoventio.udboy.com` — that is Customer #1's address, and the form
   refuses it); server IP `201.18.218.251`. Leave routing OFF. Save.
3. **Main Admin → Customers → Add customer**: name it, choose **Use an existing project** → ISP Digital,
   address `zoventio.udboy.com`. Nothing in the project changes; only the link is added.
4. On the customer page press **Check now** for `zoventio.udboy.com` → expect *Live*.
5. **Caddy, one time** (needs sudo; the exact file is on the Domains page): back up
   `/etc/caddy/Caddyfile`, add the global `on_demand_tls { ask … }` block and the `https://` and
   `http://` catch-all sites, keep the existing `zoventio.udboy.com` block unchanged,
   `caddy validate`, `systemctl reload caddy`. Create the DNS A record `admin.udboy.com → 201.18.218.251`
   and open `https://admin.udboy.com` once (it gets its certificate on that first visit).
6. **Switch routing ON** from `https://admin.udboy.com` (the form refuses any other address). From then
   on `zoventio.udboy.com` opens Customer #1's workspace only (their staff keep their bookmarks and
   sign-ins; a Main Admin there sees only that workspace, no portal), `admin.udboy.com` opens the portal,
   and a new customer's address opens only that customer. Bare `udboy.com` / the IP are untouched by
   routing until they are added somewhere, so existing access keeps working during the transition.

**Rollback:** switch routing OFF on the Domains page (immediate, no restart); Caddy:
`cp Caddyfile.bak Caddyfile && systemctl reload caddy`. The migration is additive and needs no
rollback. WhatsApp sessions are not touched by any step except the deploy's normal worker restart.

### Known limits of Phase 2 (deliberate; later phases)

- Plans, subscriptions, payments, suspension by billing, owner invitations and limits: built in Phase 3 (§10).
- Absolute URLs the app builds for outside services (Google OAuth callback, Meta/Telegram webhooks)
  still use `NEXTAUTH_URL` (the platform address); those integrations keep working through it.
- Users stay platform-wide: a username is unique across all customers.

## 8. Recovery — the platform admin cannot be locked out

Three independent ways back in, from the gentlest:

1. **The form refuses the mistake.** Saving domain settings with routing ON is refused unless the
   address you are using is in the admin list — whether you are switching routing on or changing the
   admin addresses while it is on. Disabling the address you are using is refused too.
2. **The server's own address is always open.** `localhost` and IP addresses are never subject to
   routing. With SSH access: `ssh -L 8668:127.0.0.1:8668 rudra@201.18.218.251`, then open
   `http://localhost:8668/admin/domains` and fix the settings.
3. **Emergency switch, no database change.** Add `SAAS_HOST_ROUTING_DISABLED=true` to the server's
   `.env`, then `docker compose up -d --no-deps --force-recreate app` (the app only — WhatsApp
   sessions live in the worker and are not touched). Every address then behaves as before routing
   existed, and the Domains page says the switch is on. Remove it and recreate the app when fixed.
   (Last resort, needs approval: `UPDATE "PlatformDomainSettings" SET "hostRoutingEnabled" = false;`.)

All three are covered by `saasHostRouting.integration.test.ts` ("recovery" block).

---

## 9. Phase 3 — design (prepared 21 Oct 2026; built — see §10 for what was decided and shipped)

Scope: **Plans, Subscriptions, Payments, Customer limits, Suspend / Unlock**, plus the customer
owner's login (create or invite), which the onboarding needs. SaaS billing stays completely separate
from the Clients module's billing (`ClientDue`/`ClientPayment` are the customer's OWN clients).

### 9.1 Data model (additive migration; platform tables, no `projectId`)

| Table | Key columns |
|---|---|
| `Plan` | name, description, `priceMinor` (BigInt), currency, `interval` MONTH/YEAR, `trialDays`, limits: `maxWhatsAppAccounts`, `maxUsers`, `features` (keys from the existing feature catalogue), `aiEnabled`; `isActive` (archived plans stay on existing subscriptions) |
| `Subscription` | `customerId`, plan **snapshot** (name, price, interval, limits copied at assignment, so editing a plan never silently changes a paying customer), `status`, `currentPeriodStart/End`, `trialEndsAt`, `graceDays`, `suspendedAt` + reason, `manualOverride` (never auto-suspended), `notes`; one current row per customer (partial unique), old rows kept as history |
| `SubscriptionPayment` | `customerId`, `subscriptionId`, `amountMinor`, currency, method (cash / bank / bKash / Nagad / card / other), reference, `periodCoveredUntil`, `receivedAt`, `recordedBy`; reversal instead of edit (same rule as Clients payments: money rows are never rewritten) |
| `SubscriptionEvent` | append-only history: created, plan changed, renewed, extended, payment recorded/reversed, entered grace, suspended (auto/manual), unlocked, cancelled — who, when, why |
| `Project.billingHoldAt` | set while the customer's subscription holds the project; null otherwise (see 9.3) |

### 9.2 Subscription states (one pure function, `subscriptionState(sub, now)`, unit-tested)

`TRIALING` → `ACTIVE` → (period ends unpaid) `PAST_DUE` for `graceDays` → `SUSPENDED`.
`SUSPENDED` → (payment / extend / manual unlock) `ACTIVE`. `CANCELLED` at the end of the period if
the admin cancels. `manualOverride` = never moves to PAST_DUE/SUSPENDED by itself (Customer #1 and
any customer you bill by hand). A **manual suspend** works in any state, immediately.

### 9.3 Enforcement — reuse the existing SUSPENDED hold, never a second mechanism

- A billing hold sets `Project.billingHoldAt`. The three places that already decide whether a
  project acts — the worker's `activeProjectIds` / `projectIsOperating` and the web's read-only rule
  (`isReadOnlyProjectStatus` via `requireActiveProject`) — treat a held project exactly like a
  SUSPENDED one. Effect, as already built and tested for SUSPENDED: no automation, no AI, no outbound
  sends, no scanners; **incoming messages still stored**; WhatsApp sessions kept; everything readable.
- The operational status (`Project.status`) is never touched by billing, so unlocking can never
  "un-suspend" something an admin suspended for another reason, and vice versa.
- In the workspace, a held project shows a clear banner ("Your subscription needs renewal — contact
  …") on every page; the owner sees a read-only **Subscription** page (plan, period, payments).
- A worker loop (hourly) moves due subscriptions ACTIVE → PAST_DUE → SUSPENDED and records each
  event; unlocking is immediate (the admin's action clears the hold and the caches).

### 9.4 Limits

- **Features**: the plan's feature list is applied to the project's existing `ProjectFeature`
  entitlements when a plan is assigned or changed (existing enforcement in nav, pages, actions and
  the worker; nothing new to forget). AI on/off = the existing AI feature switches.
- **WhatsApp numbers / users**: checked inside the actions that create them (add account, give
  project access / create login / accept invitation), under an advisory lock so two clicks cannot
  pass a limit together. Lowering a plan deletes nothing: existing numbers and people keep working;
  new ones are refused with the reason.

### 9.5 Customer owner access

The owner is a user whose access is **only** that customer's project, made its **Lead** (existing
two-level permissions: full control of the project's own members and roles; no platform key can be
assigned to a project role — already enforced by a database CHECK). Global role: a new built-in
"Customer user" role with no platform keys. Two ways, both from the customer page:
**Create login** (temporary password, must be changed at first sign-in) or **Invite** (single-use link,
72 h, hashed in the database, opens a set-password page on the customer's own address; sent through
the existing SMTP outbox or copied by hand). Revoke access / reset password from the same page.

### 9.6 Main Admin UI

- **Plans** page: create, edit, archive; shows which customers use each plan.
- **Customer page** gains: Subscription card (status, period, days left, plan; Assign/Change plan,
  Renew, Extend by N days, Record payment, Suspend now, Unlock, Cancel), Payments history, Events
  timeline, Owner card (create login / invite / revoke).
- **Customers list** gains status and expiry columns and filters (expiring in 7 days, past due,
  suspended).
- **Add customer** becomes the guided wizard: company → address → plan and dates → owner → review.

### 9.7 Tests (throwaway database, each confirmed to fail without its protection)

State machine (pure); hold blocks sends/automation in the worker but stores incoming messages;
web read-only while held; unlock restores at once; manual override never auto-suspends; limits
refuse the N+1th number/user (including two concurrent attempts); plan change applies features;
payments never rewritten; owner sees only their project and holds no platform key; invitation is
single-use and expires.

### 9.8 Rollout safety for Customer #1

The migration adds tables and one nullable column. Customer #1 gets a **manual-override** subscription
("Manual — no expiry") when you assign one, or none at all — a customer without a subscription is
never held. Nothing is enforced against Customer #1 unless you choose to.

### 9.9 Decisions needed before building Phase 3

1. **Currency**: BDT only, or several (each plan has one currency)?
2. **Grace period** default after expiry (suggestion: 7 days)?
3. **While suspended**: read-only access + renewal banner (recommended — owner can still see data and
   messages keep being stored), or block sign-in entirely with only a renewal page?
4. **Payment methods** to list (suggestion: Cash, Bank transfer, bKash, Nagad, Card, Other)?
5. Should the **customer owner** see their subscription and payment history (recommended), and
   receive **expiry reminder emails** (needs SMTP set up in Settings → Email)?

---

## 10. Phase 3 — as built (21 Oct 2026, on `rudra`, not deployed)

Rudra's decisions: **BDT only** (the currency list is one constant, `SUPPORTED_CURRENCIES`, so adding one
is a code change, never a data migration); **grace 7 days**, configurable (Main Admin → Plans → Billing
settings, per subscription too); **suspended = read-only workspace + renewal notice**, data, WhatsApp
sessions and incoming collection kept, outbound / automation / writes stopped; **payments recorded by
hand** — bKash, Nagad, Bank transfer, Cash, Card, Other — no gateway, no card data ever stored; **the
owner** sees plan, expiry, invoices, payments and renewal status, with in-app notices and email
reminders when platform email is configured.

### 10.1 Customer #1 cannot be suspended by this phase

Three independent reasons, each tested:
1. **No subscription = never held, never limited.** The billing loop reads only customers WITH a current
   subscription; `lockAndCheckCustomerLimit` returns "no limit" without one. Customer #1 has none until
   an admin assigns one.
2. **Automatic suspension is OFF unless ticked**, per subscription (`Subscription.autoEnforce`, default
   false). With it off a lapsed subscription reads PAST_DUE and is never held, however late.
3. **The migration sets nothing.** It adds tables and the nullable `Project.billingHoldAt`; no row is
   written for any existing project or customer.

A held workspace is released at once by recording a payment, extending, Unlock, or turning automatic
suspension off.

### 10.2 What was built

| Piece | Where |
|---|---|
| Tables `PlatformBillingSettings`, `Plan`, `Subscription` (plan snapshot, one current per customer by partial unique index), `SubscriptionInvoice` (`INV-000001` from `subscription_invoice_seq`), `SubscriptionPayment` (append-only by trigger: never edited or deleted; reversed with a reason, once), `SubscriptionEvent` (history; `dedupKey` makes each reminder once), `UserInvitation` (token stored as a hash; link kept encrypted only until emailed); `Project.billingHoldAt` | migration `20261021150000_saas_billing` (additive) |
| The rules: state (`subscriptionState`), notices, which reminder is due, limits wording, money in minor units, plan input, email wording | `packages/shared/src/saasBilling.ts` (pure, unit-tested) |
| The ONE writer of the hold | `recomputeCustomerBilling` (`packages/db`) — conditional updates, each change recorded |
| Enforcement = the existing SUSPENDED rules | worker: `OPERATING_PROJECT_FILTER` / `effectiveProjectStatus` (`project/context.ts`) on every queue claim, scanner and command; web: `effectiveProject` in `decideAccess` (read-only, renewal wording from `projectReadOnlyError`) |
| Limits (WhatsApp numbers, users) under an advisory lock | `server/customerLimits.ts`, called inside the creating transaction (add account, create user, grant access, make Lead, accept invitation) |
| Admin actions (all `projects.manage`, all in the customer's history AND System Logs) | `server/actions/saasBilling.ts` |
| Billing loop (5 min): recompute holds, reminders, invitation emails | `apps/worker/src/billing/billingProcessor.ts` |
| Pages | Main Admin → **Plans** (plans + billing settings); customer page → **Subscription** (assign / change plan, record payment, issue / void invoice, extend, suspend / unlock, cancel, terms, history) and **Owner and people** (invite or create the owner); the workspace's own **Subscription** page (owner / Lead, read-only) and the renewal banner on every page |
| Owner sign-up | `/invite/<token>` — single use, 72 h, only on the customer's own address (or an open one) |

The owner is the project's **Lead with no global role**: they run their own members and roles inside
the workspace (PROJECT_ROLES.md) and can never hold a platform key.

A payment covers the next period in the cycle; when the customer is more than a period behind, the new
period starts on the day of payment, so a customer who pays is never left suspended by a period that
already ended. Reversing a payment puts the paid-through date back when that payment was what moved it.

### 10.3 Email

Only the worker sends, only when `PLATFORM_SMTP_HOST` and `PLATFORM_SMTP_FROM_ADDRESS` are set
(`.env`; see `.env.example`). This is the PLATFORM's mail account, separate from any project's
Settings → Email. Without it nothing is emailed: the reminder is still recorded and the in-app notice
still shows, and an invitation link is copied by hand. Reminders go to the customer's contact email and
its Leads, at most once per reminder day per period (7 / 3 / 1 by default), then once when payment is
due and once when suspended automatically (never for a manual suspension).

### 10.4 Tests

`packages/shared/src/__tests__/saasBilling.test.ts` (unit), `apps/web/src/__tests__/saasBilling.integration.test.ts`
(real sign-in, actions and access checks), `apps/worker/src/__tests__/saasBillingProcessor.integration.test.ts`
and the billing-hold block of `projectLifecycle.integration.test.ts`. Each protection was removed in turn
and its tests went red: the worker ignoring the hold, the web ignoring the hold, enforcement without
`autoEnforce`, the limit without its lock, reminders without dedup, the invitation email without its claim.

### 10.5 Deploying Phase 3 (needs Rudra's go-ahead)

Same as any deploy, migrate first (DEPLOY.md). Nothing changes for Customer #1 on deploy. Afterwards,
optionally: create plans, set payment instructions, add `PLATFORM_SMTP_*` to `.env` and recreate the
worker (that is a WhatsApp-session restart — choose a quiet moment). Assigning Customer #1 a plan is a
separate decision; leave "Suspend automatically" unticked until you mean it.
