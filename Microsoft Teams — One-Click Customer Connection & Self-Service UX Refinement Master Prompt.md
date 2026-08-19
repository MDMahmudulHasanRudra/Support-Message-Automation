# Microsoft Teams — One-Click Customer Connection & Self-Service UX Refinement

## Context

This repository already contains a completed P0 Microsoft Teams Integration + Unified Support Analytics implementation.

The current P0 implementation includes:

- `packages/teams-client`
- Microsoft OAuth/Graph integration
- Teams account model
- Teams/Channel/Message synchronization
- Resolution keywords/rules
- Support issues
- Resolution events
- Existing WhatsApp outbound notification integration
- Teams integration UI
- Issue management UI
- Support analytics
- Tests
- Documentation

The existing WhatsApp automation from Slice 1–3 is stable and must remain stable.

Your task now is **NOT to rebuild Teams integration**.

Your task is to deeply refine the Microsoft Teams connection experience so that a customer/admin can connect their Microsoft Teams account with the minimum possible technical friction.

The final customer experience should feel similar to:

> "Connect Microsoft Teams → Microsoft Login → Allow → Connected."

The customer should NOT need to understand Microsoft Graph, Azure App Registration, Client IDs, Client Secrets, Tenant IDs, OAuth tokens, Team IDs, Channel IDs, or API configuration.

---

# 1. PRIMARY PRODUCT GOAL

Transform the current Teams integration into a clean self-service experience.

The customer should be able to:

1. Open the application.
2. Go to Integrations.
3. Click **Connect Microsoft Teams**.
4. Be redirected to Microsoft's official authentication page.
5. Log in using their Microsoft account.
6. Complete MFA if Microsoft requires it.
7. Approve the requested permissions.
8. Automatically return to our application.
9. See that Teams is connected.
10. Automatically discover their available Teams/channels.
11. Begin using the integration.

The target experience is:

```text
Customer Dashboard
        ↓
Microsoft Teams
        ↓
[ Connect Microsoft Teams ]
        ↓
Microsoft Official Login
        ↓
Email + Password
        ↓
MFA if required
        ↓
Microsoft Consent
        ↓
Redirect back
        ↓
Automatic Discovery
        ↓
Automatic Initial Sync
        ↓
✓ Connected
```

---

# 2. CRITICAL SECURITY PRINCIPLE

The application MUST NOT collect the customer's Microsoft password.

Never create a form where the customer enters:

```text
Microsoft Email
Microsoft Password
```

inside our own application and submits those credentials to our backend.

Instead, use Microsoft's official OAuth authorization flow.

Correct architecture:

```text
Our Application
      ↓
Microsoft Authorization URL
      ↓
Microsoft Official Login
      ↓
Microsoft Authenticates User
      ↓
Microsoft Grants Authorization
      ↓
Authorization Code
      ↓
Our Callback
      ↓
Tokens
      ↓
Encrypted Server Storage
      ↓
Microsoft Graph API
```

The customer's Microsoft password must remain exclusively between the customer and Microsoft.

This is a hard security requirement.

---

# 3. DO NOT REWRITE THE EXISTING P0

Before changing anything:

Inspect the existing implementation.

Read:

- `packages/teams-client`
- OAuth routes
- callback implementation
- Teams account models
- sync worker
- Graph client
- Teams integration page
- existing environment configuration
- authentication system
- existing encryption/token-storage mechanism
- existing settings UI
- existing issue module
- existing support analytics
- tests
- `TEAMS_SETUP.md`
- `ARCHITECTURE.md`
- `README.md`
- `PROJECT_REFERENCE.md`

Understand exactly how the current implementation works.

Then improve it incrementally.

Do NOT rewrite working Teams backend logic merely to make the UI cleaner.

Do NOT modify the existing WhatsApp automation unless absolutely necessary.

---

# 4. CUSTOMER EXPERIENCE

The customer-facing UI should hide infrastructure complexity.

The customer should see something like:

```text
Microsoft Teams

Connect your Microsoft Teams account
to synchronize your support and development
conversations.

[ Connect Microsoft Teams ]
```

Clicking the button must start the official Microsoft OAuth flow.

---

# 5. MICROSOFT LOGIN

When the customer clicks:

```text
Connect Microsoft Teams
```

redirect them to Microsoft's official authentication page.

Do NOT create an embedded imitation of Microsoft's login page.

