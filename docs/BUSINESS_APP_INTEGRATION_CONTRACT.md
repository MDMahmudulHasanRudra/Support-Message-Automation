# Business App Integration Contract

**Host contract version:** `2026-11-14.draft-1` (`BUSINESS_APP_CONTRACT_VERSION` in `packages/shared/src/businessApps.ts`).
**Commerce's own contract:** `v1`, as published by the Commerce repository in `docs/GET_ASSIST_INTEGRATION.md` and `docs/API_CONTRACT.md`. The host speaks exactly that; nothing below invents an endpoint.
**Host:** Chithii (`chithii.com`), the multi-tenant support platform.
**First app:** Commerce, an independently deployed ASP.NET Core + Next.js ERP. Education and Travel follow the same contract.
**Status of this document:** Commerce is connected for real (14 Nov 2026). Verified end to end against a running Commerce build: provisioning, the encrypted key, workspace mapping, the embedded dashboard, and live prices in the AI's grounding. Not deployed.

Every item is labelled:

| Label | Meaning |
|---|---|
| **IMPLEMENTED** | Exists in the Chithii codebase on this branch and is covered by tests. |
| **PROPOSED** | The host's proposal. Not built on either side. Open to change by agreement. |
| **WAITING FOR COMMERCE** | The host is ready; it needs something only the Commerce app can provide (an endpoint, a key, a decision). |
| **NOT SUPPORTED** | Deliberately refused, now and in this contract version. |

---

## 1. What a Business App is

