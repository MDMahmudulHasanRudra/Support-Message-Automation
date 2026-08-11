## Purpose

This document defines the mandatory engineering, UI, database, reliability,
and operational standards for this software.

These standards apply to all existing and future modules.

The goal is:

- Stable production behavior
- Simple and predictable UI
- Reliable database operations
- Safe WhatsApp automation
- Clear error handling
- No accidental duplicate actions
- Maintainable code
- Minimal unnecessary complexity

Do NOT add functionality only because it is technically possible.

Only implement functionality that has a real operational/business need.

---

# 1. Core Engineering Principles

## 1.1 Stability First

Existing working functionality must not be broken while adding new functionality.

Before modifying a module:

1. Understand the existing implementation.
2. Identify dependencies.
3. Check database relationships.
4. Check worker/background processes.
5. Check existing automation behavior.
6. Modify the smallest possible surface area.
7. Run relevant tests.
8. Verify the application still starts correctly.

Never rewrite a working module unnecessarily.

---

## 1.2 No Unnecessary Features

Do not add:

- Features without a clear operational purpose
- Duplicate functionality
- Decorative dashboards
- Excessive charts
- Complex abstractions without need
- Unused configuration
- Unnecessary database fields
- Unnecessary API endpoints

Prefer:

> Simple → Reliable → Maintainable

over:

> Complex → Feature-heavy → Difficult to maintain

---

# 2. UI Stability Standards

Every important page must properly handle:

- Loading state
- Empty state
- Error state
- Retry
- Success feedback
- Confirmation
- Disabled state
- Permission handling
- Bulk operation feedback

Never show only:

> Done

Instead show meaningful results.

Example:

