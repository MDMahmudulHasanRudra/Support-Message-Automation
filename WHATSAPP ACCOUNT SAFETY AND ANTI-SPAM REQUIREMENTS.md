# WHATSAPP ACCOUNT SAFETY AND ANTI-SPAM REQUIREMENTS

The system must be designed to minimize the risk of WhatsApp account restrictions caused by excessive or unnatural automation behavior.

The system must prioritize conservative and human-like support automation.

The goal is NOT to send bulk spam messages.

The goal is to:

- Monitor existing support groups.
- Process incoming client messages.
- Ignore unnecessary/default/system messages.
- Send automatic replies only when a configured rule explicitly requires it.
- Notify the internal support team.
- Avoid unnecessary outbound WhatsApp activity.

The system must never generate aggressive or uncontrolled message sending behavior.

---

# OUTBOUND MESSAGE SAFETY

Every outgoing automatic reply must pass through an outbound safety layer before sending.

The safety layer must check:

- Is the rule active?
- Is auto-reply enabled?
- Has this client already received the same reply recently?
- Is the message part of a monitored support conversation?
- Is the message being sent because of an actual incoming client message?
- Has the maximum reply limit been reached?
- Is the destination valid?

If any safety check fails, the message must NOT be sent.

---

# NO BULK SPAM MODE

The application must NOT include an unrestricted bulk messaging mode.

The system must not automatically send the same message to hundreds or thousands of unrelated users.

Automatic replies should normally be triggered by an incoming message from the same conversation.

Example allowed workflow:

Client sends:

"হ্যালো, আমার সফটওয়্যারে সমস্যা হচ্ছে"

↓

System matches an active support rule

↓

System sends one configured acknowledgement

↓

Support team is notified.

The system must not continuously send repeated promotional or unsolicited messages.

---

# AUTO-REPLY COOLDOWN

Every auto-reply rule must support a configurable cooldown.

Example:

Rule:
General Greeting Reply

Cooldown:
12 hours

If the same client sends:

"Hello"

multiple times within the configured cooldown period, the system must not repeatedly send the same automatic reply.

Example:

10:00 AM

Client:
Hello

System:
Automatic reply sent.

10:05 AM

Client:
Hello

System:
Do not send the same reply again.

Reason:
Auto-reply cooldown is active.

The administrator must be able to configure cooldown periods.

Examples:

- 5 minutes
- 15 minutes
- 1 hour
- 6 hours
- 12 hours
- 24 hours
- Custom duration

---

# PER-CLIENT REPLY LIMIT

The system must support reply limits per client.

Example configuration:

Maximum automatic replies:

3 replies per client per hour

Maximum automatic replies:

10 replies per client per day

When the configured limit is reached:

- Stop automatic replies.
- Continue storing incoming messages.
- Notify the support team if necessary.
- Log the reason.

The system must never continue sending unlimited automatic replies to the same client.

---

# GLOBAL MESSAGE RATE LIMITING

The system must include configurable global outbound rate limiting.

Example settings:

Maximum automatic replies per minute:
5

Maximum automatic replies per hour:
100

Maximum automatic replies per day:
500

These values must be configurable.

The system must stop or pause additional automatic replies when the configured limit is reached.

The administrator must be able to:

- Enable rate limiting.
- Disable rate limiting.
- Edit limits.
- View current usage.

The default configuration must be conservative.

---

# QUEUE-BASED MESSAGE SENDING

Automatic replies must not be sent directly from the incoming message event.

All outgoing messages must be placed into a message queue.

Architecture:

Incoming Client Message
        ↓
Rule Engine
        ↓
AUTO_REPLY Action
        ↓
Safety Validation
        ↓
Outbound Message Queue
        ↓
Rate Limiter
        ↓
Cooldown Check
        ↓
Duplicate Check
        ↓
WhatsApp Provider
        ↓
Message Sent

The queue must support:

- Pending.
- Processing.
- Sent.
- Failed.
- Cancelled.
- Rate Limited.

