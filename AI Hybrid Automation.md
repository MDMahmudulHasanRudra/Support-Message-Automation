

# MASTER IMPLEMENTATION PROMPT — AI Hybrid Automation & Self-Learning Rule System

You are working on the existing **Support Message Automation** project.

The existing application already has:

* WhatsApp account management
* OpenWA-based WhatsApp connectivity
* Group management
* Group monitoring
* Message monitoring
* Automation Rules
* AutomationExecution
* OutboundMessage
* Notification system
* Queue/worker architecture
* Conversation Learning
* ConversationSession
* PatternCandidate
* PatternCandidateEvidence
* Unknown Pattern Detection
* AI client abstraction
* Group Message Sender
* Support Escalation
* Learning Settings
* Existing dashboard and admin UI

## CRITICAL RULE

**Do NOT rebuild existing functionality.**

Before changing anything:

1. Inspect the entire repository.
2. Read `ENGINEERING_STANDARDS.md`.
3. Inspect the current Prisma schema.
4. Inspect the current message-processing pipeline.
5. Inspect the current AutomationRule engine.
6. Inspect `packages/ai-client`.
7. Inspect Conversation Learning.
8. Inspect Unknown Pattern Detection.
9. Inspect OutboundMessage and queue processing.
10. Inspect existing Notification and Support Escalation systems.
11. Inspect current AI settings/UI.
12. Inspect existing tests.

Reuse existing architecture wherever possible.

Do not create duplicate systems when an existing system already performs the required function.

---

# 1. OBJECTIVE

Implement a new **Hybrid AI Automation Layer** on top of the existing automation engine.

The final architecture must work like this:

```text
Incoming WhatsApp Message
          │
          ▼
Message Normalization
          │
          ▼
Team Member / Group / Monitoring checks
          │
          ▼
Existing Automation Rule Engine
          │
      ┌───┴────┐
      │        │
   MATCH    NO MATCH
      │        │
      ▼        ▼
 Execute    AI Decision Layer
 Rule            │
                 │
          ┌──────┼─────────┐
          │      │         │
       ≥90%    <90%      Error/
      confidence confidence unavailable
          │      │         │
          ▼      ▼         ▼
       AI Reply Human     Human
          │      │        │
          ▼      ▼        ▼
      Send Reply Human   Human
          │      │        │
          └──────┼────────┘
                 │
                 ▼
          Learning / Rule
             Proposal
                 │
                 ▼
        Existing Rule Engine
```

The objective is to gradually reduce AI dependency.

Initial stage:

```text
Rule coverage = low
AI usage = high
Human involvement = fallback
```

After sufficient learning:

```text
Rule coverage = high
AI usage = low
Human involvement = rare
```

Eventually:

```text
Most known patterns → deterministic rules
Unknown patterns → AI
Ambiguous patterns → Human
```

---

# 2. ABSOLUTE SAFETY PRINCIPLE

AI must NOT become a direct uncontrolled automation engine.

The AI layer must operate under strict policy.

AI can:

* understand messages
* classify intent
* identify patterns
* generate a proposed response
* provide confidence
* explain reasoning in structured form
* propose a reusable automation rule

AI must NOT:

* directly execute arbitrary application commands
* directly modify the database
* directly activate rules
* bypass membership verification
* bypass monitoring
* bypass existing safety checks
* bypass kill switches
* bypass queue processing
* directly access WhatsApp provider APIs
* directly send WhatsApp messages outside the existing outbound pipeline

AI output must go through the existing application architecture.

---

# 3. RULE-FIRST ARCHITECTURE

This is the most important requirement.

For every incoming customer message:

### Step 1

Run the existing deterministic Automation Rule Engine first.

If an active rule matches:

```text
RULE MATCH
```

Execute the existing rule normally.

### Step 2

Only if no suitable rule matches:

```text
NO_MATCH
```

and the group/account is eligible for AI automation, invoke AI.

Therefore:

```text
Rule Engine
     ↓
Match?
 ┌───┴───┐
YES      NO
 │        │
Reply    AI
```

This prevents unnecessary AI API calls.

---

# 4. AI ENABLE/DISABLE CONTROL

