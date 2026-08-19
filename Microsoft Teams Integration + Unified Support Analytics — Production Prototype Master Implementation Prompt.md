# Microsoft Teams Integration + Unified Support Analytics
## Production Prototype — Master Implementation Prompt

You are working on an existing production-oriented WhatsApp support automation platform.

The existing WhatsApp automation has already completed Slice 1, Slice 2, and Slice 3 and is considered stable.

Your job now is **NOT to redesign or rewrite the WhatsApp automation**.

Your job is to add a new, isolated **Microsoft Teams Integration + Support Operations Analytics layer** on top of the existing system while preserving all existing WhatsApp functionality.

---

# 1. PRIMARY OBJECTIVE

Build and integrate a production-ready prototype of the following workflow:

```text
Customer
   ↓
WhatsApp Support
   ↓
Support Executive
   ↓
Issue forwarded to Microsoft Teams
   ↓
Developer / Internal Team works on issue
   ↓
Developer replies:
"Done"
"Fixed"
"Complete"
"Please check again"
etc.
   ↓
Teams Automation detects configured resolution keyword
   ↓
Existing automation/rules determine action
   ↓
Customer is automatically informed through WhatsApp
   ↓
Support activity is recorded
   ↓
Dashboard shows complete support history and team-member analytics
```

The final system should provide a unified view of:

- Customer issue
- WhatsApp conversation
- Support executive
- Teams issue/message
- Developer response
- Resolution keyword
- Resolution timestamp
- Customer notification
- Support activity
- Team member performance
- Support duration
- Issue status

---

# 2. CRITICAL SAFETY RULE

## DO NOT BREAK THE EXISTING WHATSAPP SYSTEM

The existing WhatsApp implementation from Slice 1–3 is considered stable.

Do NOT unnecessarily modify:

- WhatsApp message pipeline
- Existing AI fallback
- AI learning system
- Existing safety checks
- AI cooldown
- Human takeover
- Priority Support
- Existing escalation state machine
- Existing group automation
- Existing WhatsApp worker architecture

Only modify existing WhatsApp code where absolutely necessary to expose a clean integration point for the new Teams/support workflow.

Prefer:

```text
Existing WhatsApp Core
        ↓
Integration/Event Layer
        ↓
New Teams + Analytics Modules
```

instead of rewriting existing logic.

If you discover a potentially useful refactor, DO NOT perform it unless it is required for this feature.

---

# 3. FIRST TASK — REPOSITORY AUDIT

Before writing code:

1. Inspect the entire repository structure.
2. Read:
   - README
   - architecture documentation
   - AGENTS.md
   - package configuration
   - Prisma schema
   - existing worker architecture
   - existing WhatsApp message pipeline
   - AI modules
   - support modules
   - Priority Support
   - existing dashboard
   - authentication/authorization
   - existing settings UI
   - existing event/logging system
3. Identify:
   - backend entry points
   - worker entry points
   - frontend structure
   - database structure
   - queue system
   - Redis usage
   - existing notification mechanisms
   - existing team-member model
   - existing WhatsApp group/member mapping
4. Determine the cleanest integration points.

Do not assume the architecture from this prompt is identical to the repository.

Use the repository's actual architecture.

Before modifying anything, produce a short internal implementation plan.

Then implement.

---

# 4. ARCHITECTURAL PRINCIPLE

Create Teams as an independent integration.

Recommended conceptual structure:

```text
Integrations
├── WhatsApp
└── Microsoft Teams

Automation
├── Existing WhatsApp Rules
├── Teams Resolution Rules
└── Support Activity Rules

Analytics
├── Support Sessions
├── Team Member Metrics
├── Issue Metrics
└── Dashboard Reports
```

Teams must not become tightly coupled to the WhatsApp worker.

Use events/jobs where appropriate.

For example:

```text
Teams Message Received
        ↓
Normalize Message
        ↓
Store Message
        ↓
Resolve Thread/Issue
        ↓
Evaluate Rules
        ↓
Resolution Detected?
        ↓
Create Resolution Event
        ↓
Existing Automation Action
```

---

# 5. MICROSOFT TEAMS INTEGRATION

Implement Microsoft Teams integration using the appropriate Microsoft-supported API, preferably Microsoft Graph API.

Do NOT scrape Teams web pages.

