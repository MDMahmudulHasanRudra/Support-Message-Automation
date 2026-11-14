# Business App Integration Contract

**Contract version:** `2026-11-14.draft-1` (`BUSINESS_APP_CONTRACT_VERSION` in `packages/shared/src/businessApps.ts`)
**Host:** Chithii (`chithii.com`), the multi-tenant support platform.
**First app:** Commerce, an independently deployed ASP.NET Core ERP. Education and Travel follow the same contract.
**Status of this document:** foundation. The host side is built; the app side is not, so no live endpoint is defined anywhere.

Every item is labelled:

| Label | Meaning |
|---|---|
| **IMPLEMENTED** | Exists in the Chithii codebase on this branch and is covered by tests. |
| **PROPOSED** | The host's proposal. Not built on either side. Open to change by agreement. |
| **WAITING FOR COMMERCE** | The host is ready; it needs something only the Commerce app can provide (an endpoint, a key, a decision). |
| **NOT SUPPORTED** | Deliberately refused, now and in this contract version. |

---

## 1. What a Business App is

- A Business App is a **separate product with its own database, its own deployment and its own users**. Chithii never reads or writes its database, and the app never reads or writes Chithii's. **IMPLEMENTED** (nothing on the host shares a database; the only host table is `ProjectAppInstallation`).
- It is an **optional add-on of one Chithii project** (a project is one business's workspace inside one customer's copy of Chithii). **IMPLEMENTED**
- It is **not** a Core Module. Chithii's internal Commerce modules (`PRODUCT_CATALOG`, `ORDERS`, `SALES_PIPELINE`, the E-commerce project type) are unrelated code inside Chithii and are untouched by this contract. **IMPLEMENTED**
- Chithii never runs code supplied by an app (no plugins, no uploaded scripts, no remote modules). **NOT SUPPORTED**, by design.

## 2. The registry (host side)

`packages/shared/src/businessApps.ts`. **IMPLEMENTED**

| Key | Name | Availability | Capabilities |
|---|---|---|---|
| `commerce` | Commerce | `INSTALLABLE` | the six `commerce.*` capabilities in §7 |
| `education` | Education | `COMING_SOON` | none yet |
| `travel` | Travel | `COMING_SOON` | none yet |

The registry holds no secret and no address. Where an app is deployed is configuration agreed at provisioning (§4), never hard-coded.

## 3. Installation lifecycle (host side)

One `ProjectAppInstallation` row per project + app (unique index). **IMPLEMENTED**

| Status | Meaning | Who moves it here |
|---|---|---|
| `PENDING` | Added to the project; connection not verified. | A Main Admin adds the app (Create Project's *Business Add-ons* step or the project's *Business Apps* tab); a check answered "not available yet"; a Main Admin re-enables a disabled app. |
| `CONNECTING` | A connection check is running. A claim: two checks never run at once; a claim older than 2 minutes is treated as abandoned. | A Main Admin presses Connect / Reconnect / Check again. |
| `ACTIVE` | The app answered a **verified** connection check for this workspace. | Only a successful `verifyConnection` answer carrying the app's workspace id. A database CHECK refuses `ACTIVE` without `lastConnectedAt` and `externalWorkspaceId`. |
| `DISABLED` | Switched off by a Main Admin. Nothing reaches the app from this project. Nothing is deleted on either side. | A Main Admin. |
| `ERROR` | The last check failed for a reason other than "not available yet" (refused credentials, contract mismatch, an `ACTIVE` app that stopped answering…). The reason is stored (≤500 characters, no token, no stack trace). | A failed check. |

Rules **IMPLEMENTED**:
- Never `ACTIVE` without a verified connection (code path and database CHECK).
- Enabling a disabled app returns it to `PENDING`, never straight to `ACTIVE`.
- Adding, connecting, disabling and enabling need the host permission `projects.manage` (a Main Admin), checked in every Server Action.
- No call to an app ever runs inside a database transaction.
- A project with no add-on selected is created exactly as before; an add-on chosen at creation is added `PENDING` after the project exists, and a failure there never fails the project.
- Archived projects cannot add apps; suspended or archived projects (a subscription hold reads as suspended) cannot connect or launch apps, and their capabilities are refused.

## 4. Provisioning and tenant mapping

