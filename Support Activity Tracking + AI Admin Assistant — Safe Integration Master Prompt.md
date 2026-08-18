# Master Implementation Prompt
## Support Activity Tracking, Configurable Counting & AI Admin Assistant

You are working on an existing production-oriented WhatsApp Support Automation software.

Your primary requirement is:

> **Add the new Support Activity Tracking + Configurable Support Counting + AI Admin Assistant functionality WITHOUT breaking, replacing, removing, or changing any existing working functionality.**

This is an **additive feature implementation**.

Do NOT rewrite the existing architecture unnecessarily.

Do NOT replace existing modules.

Do NOT modify existing behavior unless it is absolutely required for integration and has been verified to be backward-compatible.

---

# 1. NON-NEGOTIABLE SAFETY RULE

Before changing anything:

1. Inspect the entire repository.
2. Understand the existing architecture.
3. Identify:
   - backend
   - frontend
   - Prisma schema
   - workers
   - WhatsApp/OpenWA integration
   - message ingestion pipeline
   - support/priority-support system
   - existing AI/learning system
   - accounts
   - groups
   - team members
   - authentication/authorization
   - existing APIs
   - existing background jobs
   - existing settings
   - existing audit/logging
4. Search for all existing implementations related to:
   - support
   - team members
   - groups
   - messages
   - keywords
   - priority support
   - escalation
   - AI
   - accounts
   - permissions
   - broadcast
   - admin settings

Do not assume anything.

Inspect the actual code.

Create an implementation plan based on the current repository.

---

# 2. EXISTING FUNCTIONALITY MUST REMAIN INTACT

The following existing systems must continue working exactly as before:

- WhatsApp account connection
- WhatsApp worker
- message receiving
- message processing pipeline
- group synchronization
- group message sender
- broadcast functionality
- priority support
- escalation system
- AI learning
- knowledge base
- team member management
- accounts management
- existing dashboards
- existing reports
- authentication
- authorization
- database migrations
- existing scheduled jobs
- existing queues
- existing APIs

Do not duplicate existing functionality.

If an existing function already performs part of the required work, reuse it instead of creating a second competing implementation.

---

# 3. CORE FEATURE

Create a new module:

# Support Activity Tracking

Purpose:

Automatically detect when configured support team members perform support actions inside WhatsApp groups.

The system should identify:

- WHO performed the support action
- WHICH group
- WHICH WhatsApp account
- WHICH message triggered the activity
- WHICH keyword/rule matched
- WHEN it happened
- whether it is a new support activity or duplicate activity
- how it should affect the support count according to Admin configuration

---

# 4. SUPPORT TEAM MEMBERS

The system must have a configurable list of Support Team Members.

Each member should have at minimum:

- id
- display name
- phone number
- active/inactive status
- createdAt
- updatedAt

If the existing project already has a Team Member model/table, DO NOT create a duplicate model.

Extend/reuse the existing implementation if appropriate.

A support member may be identified by:

- normalized phone number
- WhatsApp JID
- existing team-member identity mechanism

Use the project's existing identity logic where available.

Phone numbers must be normalized consistently.

Example:

```text
017xxxxxxxx
88017xxxxxxxx
+88017xxxxxxxx
```

These should not accidentally become three different people.

---

# 5. SUPPORT TRIGGER / KEYWORD SYSTEM

Admin must be able to define support keywords.

Examples:

```text
done
solved
fixed
complete
completed
problem solved
issue fixed
```

Do NOT hardcode these keywords.

Admin must be able to:

- add keyword
- edit keyword
- delete keyword
- enable/disable keyword
- view all keywords

Each keyword should optionally support:

- exact match
- contains match
- case-insensitive matching

Default behavior should be case-insensitive.

For example:

```text
Done
done
DONE
dOnE
```

should normally be treated as the same keyword when case-insensitive mode is enabled.

---

# 6. CONFIGURABLE SUPPORT RULES

Do not make the system keyword-only.

Create a flexible rule architecture.

Admin should eventually be able to configure:

### Rule Name

Example:

```text
Support Completed
```

### Team Members

```text
All Support Members
```

or selected members.

### Groups

```text
All Groups
```

or selected groups.

### Trigger Type

Initially support:

- keyword/message match

Design the architecture so future triggers can be added without rewriting the system.

Potential future triggers:

- reply to customer
- mention
- reaction
- command
- manual mark as supported
- AI classification

### Keywords

Example:

```text
done
solved
fixed
```

### Active

```text
enabled / disabled
```

---

# 7. SUPPORT COUNTING MODES

This is a critical requirement.

Admin must be able to choose how support activity is counted.

Provide at least these modes:

## Mode 1 — UNIQUE_GROUP

If the same group receives multiple support actions, count that group only once within the configured counting period.

Example:

```text
Group A

Rudra -> Done
Rahim -> Solved
Karim -> Fixed
Rudra -> Complete
```

Result:

```text
Support Count = 1
```

because all activity belongs to the same group.

---

## Mode 2 — EVERY_ACTIVITY

Every valid support action counts.

Example:

```text
Rudra -> Done      = 1
Rahim -> Solved    = 1
Karim -> Fixed     = 1
Rudra -> Complete  = 1
```

Result:

```text
Support Count = 4
```

---

## Mode 3 — PER_TEAM_MEMBER

Optional but recommended.

Each team member's support activity is counted separately.

Example:

```text
Rudra = 2
Rahim = 1
Karim = 1
```

Design the system so additional counting modes can be introduced later.

---

# 8. COUNTING PERIOD

Do NOT permanently assume that duplicate support means duplicate forever.

Support counting should support a configurable time boundary.

Admin should eventually be able to choose:

- per day
- per shift
- per session
- custom time window

For the first implementation, support:

```text
DAILY
```

and structure the code so future modes can be added.

Example:

If Group A is supported 5 times today:

```text
UNIQUE_GROUP + DAILY
= 1
```

Tomorrow:

```text
UNIQUE_GROUP + DAILY
= another 1
```

Do not allow historical records to be deleted merely because they are duplicates.

Store the actual activities separately from calculated counting.

---

# 9. IMPORTANT DATA DESIGN

Separate:

## Raw Support Activity

from:

## Aggregated Support Count

This is very important.

Never store only the final count.

We need the underlying activity history.

Example:

```text
SupportActivity

id
accountId
groupId
messageId
teamMemberId
ruleId
keywordId
messageText/reference
activityType
occurredAt
createdAt
metadata
```

Then calculate or aggregate counts from these records.

This allows future reporting and auditing.

---

# 10. IDEMPOTENCY / DUPLICATE PROTECTION

The WhatsApp message pipeline may process the same message more than once.

Therefore the Support Activity processor MUST be idempotent.

A single WhatsApp message must not accidentally generate multiple identical SupportActivity records.

Use a stable unique identifier where available, such as:

```text
accountId + messageId + ruleId
```

or another identity appropriate to the existing message model.

Inspect the current message schema before implementing this.

Do not invent duplicate IDs if the existing system already has a reliable message ID.

---

# 11. MESSAGE PIPELINE INTEGRATION

Integrate Support Activity Tracking into the existing message processing pipeline.

DO NOT create a second independent WhatsApp listener.

The preferred flow is:

```text
WhatsApp
   ↓
Existing Message Listener
   ↓
Existing Message Pipeline
   ↓
Existing Message Persistence
   ↓
Support Activity Detector
   ↓
Support Activity Record
   ↓
Counting / Aggregation
   ↓
Dashboard / Reports
```

The new detector should be isolated.

For example:

```text
support-activity.service
support-rule.service
support-count.service
support-keyword.service
```

Use the existing project conventions instead of blindly using these exact filenames.

---

# 12. DO NOT BLOCK THE MESSAGE PIPELINE

Support activity detection must not cause the WhatsApp message processor to fail.

If the support tracking feature throws an error:

```text
WhatsApp message processing MUST continue.
```

Use appropriate:

- error handling
- logging
- retry behavior where appropriate

Do not allow an analytics/reporting feature to take down the core WhatsApp worker.

---

# 13. MULTI-ACCOUNT SUPPORT

The existing system supports WhatsApp accounts.

Support activity records must be account-aware.

Never assume there is only one WhatsApp account.

Every relevant query should properly scope by:

```text
accountId
```

when required.

Do not introduce account-agnostic queries.

A group or message belonging to Account A must not accidentally affect Account B's statistics.

---

# 14. GROUP SCOPING

Support activities must identify the correct group.

The system should store/reference:

```text
groupId
accountId
```

Do not rely only on group name.

Group names can change.

Use stable WhatsApp/group identifiers wherever available.

---

# 15. DASHBOARD

Create a new admin page:

# Support Activity

Show:

### Summary