Do NOT automate the Teams browser UI.

Use official API mechanisms.

The integration must support connecting a Microsoft account/tenant and retrieving the Teams data that the configured account is authorized to access.

---

# 6. MICROSOFT AUTHENTICATION

Implement Microsoft OAuth / Microsoft identity authentication using the repository's existing authentication conventions where possible.

The integration should support:

- Connect Microsoft account
- OAuth authorization
- Callback
- Token storage
- Token refresh
- Disconnect account
- Reconnect account
- Connection status

Never store raw OAuth secrets/tokens in plaintext database fields if the existing project has an encryption mechanism.

If encryption infrastructure does not exist, introduce a minimal secure credential-storage mechanism appropriate for the existing deployment.

Never expose access tokens to the frontend.

---

# 7. PERMISSIONS

Use the minimum Microsoft Graph permissions required.

Do not request broad permissions simply because they are convenient.

Determine the exact Graph permissions required for:

- Teams
- Channels
- Messages
- Replies
- Team members
- Message metadata

Document the required Microsoft Entra ID / Azure App Registration configuration.

If some Teams data cannot be accessed because of Microsoft Graph permission limitations, do NOT fake or simulate it.

Clearly expose the limitation.

---

# 8. TEAMS ACCOUNT MANAGEMENT

Add a Teams Integration section in the admin UI.

It should show:

```text
Microsoft Teams
────────────────────────
Status: Connected

Account:
user@example.com

Tenant:
Example Organization

Last Sync:
2026-08-19 12:30

[Sync Now]
[Disconnect]
```

If disconnected:

```text
Microsoft Teams
────────────────────────
Status: Not Connected

[Connect Microsoft Teams]
```

---

# 9. TEAMS DATA SYNC

Implement synchronization for the Teams data that the API permissions allow.

At minimum, build the architecture for:

- Teams
- Channels
- Members
- Messages
- Replies
- timestamps
- sender
- message IDs
- parent/thread relationship

Store external IDs so synchronization is idempotent.

Never create duplicate records when the same Teams message is received twice.

Use unique constraints where appropriate.

---

# 10. WEBHOOK / POLLING STRATEGY

Prefer Microsoft-supported webhook/subscription mechanisms for near-real-time message detection if practical and supported by the current application architecture.

If webhook setup is not practical for today's deployment, implement a reliable polling/sync mechanism as the initial production prototype.

Polling must:

- use incremental synchronization where possible
- store last sync state
- avoid downloading the entire history every time
- be idempotent
- handle rate limits
- retry transient failures
- log failures
- avoid duplicate processing

Design the system so webhook-based realtime synchronization can be added later without redesigning the data model.

---

# 11. DATABASE MODEL

Extend Prisma/database with appropriate models.

Do not blindly use these exact names if the repository has naming conventions, but the data model must cover the following concepts.

## TeamsAccount

Store:

- id
- provider
- tenantId
- externalUserId
- email/displayName
- connection status
- encrypted token information if required
- createdAt
- updatedAt
- lastSyncAt

## TeamsTeam

Store:

- id
- TeamsAccount relation
- externalTeamId
- name
- metadata
- createdAt
- updatedAt

## TeamsChannel

Store:

- id
- team relation
- externalChannelId
- name
- channel type
- createdAt
- updatedAt

## TeamsMessage

Store:

- id
- externalMessageId
- channel relation
- sender
- sender external ID
- message body/content
- createdAt
- updatedAt
- parentMessageId/thread relationship
- raw metadata only where necessary

Ensure external IDs are unique.

---

# 12. ISSUE TRACKING

Introduce an internal normalized concept for support issues.

The goal is to connect:

```text
Customer Issue
     ↓
WhatsApp Conversation
     ↓
Internal Support Issue
     ↓
Teams Thread
     ↓
Developer Resolution
     ↓
Customer Notification
```

Create an issue model or reuse an existing ticket/case model if one already exists.

Do NOT create a duplicate issue system if the repository already has an appropriate support-case model.

The issue should support statuses such as:

```text
OPEN
IN_PROGRESS
WAITING_DEVELOPER
RESOLUTION_DETECTED
WAITING_CUSTOMER_CHECK
RESOLVED
CLOSED
```

Use the existing project's naming conventions if different.

---