**PROPOSED / WAITING FOR COMMERCE**

Mapping: **one Chithii project ↔ one Commerce workspace.** Chithii identifies the project by an opaque installation id; Commerce answers with its own `externalWorkspaceId`. Neither side relies on the other's names, slugs or customer ids.

Proposed flow:
1. A Main Admin adds Commerce to a project. **IMPLEMENTED** (row `PENDING`).
2. The Chithii platform operator registers the project with Commerce out of band (or through a provisioning endpoint Commerce publishes), and Commerce issues **per-installation client credentials** for server-to-server calls. **WAITING FOR COMMERCE**: the provisioning endpoint or procedure, and the credential type (OAuth 2.0 client credentials preferred; mutual TLS acceptable).
3. Credentials are stored encrypted on the host (the existing `encryptSecret` envelope), never in `ProjectAppInstallation`, never shown after saving, never sent to a browser. **PROPOSED** (the storage column does not exist yet; it is added with the first real adapter).
4. A Main Admin presses Connect. The adapter calls Commerce's connection-check endpoint; Commerce answers `{ externalWorkspaceId, appContractVersion }`. Only then is the installation `ACTIVE`. **IMPLEMENTED on the host** (`connectBusinessApp`, `BusinessAppAdapter.verifyConnection`); **WAITING FOR COMMERCE** for the endpoint.

Today no adapter is registered, so Connect answers honestly: *"Commerce has not published its connection endpoint yet … nothing was sent anywhere"*, and the installation stays `PENDING`. **IMPLEMENTED**

## 5. Signing a person in (SSO launch)

**PROPOSED / WAITING FOR COMMERCE** (host launcher and authorization **IMPLEMENTED**)

Host side, **IMPLEMENTED**:
- The sidebar shows a **Business Apps** group only with an `ACTIVE` installation, in a project that operates, for a role holding `business_apps.open`.
- `/p/<project>/apps/<appKey>` is the launcher. `authorizeBusinessAppLaunch` decides, in order: session → project access → project status → installation (project-scoped; another project's or customer's is never found) → `business_apps.open`. Pending, disabled, error, suspended and archived each get an honest message.
- Open asks the server for a launch; the browser then makes a **top-level navigation** to the app. No iframe. No Chithii session cookie, password or long-lived token is ever passed to the app.
- A launch URL must be `https:`; anything else is refused.

Proposed protocol (OIDC-style, host as the identity provider for this hand-off only):
1. The host calls Commerce's *create launch* endpoint server-to-server with the installation credentials and a subject: `{ subject, displayName, scopes }`. `subject` is a pseudonymous, stable SHA-256 of installation id + host user id, so Commerce never learns Chithii's user ids. **IMPLEMENTED on the host** (`LaunchSubject`, hashing).
2. Commerce returns `{ redirectUrl, expiresAt }`: its own sign-in URL carrying a **single-use authorization code valid ≤ 60 seconds**. **WAITING FOR COMMERCE**
3. The browser goes to `redirectUrl`; Commerce redeems the code and starts **its own** session.
4. **Commerce decides the person's role inside Commerce.** The host's scopes say only that the person may open the app (`app.open`). The host never auto-grants Commerce admin. **PROPOSED**

Alternative (also acceptable): standard OpenID Connect authorization-code flow with PKCE where Chithii publishes a discovery document. **PROPOSED**, larger host change; not chosen for draft-1.

## 6. Permission scopes

| Scope | Meaning | Status |
|---|---|---|
| `app.open` | The person may enter the app from this workspace. Their rights inside are Commerce's. | **PROPOSED** (sent by the host launcher once an adapter exists) |
| `catalog.read` | Products, variants, prices, offers. | **PROPOSED** |
| `inventory.read` | Availability. | **PROPOSED** |
| `orders.read.verified` | One order's status, only for a verified customer identity (§8). | **PROPOSED** |
| any write scope (create order, refund, change price, change stock) | | **NOT SUPPORTED** in this contract version. |

Host-side keys, **IMPLEMENTED**: `business_apps.open` (open an installed app; not a `.view` key, so the Read Only role does not gain it by default; project roles may carry it) and `projects.manage` (manage installations).

## 7. Capability API (server-to-server)