Add an explicit AI automation control.

Example:

```text
AI Automation
[ OFF / ON ]
```

AI should never activate simply because an API key exists.

When OFF:

```text
Rule → Human/Existing fallback
```

When ON:

```text
Rule → AI fallback → Human fallback
```

The setting must support appropriate scope.

Prefer:

* Global AI enable/disable
* Account-level enable/disable
* Group-level AI enable/disable

Do not add excessive configuration if the existing architecture already provides an equivalent mechanism.

Use the smallest configuration model necessary.

---

# 5. AI CONFIDENCE POLICY

AI must return structured output.

Conceptually:

```json
{
  "intent": "...",
  "response": "...",
  "confidence": 0.96,
  "shouldReply": true,
  "reason": "...",
  "ruleProposal": {
    "eligible": true,
    "triggerPattern": "...",
    "response": "..."
  }
}
```

Do not blindly trust arbitrary AI text.

Validate:

* confidence
* response presence
* intent
* safety status
* group/account eligibility
* AI policy
* message state

### Confidence threshold

Default:

```text
90%
```

If:

```text
confidence >= 0.90
```

AI may propose/send a response **only if all other safety conditions pass**.

If:

```text
confidence < 0.90
```

do NOT auto-reply.

Instead:

```text
Human intervention
```

---

# 6. HUMAN FALLBACK

When AI cannot confidently understand a message:

```text
AI confidence < 90%
```

or:

* AI unavailable
* API failure
* timeout
* malformed AI response
* safety validation failure
* no appropriate response
* ambiguous intent

the system must involve a human.

Use the existing Notification / Support Escalation infrastructure where appropriate.

Do not create a second notification architecture.

The notification should contain useful context:

```text
AI Assistance Required

Group:
Sender:
Message:

AI confidence:
Detected intent:
Reason:

[Open Message]
[Respond]
```

---

# 7. HUMAN REPLY → RULE LEARNING

This is extremely important.

Suppose:

```text
Customer:
"ভাই, আজকে ইন্টারনেট অনেক স্লো"
```

AI confidence is only:

```text
82%
```

So AI does not reply.

Human responds:

```text
"ভাইয়া, আপনার লাইনটি আমরা চেক করছি..."
```

The system must record this relationship:

```text
Customer Message
        ↓
Human Response
```

Then create a **Rule Proposal**, not automatically activate it unless existing policy explicitly permits activation.

Example:

```text
Detected Pattern:
internet slow / slow internet / net slow

Response:
ভাইয়া, আপনার লাইনটি আমরা চেক করছি...
```

The proposal should use the existing AutomationRule / learning architecture.

---

# 8. AI REPLY → RULE LEARNING

If AI confidently replies:

```text
Customer:
"ভাইয়া প্যাকেজ পরিবর্তন করতে চাই"

AI confidence:
96%

AI:
"অবশ্যই ভাইয়া। কোন প্যাকেজে পরিবর্তন করতে চান?"
```

After successful delivery, store:

```text
Input pattern
Intent
AI response
Confidence
Group
Account
Timestamp
AutomationExecution
OutboundMessage
```

Then generate a reusable Rule Proposal.

Example:

```text
Trigger:
package change request

Response:
অবশ্যই ভাইয়া। কোন প্যাকেজে পরিবর্তন করতে চান?
```

Again:

**Do not blindly activate it.**

Follow the existing rule approval/activation policy.

---

# 9. EXACT RESPONSE LEARNING

The system must preserve the relationship between:

```text
Incoming message
        ↓
Detected pattern
        ↓
Response
        ↓
Response source
```

Response source must distinguish:

```text
HUMAN
AI
EXISTING_RULE
```

This is essential for future learning and auditing.

Example:

```text
Pattern:
"নেট স্লো"

Response:
"ভাইয়া, আপনার সংযোগটি চেক করছি।"

Source:
HUMAN
```

---

# 10. RULE REUSE BEFORE AI

After a rule has been created and activated:

A future similar message must first go through:

```text
AutomationRule Engine
```

If matched:

```text
Execute rule
```

AI must NOT be called.

Example:

### First occurrence