# 13. LINKING WHATSAPP AND TEAMS

Provide a clean mechanism to associate an internal issue with a Teams conversation/thread.

Example:

```text
Issue #1024

Customer:
ABC ISP

WhatsApp Group:
ABC Support

Support Executive:
Rudra

Teams:
Development Team

Teams Channel:
Bug Support

Teams Thread:
external-thread-id

Status:
WAITING_DEVELOPER
```

The relationship should be explicit.

Do not rely only on message text to maintain the relationship.

---

# 14. TEAMS RESOLUTION KEYWORDS

Create an Admin-configurable rule system.

Example categories:

### Resolution Keywords

```text
done
fixed
complete
completed
solved
resolved
please check again
check again
issue fixed
problem solved
```

The administrator must be able to:

- Add keyword
- Edit keyword
- Disable keyword
- Delete keyword
- Categorize keyword
- Enable/disable rule

Do not hardcode these values.

Provide sensible initial defaults.

---

# 15. KEYWORD MATCHING

Implement robust matching.

It should support:

- case-insensitive matching
- whitespace normalization
- punctuation normalization
- Bangla/English text where appropriate
- phrase matching
- exact/contains matching according to rule configuration

Avoid false positives.

For example, a keyword such as:

```text
done
```

should not accidentally trigger because it appears inside an unrelated word.

For important rules, prefer word-boundary or phrase-aware matching.

---

# 16. RESOLUTION EVENT

When a Teams message matches an enabled resolution rule:

Create a structured event:

```text
ResolutionDetected
```

Containing:

- issueId
- Teams message ID
- Teams channel
- sender
- matched keyword/rule
- timestamp
- confidence/match information if applicable

This event must be idempotent.

The same Teams message must not resolve the issue multiple times.

---

# 17. CUSTOMER NOTIFICATION

When a resolution event is detected:

Do NOT directly hardcode a WhatsApp send inside the Teams client.

Instead:

```text
Teams
 ↓
ResolutionDetected Event
 ↓
Automation Engine
 ↓
Existing WhatsApp Sending Mechanism
 ↓
Customer
```

Reuse the existing WhatsApp message sending infrastructure.

Example automatic customer message:

> Our development team has completed the requested fix. Please check again and let us know if the issue is still occurring.

Make the customer-facing message configurable.

Provide Admin settings for the notification template.

Support variables such as:

```text
{{customerName}}
{{issueId}}
{{executiveName}}
{{resolutionKeyword}}
```

Only expose variables that are actually available in the existing system.

---

# 18. CUSTOMER NOTIFICATION SAFETY

Before sending the automatic customer notification:

Verify:

- issue is still open
- customer mapping exists
- WhatsApp destination exists
- the resolution event has not already been processed
- the issue has not been manually closed
- automation is enabled
- the configured rule allows notification

If any required condition fails, do not send.

Record the reason.

---

# 19. MANUAL OVERRIDE

Admins/support executives must be able to:

- Disable automatic resolution notification
- Manually mark issue resolved
- Manually reopen issue
- Ignore a resolution message
- Retry customer notification

This must be auditable.

---

# 20. SUPPORT ACTIVITY ANALYTICS

Now extend the existing Support module.

The system must track support activity by team member.

Possible activity types:

```text
GROUP_SUPPORT
DM_SUPPORT
CALL_SUPPORT
MESSAGE_SUPPORT
ISSUE_HANDLING
DEVELOPER_COORDINATION
CUSTOMER_FOLLOWUP
```

Use the actual capabilities available from the existing data.

Do not invent activity duration where the system has insufficient evidence.

---

# 21. SUPPORT SESSION MODEL

Create a normalized support-session concept.

Example:

```text
SupportSession

teamMemberId
customer/group
activityType
startedAt
endedAt
durationSeconds
source
confidence
metadata
```

The `source` should identify where the evidence came from.

For example:

```text
WHATSAPP_MESSAGE
WHATSAPP_GROUP_ACTIVITY
TEAMS_MESSAGE
MANUAL
```

---

# 22. SUPPORT TIME CALCULATION

This is important.

Do NOT simply count every message as one hour of support.

Use timestamps and activity windows.

Example:

```text
10:10 Executive message
10:15 Customer reply
10:20 Executive message
10:35 Executive message
10:45 Customer reply
```