Typed in `packages/shared/src/businessAppContract.ts`: **IMPLEMENTED as types only.** No path, method or host is defined; Commerce publishes them. **WAITING FOR COMMERCE**

Common rules **PROPOSED**:
- Every response carries `asOf` (ISO 8601, the moment the app produced it).
- Money is `{ amountMinor: string /* integer minor units */, currency: ISO 4217 }`. Never a float.
- `inStock` / `available` may be `null` meaning *the app did not say*; the host never defaults it.
- Errors use the codes in §11, never an empty success.
- The host sends `X-Contract-Version: 2026-11-14.draft-1`; the app answers with its own and refuses an incompatible major.

| Capability | Request | Response | Status |
|---|---|---|---|
| `commerce.searchProducts` | `{ query, limit }` | `{ products: ProductSummary[], truncated }` | **WAITING FOR COMMERCE** |
| `commerce.getProductDetails` | `{ productId }` | `ProductSummary & { description, variants[] }` | **WAITING FOR COMMERCE** |
| `commerce.getCurrentPrice` | `{ productId, variantId? }` | `{ price: Money, validUntil }` | **WAITING FOR COMMERCE** |
| `commerce.checkAvailability` | `{ productId, variantId?, quantity }` | `{ available, quantityAvailable \| null }` | **WAITING FOR COMMERCE** |
| `commerce.getActiveOffers` | `{ productId? }` | `{ offers[] }` | **WAITING FOR COMMERCE** |
| `commerce.getOrderStatus` | `{ orderReference, verifiedCustomer: { kind: "PHONE_E164", value } }` | `{ orderReference, status, updatedAt, trackingUrl }` | **WAITING FOR COMMERCE** |

The capability gate every host caller must pass first — `resolveBusinessAppCapability(db, projectId, appKey, capability)` in `packages/db` — is **IMPLEMENTED**: only a declared capability of an `ACTIVE` installation in a project that operates. Disabled, pending, error, not installed, suspended, billing-held or archived → no call.

## 8. AI rules

When Chithii's AI answers a customer using an app, these hold. The gate (§7) is **IMPLEMENTED**; wiring an app into the AI's grounding is **PROPOSED**, after a real adapter exists, and will reuse the existing grounding path (`findCommerceGrounding`, `AI_COMMERCE.md`) rather than a second AI path.

1. **Fresh data only.** Prices, stock and offers are fetched at answer time; an answer older than the agreed freshness window (`asOf`) is not quoted. **PROPOSED**
2. **Never invent a price.** A money amount in a reply must be one the app returned in this exchange; anything else hands over to a person (the existing `UNGROUNDED_PRICE` rule). **PROPOSED**
3. **An API failure is not zero stock.** A timeout or error is "I could not check", handed to a person — never "out of stock" or "none". **PROPOSED**
4. **Customer data needs a verified identity.** Order status only for a sender whose WhatsApp-delivered number (`@c.us`, never a LID, never a number someone typed) is the verified identity passed to the app. **PROPOSED**
5. **No AI writes.** Buy, cancel, return or change requests hand over to a person. **NOT SUPPORTED** for the AI.
6. **Disabled means silent.** A disabled installation is never asked anything (gate **IMPLEMENTED**, tested).

## 9. Events and webhooks (app → host)

**PROPOSED / WAITING FOR COMMERCE**. The host's existing signed-webhook practice (`INTEGRATION_HUB.md`) is the model.

- One endpoint per installation, keyed by an unguessable path key that selects the installation; the payload never names a Chithii project. **PROPOSED**
- **Signed**: `X-Signature: sha256=<hex HMAC of the raw body>` with a per-installation secret, plus `X-Timestamp`; the host refuses a signature older than 5 minutes. **PROPOSED**
- **Versioned**: `{ "contractVersion": "...", "type": "order.status_changed", "id": "<event id>", "occurredAt": "...", "data": { ... } }`. **PROPOSED**
- **Idempotent**: the host stores each `id` once (unique index) and ignores a replay; the app retries with backoff until a 2xx. **PROPOSED**
- **Recorded first, processed later**: the request only records the event, as the host's channel webhooks do. **PROPOSED**
- Event types for draft-1: `order.status_changed`, `product.price_changed`, `product.availability_changed`, `installation.revoked`. **PROPOSED**