```text
Today's Support Groups
Today's Support Activities
Active Support Members
Total Supported Groups
Repeated Support Activities
```

### Team Performance

Example:

```text
Member       Unique Groups    Activities
------------------------------------------
Rudra             42              57
Rahim             31              38
Karim             25              29
```

The exact UI should follow the existing project's design system.

Do not introduce an unrelated UI style.

---

# 16. GROUP SUPPORT HISTORY

Admin should be able to inspect a group.

Example:

```text
Group: ABC ISP

Today

10:31 AM
Rudra
"Done"
Keyword: done

11:02 AM
Rahim
"Problem solved"
Keyword: solved

12:44 PM
Rudra
"Fixed"
Keyword: fixed
```

If counting mode is:

```text
UNIQUE_GROUP
```

show:

```text
Counted Support: 1
Activities: 3
```

This distinction is important.

---

# 17. TEAM MEMBER REPORT

For each support member:

Show:

- total activities
- unique groups
- daily count
- weekly count
- monthly count
- repeated support activities
- matched keywords
- supported groups

Use existing reporting/query conventions.

Avoid N+1 database queries.

Use efficient aggregation queries where possible.

---

# 18. SETTINGS PAGE

Create a Support Activity settings section.

Admin can configure:

### Support Activity

```text
Enable/Disable
```

### Counting Mode

```text
UNIQUE_GROUP
EVERY_ACTIVITY
PER_TEAM_MEMBER
```

### Counting Period

```text
DAILY
```

### Keyword Matching

```text
Case Sensitive
Case Insensitive
```

### Team Members

Manage support members.

### Keywords

Manage support keywords.

### Rules

Manage support rules.

All settings must be persisted in the database.

Do not rely only on environment variables.

---

# 19. AI ADMIN ASSISTANT

Create an Admin-only AI chat interface.

Name suggestion:

# AI Admin Assistant

This is NOT a generic chatbot.

It should operate as a controlled interface to the software.

The AI must be able to:

### Read information

Examples:

```text
How many groups were supported today?

How many groups did Rudra support today?

Show today's top 10 support members.

Which groups were supported more than once?

Show today's support activity.

How many support activities matched "done"?

Show support activity for Group ABC.
```

---

# 20. AI TOOL ARCHITECTURE

Do NOT allow the AI to directly modify the database.

Implement controlled backend tools/actions.

Example tool categories:

### Support Tools

```text
getSupportStats
getTeamMemberStats
getGroupSupportHistory
getSupportActivities
getTopSupportMembers
getRepeatedSupportGroups
```

### Configuration Tools

```text
getSupportSettings
updateSupportCountingMode
addSupportKeyword
updateSupportKeyword
deleteSupportKeyword
addSupportMember
updateSupportMember
removeSupportMember
```

### Existing Software Tools

Only expose existing functionality after inspecting the actual code.

For example:

```text
getWhatsAppAccounts
getGroups
getPriorityCases
getAISettings
getBroadcastJobs
```

Do not invent tools that the backend cannot safely execute.

---

# 21. AI WRITE ACTION SECURITY

Read-only actions can execute automatically if permitted.

Configuration changes should require appropriate permission.

Dangerous actions MUST require explicit confirmation.

Example:

Admin:

```text
Change support counting mode to EVERY_ACTIVITY.
```

AI:

```text
Current mode: UNIQUE_GROUP

New mode: EVERY_ACTIVITY

This will affect future support statistics.

Confirm?
```

Admin:

```text
Confirm
```

Then execute the action.

---

# 22. AI PERMISSION SYSTEM

The AI must respect the logged-in Admin's permissions.

Never bypass:

- authentication
- authorization
- role permissions
- account permissions
- group permissions

The AI must never grant itself permissions.

If the current admin cannot perform an action through the normal application, the AI must not perform it either.

---

# 23. AI AUDIT LOG

Every AI action that changes data must be logged.

Store:

```text
adminId
action
toolName
arguments
result
success/failure
timestamp
```

Do not store sensitive information unnecessarily.

For high-risk actions, maintain a clear audit trail.

---

# 24. AI NATURAL LANGUAGE EXAMPLES

The AI should understand Bangla, Banglish, and English where practical.

Example:

```text
আজকে কে সবচেয়ে বেশি support দিয়েছে?
```

```text
Rudra koyta group support korse?
```

```text
show me today's support report
```

```text
same group e multiple support ekta count koro
```

```text
done keyword ta add koro
```

```text
Rahim ke support team e add koro
```