```text
Customer:
"নেট স্লো"

Rule:
NO MATCH

AI:
96%

AI Reply:
"ভাইয়া, আপনার সংযোগটি চেক করছি।"

→ Rule Proposal generated
```

### After rule approval/activation

```text
Customer:
"ভাইয়া নেটটা স্লো"

Rule Engine:
MATCH

→ Existing Rule Reply

AI:
NOT CALLED
```

This is the primary cost-saving mechanism.

---

# 11. SIMILARITY MUST NOT MEAN UNSAFE FUZZY REPLY

Do not simply make every semantically similar message trigger a rule.

Rules must have controlled matching behavior.

Reuse the existing AutomationRule matching architecture.

Where appropriate support:

* exact phrase
* normalized phrase
* keyword
* configured match mode
* known pattern
* approved pattern

If semantic similarity is introduced, it must have a clear confidence/threshold policy and must not bypass rule safety.

Do not introduce a vector database unless the existing architecture actually requires it.

---

# 12. AI SHOULD CREATE RULE PROPOSALS, NOT DIRECT RULE ACTIVATION

AI can suggest:

```text
Rule name
Trigger
Match mode
Keywords/patterns
Response
Priority
Scope
Reason
Evidence
Confidence
```

Example:

```text
Rule Proposal

Name:
Internet Slow Response

Trigger:
internet slow

Match:
KEYWORD / NORMALIZED

Response:
ভাইয়া, আপনার সংযোগটি চেক করছি।

Confidence:
96%

Evidence:
14 conversations
6 groups
3 distinct customer patterns

Source:
AI
```

Status:

```text
DRAFT
```

or existing equivalent status.

Human/admin can:

```text
Approve
Reject
Edit
Activate
```

Never silently activate AI-created rules unless the existing project already has an explicit opt-in auto-approval mechanism and the configured policy allows it.

---

# 13. AI LEARNING SHOULD USE EXISTING CONVERSATION LEARNING

Do NOT build a second learning system.

Reuse:

```text
ConversationSession
PatternCandidate
PatternCandidateEvidence
LearningSettings
Pattern detection
Unknown Pattern Detection
```

The new AI layer should enhance the existing learning system.

Architecture:

```text
Messages
   ↓
Conversation Sessions
   ↓
Pattern Detection
   ↓
Pattern Candidate
   ↓
AI Analysis
   ↓
Rule Proposal
```

---

# 14. AI SHOULD BE OPTIONAL

The system must continue working normally if AI is completely unavailable.

Example:

```text
AI API key missing
```

must NOT break:

* WhatsApp
* message processing
* rule engine
* queue
* notifications
* group monitoring
* existing automation

AI becomes an optional enhancement layer.

---

# 15. MULTIPLE AI CONNECTION METHODS

Extend the existing AI client abstraction.

Do NOT hardcode one provider.

The UI should allow an administrator to choose/configure an AI provider.

At minimum architect for:

### Provider type 1 — Direct API

Example:

```text
OpenAI-compatible API
```

Configuration:

```text
Provider
API Base URL
API Key
Model
```

### Provider type 2 — OpenAI-compatible self-hosted/local endpoint

Support configurable:

```text
Base URL
Model
Authentication
```

This allows future local/self-hosted AI.

### Provider type 3 — Local AI

If the current environment can safely support a local model endpoint, allow:

```text
localhost / internal network endpoint
```

Do not assume a specific local model runtime unless the repository already supports one.

### Provider architecture

Use:

```text
AiClient
   ↓
AiProviderAdapter
   ├── OpenAI-compatible
   ├── Local endpoint
   └── Future providers
```

The core automation system must depend on the interface, not a provider.

---

# 16. AI PROVIDER SECURITY

Never store API keys in plain text if the application already has a secure secret/configuration mechanism.

Do not expose API keys to:

* browser
* client-side JavaScript
* logs
* Message records
* AutomationExecution visible text
* error messages

API credentials must remain server-side.

When displaying credentials:

```text
••••••••••••
```

Provide:

```text
Test Connection
```

instead of exposing secrets.

---

# 17. AI SETTINGS UI

Create or extend the existing AI settings page.

Keep it clean and practical.