The system must avoid sending many messages simultaneously.

---

# REPLY DELAY

Automatic replies must support a configurable delay.

The system should not always respond instantly with exactly the same timing.

Example configuration:

Minimum delay:
3 seconds

Maximum delay:
15 seconds

The exact delay should be configurable.

However, the system must not attempt to impersonate a human or evade platform detection.

The purpose of the delay is to prevent bursts of simultaneous automated outbound messages and to provide stable queue processing.

---

# DUPLICATE REPLY PREVENTION

The system must prevent sending the same reply multiple times because of:

- Duplicate WhatsApp events.
- Worker restart.
- Database retry.
- Network failure.
- Queue retry.
- Application restart.

Every outgoing message must have an idempotency key.

Example:

WhatsApp Account ID
+
Chat ID
+
Incoming Message ID
+
Rule ID
+
Action Type

Before sending a reply, the system must check whether that action was already successfully completed.

---

# AUTOMATION LOOP PREVENTION

The system must never process its own outgoing messages as new client requests.

The system must distinguish:

- Incoming client messages.
- Internal team messages.
- System-generated messages.
- Outgoing automated replies.

Rule:

IF message is outgoing

THEN:

Do not process through client automation rules.

Additionally:

If the system sends an automatic reply, that reply must not trigger another automation rule.

The system must prevent:

- Infinite reply loops.
- Auto-reply-to-auto-reply loops.
- Notification loops.
- Forwarding loops.

---

# TEAM MEMBER SAFETY FILTER

Internal team member messages must be filtered before normal automation.

The administrator must maintain an internal team member list.

Each team member must have:

- Name.
- WhatsApp Number.
- Role.
- Department.
- Status.

Example:

Rudra
+8801XXXXXXXXX
Support
ACTIVE

When an active team member sends a message:

Default action:

IGNORE_FOR_CLIENT_AUTOMATION

The message may still be stored for conversation history, but it must not:

- Trigger client auto-replies.
- Trigger a new support alert.
- Trigger client issue classification.

The administrator must be able to override this behavior with specific rules when required.

---

# LAST TEAM MESSAGE RULE

The system must support conversation-aware rules.

Example:

IF the most recent previous message in the group was sent by an internal support team member

AND

the new incoming message matches a configured default/system message pattern

THEN:

IGNORE

This rule must NOT blindly ignore every new client message.

The administrator must define:

- Previous sender condition.
- Current sender condition.
- Message pattern.
- Group scope.
- Action.
- Rule priority.

The rule must support:

- ACTIVE.
- DISABLED.
- EDIT.
- DELETE.

---

# SUPPORT ACKNOWLEDGEMENT SAFETY

Support acknowledgement rules should send only one acknowledgement within the configured cooldown period.

Example:

Client:

"আমার পেমেন্ট করেছি কিন্তু ব্যালেন্স আপডেট হয়নি"

System:

"আপনার বিষয়টি গ্রহণ করা হয়েছে। অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন, আমাদের Support Team বিষয়টি যাচাই করছে।"

The system must not repeatedly send the same acknowledgement every time the client sends another message.

Instead:

First message:
Auto acknowledgement allowed.

Follow-up messages within cooldown:
Do not send the same acknowledgement again.

Support team notification:
Update existing support event instead of creating unlimited duplicate alerts.

---

# ACCOUNT HEALTH MONITORING

The system must monitor WhatsApp connection health.

Possible states:

- CONNECTED
- DISCONNECTED
- RECONNECTING
- AUTHENTICATION_REQUIRED
- SESSION_ERROR
- OUTBOUND_PAUSED
- RATE_LIMITED
- ERROR

If unusual sending failures occur:

The system must automatically:

1. Stop or pause non-essential automatic replies.
2. Continue collecting incoming messages if possible.
3. Record detailed logs.
4. Display an account health warning.
5. Notify the administrator through the configured internal notification channel.

The system must never respond to repeated failures by aggressively retrying messages without limits.

---

# SAFE RETRY POLICY

