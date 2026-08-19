# Microsoft Teams Integration — Setup

This document has two audiences, kept deliberately separate: a **developer/infrastructure**
one-time setup (Azure App Registration, environment variables) and a **customer** setup that's
just three clicks. If you're the customer connecting your own Microsoft Teams account, skip
straight to [Customer setup](#customer-setup) — someone else has already done the developer part.

## One-time developer setup

This feature needs a real Azure App Registration — it cannot be pre-configured for you, since it
requires access to your organization's Microsoft Entra (Azure AD) tenant. Follow these steps once,
then fill in the four environment variables below. A customer using the integration never sees or
needs any of this.

### 1. Register an app in Azure

1. Go to [Azure Portal → Microsoft Entra ID → App registrations → New registration](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/CreateApplicationBlade).
2. Name it (e.g. "Support Automation — Teams Integration").
3. **Supported account types**: "Accounts in this organizational directory only" (single tenant) —
   this integration is designed for one connected organization, not a multi-tenant app.
4. **Redirect URI**: platform "Web", value matching `MICROSOFT_REDIRECT_URI` below exactly
   (e.g. `http://localhost:3000/api/teams/callback` for local dev, or your real domain in production).
5. Click **Register**.

### 2. Create a client secret

App registration → **Certificates & secrets** → **New client secret** → copy the **Value**
immediately (it's never shown again). This is `MICROSOFT_CLIENT_SECRET`.

### 3. Add API permissions

App registration → **API permissions** → **Add a permission** → **Microsoft Graph** →
**Delegated permissions** — add all of:

- `User.Read`
- `Team.ReadBasic.All`
- `Channel.ReadBasic.All`
- `ChannelMessage.Read.All`
- `offline_access` (usually already present by default)

Click **Grant admin consent** for your organization (requires a tenant admin) — without this, the
consent screen during connect will fail or silently omit scopes.

### 4. Collect the four values

| Env var | Where to find it |
|---|---|
| `MICROSOFT_CLIENT_ID` | App registration's **Overview** page → "Application (client) ID" |
| `MICROSOFT_CLIENT_SECRET` | The secret **Value** copied in step 2 |
| `MICROSOFT_TENANT_ID` | App registration's **Overview** page → "Directory (tenant) ID" |
| `MICROSOFT_REDIRECT_URI` | The exact redirect URI registered in step 1 |

Set these in `.env` (see `.env.example`) and restart `docker compose up -d` (or your local dev
servers) so both `app` and `worker` pick them up. Once this is done, the "Connect Microsoft Teams"
button on the Teams Integration page becomes active for every customer/admin who logs into this
dashboard — this is a one-time, per-deployment step, not something each customer repeats.

## Customer setup

Once a developer has completed the one-time setup above, connecting is three steps:

1. Go to **Teams Integration → Connection** and click **Connect Microsoft Teams**.
2. Sign in on Microsoft's own login page — enter your email, password, and complete MFA if your
   organization requires it, exactly as you would signing into Teams or Outlook directly.
3. Review and approve the requested permissions ("Allow").

You're returned to the dashboard automatically, already connected — your Teams and channels are
discovered and begin syncing right away, with no further setup required. You never need to know
what a Client ID, Tenant ID, or Graph API is.

**This application never asks for, sees, or stores your Microsoft password.** Do not say (in
support conversations or anywhere else) "enter your Microsoft password into our application" —
that flow does not exist and never will. The correct description is: *"Click Connect Microsoft
Teams and sign in securely through Microsoft's official authentication page."* Your password stays
between you and Microsoft; this application only ever receives an authorization token after you've
approved access, and that token is encrypted at rest and never sent to your browser.

### Connection states you may see

| State | What it means |
|---|---|
| Not connected | No Microsoft account linked yet |
| Connected | Working normally |
| Synchronizing… | A sync pass is actively running (briefly, after connecting or clicking Sync Now) |
| Needs attention | A sync or refresh attempt failed for a reason worth investigating (see the message shown) |
| Reconnect needed | Your Microsoft authorization was revoked or expired — click Reconnect, no data is lost |

### Managing which Teams/channels are used

By default every Team and channel your account can see is available for automation immediately —
no setup wizard required. If you want to narrow that down (e.g. exclude a "Management" or
"General" channel from being synced), use **Teams Integration → Manage Teams & Channels**. This is
entirely optional.

### Disconnecting

**Teams Integration → Connection → Disconnect** stops synchronization but keeps all your existing
Issue history and synced messages — nothing is deleted. Reconnecting later picks up where you left
off.

## What this integration does and doesn't do

- **Reads only**: joined teams, channels, and channel messages (including thread replies) — it
  never posts, edits, or deletes anything in Microsoft Teams.
- **Polling, not real-time**: the worker syncs every few minutes (configurable in Teams Integration
  → Settings), not via a live webhook subscription — that's a documented, deferred later phase.
- **Message sync is scoped**: a channel is only message-synced if it's enabled in Manage Teams &
  Channels (on by default) or has an Issue explicitly linked to it — never the whole tenant's
  history at once.
- **Customer notification is off by default**: even with resolution detection on, no WhatsApp
  message is ever sent to a customer until an admin explicitly enables "Notify the customer
  automatically" in Teams Integration → Settings — matching this app's conservative,
  anti-spam-by-default philosophy for every other automated send.
- **Token refresh is automatic**: an expiring access token is refreshed in the background; you're
  only asked to reconnect if Microsoft itself revokes or expires the underlying authorization
  (shown as "Reconnect needed"), never on a routine schedule.

## Known limitation

The real OAuth handshake and live Microsoft Graph API calls cannot be exercised in an automated
test environment without a registered Azure app and a real user consenting — this repository's
tests cover the resolution engine, idempotency, notification safety logic, and the OAuth
error-classification/state-validation logic directly (see
`apps/worker/src/__tests__/teamsResolution.integration.test.ts`,
`apps/worker/src/__tests__/teamsTokenRefresh.integration.test.ts`, and
`packages/teams-client/src/__tests__/TeamsAuthClient.test.ts`), but the actual token exchange and
Graph calls are only verified by completing the connect flow above against a real tenant.