Example:

```text
AI Automation
────────────────────────

Status
[ ON ]

Provider
[ OpenAI-compatible ▼ ]

Base URL
[ https://... ]

API Key
[ ••••••••• ]

Model
[ model-name ]

Confidence Threshold
[ 90% ]

Human Fallback
[ ON ]

Rule Learning
[ ON ]

AI Rule Auto-Approval
[ OFF ]

[ Test Connection ]
[ Save Settings ]
```

Do not add unnecessary configuration.

---

# 18. AI GROUP CONTROL

Admins must be able to control where AI operates.

Example:

```text
Group
Support Team Internal Discussion ( ISP Digital )

Monitoring:
ON

AI Automation:
ON

AI Confidence:
90%

Human Fallback:
ON
```

The system must respect:

```text
Group monitored?
Account connected?
AI enabled?
AI allowed for group?
```

before attempting AI automation.

---

# 19. TEST GROUP POLICY

The approved test group is:

```text
Support Team Internal Discussion ( ISP Digital )
```

Use this group for functional testing.

The groups:

```text
Auto SMS Test Group
Auto SMS Test Group 2
```

are test-specific groups and must not accidentally receive production automation.

Never send real automated test messages to arbitrary customer groups.

---

# 20. AI COST CONTROL

This is a major requirement.

The architecture must explicitly minimize AI calls.

Priority:

```text
1. Existing deterministic rule
2. Learned deterministic rule
3. Pattern-based known response
4. AI
5. Human
```

Therefore:

```text
Known message
    ↓
Rule
    ↓
No AI cost
```

Only unknown/ambiguous messages reach AI.

AI should never be called repeatedly for the same known pattern if a valid active rule already exists.

---

# 21. AI RESPONSE CACHE / REUSE

If an existing active rule already handles the same intent/pattern:

```text
DO NOT CALL AI
```

If appropriate, maintain a safe lookup of previously approved patterns.

Do not use an uncontrolled response cache that could return stale or incorrect replies.

Rule Engine remains the source of truth.

---

# 22. AI FAILURE BEHAVIOR

If AI API fails:

```text
AI unavailable
```

the application must continue normally.

Do:

```text
Log failure
Create human notification if configured
Keep message persisted
Keep processing pipeline healthy
```

Do NOT:

```text
Crash worker
Block queue
Disconnect WhatsApp
Retry forever
```

Use bounded retries and existing queue conventions.

---

# 23. AI AUDIT TRAIL

Every AI decision should be auditable.

Record enough information to understand:

```text
Message
AI provider
Model
Confidence
Intent
Decision
Response
Response source
Rule proposal
Execution result
Timestamp
```

Do not store unnecessary sensitive provider payloads.

Do not store API secrets.

---

# 24. HUMAN/AI/RULE DECISION HISTORY

The message detail page should eventually make the chain visible:

```text
Incoming Message
       ↓
Rule Engine
       ↓
NO MATCH
       ↓
AI Analysis
       ↓
Confidence: 96%
       ↓
AI Reply
       ↓
OutboundMessage
       ↓
SENT
       ↓
Rule Proposal Created
       ↓
Approved
       ↓
Future messages use Rule
```

For human:

```text
Incoming Message
       ↓
Rule Engine
       ↓
NO MATCH
       ↓
AI confidence: 72%
       ↓
Human notified
       ↓
Human reply
       ↓
Learning Evidence
       ↓
Rule Proposal
```

This history is extremely important for debugging.

---

# 25. DO NOT BREAK EXISTING PIPELINE

Do not unnecessarily modify:

```text
processIncomingMessage.ts
```

If modification is absolutely necessary, preserve all existing stages:

```text
MESSAGE_RECEIVED
NORMALIZED
TEAM_MEMBER_CHECK
GROUP_RESOLVED
PERSISTED
DUPLICATE_CHECK
RULE_CHECK
ACTION_DECISION
```

Add AI as a controlled stage after deterministic rule evaluation.

Do not bypass:

* duplicate protection
* team member detection
* group monitoring
* account routing
* membership verification
* queue
* kill switch
* existing rule priority
* notification system

---