This may represent one support session rather than five separate sessions.

Implement reasonable session grouping.

For example, activity occurring within a configurable inactivity window can belong to the same session.

Make the inactivity threshold configurable.

Example default:

```text
15 minutes
```

Do not count overlapping sessions twice.

---

# 23. CALL SUPPORT

Do not claim exact call duration from a text keyword alone.

If the existing system has actual call logs/duration, use them.

If only a keyword exists such as:

```text
calling
call করছি
phone করছি
```

record this as an activity indicator, not automatically as exact call duration.

The UI should distinguish:

```text
Verified Call Duration
```

from:

```text
Estimated/Detected Call Activity
```

This is critical for trustworthy reporting.

---

# 24. MESSAGE / DM / GROUP SUPPORT

Use existing WhatsApp message metadata to classify support activity.

Possible dimensions:

```text
Group
Direct Message
Customer
Team Member
Timestamp
Message type
```

Admin-configurable keywords can assist classification.

Examples:

### Call indicators

```text
calling
call
phone
কল
ফোন
```

### DM indicators

```text
dm
inbox
personal
```

### Customer follow-up

```text
check
please check
update
follow up
```

Do not hardcode the final keyword set.

---

# 25. ADMIN CONFIGURATION

Create an easy Support Automation settings page.

Admin should be able to configure:

### Resolution Keywords

- Done
- Fixed
- Complete
- Solved
- Check again

### Support Activity Keywords

- Call
- DM
- Follow-up
- Issue
- Customer

### Session Timeout

Example:

```text
15 minutes
```

### Automation toggles

```text
Enable Teams Resolution Detection
Enable Automatic Customer Notification
Enable Support Analytics
Enable Keyword Classification
```

---

# 26. DASHBOARD

Upgrade the existing dashboard without destroying the current UI.

Keep existing cards.

Add a new section:

# Support Operations

Overall metrics:

```text
Total Issues
Open Issues
In Progress
Waiting Developer
Resolved
Closed

Total Support Hours
Total Call Activity
Total DM Support
Total Group Support
Total Customer Follow-ups
```

---

# 27. TEAM MEMBER REPORT

Add a team-member analytics section.

Example:

```text
Team Member Performance

---------------------------------------------------
Member       Groups   Issues   Support Time
---------------------------------------------------
Rudra        42       86       37h 20m
Rahim        31       61       29h 10m
Karim        27       48       22h 45m
---------------------------------------------------
```

Clicking a team member should open a detailed report.

---

# 28. INDIVIDUAL MEMBER DETAIL

Example:

```text
Rudra
Support Executive

This Month

Groups Supported:        42
Issues Handled:          86
Issues Resolved:         74

Total Support Time:      37h 20m
Group Support:           10h 20m
DM Support:              15h
Call Activity:           12h

Developer Issues:        41
Customer Follow-ups:     67
```

Below that:

```text
Recent Activity

Date        Customer       Type             Duration
------------------------------------------------------
Aug 19      ABC ISP        Group Support    42m
Aug 19      XYZ ISP        Developer        31m
Aug 18      DEF ISP        DM Support       18m
```

---

# 29. DATE FILTERS

Dashboard reports must support:

```text
Today
Yesterday
This Week
This Month
Last Month
Custom Range
```

Team member filter:

```text
All
Rudra
Rahim
Karim
...
```

Customer/group filter should be available if the existing data model supports it.

---

# 30. MONTHLY REPORT

Each team member should have a monthly summary.

Example:

```text
August 2026

Team Member: Rudra

Working/Support Days: 18

Total Groups: 42
Total Issues: 86
Resolved: 74

Group Support: 10h 20m
DM Support: 15h
Call Activity: 12h
Follow-up Activity: 8h

Total Recorded Support Activity:
37h 20m
```

Clearly label calculated/estimated metrics.

Do not present uncertain inferred data as exact fact.

---

# 31. EXPORT

If the existing application already supports reporting/export, integrate with it.

Otherwise provide a simple export capability for:

- CSV
- Excel if already supported
- JSON/API if appropriate

Do not add unnecessary export libraries unless required.

---

# 32. AUDIT LOGGING

All important automated actions must be auditable.

Examples:

```text
Teams account connected
Teams message synchronized
Resolution keyword detected
Issue linked to Teams thread
Customer notification queued
Customer notification sent
Customer notification failed
Issue manually resolved
Issue reopened
Keyword rule changed
Support activity created
```

Use the existing system logging/event architecture where possible.

Do not duplicate logging infrastructure unnecessarily.

---

# 33. QUEUES / BACKGROUND WORKERS

Do not perform long-running Teams synchronization inside HTTP request handlers.

Use the existing queue/worker infrastructure.

Recommended jobs:

```text
teams.sync
teams.message.process
teams.resolution.evaluate
support.analytics.aggregate
customer.resolution.notify
```

Use the repository's existing queue naming conventions.

Jobs must be idempotent.

---

# 34. ERROR HANDLING

Handle:

- Microsoft token expiration
- OAuth failure
- Graph API rate limits
- Network timeout
- Graph API errors
- Missing permissions
- Deleted Teams channels
- Deleted messages where applicable
- Duplicate webhook events
- Duplicate messages
- WhatsApp notification failure
- Database failures

Do not crash the main worker because Teams is temporarily unavailable.

Teams failure must be isolated.

---

# 35. RETRY POLICY

Transient failures should retry with bounded exponential backoff.

Permanent failures should be marked failed and logged.

Do not create infinite retries.

Respect Microsoft Graph rate limits.

---

# 36. UI DESIGN PRINCIPLES

The new UI must be easy for a support executive to use.

Avoid overwhelming the user with technical information.

Separate:

```text
Support
Teams
Automation
Analytics
Settings
```

Where appropriate.

The admin should not need to understand Microsoft Graph internals.

---

# 37. SUPPORT EXECUTIVE WORKFLOW

The ideal workflow should be:

```text
1. Customer reports issue
2. Executive handles customer
3. Executive creates/links internal issue
4. Issue is sent/linked to Teams
5. Developer works on it
6. Developer replies "Done / Fixed / Check again"
7. System detects resolution
8. Executive/customer is notified according to configured automation
9. Issue status updates
10. Support activity is recorded
11. Dashboard metrics update
```

Make this workflow simple.

---

# 38. DO NOT OVER-AUTOMATE

Automation must never silently make destructive decisions.

For ambiguous situations:

```text
Detect
→ Log
→ Mark for review
```

instead of:

```text
Detect
→ Automatically close everything
```

Especially for keyword-based resolution.

---

# 39. AI INTEGRATION

Do NOT replace the existing AI learning architecture.

Do NOT make Teams dependent on AI for the initial implementation.

The first production prototype should work with deterministic rules.

Later AI can enhance:

- issue classification
- developer/customer intent detection
- resolution confidence
- support activity classification
- duplicate issue detection
- automatic summaries

For this implementation:

**Rules first. AI optional.**

---

# 40. EXISTING AI LEARNING SYSTEM

The existing AI learning system should remain intact.

Where useful, Teams conversations may later become another knowledge source.

Do not automatically feed all Teams conversations into AI learning in this implementation.

Only create clean extension points.

If the existing knowledge system already supports source documents/messages, document how Teams could become a future source.

---

# 41. SECURITY

Ensure:

- OAuth tokens are protected
- Secrets are never returned to frontend
- Admin-only settings are protected
- Team member reports respect authorization
- Tenant/account data is isolated
- External IDs cannot be used to bypass authorization
- API endpoints validate ownership/access
- Webhook endpoints verify authenticity where Microsoft requires it

---

# 42. DATABASE MIGRATION

Create a proper Prisma migration.

Before migration:

- inspect existing schema
- avoid destructive changes
- do not modify existing production data
- use nullable/default values for existing rows where required

Migration must be additive unless absolutely necessary.

Test it against an isolated database.

Do not run production migration automatically during development.

---

# 43. TESTING REQUIREMENTS

At minimum add tests for:

### Teams

- OAuth state handling
- token refresh
- message synchronization
- duplicate message prevention
- thread mapping
- Teams API failure
- rate-limit handling

### Resolution

- keyword matching
- case-insensitivity
- phrase matching
- false-positive prevention
- duplicate resolution event prevention
- disabled keyword
- manual override

### WhatsApp notification

- correct customer mapping
- notification sent once
- notification failure
- already-resolved issue
- disabled automation

### Analytics