Do NOT ask for their Microsoft password.

Do NOT proxy Microsoft credentials through our backend.

Do NOT store Microsoft passwords.

Microsoft should handle:

- email
- password
- MFA
- security policies
- conditional access
- Microsoft account authentication

Our application should only handle the authorization result.

---

# 6. OAUTH FLOW

Implement or refine the OAuth flow to support:

```text
GET /integrations/microsoft-teams/connect
        ↓
Generate secure OAuth state
        ↓
Redirect to Microsoft
        ↓
User authenticates
        ↓
Microsoft redirects to callback
        ↓
Validate state
        ↓
Exchange authorization code
        ↓
Retrieve Microsoft account identity
        ↓
Encrypt/store tokens
        ↓
Create/update TeamsAccount
        ↓
Queue initial synchronization
        ↓
Redirect to Teams integration UI
```

Use secure OAuth state validation.

Protect against:

- CSRF
- replayed callback
- invalid state
- expired state
- callback for another user
- duplicate account connections

---

# 7. TOKEN SECURITY

Access tokens and refresh tokens must never be exposed to frontend JavaScript.

Never return tokens from API responses.

Never put tokens in:

- URL parameters
- browser localStorage
- frontend state
- client-side cookies unless the existing architecture explicitly requires secure HTTP-only authentication cookies

Use the existing encrypted token-storage mechanism.

If the current Teams implementation already correctly encrypts token fields, preserve that implementation.

Do not replace the existing encryption system unnecessarily.

---

# 8. CONNECTION STATE

The UI must have clear connection states.

At minimum:

```text
NOT_CONNECTED
CONNECTING
CONNECTED
SYNCING
ERROR
DISCONNECTED
REAUTH_REQUIRED
```

Use the existing enum/conventions if available.

---

# 9. NOT CONNECTED UI

Display:

```text
Microsoft Teams

Not connected

Connect your Microsoft Teams account to
synchronize Teams conversations and automate
developer resolution workflows.

[ Connect Microsoft Teams ]
```

Keep it simple.

Do not show:

- Client ID
- Tenant ID
- Client Secret
- Graph permissions
- OAuth URLs
- Technical configuration

---

# 10. CONNECTING STATE

After clicking connect, immediately show a meaningful state.

Example:

```text
Connecting to Microsoft Teams...

You will be redirected to Microsoft
to securely sign in.
```

Prevent accidental duplicate clicks.

Disable the button while the OAuth initiation request is in progress.

---

# 11. OAUTH ERROR UI

If Microsoft authentication fails:

```text
Microsoft Teams connection failed.

Your account was not connected.

[ Try Again ]
```

Provide a concise error message.

Do not expose:

- stack traces
- OAuth authorization codes
- access tokens
- internal API errors
- database errors

Log technical details server-side.

---

# 12. SUCCESS UI

After OAuth callback succeeds:

```text
✓ Microsoft Teams Connected

Account:
support@company.com

Preparing your Teams data...
```

Then show synchronization progress.

---

# 13. AUTOMATIC DISCOVERY

After successful authentication, automatically discover available Teams data through Microsoft Graph.

Do NOT ask the customer to manually enter:

- Team ID
- Channel ID
- Tenant ID
- Message ID

The backend should discover them automatically.

---

# 14. INITIAL SYNC

After account connection:

```text
OAuth success
     ↓
Teams account created
     ↓
Queue initial sync
     ↓
Discover Teams
     ↓
Discover Channels
     ↓
Store Teams/Channels
     ↓
Start message synchronization
```

Do not block the HTTP callback for a long-running full sync.

Use the existing worker/queue architecture.

---

# 15. SYNC PROGRESS UI

Show friendly progress.

Example:

```text
Microsoft Teams

✓ Account connected

Discovering your Teams...
✓ 6 Teams found

Discovering channels...
✓ 31 channels found

Synchronizing messages...
████████████░░░░ 78%

This may take a few moments.
You can leave this page open.
```

If exact progress cannot be calculated reliably, use an indeterminate progress state instead of showing fake percentages.

Never fabricate progress numbers.

---

# 16. CONNECTED STATE

After synchronization:

```text
Microsoft Teams

✓ Connected

Account
support@company.com

Teams
6

Channels
31

Messages
12,482

Last sync
Just now

[ Manage Teams ]
[ Sync Now ]
[ Disconnect ]
```

This should be the primary connected-state UI.