## 10. Disable, revoke, uninstall

- **Disable on the host**: **IMPLEMENTED**. The installation becomes `DISABLED`; the launcher, the sidebar and the capability gate refuse at once. Nothing is deleted on either side. Re-enabling needs a fresh connection check.
- **Revoke credentials**: when an installation is disabled, the host will ask Commerce to revoke its credentials and discard its stored copy. **PROPOSED / WAITING FOR COMMERCE**
- **App-side revocation**: Commerce sends `installation.revoked`; the host marks the installation `ERROR` with the reason. **PROPOSED**
- **Project archive / customer removal**: launch and capabilities are already refused for an archived or suspended project (**IMPLEMENTED**). Deleting a project removes its installation rows with its other data (catalogue-derived deletion order, **IMPLEMENTED**). Telling Commerce to retire the workspace: **PROPOSED**.
- **Uninstall** (removing the row while keeping history elsewhere): **NOT SUPPORTED** in draft-1; disable instead.

## 11. Errors

`BusinessAppErrorCode` (**IMPLEMENTED as types**):

| Code | Meaning | Host behaviour |
|---|---|---|
| `NOT_AVAILABLE` | No adapter or endpoint exists yet. | Installation stays `PENDING` with the reason (an `ACTIVE` one becomes `ERROR`). |
| `UNAUTHORIZED` | The app refused the credentials. | `ERROR`. |
| `FORBIDDEN` | The scope does not cover the call. | No retry; reported. |
| `NOT_FOUND` | | Reported as not found, never as "zero". |
| `WORKSPACE_NOT_PROVISIONED` | | `ERROR`; provisioning needed. |
| `RATE_LIMITED` | | Retry later; never quoted as an answer. |
| `TIMEOUT` | Outcome unknown. | Never read as empty, zero or none. |
| `UPSTREAM_ERROR` | | `ERROR` on a connection check; "could not check" elsewhere. |
| `CONTRACT_MISMATCH` | Incompatible contract version, or a malformed answer (e.g. a connection answer without a workspace id). | Not accepted; `ERROR`. |

Every message shown to a Main Admin is a sentence without tokens or stack traces.

## 12. Versioning

- The contract version is a date plus a label (`2026-11-14.draft-1`). **IMPLEMENTED** (stored per installation as `contractVersion`).
- Additive changes (a new optional field, a new capability, a new event type) keep the version family; a removed or retyped field is a new version. **PROPOSED**
- The host records the contract an installation was made against and will refuse a capability call across an incompatible version (`CONTRACT_MISMATCH`). **PROPOSED**
- This document and `businessAppContract.ts` change together.

## 13. Not in scope (this version)

**NOT SUPPORTED**: a shared database; embedding the app in an iframe; passing Chithii cookies or long-lived tokens to the app; running app-supplied code in Chithii; any write capability; the AI acting on an app; automatic Commerce admin rights; billing for Business Apps (the entitlement boundary is `installBusinessApp`, where a plan check will go when apps are billed).

## 14. Host files

| File | What |
|---|---|
| `packages/shared/src/businessApps.ts` | Registry, statuses, launch / capability / install rules |
| `packages/shared/src/businessAppContract.ts` | Typed adapter interface and capability shapes |
| `packages/db/prisma/migrations/20261114100000_business_app_installations/` | `ProjectAppInstallation`, CHECKs, project-immutable trigger |
| `packages/db/src/index.ts` → `resolveBusinessAppCapability` | The capability gate |
| `apps/web/src/server/businessApps.ts` | Install, connect, enable/disable, launch authorization, adapter registry |
| `apps/web/src/server/actions/businessApps.ts` | Server Actions (each checks its own permission) |
| `apps/web/src/app/admin/business-apps/` | Main Admin → Business Apps |
| `apps/web/src/app/admin/projects/[id]/BusinessAppsPanel.tsx` | A project's Business Apps tab |
| `apps/web/src/app/admin/projects/new/CreateProjectForm.tsx` | Create Project → Business Add-ons (optional) |
| `apps/web/src/app/p/[project]/(dashboard)/apps/` | Workspace hub and launcher |
| `apps/web/src/__tests__/businessApps.integration.test.ts` | Host-side guarantees, each confirmed to fail without its rule |