- support session creation
- session merging
- inactivity timeout
- team-member aggregation
- monthly aggregation
- group/DM classification
- call activity detection
- no duplicate duration

---

# 44. REGRESSION TEST REQUIREMENT

Before declaring completion:

Run all existing tests.

The existing WhatsApp/AI tests must remain green.

At minimum verify:

```text
Existing Worker Tests
Existing Engine Tests
AI Client Tests
New Teams Tests
New Support Analytics Tests
Typecheck
Build
```

No existing test may be removed merely to make the suite pass.

---

# 45. OBSERVABILITY

Add useful structured logs.

Example:

```text
[TEAMS_SYNC]
account=...
channel=...
messages=...

[TEAMS_RESOLUTION]
issue=...
message=...
keyword=...

[CUSTOMER_NOTIFY]
issue=...
destination=...
status=sent

[SUPPORT_SESSION]
member=...
type=GROUP_SUPPORT
duration=...
```

Never log:

- OAuth access tokens
- refresh tokens
- passwords
- sensitive secrets

---

# 46. ENVIRONMENT CONFIGURATION

Document all required environment variables.

Use clear names such as:

```text
MICROSOFT_CLIENT_ID
MICROSOFT_CLIENT_SECRET
MICROSOFT_TENANT_ID
MICROSOFT_REDIRECT_URI
```

Use the repository's existing environment naming conventions where appropriate.

Do not hardcode credentials.

---

# 47. MICROSOFT APP SETUP DOCUMENTATION

Create documentation explaining:

1. How to create Microsoft Entra App Registration
2. Where to configure redirect URI
3. Which Graph permissions are required
4. How to create/configure client secret
5. How to configure environment variables
6. How to connect the account from the dashboard
7. How to troubleshoot permission errors
8. How to configure Teams synchronization
9. How to configure resolution keywords

Do not include real credentials.

---

# 48. DEPLOYMENT

After implementation:

1. Run tests.
2. Run typecheck.
3. Run build.
4. Inspect git diff.
5. Inspect database migration.
6. Verify Docker configuration.
7. Verify production environment variables.
8. Verify worker configuration.
9. Verify frontend/backend routing.
10. Verify health checks.

Do NOT deploy destructive changes.

Do NOT restart unrelated services unnecessarily.

---

# 49. PRODUCTION SMOKE TEST

After deployment, verify:

### Existing WhatsApp

- WhatsApp connection still works
- messages still arrive
- rules still work
- AI fallback still works
- cooldown still works
- human takeover still works
- priority support still works

### Teams

- Microsoft account connects
- Teams are visible
- channels are visible
- messages synchronize
- new message processing works
- keyword detection works

### Automation

Test:

```text
Developer:
"Done, please check again."

Expected:

Teams message
→ Resolution detected
→ Issue status updated
→ Customer notification queued
→ WhatsApp notification sent
→ Audit event recorded
```

---

# 50. IMPORTANT: DO NOT FAKE FUNCTIONALITY

If Microsoft Graph does not allow a requested operation with the available permissions:

Do not create fake data.

Do not pretend synchronization is realtime.

Do not create fake call durations.

Do not report estimated support time as verified time.

Clearly distinguish:

```text
Verified
Detected
Estimated
Manual
```

---

# 51. IMPLEMENTATION STRATEGY

Implement in this order:

## Phase 1
Repository audit and architecture mapping.

## Phase 2
Database models + migration.

## Phase 3
Microsoft OAuth/account connection.

## Phase 4
Teams synchronization.

## Phase 5
Teams message/thread storage.

## Phase 6
Issue ↔ Teams linking.

## Phase 7
Resolution keyword engine.

## Phase 8
Resolution event → existing automation integration.

## Phase 9
Customer WhatsApp notification.

## Phase 10
Support activity/session engine.

## Phase 11
Support analytics aggregation.

## Phase 12
Dashboard UI.

## Phase 13
Admin settings UI.

## Phase 14
Tests.

## Phase 15
Full regression/typecheck/build.

## Phase 16
Deployment and smoke testing.

---

# 52. TIME/SCOPE PRIORITY

The goal is to make a **fully operational prototype today**, not to build every possible future feature.

Prioritize:

### P0 — Must work today

