# RULE-BASED SUPPORT MESSAGE AUTOMATION

The system must support a complete rule-based WhatsApp support automation engine.

The system is not limited to message filtering.

It must be capable of:

- Ignoring team member messages.
- Ignoring predefined/default messages.
- Ignoring messages based on the last sender.
- Automatically replying to clients.
- Detecting support-related messages.
- Notifying the support team.
- Forwarding messages.
- Tagging messages.
- Applying different rules for different WhatsApp groups.
- Allowing administrators to create, edit, enable, disable, duplicate, test, and delete automation rules.

The administrator must be able to configure the system without modifying application code.

---

# TEAM MEMBER FILTERING

The administrator must be able to maintain a list of internal team members.

Each team member record must contain:

- Name.
- WhatsApp phone number.
- Department or role.
- Active status.

Example:

Name: Support Executive 1
Phone: +8801XXXXXXXXX
Role: Support
Status: ACTIVE

The system must check the sender before processing a message.

Rule:

IF sender belongs to an active internal team member

THEN:

IGNORE_MESSAGE

The message must not trigger client support automation or unnecessary support notifications.

The team member list must support:

- Add.
- Edit.
- Enable.
- Disable.
- Delete.

---

# LAST MESSAGE SENDER RULE

The system must support rules based on the sender of the previous or latest message in a group.

Example:

IF previous message sender is an internal team member

THEN:

Apply configured action.

Possible actions:

- Ignore the next matching message.
- Ignore duplicate/default messages.
- Stop automation.
- Continue normal processing.

This behavior must be configurable per rule.

The administrator must be able to:

- Enable the rule.
- Disable the rule.
- Edit conditions.
- Delete the rule.

The system must not globally ignore all client messages merely because the previous sender was a team member.

The exact scope and conditions of the rule must be configurable.

---

# DEFAULT MESSAGE FILTERING

The administrator must be able to create predefined message rules.

Examples:

"সম্মানিত গ্রাহক"

"আপনার পেমেন্ট সফলভাবে গ্রহণ করা হয়েছে"

"Payment successful"

"Recharge successful"

A rule can match:

- Exact text.
- Contains keyword.
- Multiple keywords.
- Regex.

Example:

IF message matches:

"Payment successful"

THEN:

IGNORE_MESSAGE

The system must support a large number of predefined rules.

Rules must be editable without restarting the application.

---

# AUTO REPLY ENGINE

The administrator must be able to teach the system what response should be sent for different client messages.

Example:

Trigger:

Message equals:

"হ্যালো"

Action:

AUTO_REPLY

Reply:

"আসসালামু আলাইকুম। আমাদের Support Team-এ যোগাযোগ করার জন্য ধন্যবাদ। অনুগ্রহ করে আপনার সমস্যাটি বিস্তারিত লিখুন।"

Example:

Trigger:

Message contains:

"payment"

Action:

AUTO_REPLY

Reply:

"আপনার Payment সংক্রান্ত বিষয়টি গ্রহণ করা হয়েছে। অনুগ্রহ করে সমস্যার বিস্তারিত তথ্য প্রদান করুন।"

The auto-reply engine must support:

- Exact trigger.
- Keyword trigger.
- Multiple keyword trigger.
- Regex trigger.
- Sender condition.
- Group condition.
- Time condition.

Each auto-reply rule must contain:

- Rule name.
- Trigger condition.
- Matching type.
- Priority.
- Reply message.
- Delay configuration.
- Active status.

Rules must support:

- Create.
- Edit.
- Enable.
- Disable.
- Delete.
- Duplicate.
- Test.

---

# SUPPORT ESCALATION

The system must detect support-related messages.

Example:

"ইন্টারনেট চলছে না"

"Payment করেছি কিন্তু balance update হয়নি"

"OLT কাজ করছে না"

"PPPoE disconnect হচ্ছে"

When a support rule matches, the system may:

1. Send an automatic acknowledgement.
2. Mark the message as SUPPORT_REQUIRED.
3. Apply a category or tag.
4. Notify the support team.

Example notification:

🚨 NEW SUPPORT REQUEST

Group:
[group name]

Client:
[sender name or number]

