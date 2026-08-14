# Task: Add Priority-Based Support Monitoring & Escalation Without Breaking Existing Functionality

You are working on an existing production-ready application.

IMPORTANT:
Do NOT rewrite, replace, remove, or break any existing functionality.

The existing AI Learning & Knowledge System is already implemented. Treat the current codebase as the source of truth.

Your job is to ADD a new modular feature on top of the existing system:

## Priority-Based Support Monitoring & Escalation

Before writing code:

1. Inspect the complete existing project architecture.
2. Identify:
   - Existing client/group management
   - Existing priority system
   - Existing WhatsApp/chat integration
   - Existing support conversation/message system
   - Existing team/member system
   - Existing notification system
   - Existing AI system
   - Existing background jobs/queues
   - Existing database models
   - Existing authentication/permissions
3. Understand how these systems currently work.
4. Reuse existing services, models, APIs and notification mechanisms wherever possible.
5. Do NOT create duplicate functionality if an equivalent service already exists.
6. Do NOT modify existing behavior unless absolutely required for integration.

---

# 1. Priority Client / Group Monitoring

The system must support priority-based support monitoring.

A client or group can have a priority level.

Example:

- HIGH / P1
- MEDIUM / P2
- NORMAL / P3

The existing application's priority/group system should be reused if already available.

For high-priority clients/groups, incoming support messages must be monitored automatically.

---

# 2. Detect Unanswered Support Messages

When a customer sends a new support message:

Determine:

- Client
- Group
- Priority
- Message
- Conversation
- Assigned support team/member
- Message timestamp
- Whether a human support executive has replied

The system must distinguish between:

### AI response

and

### Human support response

An AI-generated response must NOT automatically count as human support acknowledgement unless the existing business rules explicitly define it that way.

---

# 3. Support Response Timer

For priority clients/groups, start an escalation timer when a new customer message arrives.

Example:

```text
Customer Message
       ↓
Priority Check
       ↓
High Priority?
       ↓
Start Response Timer
```

The response timer must be configurable.

Do NOT hard-code the timing values.

Example configuration:

```text
First Alert: 0 minutes
Second Alert: 5 minutes
Team Member Escalation: 10 minutes
Personal Escalation: 15 minutes
Repeated Follow-up: configurable
```

These are examples only.

The admin must be able to configure the actual values.

---

# 4. First Notification

When a high-priority customer sends a support message:

Immediately notify the appropriate support group/team using the existing notification or WhatsApp integration.

The notification should contain useful context:

- Client name
- Client/group
- Priority
- Message summary
- Message time
- Assigned member if available
- Current response status

Do not send unnecessary duplicate notifications.

---

# 5. Second Notification

If the customer still has not received a human support response after the configured first escalation interval:

Send another notification.

The notification should clearly indicate:

```text
HIGH PRIORITY SUPPORT
Customer is still waiting for a human response.
```

Include the original support context.

---

# 6. Personal Team Member Notification

If there is an assigned support executive/team member:

Send a personal notification/message to that team member.

Example meaning:

> This high-priority client is still waiting for support. Please review the conversation and respond.

Use the application's existing messaging/notification infrastructure.

Do NOT invent a completely separate messaging system if one already exists.

---

# 7. Escalate to Administrator / Owner

If the assigned team member still does not respond after the configured escalation period:

Send a personal notification to the configured administrator/owner.

This must be a direct/personal notification, not only a group notification.

The notification must contain:

- Client
- Priority
- Original message
- Waiting duration
- Assigned support member
- Number of previous notifications
- Current escalation level
- Conversation reference/link if available

---

# 8. Continuous Follow-up

The system must continue monitoring the conversation until one of these conditions occurs:

### Condition A

A human support executive replies.

Then:

```text
STOP ESCALATION
STOP TIMER
MARK SUPPORT AS ACKNOWLEDGED
```

### Condition B

The conversation is resolved/closed.

Then:

```text
STOP ESCALATION
STOP FOLLOW-UP
```

### Condition C

No human response.

Continue escalation according to the configured policy.

---

# 9. Escalation State Machine

Implement a clear state machine.

Example:

```text
NEW
 ↓
MONITORING
 ↓
TEAM_NOTIFIED
 ↓
WAITING_FOR_HUMAN
 ↓
SECOND_ALERT
 ↓
MEMBER_ESCALATED
 ↓
ADMIN_ESCALATED
 ↓
FOLLOW_UP
 ↓
HUMAN_REPLIED
 ↓
RESOLVED
```

Do not rely only on frontend timers.

The backend must be responsible for escalation state.

---

# 10. Background Jobs

Use the existing background job/queue infrastructure.

If Redis + BullMQ already exists, reuse it.

Do not create a second queue system.

The escalation worker should:

- Check pending priority conversations
- Check response deadlines
- Trigger notifications
- Update escalation state
- Schedule next follow-up
- Stop escalation when human response is detected

Jobs must be idempotent.

A job retry must NOT create duplicate notifications.

---

# 11. Duplicate Notification Protection

This is critical.

The same escalation level must not repeatedly send duplicate notifications because of:

- Worker retry
- Server restart
- Queue retry
- Browser refresh
- API retry
- Multiple workers

Track notification/escalation history.

Example:

```text
Conversation ID
Escalation Level
Notification Type
Recipient
Sent At
Status
```