```text
10 selected

8 updated successfully
1 already monitored
1 failed

[View Details]

For destructive or operationally important actions:

Are you sure?

This will disable monitoring for 10 groups.

[Cancel] [Confirm]

Buttons must be disabled while an operation is processing.

Prevent double-click and duplicate submissions.

3. UI Design Standards

The application should use a consistent desktop-first design.

Desktop

Sidebar:

240–260px

Header:

56–64px

Main content:

max-width: 1400–1600px

Page padding:

24px

Card radius:

16–20px maximum

Button height:

36–40px

Input height:

40–44px

Table row height:

48–56px

Modal width:

480–700px

Large forms:

800–1000px

Do not unnecessarily increase UI density.

The interface should remain:

Clean
Fast
Predictable
Easy to scan
Consistent across modules
4. Tables

Large datasets must not be rendered as an unlimited single table.

Use:

Server-side pagination
Search
Relevant filters
Sorting where operationally useful
Bulk selection when bulk operations are actually needed

Default page size:

50

Avoid loading thousands of records into the browser unnecessarily.

For bulk operations:

Select all visible

must be clearly different from:

Select all records

Never perform bulk actions on hidden/unselected records accidentally.

5. Database Standards

Important entities should have:

Stable primary ID
createdAt
updatedAt
Appropriate indexes
Unique constraints where required
Foreign keys where appropriate
Appropriate nullable/default handling

Use soft deletion/deactivation when historical records must be preserved.

Do not physically delete records when other records depend on their historical identity.

Example:

WhatsApp groups should be deactivated rather than deleted when the account leaves the group.

6. Database Integrity

Every important relationship must be reviewed for:

Foreign-key integrity
Unique constraints
Duplicate prevention
Null handling
Cascade behavior
Historical data preservation

For high-volume tables, indexes must be planned according to real query patterns.

Especially review:

Account ID
Group ID
WhatsApp message ID
Status
Created time
Job ID
Related message ID

Do not add indexes blindly.

7. Idempotency

Any operation that can accidentally execute more than once must be idempotent.

This applies especially to:

WhatsApp message processing
Automated replies
Group broadcasts
Queue processing
Reconnect commands
Group synchronization
Retry operations

The same WhatsApp message must never create duplicate processing records.

The same broadcast job/group combination must never accidentally send twice.

Use database constraints and application-level checks together.

8. WhatsApp Account Stability

Each WhatsApp account must have a clear lifecycle:

WAITING_FOR_QR
AUTHENTICATING
CONNECTED
DISCONNECTED
ERROR

Account information should include where available:

Phone number
Push name
Connection status
Last connection
Last heartbeat
Worker health
Session state

Important actions:

Reconnect
Resync Groups
Logout

must have:

Loading state
Disabled state
Error handling
Success feedback
9. Command Safety

Commands for the same WhatsApp account must not be allowed to create conflicting concurrent operations.

Examples:

RECONNECT
RECONNECT
RESYNC
RECONNECT

must not blindly execute back-to-back.

Account-level command coordination must prevent:

Duplicate reconnects
Concurrent reconnects
Reconnect during unstable authentication
Conflicting group sync operations

A command that is already running should not be started again unnecessarily.

10. Worker Stability

Background worker failures must not unnecessarily terminate unrelated functionality.

For example:

A group synchronization timeout must not kill:

WhatsApp connection
Heartbeat
Message listener
Queue processor
Other account processing

Long-running operations should have:

Timeout
Retry where appropriate
Backoff
Clear failure state
Logging

Do not use infinite retries.

11. Group Management

Group management must distinguish:

Active

from:

Monitored

They are NOT the same thing.

Active

The WhatsApp account is currently a member of the group.

Monitored

The administrator has selected the group for automation/monitoring.

Required functionality:

Search
Pagination
All
Monitored
Not Monitored
Active
Inactive
Individual selection
Select all visible
Bulk Monitor
Bulk Unmonitor
Group detail
Last synced
Account
WhatsApp Group ID
Participant count where available

Bulk operation feedback must clearly report the result.

12. Message Monitoring

Messages must be traceable from:

WhatsApp
↓
Provider
↓
Worker
↓
Message Pipeline
↓
Database
↓
Rule Evaluation
↓
Action
↓
Outbound Queue
↓
WhatsApp

Important message information:

Account
Group
Sender
Message body
Direction
WhatsApp message ID
Database ID
Timestamp
Rule decision
Action
Processing status

The system must prevent duplicate message processing.

13. Automation Rules

Automation rules are part of the core business logic.

Rules must have clear:

Name
Type
Match condition
Priority
Active/inactive state
Response/action
Cooldown where required

Rule evaluation must be deterministic.

The system must be able to explain:

Message
↓
Matched Rule
↓
Action

When no rule matches:

NO_MATCH

must be clearly represented.

Automation history should preserve the decision that was made.

14. Group Message Sender

Group broadcasting must use the same reliable outbound queue architecture.

Flow:

Select Account
↓
Select Groups
↓
Compose Message
↓
Preview
↓
Confirm
↓
Queue
↓
Send
↓
Result

Required safeguards:

Exact group matching
Duplicate detection
Invalid group detection
Live membership verification
Preview
Confirmation
Queue
Rate limit
Retry
Stop/Kill switch
History
Failed-only retry

Do not introduce a second independent WhatsApp sending mechanism.

All outbound messages should use the controlled outbound queue.

15. Outbound Queue

Outbound processing must be observable.

Useful states:

PENDING
PROCESSING
SENT
FAILED
SKIPPED

Important information:

Job
Account
Group
Message
Attempt count
Error
Created time
Processed time
Provider message ID

The queue must protect against:

Duplicate sending
Stuck processing states
Unlimited retries
Concurrent duplicate workers
16. Automation History

Important automation actions should be traceable.

Example:

Incoming Message
↓
Rule Evaluation
↓
Rule Matched
↓
Action Selected
↓
Outbound Message Created
↓
Queue
↓
Provider
↓
Sent / Failed

An administrator should be able to understand what happened without reading server logs.

Correlation IDs should be available for debugging.

17. Error Handling

Errors must be useful.

Bad:

Error occurred

Good:

Group membership verification failed.

The message was not sent.

[Retry]

Never silently swallow important errors.

Do not expose internal stack traces to normal users.

Detailed technical errors belong in server/worker logs.

18. Logging

Logs should answer:

What happened?
When?
For which account?
For which group?
For which message/job?
What was the result?
Why did it fail?

Use correlation IDs for multi-stage operations.

Example:

accountId:whatsappMessageId

Avoid excessive repetitive logging.

Do not log:

Passwords
Authentication secrets
Session secrets
Sensitive tokens
19. Real-Time Information

Real-time updates should only be used where they provide actual operational value.

Appropriate examples:

WhatsApp connection status
Worker health
Queue status
Broadcast progress
Critical alerts

Do not make every UI component real-time unnecessarily.

20. Performance

Prefer server-side operations for large datasets.

Avoid:

Load everything → filter in browser

Prefer:

Search/filter → database → pagination → UI

Do not repeatedly query the same large dataset without need.

Avoid expensive bulk operations inside critical WhatsApp connection paths.

21. Testing Strategy

Testing should be proportional to risk.

Do not waste excessive development time or tokens repeatedly testing unchanged functionality.

Priority:

High-risk

Test carefully:

WhatsApp connection
Message receiving
Automation
Outbound sending
Group broadcasting
Queue
Retry
Duplicate prevention
Database migrations
Lower-risk

Minimal verification is sufficient for:

Simple UI changes
Read-only pages
Static layout changes
Non-critical display changes

For real WhatsApp testing, use the designated internal test group:

Support Team Internal Discussion ( ISP Digital )

Do not use customer-facing groups for development testing.

Real WhatsApp tests should be minimal and purposeful.

22. Production Safety

Before modifying production-connected functionality:

Check current state.
Check database migration status.
Check worker health.
Check WhatsApp connection state.
Check pending commands/jobs.
Make the smallest change possible.
Rebuild/redeploy.
Verify health.
Verify the affected feature.
Check for unintended side effects.

Never perform unnecessary destructive operations.

23. Migration Standards

Database migrations must be:

Additive where possible
Backward compatible where practical
Reversible in design
Safe for existing data
Explicitly tested

Never casually delete or rename production columns.

Before destructive changes:

Confirm dependencies
Confirm historical data requirements
Confirm application usage
Back up where appropriate
24. Code Quality

Prefer:

Small focused functions
Clear names
Existing project patterns
Shared utilities where genuinely useful
Type safety
Explicit error handling

Avoid:

Giant functions
Duplicate business logic
Magic values
Unused abstractions
Dead code
Copy-pasted implementations

Do not refactor unrelated code while implementing a feature unless required for correctness.

25. Feature Development Workflow

For every new feature:

Understand
↓
Audit existing implementation
↓
Define minimum required behavior
↓
Implement
↓
Typecheck
↓
Unit/integration test
↓
Build
↓
Deploy
↓
Minimal real-world verification when required
↓
Commit

Do not start the next major module while the current module has unresolved critical issues.

26. Feature Scope Rule

Every feature must answer:

What problem does it solve?
Who uses it?
What is the minimum required behavior?
What existing functionality can be reused?
What can go wrong?
How do we prevent duplicate or destructive actions?

If a proposed feature does not provide meaningful operational value, do not add it.

27. Final Rule

The software should prioritize:

Reliability
    ↓
Correctness
    ↓
Safety
    ↓
Maintainability
    ↓
Usability
    ↓
Performance
    ↓
Visual polish

Do not sacrifice stability for unnecessary features.

Do not add complexity without a real requirement.

Keep the system simple, predictable, observable, and production-safe.