# 26. OUTBOUND MESSAGE SAFETY

AI-generated responses must use the existing:

```text
OutboundMessage
```

and existing queue/worker delivery pipeline.

Never:

```text
AI → OpenWA → send
```

Directly.

Correct:

```text
AI
 ↓
Validated response
 ↓
OutboundMessage
 ↓
Queue
 ↓
Worker
 ↓
Membership verification
 ↓
OpenWA
 ↓
WhatsApp
```

---

# 27. HUMAN RESPONSE CAPTURE

Determine how the application can reliably identify a human response.

Inspect the current inbound message pipeline and WhatsApp message metadata.

Do not assume sender identity.

Reuse the existing:

```text
isFromTeamMember
```

or equivalent team-member detection.

A human response should only become learning evidence when:

* sender is verified as a team member
* response belongs to the relevant conversation
* target group is known
* original customer message can be correlated safely

Avoid guessing correlations.

---

# 28. RULE PROPOSAL DEDUPLICATION

If the same pattern already has a rule proposal:

Do NOT create endless duplicate proposals.

Use existing pattern candidate/rule relationships where possible.

Example:

```text
Pattern:
internet slow

Existing Proposal:
Internet Slow Response

→ update evidence/count
→ do not create duplicate proposal
```

---

# 29. MULTI-GROUP LEARNING

A pattern should become more trustworthy when observed across multiple groups/customers.

Reuse existing:

```text
minDistinctGroupsForCandidate
minDistinctClientsForCandidate
```

Do not hardcode:

```text
10 groups
```

unless the existing settings explicitly require it.

The existing configurable learning thresholds remain the source of truth.

---

# 30. HUMAN OVERRIDE

Human must always be able to override AI.

Provide:

```text
AI Automation ON/OFF
Disable AI for group
Disable specific rule
Reject AI rule proposal
Edit AI-generated rule
```

Existing kill switches remain authoritative.

---

# 31. UI REQUIREMENTS

Follow `ENGINEERING_STANDARDS.md`.

Every new UI must have:

* Loading state
* Empty state
* Error state
* Retry
* Success feedback
* Confirmation where destructive
* Disabled state
* Permission handling
* Bulk operation where genuinely applicable

Never show only:

```text
Done
```

Use:

```text
AI configuration saved successfully.

Provider: OpenAI-compatible
Model: ...
Status: Connected
```

For rule learning:

```text
Rule proposal created

Source: AI
Confidence: 96%
Evidence: 12 conversations
Status: Draft

[Review Proposal]
```

---

# 32. DASHBOARD AI STATUS

Add only useful information to the existing dashboard.

For example:

```text
AI Automation
ON

AI Requests Today
24

AI Replies
18

Human Escalations
6

Rules Learned
12

AI Calls Avoided
438
```

Do not add excessive charts.

---

# 33. COST SAVING METRICS

Track useful metrics:

```text
AI calls
AI successful replies
AI fallback events
Human escalations
Rule-based replies
AI calls avoided
AI-generated rule proposals
Approved AI rules
```

This lets the company see whether AI dependency is actually decreasing.

---

# 34. AI REMOVAL / OFFLINE OPERATION

The application must remain fully operational if the AI provider is removed.

Test:

```text
AI ON
→ works

AI OFF
→ existing rules work

AI credentials removed
→ existing rules still work

AI provider unavailable
→ human fallback works

AI package unavailable
→ worker does not crash
```

This is a hard requirement.

---

# 35. DATABASE CHANGES

Before adding any schema:

Inspect existing models.

Prefer reusing:

```text
AutomationRule
AutomationExecution
PatternCandidate
PatternCandidateEvidence
ConversationSession
LearningSettings
OutboundMessage
Notification
```

Only add fields/tables when genuinely necessary.

All migrations must be:

* additive
* reversible where practical
* zero-data-loss
* properly indexed
* foreign-key safe
* compatible with existing production data

Do not create duplicate tables for information already modeled elsewhere.

---

# 36. TEST STRATEGY

Do not waste tokens/resources on unnecessary real WhatsApp testing.

Use:

### Automated tests

Test:

```text
Rule match → AI not called

No rule → AI called

AI confidence >= 90 → eligible for reply

AI confidence < 90 → human fallback

AI unavailable → human fallback

AI response → rule proposal

Human response → rule proposal

Existing rule after learning → AI not called

Duplicate proposal → prevented

AI disabled → AI not called

Group AI disabled → AI not called

Worker remains healthy after AI failure
```

### Minimal real test

Use only:

```text
Support Team Internal Discussion ( ISP Digital )
```

for the final real-world verification.

Do not run broad real-group tests unnecessarily.

---

# 37. IMPLEMENTATION PROCESS

Do not immediately start coding.

First produce an **Architecture Impact Report** containing:

1. Current AI architecture
2. Current rule engine architecture
3. Current conversation learning architecture
4. Current outbound architecture
5. Exact files that need modification
6. Exact files that do NOT need modification
7. Database changes required
8. UI changes required
9. Worker changes required
10. Security implications
11. Cost-control architecture
12. Testing strategy
13. Migration plan
14. Risks

Then implement in small phases.

---

# 38. IMPLEMENTATION PHASES

Use this order:

### Phase A — AI Provider Layer

* Multiple provider architecture
* Secure credentials
* Provider settings
* Connection test
* AI enable/disable

### Phase B — AI Decision Layer

* Rule-first
* AI fallback
* Confidence threshold
* Human fallback

### Phase C — AI Response Execution

* Validation
* Existing OutboundMessage
* Existing queue
* Existing membership verification
* Existing OpenWA path

### Phase D — Learning

* AI response → evidence
* Human response → evidence
* PatternCandidate integration
* Rule proposal generation

### Phase E — Rule Reuse

* Existing rule checked first
* AI bypassed for known patterns
* Duplicate proposal prevention

### Phase F — UI

* AI Settings
* Group AI settings
* AI activity
* Human escalation
* Rule proposal visibility
* Message detail trace

### Phase G — Testing

Automated first.

Minimal real WhatsApp test last.

---

# 39. DEFINITION OF DONE

Do not consider this feature complete unless:

### Provider

* Multiple AI connection methods are supported through a clean abstraction.
* API credentials are secure.
* Provider failure does not crash the worker.

### Rule Engine

* Rules always execute before AI.
* AI is only called after a genuine rule miss.

### AI

* AI can classify.
* AI returns confidence.
* ≥90% can be eligible for automatic response.
* <90% goes to human fallback.
* AI cannot bypass safety systems.

### Learning

* AI replies become learning evidence.
* Human replies become learning evidence.
* Existing Conversation Learning is reused.
* Rule proposals are generated.
* Duplicate proposals are prevented.

### Cost

* Known patterns use rules.
* AI is not called for known active rules.
* AI usage can be measured.
* AI calls avoided can be measured.

### Safety

* AI cannot directly send through OpenWA.
* All sends use existing OutboundMessage/queue.
* Membership verification remains active.
* Kill switches remain effective.
* Group/account monitoring remains authoritative.

### Reliability

* AI unavailable → software still works.
* AI disabled → software still works.
* Existing automation rules remain unaffected.
* WhatsApp worker remains healthy.

---

# 40. FINAL INSTRUCTION

**Do not over-engineer this.**

The purpose is not to build a completely separate AI platform.

The purpose is:

```text
EXISTING SOFTWARE
       +
AI FALLBACK
       +
HUMAN FALLBACK
       +
CONVERSATION LEARNING
       +
RULE GENERATION
       =
SELF-IMPROVING AUTOMATION
```

The existing deterministic rule engine must remain the foundation.

AI is an intelligent fallback and learning assistant.

Over time:

```text
Customer message
      ↓
Known rule?
   YES → instant deterministic reply
      ↓
   NO
      ↓
AI confidence ≥ 90%?
   YES → AI reply → learn → rule proposal
      ↓
   NO
      ↓
Human → learn → rule proposal
```

The long-term objective is to move more and more conversations from:

```text
AI-dependent
```

to:

```text
Deterministic rule-based
```

while keeping AI available for genuinely new or ambiguous situations.

**Start by auditing the repository and producing the Architecture Impact Report. Do not modify code until the audit is complete.**