---

# 17. AUTOMATIC TEAM DISCOVERY

By default, discover all Teams the authenticated account is authorized to access.

Do not require manual configuration before discovery.

After discovery, allow the customer to choose which Teams are relevant to automation.

---

# 18. TEAM SELECTION

Provide a simple management interface:

```text
Manage Teams

Select the Teams used for support automation.

☑ Development Team
☑ Customer Support
☐ Management
☐ General

[ Save ]
```

Use actual discovered Teams.

Do not ask for Team IDs.

---

# 19. CHANNEL SELECTION

After Teams are selected:

```text
Channels

Development Team

☑ Bug Support
☑ Developer Issues
☐ General
☐ Announcements

Customer Support

☑ Customer Escalations
☐ General

[ Save ]
```

Again:

No IDs.

No Graph configuration.

No technical terminology.

---

# 20. DEFAULT BEHAVIOR

The first connection should require as little configuration as possible.

Recommended default:

```text
Connect
↓
Discover
↓
Show everything available
↓
Allow optional filtering
```

Do not force the user through a long setup wizard unless necessary.

---

# 21. AUTOMATION SETTINGS

After Teams connection, provide a simple automation section.

Example:

```text
Resolution Automation

When a developer replies with:

☑ Done
☑ Fixed
☑ Complete
☑ Solved
☑ Please check again

automatically process the issue according
to your support automation rules.

[ Manage Resolution Rules ]
```

Reuse the existing `TeamsResolutionKeyword` / rule system.

Do not create a duplicate keyword system.

---

# 22. RESOLUTION FLOW

Preserve the existing P0 resolution architecture.

The flow must remain:

```text
Teams Message
      ↓
Stored
      ↓
Resolution Engine
      ↓
Configured keyword matched?
      ↓
Resolution Event
      ↓
Safety checks
      ↓
Existing WhatsApp outbound queue
      ↓
Customer notification
```

Do NOT create a second WhatsApp sender.

The existing outbound queue remains the single outbound path.

---

# 23. CUSTOMER NOTIFICATION

When a valid resolution is detected:

Example:

Developer:

```text
Fixed. Please check again.
```

System:

```text
Teams message
↓
Resolution detected
↓
Issue updated
↓
Customer notification queued
↓
Existing WhatsApp sender
↓
Customer receives message
```

Preserve the existing safety checks.

Do not bypass:

- duplicate prevention
- issue status checks
- customer mapping
- automation enable/disable
- manual override
- existing WhatsApp safety rules

---

# 24. DISCONNECT

Provide:

```text
[ Disconnect ]
```

When clicked:

Confirm:

```text
Disconnect Microsoft Teams?

This will stop synchronization and
Teams-based automation for this account.

Your existing issue history will remain
available unless you explicitly choose
to remove it.

[ Cancel ] [ Disconnect ]
```

Do not silently delete historical issues/messages.

Disconnecting an account should normally stop future synchronization while preserving historical records.

---

# 25. RECONNECT

If tokens expire or authorization is revoked:

Show:

```text
Microsoft Teams needs to be reconnected.

[ Reconnect Microsoft Teams ]
```

Clicking should restart OAuth.

Do not ask for credentials inside our UI.

---

# 26. TOKEN REFRESH

The backend should automatically refresh tokens when possible.

The customer should not need to repeatedly log in.

Expected experience:

```text
Normal operation
       ↓
Access token expires
       ↓
Backend refreshes token
       ↓
Continue working
```

Only require user reauthentication if Microsoft requires it.

---

# 27. BACKGROUND SYNC

Preserve the existing polling architecture if it is already working.

The user should not have to click Sync repeatedly.

After connection:

```text
Initial Sync
     ↓
Background Incremental Sync
     ↓
New Teams Messages
     ↓
Resolution Engine
```

The UI may expose:

```text
[ Sync Now ]
```

as a manual recovery/control option.

---

# 28. SYNC HEALTH

Show:

```text
Sync status: Healthy
Last sync: 2 minutes ago
```

If failure occurs:

```text
Sync status: Needs attention

Microsoft Teams synchronization has stopped.

[ Reconnect ]
```

Do not display raw API errors to customers.

---

# 29. ADMIN VS CUSTOMER RESPONSIBILITY

Separate technical responsibilities clearly.

## Developer/Infrastructure responsibility

One-time:

- Microsoft Entra App Registration
- Redirect URI
- Required Graph permissions
- Client configuration
- Server environment variables
- Secure token encryption configuration

## Customer responsibility

Normal usage:

- Click Connect
- Microsoft Login
- MFA if required
- Approve access
- Select Teams/Channels if desired

The customer should never need to understand the infrastructure configuration.

---

# 30. DO NOT ASK CUSTOMER FOR AZURE CONFIGURATION

Never put fields like this in customer UI:

```text
Client ID
Client Secret
Tenant ID
Redirect URI
Authorization URL
Graph API URL
```

Those belong to infrastructure/admin configuration only.

---

# 31. MULTI-TENANT SAFETY

The application must correctly associate:

```text
Application User
        ↓
TeamsAccount
        ↓
Microsoft Identity
        ↓
Tenant
        ↓
Teams
```

A user must only see Teams data belonging to their authorized connected account.

Do not allow one application's user to access another user's Teams account.

---

# 32. ACCOUNT MODEL

Reuse the existing `TeamsAccount` model if it already supports this.

Ensure it can identify:

- application user/owner
- Microsoft tenant
- Microsoft user
- email/display name
- connection state
- encrypted token data
- last sync time
- created/updated timestamps

Do not duplicate the account model.

---

# 33. API DESIGN

Inspect existing routes before adding new ones.

Prefer endpoints conceptually like:

```text
GET  /integrations/microsoft-teams
GET  /integrations/microsoft-teams/connect
GET  /integrations/microsoft-teams/callback
POST /integrations/microsoft-teams/sync
POST /integrations/microsoft-teams/disconnect
GET  /integrations/microsoft-teams/teams
GET  /integrations/microsoft-teams/channels
```

Use the repository's existing route conventions.

Do not blindly create these exact routes if equivalent routes already exist.

Avoid duplicate endpoints.

---

# 34. FRONTEND STATE MANAGEMENT

Use the existing frontend data-fetching/state conventions.

Do not introduce another state-management library merely for this feature.

Connection state should update automatically after:

- OAuth success
- sync completion
- disconnect
- token error

---

# 35. UI PRINCIPLES

The Teams integration UI must be:

- simple
- clean
- understandable
- mobile-friendly if the existing dashboard supports it
- consistent with the existing design system
- free of unnecessary technical information

Use existing:

- buttons
- cards
- dialogs
- tables
- badges
- loading states
- toast/notification system

Do not introduce a completely new design system.

---

# 36. TECHNICAL DETAILS PAGE

If developers need technical configuration, keep it separate.

For example:

```text
Admin
→ System Configuration
→ Microsoft Integration
```

Customer-facing:

```text
Settings
→ Integrations
→ Microsoft Teams
```

Customer sees only the connection experience.

Developers/admins can access infrastructure diagnostics separately.

---

# 37. SECURITY TESTS

Add or update tests for:

- OAuth state generation
- OAuth state validation
- invalid state
- expired state
- duplicate callback
- token encryption
- token not returned to frontend
- unauthorized Teams access
- disconnect behavior
- reconnect behavior
- token refresh
- account isolation

---

# 38. UX TESTS

Add tests where practical for:

- Not connected state
- Connect button
- Connecting state
- OAuth success
- OAuth failure
- Sync state
- Connected state
- Disconnect confirmation
- Reconnect required
- Team selection
- Channel selection

Use the repository's existing testing strategy.

Do not introduce an entirely new testing framework.

---

# 39. REGRESSION REQUIREMENT

After implementation:

Run the entire existing suite.

The following must remain green:

```text
Existing Worker Tests
Existing Engine Tests
Existing AI Client Tests
Existing WhatsApp Tests
Existing Teams Tests
New OAuth/Connection Tests
New UI/Integration Tests
```

No test may be deleted simply to make the suite pass.

---

# 40. TYPECHECK AND BUILD

Run:

```text
pnpm typecheck
```

and the repository's complete production build.

Both must pass.

If Docker is part of the current deployment:

Build both existing images.

Verify the new Teams functionality is included.

---

# 41. DOCKER / DEPLOYMENT

Do not introduce a new service unless required.

Keep the existing deployment architecture.

Teams sync should run through the existing worker where possible.

Do not create a separate Teams worker container unless the current architecture genuinely requires it.

---

# 42. DOCUMENTATION UPDATE

Update:

- `TEAMS_SETUP.md`
- `README.md`
- `ARCHITECTURE.md`
- `PROJECT_REFERENCE.md`

Document the new simplified customer experience.

The documentation should clearly separate:

## One-time developer setup

Microsoft App Registration and environment configuration.

## Customer setup

Connect → Microsoft Login → Allow → Done.

---

# 43. DO NOT CLAIM PASSWORD LOGIN

Documentation must never say:

> "Enter your Microsoft password into our application."

Instead say:

> "Click Connect Microsoft Teams and sign in securely through Microsoft's official authentication page."

---

# 44. ERROR RECOVERY

Design clear recovery paths.

### OAuth cancelled

```text
Connection cancelled.

[ Connect Again ]
```

### Permission denied

```text
Microsoft did not grant the required permissions.

[ Try Again ]
```

### Token revoked

```text
Microsoft Teams authorization has expired.

[ Reconnect ]
```

### Graph API unavailable

```text
Microsoft Teams is temporarily unavailable.

We'll retry automatically.
```

### Sync failure

```text
Synchronization needs attention.

[ Retry Sync ]
```

---

# 45. OBSERVABILITY

Add structured logs around:

```text
Teams OAuth started
Teams OAuth callback received
Teams account connected
Teams token refreshed
Teams initial sync started
Teams initial sync completed
Teams incremental sync completed
Teams sync failed
Teams account disconnected
Teams reauthentication required
```

Never log:

- passwords
- access tokens
- refresh tokens
- client secrets

---

# 46. NO FAKE PROGRESS

Do not display:

```text
78% complete
```

unless the backend can calculate actual progress.

If exact progress is unavailable, display:

```text
Synchronizing your Teams data...
```

with an indeterminate progress indicator.

Accuracy is more important than visual polish.

---

# 47. PERFORMANCE

Initial synchronization may be large.

Do not:

- load all messages into memory
- block HTTP requests
- create N+1 Graph requests unnecessarily
- repeatedly download unchanged messages

Use:

- pagination
- incremental synchronization
- background jobs
- batching where supported
- database upserts
- existing queue infrastructure

---

# 48. GRAPH API LIMITATIONS

Do not promise that our application can access every feature visible in Microsoft Teams Web.

The available data depends on:

- Microsoft Graph APIs
- granted permissions
- tenant policies
- account type
- Microsoft licensing
- API limitations

If something is unavailable, surface it honestly.

Do not create fake data.

---

# 49. FUTURE SaaS COMPATIBILITY

Even though the current product may initially serve one organization, design the Teams account relation so that multiple application users/accounts can be supported safely later.

Do not hardcode:

```text
one global Microsoft account
```

Do not hardcode a single tenant.

The connected account should belong to the authenticated application user/organization.

---

# 50. IMPORTANT: KEEP THE CURRENT RESOLUTION SYSTEM

The Teams P0 resolution engine is already implemented.

Do not replace it.

Do not move resolution logic into the frontend.

Do not create another keyword engine.

Refine only the connection/configuration UX.

---

# 51. IMPORTANT: KEEP WHATSAPP STABLE

The WhatsApp automation from Slice 1–3 is frozen.

Do not modify it for cosmetic reasons.

If Teams needs to trigger WhatsApp notification, use the existing outbound queue.

The architecture must remain:

```text
Teams
 ↓
Resolution Engine
 ↓
Existing Automation/Event
 ↓
Existing WhatsApp Outbound Queue
 ↓
Customer
```

Never create:

```text
Teams
 ↓
New WhatsApp Sender
```

---

# 52. IMPLEMENTATION PHASES

Implement this work incrementally.

## Phase 1 — Audit

Inspect the current P0 implementation.

Document:

- OAuth flow
- account model
- routes
- token storage
- sync worker
- current UI
- current settings
- current tests

Do not modify code yet.

---

## Phase 2 — OAuth Refinement

Ensure:

- official Microsoft OAuth
- secure state
- correct callback
- token encryption
- account ownership
- refresh handling
- error handling

---

## Phase 3 — Connection UI

Build/refine:

```text
Not Connected
     ↓
Connecting
     ↓
Microsoft Login
     ↓
Connected
```

Keep it extremely simple.

---

## Phase 4 — Automatic Discovery

After connection:

- discover Teams
- discover channels
- persist data
- queue initial sync

---

## Phase 5 — Sync UX

Display:

- sync status
- last sync
- Teams count
- channel count
- message count
- errors/recovery

---

## Phase 6 — Team/Channel Management

Allow optional selection.

Do not force unnecessary configuration.

---

## Phase 7 — Resolution Settings

Reuse existing keyword/rule system.

Make it easy for admins to configure.

---

## Phase 8 — Disconnect/Reconnect

Implement safe lifecycle management.

Preserve historical records.

---

## Phase 9 — Tests

Add regression/security/UX tests.

---

## Phase 10 — Build/Deploy Verification

Run:

```text
All tests
Typecheck
Build
Docker build
Database migration verification
```

---

# 53. FINAL CUSTOMER EXPERIENCE

The finished product should feel like this:

```text
─────────────────────────────────────────
          Microsoft Teams
─────────────────────────────────────────

Connect your Microsoft Teams account.

We'll securely connect through Microsoft
and automatically discover your Teams and
channels.

          [ Connect Microsoft Teams ]
─────────────────────────────────────────
```

After click:

```text
Microsoft Official Login
        ↓
Email
        ↓
Password
        ↓
MFA
        ↓
Allow
```

Return:

```text
─────────────────────────────────────────
✓ Microsoft Teams Connected
─────────────────────────────────────────

Account
support@company.com

Teams found          6
Channels found       31
Messages synced      12,482

Sync status          Healthy
Last sync             Just now

        [ Manage Teams ]
        [ Sync Now ]
        [ Disconnect ]
─────────────────────────────────────────
```

The customer should feel:

> "I connected my Microsoft account and everything appeared automatically."

---

# 54. DEFINITION OF DONE

The implementation is complete only when:

- [ ] Customer never enters Microsoft password into our application
- [ ] Microsoft official OAuth login works
- [ ] OAuth state is secure
- [ ] OAuth callback is secure
- [ ] Tokens are encrypted
- [ ] Tokens never reach frontend
- [ ] Automatic account discovery works
- [ ] Teams are automatically discovered
- [ ] Channels are automatically discovered
- [ ] Initial synchronization runs in background
- [ ] Incremental synchronization continues automatically
- [ ] Connected state is clear
- [ ] Sync status is visible
- [ ] Customer can optionally select Teams
- [ ] Customer can optionally select Channels
- [ ] Resolution rules remain functional
- [ ] Existing Teams resolution engine remains intact
- [ ] Existing WhatsApp outbound queue remains the only outbound path
- [ ] Disconnect works
- [ ] Reconnect works
- [ ] Token refresh works
- [ ] OAuth failures are handled cleanly
- [ ] Graph failures are handled cleanly
- [ ] Account isolation is enforced
- [ ] Existing WhatsApp functionality remains untouched
- [ ] Existing Slice 1–3 tests remain green
- [ ] Existing P0 Teams tests remain green
- [ ] New OAuth tests pass
- [ ] New connection UX tests pass
- [ ] Typecheck passes
- [ ] Production build passes
- [ ] Docker build passes
- [ ] Documentation is updated

---

# 55. FINAL IMPLEMENTATION REPORT

After completing the work, report:

## Architecture

Explain the final OAuth → Graph → Teams → Resolution → WhatsApp flow.

## Customer UX

Explain exactly how a new customer connects Teams.

## Security

Explain:

- password handling
- OAuth
- token storage
- account isolation

## Backend

List modified/new modules.

## Frontend

List modified/new pages/components.

## Database

List schema/migration changes.

## Worker

List sync/authentication jobs.

## Tests

Report exact results.

## Build

Report typecheck/build/Docker results.

## Deployment

Report what was deployed or explicitly state if nothing was deployed.

## Known Limitations

List any Microsoft Graph or tenant-specific limitations honestly.

---

# FINAL COMMAND

Start now.

First inspect the current repository and existing P0 Teams implementation.

Do not ask me to manually explain code that you can inspect yourself.

Do not rebuild working functionality.

Do not collect Microsoft passwords.

Do not introduce unnecessary dependencies.

Do not modify stable WhatsApp Slice 1–3 functionality.

Refine the existing implementation incrementally.

The final customer experience must be:

**Connect Teams → Microsoft Login → Consent → Automatic Discovery → Ready.**

Make the technical complexity belong to the infrastructure/developer side, not the customer.

Proceed phase by phase, test after each meaningful change, and finish with a complete regression test, typecheck, build, and implementation report.