The AI should map these requests to the correct backend tools.

---

# 25. AI SHOULD NOT HALLUCINATE

If the requested information is not available:

Say that the information is unavailable.

Do NOT invent:

- support counts
- group names
- team members
- keywords
- account information
- database records

All factual software information must come from actual backend tools/data.

---

# 26. EXISTING AI SYSTEM

The repository already contains AI-related functionality.

Before implementing the Admin AI:

1. Inspect the existing AI architecture.
2. Identify existing AI provider abstraction.
3. Identify existing API/model configuration.
4. Identify existing AI settings.
5. Reuse existing provider infrastructure where appropriate.
6. Do not create a second unnecessary AI provider system.

If the current AI system already supports tool calling, extend it.

If it does not, implement a clean tool/action layer.

---

# 27. UI REQUIREMENTS

Follow the existing application's:

- typography
- spacing
- colors
- components
- sidebar
- cards
- tables
- modals
- forms
- notification system

Do not redesign the entire application.

Only add the required screens/components.

Suggested navigation:

```text
Support
├── Activity
├── Team
├── Rules
├── Keywords
├── Reports
└── Settings

AI Admin
└── Assistant
```

If the existing sidebar has a Support section, integrate into it instead of creating duplicate navigation.

---

# 28. DATABASE MIGRATION SAFETY

Use proper Prisma migration practices.

Before migration:

1. Inspect existing Prisma schema.
2. Identify relationships.
3. Avoid destructive changes.
4. Do not rename/drop existing fields unless absolutely necessary.
5. Prefer additive migrations.

Never use:

```text
prisma migrate reset
```

on an existing production database.

Never delete existing production data.

After migration:

```text
prisma generate
prisma migrate deploy
```

or the project's established migration workflow.

---

# 29. BACKWARD COMPATIBILITY

Existing installations without Support Activity configuration must continue working.

Default behavior:

```text
Support Activity = disabled
```

or another safe default consistent with the existing application's behavior.

Enabling the module must be explicit.

Existing messages should continue processing normally.

---

# 30. PERFORMANCE

This system may process a large number of WhatsApp messages.

Therefore:

- do not run expensive AI processing for every message
- first perform cheap filtering
- check whether sender is a support member
- check whether the message is eligible
- then evaluate keywords/rules

Recommended conceptual flow:

```text
Incoming Message
      ↓
Is Group Message?
      ↓
Is Sender Support Member?
      ↓
Is Support Activity Enabled?
      ↓
Does Group/Rule Apply?
      ↓
Keyword Match?
      ↓
Create Activity
      ↓
Update/Calculate Count
```

Do not invoke an LLM for ordinary keyword detection.

AI classification can be added later as an optional rule.

---

# 31. INDEXING

Add appropriate database indexes for frequent queries.

Likely candidates:

```text
accountId
groupId
teamMemberId
occurredAt
ruleId
keywordId
```

Use composite indexes based on actual query patterns.

Do not blindly add excessive indexes.

---

# 32. TIMEZONE

The application appears to be used in Bangladesh.

Do not hardcode timezone logic in multiple places.

Inspect the existing application's timezone handling.

Use the existing timezone configuration.

Daily counting must respect the configured application/business timezone.

---

# 33. API DESIGN

Create clean APIs following the project's existing API conventions.

Suggested endpoints:

```text
GET    /support-activity/stats
GET    /support-activity
GET    /support-activity/groups/:groupId
GET    /support-activity/team/:teamMemberId
GET    /support-activity/reports

GET    /support-activity/settings
PATCH  /support-activity/settings

GET    /support-activity/members
POST   /support-activity/members
PATCH  /support-activity/members/:id
DELETE /support-activity/members/:id

GET    /support-activity/keywords
POST   /support-activity/keywords
PATCH  /support-activity/keywords/:id
DELETE /support-activity/keywords/:id

GET    /support-activity/rules
POST   /support-activity/rules
PATCH  /support-activity/rules/:id
DELETE /support-activity/rules/:id

POST   /ai/admin/chat
```

These are suggestions only.

Follow the project's actual API architecture.

Do not duplicate an existing endpoint.

---

# 34. TESTING REQUIREMENTS

Before declaring completion, add tests.

At minimum:

## Support Member Detection

Test:

```text
support member -> detected
normal member -> ignored
inactive support member -> ignored
```

## Keyword Detection

Test:

```text
done -> match
DONE -> match when case insensitive
solved -> match
random text -> no match
```

