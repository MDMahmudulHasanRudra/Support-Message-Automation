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