- A Business App is a **separate product with its own database, its own deployment and its own users**. Chithii never reads or writes its database, and the app never reads or writes Chithii's. **IMPLEMENTED**
- It is an **optional add-on of one Chithii project**. **IMPLEMENTED**
- It is **not** a Core Module. Chithii's internal Commerce modules (`PRODUCT_CATALOG`, `ORDERS`, `SALES_PIPELINE`) are unrelated code inside Chithii and are untouched. **IMPLEMENTED**
- Chithii never runs code supplied by an app (no plugins, no uploaded scripts, no remote modules, no script injected into Chithii's origin). **NOT SUPPORTED**, by design.

## 2. The registry (host side)

`packages/shared/src/businessApps.ts`. **IMPLEMENTED**

| Key | Name | Availability | Capabilities | App contract versions the host supports |
|---|---|---|---|---|
| `commerce` | Commerce | `INSTALLABLE` | the six `commerce.*` capabilities in §7 | `v1` |
| `education` | Education | `COMING_SOON` | none yet | none |
| `travel` | Travel | `COMING_SOON` | none yet | none |

The registry holds no secret and no address. Where Commerce lives is deployment configuration (§4.1), never a row, a form or a request.

## 3. Installation lifecycle (host side)

One `ProjectAppInstallation` row per project + app (unique index). **IMPLEMENTED**

| Status | Meaning | Who moves it here |
|---|---|---|
| `PENDING` | Added to the project; connection not verified. | A Main Admin adds the app; a check answered "not available / not configured"; a Main Admin re-enables a disabled app. |
| `CONNECTING` | A connection check is running (a claim; one older than 2 minutes is abandoned). | Connect / Reconnect / Check again. |
| `ACTIVE` | Commerce answered a **verified** connection (§4.3). | Only a verified answer. A database CHECK refuses `ACTIVE` without `lastConnectedAt` and `externalWorkspaceId`. |
| `DISABLED` | Switched off by a Main Admin. Nothing reaches the app from this project. Nothing is deleted. | A Main Admin. |
| `ERROR` | The last check failed (refused key, wrong secret, contract mismatch, a different workspace, Commerce says the connection is not active…). The reason is stored as Commerce said it (≤500 characters, no token). | A failed check. |

Rules **IMPLEMENTED**: never `ACTIVE` without a verified connection (code and CHECK); enabling returns to `PENDING`; managing needs `projects.manage` in every Server Action; no call to an app inside a database transaction; a project with no add-on is created exactly as before; archived projects cannot add apps; suspended (a subscription hold reads as suspended) or archived projects cannot connect, launch or call.

## 4. Provisioning and tenant mapping (Commerce v1)

### 4.1 Configuration **IMPLEMENTED**

| Variable | Where | What |
|---|---|---|
| `COMMERCE_API_URL` | app + worker | Server-to-server base address of the Commerce API. |
| `COMMERCE_APP_URL` | app | The Commerce dashboard's origin, shown inside the workspace (§5). Must be a different origin from Chithii. |
| `COMMERCE_PROVISIONING_SECRET` | app only | The same value as Commerce's `GETASSIST_PROVISIONING_SECRET`. Never given to the worker. |
| `COMMERCE_SIGNATURE_HEADER` | app (optional) | Defaults to `X-GetAssist-Signature`, Commerce's default. |

Every address must be HTTPS, or plain HTTP on a loopback host (a developer's machine), with no credentials, query or fragment (`parseApprovedAppUrl`). Unset or invalid means Commerce cannot be connected and nothing is sent; the installation stays `PENDING` with that reason.

### 4.2 Mapping **IMPLEMENTED**

Commerce's `AppConnection` maps `(hostPlatform "Get Assist", hostCustomerId, hostProjectId)` to one Commerce tenant + workspace. The host sends:

- `hostCustomerId` = the Chithii customer id, or `founding` for the original installation's projects (they carry no customer id);
- `hostProjectId` = the Chithii project id;
- `customerName`, `projectName`, `workspaceName` (the project's name), `currency` (new workspaces only), `contractVersion: "v1"`;
- `webhookUrl: null` (§9), `externalWorkspaceReference: null` (Commerce then uses its workspace id).

Commerce's workspace id is stored as `externalWorkspaceId`, its tenant and connection ids as `externalTenantId` / `externalConnectionId`. The Commerce workspace id is never accepted as an authorization input on reads: Commerce resolves it from the key.

### 4.3 Connecting **IMPLEMENTED** (`commerceAppAdapter.verifyConnection` in `packages/db`, `connectBusinessApp` in the web app)

A Main Admin chooses, in Main Admin → Project → Business Apps → Connect:

- **Use an existing workspace**: the Commerce workspace id (from Commerce → Settings → Integration). Commerce refuses one already linked to another host project (409), or one that does not exist (404).
- **Create a new workspace**: Commerce creates a tenant, workspace, default warehouse and 0% tax rate. ⚠ Commerce v1 gives that new workspace **no user**, so nobody can sign in to it until a Commerce admin adds one (§12).

Then, in order, every step required:

1. `POST /api/v1/integrations/provision`, signed with HMAC-SHA256 over `{timestamp}.{rawBody}` (`X-GetAssist-Timestamp`, `X-GetAssist-Signature`), outside any transaction, 10 s ceiling, no redirect followed.
2. The answer's shape is checked (workspace id a UUID, status and contract version strings).
3. **The API key is encrypted and stored the moment it arrives**, before any further check, because Commerce shows it once. It is stored only as an `encryptSecret` envelope (a CHECK refuses a plaintext `cmk_…`), with its non-secret prefix as `credentialHint`. It never reaches a browser or a view.
4. Workspace: in link mode Commerce's workspace must be the one asked for; on a re-check it must be the one already stored (`WORKSPACE_MISMATCH` otherwise; the project is never re-pointed).
5. Contract: `apiContractVersion` must be one the host has an adapter for (`v1`). Checked again by the host above any adapter.
6. Status: Commerce must report the connection `Active`.
7. One authenticated read with the key (`GET /api/v1/integrations/products/search?pageSize=1`) must answer a Commerce page. This proves the key, its scope and that Commerce considers the connection active.

Only then is the installation `ACTIVE`. **Check again** repeats the same steps with the stored key (Commerce's provisioning is idempotent and returns no second key). A project that is already mapped is only ever re-checked, never re-pointed at another workspace from the host.

If the host never held the key (lost before it was stored), Commerce v1 cannot hand it over again; the host says so and stays `ERROR`. **WAITING FOR COMMERCE**: a host-authenticated key rotation endpoint.

## 5. Opening Commerce from the workspace

### 5.1 Embedded dashboard **IMPLEMENTED**

Workspace → Business Apps → Commerce (`/p/<project>/apps/commerce`) shows **Commerce's own frontend**, on Commerce's own origin, inside the Chithii shell: Chithii's sidebar, a bar with "Back to <project>", Reload and New tab, and Commerce's dashboard with its own navigation below.

- Rendered only after `authorizeBusinessAppLaunch` allows it (session, project access, project status, `ACTIVE` installation, `business_apps.open`). A refused decision renders no frame.
- `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"`, `referrerPolicy="no-referrer"`. `allow-same-origin` lets Commerce keep its own sign-in; it is safe only because the frame is another origin, so the page refuses to frame an address on Chithii's own host.
- The address carries only a path inside Commerce (`?path=`, through `safeAppPath`: absolute path only, never `//host`, a scheme or a backslash). No Chithii cookie, token, project id or user id is put in it. Chithii injects no script.
- Chithii's (report-only) CSP lists `COMMERCE_APP_URL`'s origin in `frame-src`.

### 5.2 Who the person is inside Commerce

The person signs in **inside the frame with their Commerce account**; Commerce's own roles decide what they can do there. Chithii decides only whether they may open Commerce from this project. **IMPLEMENTED**

Single sign-on (Chithii signing the person in to Commerce) is **WAITING FOR COMMERCE**: Commerce v1 answers `POST /api/v1/integrations/sso/exchange` with 501, and its OIDC design (`SSO_INTEGRATION.md` in Commerce) is not built. The host side is ready for a launch hand-off: `createLaunch` returns `{ redirectUrl, expiresAt }`, and `validateLaunchTicket` follows it only on the approved origin, secure, expiring within 5 minutes and not already expired. **IMPLEMENTED on the host**, tested with a stand-in adapter.

### 5.3 Commerce-side items for embedding **WAITING FOR COMMERCE**

- Commerce's **frontend** sends no `frame-ancestors` or `X-Frame-Options` (its `HostPlatform:AllowedParentOrigins` is applied only to API responses). It should send `frame-ancestors <Chithii origins>` on the dashboard pages too, so only Chithii can frame it.
- A workspace hint for the frame (open the mapped workspace after sign-in for a person who belongs to several) does not exist; Commerce opens whichever workspace the person last used.

## 6. Permission scopes

| Scope | Grants | Status |
|---|---|---|
| Commerce `products.read`, `offers.read`, `customers.read`, `orders.read` | The read-only key Commerce issues at provisioning. | **IMPLEMENTED** (Commerce issues these; the host uses only reads) |
| any write scope | | **NOT SUPPORTED**. Commerce v1 has none, and the host asks for none. |

Host-side keys: `business_apps.open` (open an installed app; not a `.view` key) and `projects.manage` (manage installations). **IMPLEMENTED**

## 7. Capability API (server-to-server, Commerce v1) **IMPLEMENTED**

Every call goes through **`callBusinessApp(db, projectId, appKey, capability, request)`** in `packages/db`, the only way host code reads app data. It passes the capability gate (`resolveBusinessAppCapability`: `ACTIVE` installation, project not suspended / held / archived, declared capability), then decrypts the installation's own key right before the call, then asks the adapter. A refused gate makes **no request at all** (tested).

| Capability | Commerce endpoint | Host answer |
|---|---|---|
| `commerce.searchProducts` | `GET /api/v1/integrations/products/search?q=&page=1&pageSize=` | `ProductSummary[]`: price, "was" price, in stock, units available, category, brand |
| `commerce.getProductDetails` | `GET /api/v1/integrations/products/{id}` | the summary, variants (price now and list price), the offers Commerce applies to it |
| `commerce.getCurrentPrice` | `GET /api/v1/integrations/products/{id}/pricing` | the variant's effective price |
| `commerce.checkAvailability` | `GET /api/v1/integrations/products/{id}/availability` | available / units |
| `commerce.getActiveOffers` | `GET /api/v1/integrations/offers/active` | live offers |
| `commerce.getOrderStatus` | `GET /api/v1/integrations/customers/search?q=` then `GET /api/v1/integrations/customers/{id}/orders` | the orders of the **one** Commerce customer whose stored number equals the verified number; two customers sharing it unlock nothing |

Rules: requests go only to the configured origin; no redirect followed; 10 s ceiling (a timeout is "unknown", never "none"); answers over 1 MB refused; every answer's shape checked (`CONTRACT_MISMATCH` otherwise). Commerce's decimal prices become exact integer minor units, or nothing if they cannot be represented exactly; never rounded.

## 8. AI rules **IMPLEMENTED**

Commerce data reaches the AI through the existing grounding path, `findCommerceGrounding` (`apps/worker/src/aiFallback/commerceContext.ts`, `AI_COMMERCE.md`). So the WhatsApp AI fallback, channel AI, AI Copilot and the Sandbox all get it, with no second AI path and no change to how anything is sent.

1. **The same switches.** The AI uses Commerce only while the project's AI commerce switches allow it (product answers, order answers). A connected Commerce counts as "the module is on" for them; with every switch off, Commerce is never asked anything (tested).
2. **Fresh data only.** Prices, stock and offers are read from Commerce at answer time, never cached; each entry says when it was read.
3. **Grounding, never a reply.** Commerce data becomes reference entries ("Product: …", "Your order …"). Every gate after it is unchanged: scope, confidence, the business-question guard, and the send-time safety check.
4. **Never invent a price.** The existing `UNGROUNDED_PRICE` check compares every money amount in a reply with the Commerce entries; an amount Commerce did not give hands the message to a person (verified against live Commerce data).
5. **A failure is not zero stock.** A refused, timed-out or malformed Commerce answer adds no entry; it is never "out of stock" or "none".
6. **Customer data needs a verified identity.** Order status only for a sender whose WhatsApp-delivered number (`@c.us`, never a LID, never a typed number) matches exactly one Commerce customer.
7. **No AI writes.** Buy, cancel, return or change requests hand over to a person (`COMMERCE_REQUEST`). **NOT SUPPORTED** for the AI.
8. **Disabled means silent.** A disabled installation or a held project is never asked anything (tested: zero requests).

## 9. Events and webhooks (Commerce → host)

Commerce v1 emits signed webhooks from an outbox (`commerce.product.*`, `commerce.price.changed`, `commerce.order.*`, …). The host does not receive them yet and sends `webhookUrl: null` at provisioning, so Commerce delivers nothing. **PROPOSED** for the next step: a receiver keyed by an unguessable path key per installation, verifying Commerce's signature, deduplicating on `X-Commerce-Event-Id`, recording first and processing later (the host's channel webhook pattern). The AI does not need it: it reads live data (§8).

## 10. Disable, revoke, uninstall

- **Disable on the host**: **IMPLEMENTED**. `DISABLED`; the launcher renders no frame, the sidebar hides the app, and `callBusinessApp` refuses before any request. The encrypted key is kept (unused) so re-enabling needs only a fresh check, never a one-time key Commerce cannot give again.
- **Sessions already open**: a person already signed in to Commerce in a frame or tab keeps Commerce's own session until it ends there; Chithii cannot end it. **WAITING FOR COMMERCE**: a host-authenticated disconnect / session revoke (Commerce v1's disable, reconnect and revoke need a Commerce admin's sign-in).
- **Revoking the key**: a Commerce admin can disable or revoke the connection in Commerce → Settings → Integration; the host then reads `ERROR` with Commerce's reason on its next check, and every capability call is refused by Commerce (403 `INTEGRATION_DISABLED`). Host-initiated revocation is **WAITING FOR COMMERCE**.
- **Project archive / customer removal**: launch and capabilities refused for an archived or suspended project; deleting a project removes its installation rows. **IMPLEMENTED**. Telling Commerce to retire the workspace: **PROPOSED**.
- **Uninstall**: **NOT SUPPORTED**; disable instead.

## 11. Errors **IMPLEMENTED**

| Code | Meaning | Host behaviour |
|---|---|---|
| `NOT_AVAILABLE` | No adapter, no configuration, or Commerce has provisioning off (503). | Stays `PENDING` with the reason (an `ACTIVE` one becomes `ERROR`). |
| `UNAUTHORIZED` | Commerce refused the key or the signature (401), or the host holds no key. | `ERROR`. |
| `FORBIDDEN` | Scope refused, or Commerce says the connection is not active (403 `INTEGRATION_DISABLED`), or the host's gate refused. | No retry; reported. |
| `NOT_FOUND` | | Reported as not found, never as "zero". |
| `WORKSPACE_NOT_PROVISIONED` | Re-check with no mapping. | Choose new or existing workspace. |
| `WORKSPACE_MISMATCH` | Commerce answered for another workspace than asked for or stored. | `ERROR`; nothing re-pointed. |
| `RATE_LIMITED` | 429. | Retry later. |
| `TIMEOUT` | No answer in 10 s. | Never read as empty, zero or none. |
| `UPSTREAM_ERROR` | Unreachable, 409 conflict, 400, 5xx, a redirect. | `ERROR` with Commerce's own message. |
| `CONTRACT_MISMATCH` | An unsupported contract version or a malformed answer. | Not accepted; `ERROR`. |

## 12. Known limits and Commerce-side requests

| Item | Status |
|---|---|
| SSO / identity hand-off into the frame | **WAITING FOR COMMERCE** (its SSO answers 501) |
| A newly provisioned workspace has no user, so nobody can sign in to it | **WAITING FOR COMMERCE** (membership provisioning, or SSO with membership mapping) |
| `frame-ancestors` on the Commerce dashboard itself (today any site can frame it) | **WAITING FOR COMMERCE** |
| Key rotation or re-issue to the host; host-initiated disable / revoke / session end | **WAITING FOR COMMERCE** |
| Opening the mapped workspace in the frame for a person in several workspaces | **WAITING FOR COMMERCE** |
| Customer search matches a phone as typed (`Contains`); a number stored with spaces may not be found by its digits | **WAITING FOR COMMERCE** (a normalised phone search) |
| A host webhook receiver for Commerce events | **PROPOSED** (host) |

## 13. Versioning

- Commerce's contract `v1` is stored per installation as `contractVersion` once it is verified. **IMPLEMENTED**
- An app contract version the host has no adapter for is never activated (`isSupportedAppContract`, checked in the adapter and again by the host). **IMPLEMENTED**
- Additive Commerce changes (new optional fields) keep `v1`; a removed or retyped field needs a new version and a new adapter. **PROPOSED**, as Commerce's own document states.
- This document, `businessAppContract.ts` and `commerceAppAdapter` change together.

## 14. Not in scope (this version)

**NOT SUPPORTED**: a shared database; passing Chithii cookies, tokens or user ids to the app; injecting any script into Chithii's origin; running app-supplied code; any write capability; the AI acting on an app; automatic Commerce admin rights; billing for Business Apps (the entitlement boundary is `installBusinessApp`).

## 15. Host files

| File | What |
|---|---|
| `packages/shared/src/businessApps.ts` | Registry, statuses, launch / capability / install rules, approved addresses, launch tickets, embed paths |
| `packages/shared/src/businessAppContract.ts` | Typed adapter interface and capability shapes |
| `packages/db/prisma/migrations/20261114100000_business_app_installations/` | `ProjectAppInstallation`, CHECKs, project-immutable trigger |
| `packages/db/prisma/migrations/20261114120000_business_app_credentials/` | Encrypted key, key hint, Commerce tenant / connection ids; CHECKs |
| `packages/db/src/index.ts` → `resolveBusinessAppCapability`, `commerceAppAdapter`, `callBusinessApp` | The gate, the Commerce v1 client, the one read path |
| `apps/web/src/server/businessApps.ts` | Install, connect (with the key stored first), enable/disable, launch authorization, embed address |
| `apps/web/src/server/actions/businessApps.ts` | Server Actions (each checks its own permission); connect modes; launch ticket checks |
| `apps/web/src/app/admin/projects/[id]/BusinessAppsPanel.tsx`, `ConnectAppDialog.tsx` | A project's Business Apps tab and the Connect dialog |
| `apps/web/src/app/p/[project]/(dashboard)/apps/[appKey]/EmbeddedBusinessApp.tsx` | Commerce inside the workspace |
| `apps/worker/src/aiFallback/commerceContext.ts` | Live Commerce data in the AI's grounding |
| `apps/web/src/__tests__/businessApps.integration.test.ts`, `apps/worker/src/__tests__/commerceAppGrounding.integration.test.ts`, `packages/shared/src/__tests__/businessAppConnection.test.ts` | Each rule confirmed to fail without it; a fake Commerce that follows Commerce's own code (`__tests__/helpers/fakeCommerce.ts`) |