Before sending a notification, check whether that escalation event has already been processed.

---

# 12. Human Reply Detection

When a support executive sends a message:

Determine whether the message qualifies as a human support response according to the existing chat architecture.

If yes:

```text
humanResponded = true
```

Then immediately stop pending escalation jobs for that conversation.

Do not send another escalation notification after the human has responded.

Handle race conditions safely.

---

# 13. Priority Configuration

Create configuration for:

```text
Priority
Response SLA
First Notification
Second Notification
Member Escalation
Admin Escalation
Follow-up Interval
Maximum Escalations
```

Do not hard-code these values.

Allow different policies for different priority levels/groups if the existing architecture supports it.

Example:

```text
P1:
Immediate
5 min
10 min
15 min

P2:
5 min
10 min
20 min

P3:
Normal monitoring
```

These values are examples only.

---

# 14. Priority Group Rule

Support should be configurable at group/client level.

For example:

```text
Group: VIP Clients
Priority: P1
Monitoring: ENABLED
Escalation: ENABLED
```

If a customer belongs to a high-priority group, apply the group's support policy.

If an individual client has a higher-specificity priority rule, use the application's existing precedence rules.

Do not create conflicting priority logic.

---

# 15. Admin Dashboard

Add a monitoring section to the existing application.

Do NOT replace the existing dashboard.

Show:

- Active priority conversations
- Waiting for human response
- First notification sent
- Escalated conversations
- Current escalation level
- Waiting duration
- Assigned member
- Last notification
- Next escalation
- Resolved conversations

Use the existing UI design system.

Do NOT create a generic AI chatbot-style dashboard.

---

# 16. Conversation Detail

For each monitored conversation, show a timeline:

```text
Customer Message
↓
Monitoring Started
↓
Team Notification
↓
Second Notification
↓
Member Notification
↓
Admin Notification
↓
Human Reply
```

Each event should show:

- Timestamp
- Event type
- Recipient
- Status

---

# 17. Manual Controls

Admin should be able to:

- Pause monitoring
- Resume monitoring
- Escalate immediately
- Assign/reassign support member
- Stop escalation
- Reset escalation
- Mark as acknowledged
- Mark as resolved

These actions must be permission-controlled and audited.

---

# 18. AI Integration

Use the existing AI system where useful.

AI may:

- Detect customer intent
- Summarize long conversations
- Determine whether the customer appears to need human support
- Generate notification summaries
- Recommend escalation
- Identify whether the customer's issue remains unresolved

But the core escalation mechanism must NOT depend entirely on an AI decision.

SLA timers and human-response detection must remain deterministic.

---

# 19. Existing AI Support Integration

The existing AI Support Executive must continue working.

The new system should work alongside it:

```text
Customer Message
      ↓
Existing AI Support
      ↓
Knowledge Retrieval
      ↓
AI Response / Human Escalation
      ↓
Priority Monitoring
      ↓
SLA Tracking
      ↓
Human Support Monitoring
```

Do not replace the existing AI Support Executive.

---

# 20. Audit Logging

Every escalation action must be logged.

Track:

```text
Conversation
Client
Priority
Escalation Level
Trigger Time
Notification Recipient
Notification Type
Notification Status
Human Response Time
Resolved Time
Triggered By
```

Use the existing audit logging system if available.

---

# 21. Security

Respect existing:

- Authentication
- RBAC
- Permissions
- Tenant isolation
- Client access rules

A team member must only receive notifications for clients/conversations they are allowed to access.

Do not expose private customer data unnecessarily.

---

# 22. Failure Handling

If notification delivery fails:

- Record failure
- Retry using existing queue/retry mechanism
- Do not create duplicate successful notifications
- Continue monitoring
- Escalate according to fallback policy

If the notification provider is unavailable, the escalation event must still be recorded.

---

# 23. Backward Compatibility

This is mandatory.

After implementation:

- Existing customer support must work.
- Existing WhatsApp integration must work.
- Existing AI Learning must work.
- Existing AI Support must work.
- Existing automation must work.
- Existing notification system must work.
- Existing dashboards must work.
- Existing database functionality must work.

When AI or escalation features are disabled:

THE EXISTING APPLICATION MUST CONTINUE TO WORK EXACTLY AS BEFORE.

---

# 24. Implementation Process

Do NOT immediately start modifying files.

First provide:

### A. Existing Architecture Summary

Identify the actual current:

- Frontend
- Backend
- Database
- WhatsApp integration
- Chat system
- Notification system
- AI system
- Queue system
- Authentication
- Relevant modules

### B. Existing Files/Modules To Reuse

List the actual files/services/modules that should be reused.

### C. Integration Plan

Show exactly where the new feature will connect to the existing system.

### D. Database Changes

Show only the new tables/fields/indexes that are actually required.

### E. Risk Analysis

Identify anything that could potentially break existing functionality.

DO NOT implement until this inspection and plan are complete.

After the plan is reviewed, implement the feature incrementally.

---

# Final Rule

The current application is already functional.

You are NOT building a new application.

You are adding:

**Priority-Based Support Monitoring + SLA Timer + Notification + Escalation + Follow-up**

ON TOP OF THE EXISTING SYSTEM.

Preserve existing functionality.

Reuse existing services.

Avoid duplicate architecture.

Do not perform unnecessary refactoring.

Do not rewrite working modules.

First inspect. Then plan. Then implement.