Failed outbound messages must not be retried indefinitely.

Example:

Maximum retries:
3

Retry intervals:

1st retry:
30 seconds

2nd retry:
5 minutes

3rd retry:
15 minutes

After maximum retries:

Status:

FAILED

The system must require manual review or follow the configured failure policy.

---

# OUTBOUND MESSAGE APPROVAL MODE

The administrator must be able to configure automation levels.

MODE 1:

MANUAL ONLY

System detects and notifies.
No automatic replies.

MODE 2:

SAFE AUTO REPLY

Only explicitly configured low-risk acknowledgement rules may send automatic replies.

MODE 3:

FULL RULE AUTOMATION

All active automation rules may execute, subject to rate limits, cooldowns, and safety checks.

Recommended default:

SAFE AUTO REPLY.

---

# AUTOMATION KILL SWITCH

The dashboard must include a global emergency switch.

Example:

AUTOMATION ENABLED

or

AUTOMATION PAUSED

When paused:

- Stop all automatic outbound WhatsApp replies.
- Continue collecting incoming messages.
- Continue storing messages.
- Continue notifying the support team if configured.
- Do not send new automated WhatsApp messages.

The administrator must be able to resume automation manually.

---

# WHATSAPP MESSAGE CONSENT AND SCOPE

The automation system should be used only for legitimate support communication and conversations where the organization is an active participant.

The system should not be used to:

- Send unsolicited promotional messages.
- Spam users.
- Automatically message unrelated contacts.
- Repeatedly contact users who have not initiated a support interaction.
- Bypass platform restrictions.

The primary automation scope is:

Existing support groups
+
Existing client support conversations
+
Configured support workflows.

---

# WHATSAPP PROVIDER ABSTRACTION

OpenWA must be isolated behind a provider abstraction.

Example:

WhatsAppProvider

Methods:

- connect()
- disconnect()
- getConnectionStatus()
- getGroups()
- subscribeToMessages()
- sendMessage()
- getAccountInfo()

OpenWA implementation:

OpenWAProvider

Future implementations may include:

- Official WhatsApp Business Platform provider.
- Other approved provider.

The core Rule Engine and Support Automation Engine must not directly depend on OpenWA-specific code.

---

# FINAL SAFE MESSAGE PROCESSING FLOW

Incoming WhatsApp Message
        ↓
Validate Message
        ↓
Check Direction
        ↓
Outgoing Message?
   YES → Ignore Automation
        ↓
NO
        ↓
Check Internal Team Member
   YES → Ignore Client Automation
        ↓
NO
        ↓
Check Group Monitoring
        ↓
Duplicate Check
        ↓
Check Last Sender Rule
        ↓
Check Default Ignore Rules
        ↓
Check Exception Rules
        ↓
Check Support Issue Rules
        ↓
Check Auto Reply Rules
        ↓
Determine Actions
        ↓
Store Result
        ↓
Support Notification Required?
   YES → Notify Teams / Support WhatsApp Group
        ↓
Auto Reply Required?
   YES
        ↓
Safety Validation
        ↓
Cooldown Check
        ↓
Per-Client Limit Check
        ↓
Global Rate Limit Check
        ↓
Queue Message
        ↓
Send Message
        ↓
Store Delivery Result

---

# FINAL ACCOUNT SAFETY PRINCIPLE

The system must prefer:

LESS AUTOMATION
OVER
AGGRESSIVE AUTOMATION.

The system must prefer:

ONE CORRECT SUPPORT ACKNOWLEDGEMENT
OVER
MULTIPLE REPEATED AUTOMATIC REPLIES.

The system must prefer:

INTERNAL TEAM NOTIFICATION
OVER
UNNECESSARY CLIENT MESSAGING.

The system must always maintain:

- Rate limits.
- Per-client limits.
- Cooldowns.
- Duplicate prevention.
- Queue-based sending.
- Retry limits.
- Automation pause control.
- Detailed logs.
- Outbound message history.

The system must be designed as a support automation system, not a bulk messaging or spam system.