## Counting

Test:

```text
UNIQUE_GROUP
same group multiple activities -> 1
different groups -> multiple counts
```

Test:

```text
EVERY_ACTIVITY
4 activities -> 4
```

## Idempotency

Process the same message twice.

Expected:

```text
1 SupportActivity
```

not:

```text
2 SupportActivities
```

## Multi-account

Account A activity must not appear in Account B statistics.

## Disabled Module

When disabled:

```text
message processing continues
no support activity created
```

## AI

Test that:

- read tools return actual data
- write tools enforce permissions
- destructive actions require confirmation
- AI cannot bypass authorization
- invalid requests fail safely

---

# 35. REGRESSION TESTING

After implementation, run the existing test suite.

Do not only run tests for the new module.

Run:

```text
existing tests
new tests
type checks
lint
build
database validation
```

If the project has worker/integration tests, run those too.

The final report must clearly state:

```text
Existing tests before change:
X

Existing tests after change:
Y

New tests:
Z

Failures:
0
```

Use actual numbers from the repository.

Do not fabricate results.

---

# 36. NO SILENT BREAKING CHANGES

If an existing test fails after your changes:

Do NOT simply modify the test to make it pass.

First determine whether the implementation broke existing behavior.

Fix the implementation if necessary.

Only update an existing test if the intended behavior genuinely changed and that change was explicitly required.

---

# 37. IMPLEMENTATION PROCESS

Follow this sequence:

## Phase 1 — Audit

Inspect repository.

Do not code yet.

Identify all relevant existing functionality.

## Phase 2 — Architecture Plan

Document:

- existing relevant models
- existing message pipeline
- existing worker
- existing APIs
- existing AI infrastructure
- integration points
- new models required
- migration strategy

## Phase 3 — Database

Add only required additive schema changes.

Create migration.

## Phase 4 — Backend

Implement:

- support member handling
- keyword handling
- rules
- detector
- activity persistence
- counting service
- reporting
- settings
- APIs

## Phase 5 — Pipeline Integration

Connect the detector to the existing message pipeline safely.

Do not create another listener.

## Phase 6 — Frontend

Implement:

- dashboard
- team management
- keywords
- rules
- settings
- reports
- AI assistant

## Phase 7 — AI

Implement controlled tool/action architecture.

Connect it to the existing AI provider system where possible.

## Phase 8 — Tests

Add unit/integration tests.

Run existing regression suite.

## Phase 9 — Final Audit

Search for:

- duplicate implementations
- account-agnostic queries
- permission bypasses
- unhandled errors
- N+1 queries
- race conditions
- duplicate event processing
- unsafe migrations
- broken existing routes
- broken UI links

---

# 38. IMPORTANT: DO NOT OVERENGINEER

Do not build unnecessary features just because they may be useful later.

Implement the requested functionality cleanly.

However, the following must be architected correctly from day one:

- account isolation
- idempotency
- permissions
- audit logging
- configurable counting
- extensible rules
- backward compatibility

---

# 39. FINAL DELIVERABLE

When finished, provide a concise implementation report containing:

### Changed Files

List actual files changed.

### Database Changes

List actual models/fields/indexes/migrations.

### APIs

List actual endpoints created.

### UI

List actual pages/components.

### AI Tools

List actual tools/actions exposed to the Admin AI.

### Counting Logic

Explain exactly how:

```text
UNIQUE_GROUP
EVERY_ACTIVITY
PER_TEAM_MEMBER
```

work.

### Existing Functionality Verification

Explain which existing systems were tested.

### Test Results

Provide actual test/build/lint results.

### Potential Risks

Mention any remaining risks honestly.

---

# 40. ABSOLUTE RULE

The most important requirement of this entire task is:

> **DO NOT BREAK THE EXISTING SOFTWARE.**

Do not perform a large refactor simply to introduce this feature.

Prefer:

```text
Existing System
      +
New Support Activity Module
      +
New AI Tool Layer
```

instead of:

```text
Existing System
      ↓
Rewrite Everything
```

Reuse existing models, services, providers, APIs, workers, components, authentication, permissions, and infrastructure wherever practical.

The new feature must behave like a native extension of the existing application.

Before making any destructive or potentially breaking change, stop and inspect the dependency chain.

If there is uncertainty, choose the safest backward-compatible implementation.

Start by auditing the repository and producing the implementation plan. Do not modify code until the architecture and integration points are understood.