Message:
[client message]

Category:
[detected category]

Action Required:
Please contact the client and resolve the issue.

Notification destinations must support:

- Microsoft Teams.
- WhatsApp Support Group.

The destination must be configurable.

---

# RULE PRIORITY

Every automation rule must have a priority.

Rules with higher priority must be evaluated before lower-priority rules.

Example:

Priority 100:

Critical Support Issue

Priority 90:

Exception Rule

Priority 70:

Auto Reply Rule

Priority 50:

Specific Ignore Rule

Priority 10:

Generic Default Ignore Rule

The system must clearly display which rule matched.

Example:

Message:
"Payment করেছি কিন্তু balance update হয়নি"

Final Action:
SUPPORT_REQUIRED

Matched Rule:
Payment Update Problem

Priority:
100

Reason:
The message contains a payment-related keyword and a balance update failure condition.

---

# MULTI-ACTION RULES

A rule may execute multiple actions.

Example:

Trigger:

Message contains:

"internet not working"

Actions:

1. Send automatic acknowledgement.
2. Add tag: INTERNET_ISSUE.
3. Mark as SUPPORT_REQUIRED.
4. Notify Microsoft Teams.
5. Forward message to WhatsApp Support Group.

The execution order must be configurable.

The system must prevent the same action from being executed multiple times for the same message.

---

# MESSAGE PROCESSING ORDER

Every incoming message should follow this pipeline:

Receive WhatsApp Message
        ↓
Validate Message
        ↓
Check Supported Message Type
        ↓
Check Sender
        ↓
Is Sender Internal Team Member?
        ↓
YES → IGNORE
        ↓
NO
        ↓
Check Previous/Last Sender Rule
        ↓
Check Group Monitoring Status
        ↓
Check Duplicate
        ↓
Check Default Ignore Rules
        ↓
Check High-Priority Exception Rules
        ↓
Check Support Escalation Rules
        ↓
Check Auto Reply Rules
        ↓
Execute Configured Actions
        ↓
Store Processing Result
        ↓
Update Notification Status

Every action must be logged.

---

# RULE SAFETY

The system must prevent automation loops.

Example:

System sends:

"Your issue has been received."

The system must not process its own outgoing reply as a new client message.

Outgoing system messages and internal team member messages must not re-enter the client support automation pipeline.

The system must prevent:

- Duplicate auto replies.
- Duplicate notifications.
- Reply loops.
- Notification loops.

Every processed message must have an idempotency key.

Every executed action must be tracked.

---

# RULE MANAGEMENT DASHBOARD

Create an Automation Rules section.

Features:

- Create Rule.
- Edit Rule.
- Delete Rule.
- Enable Rule.
- Disable Rule.
- Duplicate Rule.
- Change Priority.
- Reorder Rules.
- Test Rule.
- View Execution History.

Rule statuses:

- DRAFT
- ACTIVE
- DISABLED
- ARCHIVED

The dashboard must display:

- Rule name.
- Trigger.
- Action.
- Priority.
- Status.
- Last modified date.
- Execution count.
- Last execution.

---

# RULE TESTER

The administrator must be able to simulate a message.

Input:

- Sender.
- Group.
- Message.
- Previous sender.
- Time.

The system must display:

- Sender classification.
- Rules evaluated.
- Matched rule.
- Ignored rules.
- Priority resolution.
- Actions that would execute.
- Auto reply that would be sent.
- Notification destination.
- Final result.

Testing a rule must NOT send a real WhatsApp message or real notification unless explicitly configured for a live test.

---

# FINAL AUTOMATION GOAL

The system must act as a configurable support automation layer.

Example:

Client sends message
        ↓
System checks sender
        ↓
Internal Team Member?
        ↓
YES → Ignore
        ↓
NO
        ↓
Check Rules
        ↓
Default SMS?
        ↓
YES → Ignore
        ↓
NO
        ↓
Auto Reply Rule?
        ↓
YES → Send configured reply
        ↓
Support Issue?
        ↓
YES → Notify Support Team
        ↓
Support Executive contacts the client
        ↓
Issue is resolved

The administrator must be able to continuously teach the system new behavior by creating and updating rules without modifying the application source code.