- Microsoft account connection
- Teams/channel/message access
- Message synchronization
- Resolution keyword configuration
- Resolution detection
- Issue status update
- Customer notification through existing WhatsApp infrastructure
- Basic support activity tracking
- Team-member dashboard
- Tests
- Deployment

### P1 — Implement if architecture allows without delaying P0

- Webhooks
- Advanced session grouping
- Detailed reports
- CSV export
- Advanced filters
- Rich Teams UI

### P2 — Future

- AI-powered Teams classification
- AI summaries
- AI resolution confidence
- Automatic issue creation from Teams
- Advanced productivity scoring
- Cross-channel AI knowledge learning

Do not allow P2 features to delay the operational P0 prototype.

---

# 53. CODE QUALITY

Follow the existing repository conventions.

Do not introduce unnecessary dependencies.

Do not rewrite working modules.

Prefer small, isolated modules.

Use clear types.

Avoid `any` unless unavoidable.

Use existing utilities before creating duplicates.

Use existing authentication/authorization.

Use existing logging.

Use existing queues.

Use existing notification infrastructure.

---

# 54. FINAL ACCEPTANCE CRITERIA

The feature is complete only when all of the following are true:

```text
[ ] Existing WhatsApp functionality remains intact
[ ] Existing Slice 1–3 tests remain green
[ ] Microsoft account can be connected
[ ] Teams data can be synchronized
[ ] Teams messages are stored idempotently
[ ] Threads can be associated with internal issues
[ ] Admin can configure resolution keywords
[ ] Resolution keyword can trigger an event
[ ] Duplicate resolution does not trigger duplicate notification
[ ] Existing WhatsApp sender is reused
[ ] Customer can receive automatic resolution notification
[ ] Support activity is recorded
[ ] Team member metrics are calculated
[ ] Dashboard shows overall support metrics
[ ] Dashboard shows individual team member metrics
[ ] Date filtering works
[ ] Admin can configure support keywords
[ ] Call activity is clearly distinguished from verified call duration
[ ] Audit logging exists
[ ] OAuth tokens are protected
[ ] Error handling exists
[ ] Retry handling exists
[ ] Database migration is tested
[ ] New tests pass
[ ] Full regression suite passes
[ ] Typecheck passes
[ ] Build passes
[ ] Production smoke test passes
[ ] Documentation is complete
```

---

# 55. FINAL REPORT FORMAT

At the end, provide a concise implementation report containing:

## Implemented

List the actual features implemented.

## Database Changes

List every new/modified model and migration.

## API Changes

List new endpoints/routes.

## UI Changes

List new pages/components/settings.

## Worker/Queue Changes

List new jobs/workers.

## Automation Flow

Explain:

```text
WhatsApp → Teams → Developer → Resolution → WhatsApp
```

## Analytics

Explain exactly how support time and team-member metrics are calculated.

## Tests

Report:

```text
Existing tests: X/X
New Teams tests: X/X
Analytics tests: X/X
Typecheck: PASS/FAIL
Build: PASS/FAIL
```

## Deployment

Report:

- migration status
- services restarted
- health status
- smoke test result

## Known Limitations

Be honest.

Do not claim functionality that Microsoft Graph or the current architecture does not actually support.

---

# FINAL INSTRUCTION

Treat the existing WhatsApp automation as a **stable production foundation**.

Do not destabilize it.

Build Microsoft Teams as an independent integration.

Build Support Analytics as an independent module.

Use deterministic rules first.

Keep AI as an extension point rather than making the new system dependent on AI.

The final result should allow the support team to operate this workflow:

```text
CUSTOMER
   ↓
WHATSAPP
   ↓
SUPPORT EXECUTIVE
   ↓
INTERNAL ISSUE
   ↓
MICROSOFT TEAMS
   ↓
DEVELOPER
   ↓
"DONE / FIXED / COMPLETE / CHECK AGAIN"
   ↓
AUTOMATION
   ↓
WHATSAPP CUSTOMER NOTIFICATION
   ↓
ISSUE RESOLVED
   ↓
SUPPORT ANALYTICS
   ↓
TEAM MEMBER DASHBOARD
```

The implementation must be production-minded, testable, auditable, secure, and isolated from the existing stable WhatsApp core.

Start by inspecting the repository and actual architecture. Do not ask for information that can be discovered from the codebase. Make reasonable implementation decisions based on the existing project conventions, document those decisions, and proceed.